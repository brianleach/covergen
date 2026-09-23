/**
 * covergen audit: the same gate, pointed at the tests a repo already has.
 *
 * Generated tests have always had to prove they check something. The tests that
 * were already in the tree never did, so a suite can grow a long tail of cases
 * that run code, raise the coverage number, cost CI time, and fail for nothing.
 * This command finds them and writes a report. It changes nothing: no test is
 * edited, deleted or rewritten here, and no model is called.
 *
 * Three passes, cheapest first.
 *
 *  1. Static, free. Every case goes through the rules registry, and a case with
 *     no assertion, only tautological ones, or only a pinned declaration is
 *     flagged weak_static.
 *  2. Dynamic, bounded. Every case in a spec file that holds a flagged one (or
 *     every case at all, with --deep) runs alone with coverage. Bugs are then
 *     planted on the source lines that case covers, and the case is re-run per
 *     planted bug. A case that catches none of them is weak_dynamic, and one
 *     that also covers nothing the rest of the suite reaches is redundant.
 *  3. Cost. Wall time per spec file, from the runs the dynamic pass already did.
 *
 * The whole run sits under the same wall-clock ceiling a sweep uses, so an audit
 * of a large suite stops rather than runs all night.
 */

import { existsSync } from "node:fs";
import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stateDirFor, type Config } from "./config.js";
import { mutantCompiled } from "./gate.js";
import { listSources, matchesSources } from "./git.js";
import { discardCoverageDir, readLcov } from "./lcov.js";
import { ceilingHit, type RunLimits } from "./limits.js";
import type { Logger } from "./logger.js";
import { generateMutants } from "./mutate.js";
import { ruleViolations } from "./rules.js";
import { getRunner } from "./runners/index.js";
import type { CoverageMap, RepoConfig, RunnerName, Runner, TestCase } from "./types.js";
import { rankByValue } from "./value.js";

export type AuditVerdict = "keeps" | "weak_static" | "weak_dynamic" | "redundant";

export interface AuditedCase {
  /** Spec file, relative to the repo cwd. */
  spec: string;
  /** Case name, or the spec path itself at spec granularity. */
  case: string;
  line: number;
  /** The strongest finding. `keeps` means nothing fired. */
  verdict: AuditVerdict;
  /** Every finding that fired, weakest first, so `verdict` is the last entry. */
  flags: AuditVerdict[];
  /** What the static pass objected to, when it objected. */
  reason?: string;
  /** Planted bugs this case failed on, over planted bugs it was re-run against. */
  caught: number;
  planted: number;
  /** Source lines this case covers, and how many of them nothing else covers. */
  coveredLines: number;
  uniqueLines: number;
  /** Wall time of the one coverage run that measured this case. */
  durationMs: number;
}

export interface SpecCost {
  spec: string;
  cases: number;
  durationMs: number;
}

export interface AuditTotals {
  cases: number;
  keeps: number;
  weakStatic: number;
  weakDynamic: number;
  redundant: number;
  planted: number;
  caught: number;
  /** Wall time of the flagged cases: what deleting them gives back per run. */
  wastedMs: number;
}

export interface AuditRepoReport {
  repo: string;
  runner: RunnerName;
  /** "case" when the runner can name one case, "spec" when the file is the unit. */
  granularity: "case" | "spec";
  specs: number;
  /** Source lines the whole suite covers, which is what a removal may not lower. */
  suiteLines: number;
  auditedCases: AuditedCase[];
  slowestSpecs: SpecCost[];
}

export interface AuditReport {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  deep: boolean;
  /** Set when the wall-clock ceiling stopped the audit before every file was read. */
  ceilingHit?: string;
  totals: AuditTotals;
  repos: AuditRepoReport[];
}

/**
 * The rules that say a case runs the code without checking it. The rest of the
 * registry is about how a test is written (real clocks, sleeps, skips), which is
 * worth knowing and is not what this command judges.
 */
const WEAK_RULES = new Set(["has-assertion", "no-tautology", "no-snapshot-only", "behavioral-evidence"]);

/** Why the static pass flagged this case, or undefined when it did not. */
export function staticReason(code: string, runner: RunnerName, disabled: readonly string[] = []): string | undefined {
  const hits = ruleViolations(code, runner, disabled).filter((v) => WEAK_RULES.has(v.id));
  return hits.length === 0 ? undefined : hits.map((v) => `${v.id}: ${v.message}`).join("; ");
}

export interface VerdictInput {
  weakStatic: boolean;
  planted: number;
  caught: number;
  coveredLines: number;
  uniqueLines: number;
}

/**
 * The verdict for one case.
 *
 * A case no bug could be planted against is not judged dynamically at all: that
 * is the gate's `tried: 0`, which has no opinion either, and reporting it as
 * weak would mean reporting every declaration-shaped file as weak.
 */
export function verdictFor(input: VerdictInput): { verdict: AuditVerdict; flags: AuditVerdict[] } {
  const flags: AuditVerdict[] = [];
  if (input.weakStatic) flags.push("weak_static");
  if (input.planted > 0 && input.caught === 0) {
    flags.push("weak_dynamic");
    if (input.coveredLines > 0 && input.uniqueLines === 0) flags.push("redundant");
  }
  return { verdict: flags[flags.length - 1] ?? "keeps", flags };
}

/** The text of one case: its own line down to the line the next case opens on. */
export function caseBody(text: string, cases: readonly TestCase[], index: number): string {
  const lines = text.split(/\r?\n/);
  const start = (cases[index] as TestCase).line - 1;
  const end = index + 1 < cases.length ? (cases[index + 1] as TestCase).line - 1 : lines.length;
  return lines.slice(start, end).join("\n");
}

const keyOf = (path: string, line: number): string => `${path}:${line}`;

/** Covered lines in one coverage map, as `path:line` keys, repo sources only. */
export function sourceLines(repo: RepoConfig, map: CoverageMap): Set<string> {
  const out = new Set<string>();
  for (const file of map.values()) {
    if (!matchesSources(repo, file.path)) continue;
    for (const [line, hits] of file.lines) if (hits > 0) out.add(keyOf(file.path, line));
  }
  return out;
}

async function globPaths(cwd: string, pattern: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of glob(pattern, { cwd })) out.push(String(entry).replaceAll("\\", "/"));
  } catch {
    return [];
  }
  return out.sort();
}

/**
 * The spec files to audit, and the source each was derived from.
 *
 * There is no spec glob in the config: a repo says where its sources are and how
 * a source maps to its spec, so walking the sources through `specPath` is what
 * names the suite. pytest is the exception, because it is the one runner whose
 * entry already carries a test glob of its own. A spec with no source under
 * `sources` is therefore not audited, which is the same blind spot generation
 * has always had.
 */
export async function auditSpecs(repo: RepoConfig): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  if (repo.runner === "pytest" && repo.pytest) {
    for (const spec of await globPaths(repo.cwd, repo.pytest.testGlob)) out.set(spec, undefined);
    return out;
  }
  for (const source of await listSources(repo)) {
    const spec = repo.specPath(source);
    if (!out.has(spec) && existsSync(join(repo.cwd, spec))) out.set(spec, source);
  }
  return out;
}

/**
 * Spec files in audit order, capped. Cheapest-value first, which is the inverse
 * of the order a sweep generates in: when only some of the suite can be audited,
 * the files worth the least are the ones whose tests are most likely to be
 * inflating a number, and the files worth the most are the ones a removal
 * proposal should touch last.
 */
async function orderSpecs(repo: RepoConfig, specs: Map<string, string | undefined>, baseline: CoverageMap, limit: number): Promise<string[]> {
  const paths = [...specs.keys()];
  if (limit <= 0 || paths.length <= limit) return paths;
  const targets = [...new Set([...specs.values()].filter((s): s is string => s !== undefined))];
  if (targets.length === 0) return paths.slice(0, limit);
  const rank = new Map((await rankByValue({ repo, baseline, targets })).map((row, i) => [row.path, i]));
  const scored = paths.map((spec) => ({ spec, at: rank.get(specs.get(spec) ?? "") ?? -1 }));
  scored.sort((a, b) => b.at - a.at || a.spec.localeCompare(b.spec));
  return scored.slice(0, limit).map((s) => s.spec);
}

export interface AuditArgs {
  config: Config;
  repo: RepoConfig;
  log: Logger;
  /** Run the dynamic pass over every case, not only the ones the static pass flagged. */
  deep: boolean;
  /** Spec files to audit at most. 0 audits every one of them. */
  limit: number;
  limits?: RunLimits;
}

/** One case run alone, with coverage. */
async function measureCase(repo: RepoConfig, runner: Runner, spec: string, filter: string | undefined, timeoutMs: number): Promise<{ covered: Set<string>; durationMs: number }> {
  const run = await runner.run(repo, { files: [spec], coverage: true, timeoutMs, caseFilter: filter });
  if (!run.lcovPath) return { covered: new Set(), durationMs: run.durationMs };
  const map = await readLcov(run.lcovPath, { cwd: repo.cwd });
  await discardCoverageDir(run.lcovPath);
  return { covered: sourceLines(repo, map), durationMs: run.durationMs };
}

/** Covered lines grouped back into file then line numbers, in path order. */
function byFile(covered: Set<string>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const key of covered) {
    const at = key.lastIndexOf(":");
    const path = key.slice(0, at);
    out.set(path, [...(out.get(path) ?? []), Number(key.slice(at + 1))]);
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Plant bugs on the lines this case covers and re-run the case against each one.
 * Every source file is restored in a finally, so a killed audit cannot leave a
 * planted bug in the tree.
 */
async function plantBugs(repo: RepoConfig, runner: Runner, spec: string, filter: string | undefined, covered: Set<string>, max: number, timeoutMs: number): Promise<{ planted: number; caught: number }> {
  let planted = 0;
  let caught = 0;
  for (const [path, lines] of byFile(covered)) {
    if (planted >= max) break;
    const abs = join(repo.cwd, path);
    let original: string;
    try {
      original = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const bugs = generateMutants({ path, language: repo.language, source: original, lines, max: max - planted });
    if (bugs.length === 0) continue;
    try {
      for (const bug of bugs) {
        if (planted >= max) break;
        await writeFile(abs, bug.source, "utf8");
        const run = await runner.run(repo, { files: [spec], coverage: false, timeoutMs, caseFilter: filter });
        // A bug the parser rejected says nothing about the test, exactly as in the gate.
        if (!mutantCompiled(run)) continue;
        planted += 1;
        if (!run.ok) caught += 1;
      }
    } finally {
      await writeFile(abs, original, "utf8");
    }
  }
  return { planted, caught };
}

export async function runAudit(args: AuditArgs): Promise<AuditReport> {
  const { config, repo, log, deep } = args;
  const started = Date.now();
  const runner = getRunner(repo.runner);
  await runner.preflight(repo);

  // One whole-suite run: what every other test already reaches, which is the
  // denominator the redundancy check subtracts from.
  const suiteRun = await runner.run(repo, { files: [], coverage: true, timeoutMs: config.gate.baseline_timeout_ms });
  if (!suiteRun.lcovPath) throw new Error(`audit needs a suite coverage run for ${repo.name}, and the runner produced no lcov (exit ${suiteRun.exitCode}).`);
  const suiteMap = await readLcov(suiteRun.lcovPath, { cwd: repo.cwd });
  await discardCoverageDir(suiteRun.lcovPath);
  const suiteCovered = sourceLines(repo, suiteMap);

  const specs = await auditSpecs(repo);
  const order = await orderSpecs(repo, specs, suiteMap, args.limit);
  const granularity: "case" | "spec" = runner.listCases ? "case" : "spec";
  log.info({ repo: repo.name, specs: order.length, granularity, deep }, "audit started");

  const audited: AuditedCase[] = [];
  const costs: SpecCost[] = [];
  for (const spec of order) {
    const stop = ceilingHit(args.limits);
    if (stop) {
      if (args.limits) args.limits.hit = stop;
      log.warn({ repo: repo.name, spec }, "wall-clock ceiling reached, auditing no further spec files");
      break;
    }
    const text = await readFile(join(repo.cwd, spec), "utf8").catch(() => "");
    const listed = (await runner.listCases?.(repo, spec)) ?? [];
    // A runner that cannot name a case, or a file this one could not read, is
    // judged whole: one pseudo-case covering the file, and no name filter.
    const cases: TestCase[] = listed.length > 0 ? listed : [{ name: spec, line: 1 }];
    const named = listed.length > 0;
    const reasons = cases.map((_, i) => staticReason(named ? caseBody(text, cases, i) : text, repo.runner, repo.disableRules));

    if (!deep && reasons.every((r) => r === undefined)) {
      for (const [i, one] of cases.entries()) {
        audited.push({ spec, case: one.name, line: one.line, verdict: "keeps", flags: [], reason: reasons[i], caught: 0, planted: 0, coveredLines: 0, uniqueLines: 0, durationMs: 0 });
      }
      continue;
    }

    const measured = [];
    for (const one of cases) {
      measured.push(await measureCase(repo, runner, spec, named ? one.name : undefined, config.gate.timeout_ms));
    }
    // What the rest of the suite reaches without this file at all. Subtracting
    // the whole file over-subtracts (a line two spec files both cover is gone
    // from here), which under-reports redundancy rather than over-reporting it.
    const fileAll = new Set<string>(measured.flatMap((m) => [...m.covered]));
    const elsewhere = new Set([...suiteCovered].filter((k) => !fileAll.has(k)));
    costs.push({ spec, cases: cases.length, durationMs: measured.reduce((sum, m) => sum + m.durationMs, 0) });

    for (const [i, one] of cases.entries()) {
      const covered = (measured[i] as { covered: Set<string> }).covered;
      const others = new Set(elsewhere);
      for (const [j, m] of measured.entries()) if (j !== i) for (const k of m.covered) others.add(k);
      const unique = [...covered].filter((k) => !others.has(k)).length;
      // Bugs are planted for a case the static pass flagged, for one that covers
      // nothing of its own (the redundancy candidates), and for every case under
      // --deep. Anything else is a case already known to be pulling its weight.
      const judge = deep || reasons[i] !== undefined || (covered.size > 0 && unique === 0);
      const bugs = judge
        ? await plantBugs(repo, runner, spec, named ? one.name : undefined, covered, config.mutation.max_mutants, config.mutation.timeout_ms)
        : { planted: 0, caught: 0 };
      const { verdict, flags } = verdictFor({ weakStatic: reasons[i] !== undefined, ...bugs, coveredLines: covered.size, uniqueLines: unique });
      audited.push({ spec, case: one.name, line: one.line, verdict, flags, reason: reasons[i], ...bugs, coveredLines: covered.size, uniqueLines: unique, durationMs: (measured[i] as { durationMs: number }).durationMs });
    }
  }

  const ended = Date.now();
  costs.sort((a, b) => b.durationMs - a.durationMs);
  return {
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    deep,
    ceilingHit: args.limits?.hit,
    totals: totalsOf(audited),
    repos: [{ repo: repo.name, runner: repo.runner, granularity, specs: order.length, suiteLines: suiteCovered.size, auditedCases: audited, slowestSpecs: costs.slice(0, 10) }],
  };
}

export function totalsOf(cases: readonly AuditedCase[]): AuditTotals {
  const count = (v: AuditVerdict): number => cases.filter((c) => c.flags.includes(v)).length;
  return {
    cases: cases.length,
    keeps: cases.filter((c) => c.verdict === "keeps").length,
    weakStatic: count("weak_static"),
    weakDynamic: count("weak_dynamic"),
    redundant: count("redundant"),
    planted: cases.reduce((sum, c) => sum + c.planted, 0),
    caught: cases.reduce((sum, c) => sum + c.caught, 0),
    wastedMs: cases.filter((c) => c.verdict !== "keeps").reduce((sum, c) => sum + c.durationMs, 0),
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The one sentence a reviewer can act on. Shared with the removal PR body. */
export function auditLead(report: AuditReport): string {
  const t = report.totals;
  const flagged = t.cases - t.keeps;
  return (
    `${flagged} ${flagged === 1 ? "case runs" : "cases run"} code without checking it, ${t.redundant} of them cover nothing the rest of the suite does not, ` +
    `and together they cost ${(t.wastedMs / 1000).toFixed(1)} seconds per run.`
  );
}

/** The report, led by the one sentence a reviewer can act on. */
export function auditMarkdown(report: AuditReport): string {
  const t = report.totals;
  const out = [
    "# Test audit",
    "",
    auditLead(report),
    "",
    `${plural(t.cases, "case")} audited, ${t.keeps} kept. Planted bugs caught: ${t.caught}/${t.planted}. Nothing was changed: this report proposes, it does not edit.`,
    "",
  ];
  if (report.ceilingHit) out.push("Stopped early: the wall-clock ceiling was reached, so later spec files were not audited.", "");
  for (const repo of report.repos) {
    out.push(`## ${repo.repo} (${repo.runner}, ${plural(repo.specs, "spec file")}, ${repo.granularity} granularity)`, "");
    if (repo.granularity === "spec") {
      out.push(`The ${repo.runner} runner cannot name a single case, so each spec file is judged whole.`, "");
    }
    const rows = repo.auditedCases.filter((c) => c.verdict !== "keeps");
    if (rows.length === 0) out.push("No case was flagged.", "");
    else {
      out.push("| verdict | spec | case | caught/planted | unique lines | ms |", "| --- | --- | --- | --- | --- | --- |");
      for (const c of rows) {
        out.push(`| ${c.flags.join(", ")} | ${c.spec}:${c.line} | ${c.case} | ${c.caught}/${c.planted} | ${c.uniqueLines}/${c.coveredLines} | ${c.durationMs} |`);
      }
      out.push("");
      for (const c of rows.filter((r) => r.reason)) out.push(`- ${c.spec}:${c.line} ${c.case}: ${c.reason}`);
      out.push("");
    }
    if (repo.slowestSpecs.length > 0) {
      out.push("Slowest spec files measured:", "");
      for (const s of repo.slowestSpecs) out.push(`- ${s.spec}: ${(s.durationMs / 1000).toFixed(1)}s over ${s.cases} ${s.cases === 1 ? "case" : "cases"}`);
      out.push("");
    }
  }
  return out.join("\n");
}

/** Write the markdown under the repo's state directory, and return where it went. */
export async function writeAudit(config: Config, repo: RepoConfig, markdown: string): Promise<string> {
  const path = join(stateDirFor(config, repo), "audit.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf8");
  return path;
}

export async function writeAuditJson(path: string, report: AuditReport): Promise<void> {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
