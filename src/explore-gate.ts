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
 * After the k passes comes the action-removal check, the end to end analogue
 * of the unit gate's mutation spot-check: the main action (the last action
 * before the last counting assertion) is commented out, the variant is run
 * once, and a spec that still passes protects nothing and is refused.
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
import { mainAction, scanSteps } from "./explore-steps.js";
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
  /** For action_removable: the main action's method, e.g. click. */
  verb?: string;
  /** Set on an accepted spec: the main action whose removal broke it, for the PR body. */
  actionRemoval?: { line: number; verb: string; broke: true };
}

/** The marker each line of the removed action carries in the variant. */
export const REMOVED_MARKER = "// covergen: removed for the action-removal check";

/** The spec with the lines from startLine to endLine (1-based, inclusive) commented out, indentation kept. */
export function withoutLines(code: string, startLine: number, endLine: number): string {
  return code
    .split("\n")
    .map((line, i) => (i + 1 >= startLine && i + 1 <= endLine ? line.replace(/^(\s*)/, `$1${REMOVED_MARKER} `) : line))
    .join("\n");
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

    const action = mainAction(scanSteps(candidate.code));
    if (!action) return { status: "no_assertion", runs, error: "no main action to remove", rule: "no_assertion", line: 1 };
    const found = { rule: "action_removable" as const, line: action.startLine, verb: action.verb };
    await writeFile(absSpec, withoutLines(candidate.code, action.startLine, action.endLine), "utf8");
    const run = await exec([...explore.testCommand, specPath], { cwd: args.cwd, timeoutMs: explore.timeoutMs, env });
    runs.push(run);
    if (run.exitCode === 0) {
      return { status: "action_removable", runs, error: `the spec still passed with its main action (${action.verb}, line ${action.startLine}) commented out`, ...found };
    }
    if (classifyFailure(`${run.stderr}\n${run.stdout}`) === "build_failed") {
      return { status: "action_removable", runs, error: "the spec without its main action did not build", ...found };
    }
    return { status: "accepted", runs, actionRemoval: { line: action.startLine, verb: action.verb, broke: true } };
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
