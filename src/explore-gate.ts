/**
 * The end to end gate, part 1: the static rules, then pass^k against the target.
 *
 * The unit gate (src/gate.ts) splices a candidate into a spec, runs it k times,
 * and restores the file in a finally block. This is the same shape for a
 * generated end to end spec, minus lcov: a spec that breaks a static rule is
 * refused before anything is written, a spec that passes the rules is written
 * as a new file under explore.spec_dir and run k times through the target
 * repo's own test command, and the file is deleted afterwards whatever the
 * verdict. Writing accepted specs for real is a later step.
 *
 * Nothing private leaks out of here: the base URL and the storage state path
 * reach the child only through the environment variables the config names, and
 * any output tail kept in `error` has both values replaced by `${NAME}`.
 */

import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { Flow } from "./explore.js";
import { checkFlowShape } from "./explore-generate.js";
import { exploreRules, staticRuleOrder } from "./explore-rules.js";
import type { ExploreRuleId, RuleContext } from "./explore-rules.js";
import type { SpecFile } from "./explore-specs.js";
import { classifyFailure, tailOf } from "./gate.js";
import { runCommand } from "./runners/exec.js";
import type { ExecFn, ExecResult } from "./runners/exec.js";
import type { ExploreOptions, FlowCandidate, FlowStatus } from "./types.js";

export interface FlowGateResult {
  status: FlowStatus;
  runs: ExecResult[];
  /** Why it failed: a shape problem, a rule message, or a scrubbed output tail. */
  error?: string;
  rule?: ExploreRuleId;
  line?: number;
}

export interface FlowGateArgs {
  explore: ExploreOptions;
  /** The target repo's working directory; spec paths are relative to it. */
  cwd: string;
  candidate: FlowCandidate;
  flow: Flow;
  flows: readonly Flow[];
  existing: readonly SpecFile[];
  acceptedThisRun: readonly SpecFile[];
  baseUrl: string;
  storageStatePath?: string;
  /** Runs the test command. Tests inject a fake; the default is runCommand. */
  exec?: ExecFn;
  /** One line per verdict: status, rule id and line number, never spec text or env values. */
  log?: (line: string) => void;
}

/**
 * Replace each value with `${NAME}`, the longer value first so a base URL that
 * prefixes another value cannot leave a fragment behind. A trailing slash is
 * optional, so output that prints the origin bare is caught too.
 */
export function scrubEnvValues(text: string, values: Readonly<Record<string, string | undefined>>): string {
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    for (const v of new Set([value, value.replace(/\/+$/, "")])) if (v.length > 0) pairs.push([v, name]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs.reduce((out, [value, name]) => out.replaceAll(value, `\${${name}}`), text);
}

export async function evaluateFlow(args: FlowGateArgs): Promise<FlowGateResult> {
  const result = await judge(args);
  const where = result.rule ? ` rule=${result.rule} line=${result.line ?? 0}` : "";
  args.log?.(`explore gate: ${result.status}${where}`);
  return result;
}

async function judge(args: FlowGateArgs): Promise<FlowGateResult> {
  const { explore, candidate } = args;
  const shape = checkFlowShape(candidate.code);
  if (shape) return { status: "build_failed", runs: [], error: shape };

  const ctx: RuleContext = {
    baseUrl: args.baseUrl,
    storageStateEnv: explore.storageStateEnv,
    flow: args.flow,
    flows: args.flows,
    existing: args.existing,
    acceptedThisRun: args.acceptedThisRun,
  };
  for (const id of staticRuleOrder) {
    const violation = exploreRules.find((r) => r.id === id)?.test?.(candidate.code, ctx);
    if (violation) return { status: violation.rule, runs: [], error: violation.message, rule: violation.rule, line: violation.line };
  }

  const specPath = normalize(candidate.specPath).replaceAll("\\", "/");
  const specDir = normalize(explore.specDir).replaceAll("\\", "/").replace(/\/+$/, "");
  if (isAbsolute(specPath) || specPath.split("/").includes("..") || !(specDir === "." || specPath.startsWith(`${specDir}/`))) {
    throw new Error(`evaluateFlow: ${specPath} is not a path under spec_dir ${specDir}`);
  }
  const absSpec = join(args.cwd, specPath);
  const made = await mkdir(dirname(absSpec), { recursive: true });
  try {
    // wx refuses an existing file, so a hand-written spec is never overwritten.
    await writeFile(absSpec, candidate.code, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    await removeMadeDirs(dirname(absSpec), made);
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`evaluateFlow: ${specPath} already exists; a spec is never overwritten`);
    throw err;
  }

  const values = { [explore.baseUrlEnv]: args.baseUrl, [explore.storageStateEnv]: args.storageStatePath };
  const env: Record<string, string> = { [explore.baseUrlEnv]: args.baseUrl };
  if (args.storageStatePath) env[explore.storageStateEnv] = args.storageStatePath;
  const exec = args.exec ?? runCommand;
  const runs: ExecResult[] = [];
  const tail = (run: ExecResult): string | undefined => {
    const text = tailOf({ ...run, ok: run.exitCode === 0 });
    return text === undefined ? undefined : scrubEnvValues(text, values);
  };
  try {
    for (let i = 0; i < explore.k; i++) {
      const run = await exec([...explore.testCommand, specPath], { cwd: args.cwd, timeoutMs: explore.timeoutMs, env });
      runs.push(run);
      if (run.exitCode === 0) continue;
      if (i === 0) return { status: classifyFailure(`${run.stderr}\n${run.stdout}`), runs, error: tail(run) ?? `exited ${run.exitCode}` };
      const note = `passed ${i} time${i === 1 ? "" : "s"} then failed on run ${i + 1} of ${explore.k}`;
      const text = tail(run);
      return { status: "flaky", runs, error: text ? `${note}\n${text}` : note };
    }
    return { status: "accepted", runs };
  } finally {
    await unlink(absSpec).catch(() => {});
    await removeMadeDirs(dirname(absSpec), made);
  }
}

/** Remove the directories mkdir created for the spec, deepest first, stopping at the first that is not empty. */
async function removeMadeDirs(dir: string, made: string | undefined): Promise<void> {
  if (!made) return;
  for (let d = dir; d.length >= made.length; d = dirname(d)) {
    try {
      await rmdir(d);
    } catch {
      return;
    }
    if (d === made) return;
  }
}
