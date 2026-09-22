/**
 * One run, end to end: preflight, baseline coverage, generate, gate, repair,
 * emit, persist state.
 *
 * Two ordering rules matter and are load-bearing:
 *  - gate evaluations run sequentially, because each one splices a candidate
 *    into the repo working tree and runs the suite. Two at once corrupt each
 *    other's tree and each other's coverage numbers.
 *  - generation for the segments of one file runs concurrently, because it is
 *    pure network latency and touches nothing on disk.
 */

import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { listSources, treeFingerprint } from "./git.js";
import { copyFile, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { watchForAbort, type AbortWatch } from "./abort.js";
import type { Config } from "./config.js";
import { generatorBackend, priceTable, stateDirFor } from "./config.js";
import { journalId, journalPath, newJournal, specFileHash, writeJournal, type JournalStatus } from "./journal.js";
import { countLines, specFileFull } from "./chunk.js";
import { claudeExec, createClaudeCodeGenerator, preflightClaudeCode } from "./claude-code.js";
import { runCost } from "./cost.js";
import { applyAccepted, prBody } from "./emit.js";
import { createGenerator, dedupeCandidates } from "./generate.js";
import { evaluate, tailOf } from "./gate.js";
import { discardCoverageDir, mergeCoverage, readLcov } from "./lcov.js";
import { ceilingHit, totalTokens, type RunLimits } from "./limits.js";
import type { Logger } from "./logger.js";
import { buildPromptBlocks, findNearestSpec, loadIdiomPack } from "./prompt.js";
import { repairLoop } from "./repair.js";
import { ruleViolations, rulesText, verdictFor } from "./rules.js";
import { getRunner } from "./runners/index.js";
import { failingCrates } from "./runners/cargo.js";
import { runCommand } from "./runners/exec.js";
import { scopeCoverage } from "./scope.js";
import { buildSegments } from "./segments.js";
import { rankByValue } from "./value.js";
import { freezableHashes, loadState, recordRun, saveState, skipSet } from "./state.js";
import type {
  Candidate,
  CoverageMap,
  GateResult,
  RepoConfig,
  RunResult,
  RunSummary,
  Runner,
  Segment,
} from "./types.js";

/**
 * A run that gated every candidate and then failed anyway, which today means the
 * accepted specs passed alone and not together, so all of them were rolled back.
 *
 * The summary rides along with the error because the gate had already decided
 * every candidate: last-run.md names each rejection and its reason, and a report
 * built from the error alone would say the repo did nothing at all.
 */
export class RunFailed extends Error {
  readonly summary: RunSummary;

  constructor(message: string, summary: RunSummary) {
    super(message);
    this.name = "RunFailed";
    this.summary = summary;
  }
}

export interface PipelineArgs {
  config: Config;
  repo: RepoConfig;
  /** Source paths relative to repo.cwd. */
  targets: string[];
  dryRun: boolean;
  /** Baseline only the target's own spec instead of the whole suite. */
  fast?: boolean;
  log: Logger;
  /** Anthropic key, passed straight to the client so it never enters process.env. */
  apiKey?: string;
  /** Ignore a cached whole-suite baseline and run the suite again. */
  refreshBaseline?: boolean;
  /** HEAD when the sweep started, recorded in the journal so the PR can be cut from it. */
  baseSha?: string;
  /**
   * Run-wide ceilings, shared with every other repo in the same sweep. Checked
   * before each target, so the candidate in flight always finishes.
   */
  limits?: RunLimits;
  /**
   * Signal watch. Defaults to one listening on SIGINT and SIGTERM; injected in
   * tests, which must never install a real handler.
   */
  abort?: AbortWatch;
}

const emptyTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Bump when the content of a whole-suite baseline changes, to invalidate cached files. */
const BASELINE_SCHEMA = "v2";

/**
 * Identity of one config entry for baseline caching. Two entries can share a
 * monorepo `root` while pointing at different packages, and a baseline describes
 * the package it ran in, not the root: cwd, runner, command prefix and the
 * source globs all change what a whole-suite run reports. The cache stays under
 * the root state dir and this key namespaces the file name per entry, so
 * sibling packages never read each other's coverage. cwd goes in relative to
 * root so the key survives a checkout at a different absolute path.
 */
export function baselineEntryKey(repo: RepoConfig): string {
  const cwd = (relative(repo.root, repo.cwd).replaceAll("\\", "/") || ".").replace(/\/+$/, "");
  const parts = JSON.stringify([cwd, repo.runner, repo.commandPrefix ?? [], repo.sources, repo.exclude ?? []]);
  return createHash("sha256").update(parts).digest("hex").slice(0, 12);
}

/**
 * Second line of defence behind the cache key: count how many of the entry's own
 * source files the cached map actually mentions. A baseline that knows fewer
 * than half of them is describing something else (a stale layout, or a file
 * written before the key covered an entry's identity), so it is refreshed
 * rather than trusted. An entry whose globs match nothing is not checked.
 */
export async function cachedBaselineFits(
  repo: RepoConfig,
  cached: CoverageMap,
): Promise<{ ok: boolean; matched: number; total: number }> {
  const sources = await listSources(repo).catch(() => [] as string[]);
  if (sources.length === 0) return { ok: true, matched: 0, total: 0 };
  let matched = 0;
  for (const rel of sources) if (cached.has(rel)) matched += 1;
  return { ok: matched * 2 >= sources.length, matched, total: sources.length };
}

function readUsage(generator: { usage?: () => unknown }): RunSummary["tokens"] {
  try {
    const raw = generator.usage?.() as Partial<RunSummary["tokens"]> | undefined;
    if (!raw) return { ...emptyTokens };
    return {
      input: raw.input ?? 0,
      output: raw.output ?? 0,
      cacheRead: raw.cacheRead ?? 0,
      cacheWrite: raw.cacheWrite ?? 0,
    };
  } catch {
    return { ...emptyTokens };
  }
}

function sumUsage(a: RunSummary["tokens"], b?: RunSummary["tokens"]): RunSummary["tokens"] {
  if (!b) return a;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/**
 * Map with at most `limit` calls in flight, results in input order. Limit 0 is no
 * limit, which is what the API backend wants. The subscription backend caps it:
 * headless runs share one usage window with every other session on the account.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (limit <= 0 || limit >= items.length) return Promise.all(items.map(fn));
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next; i < items.length; i = next) {
      next = i + 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

async function baselineRun(
  repo: RepoConfig,
  runner: Runner,
  files: string[],
  timeoutMs: number,
): Promise<RunResult> {
  // An empty file list is the whole-suite baseline, and it has to see files no test
  // loads: a source file with no spec at all is exactly what generation is for, and a
  // runner that reports only loaded files leaves it out of the map, so segments.ts
  // finds no uncovered lines and the target is skipped. A fast-mode baseline names the
  // target's own spec and stays narrow.
  return runner.run(repo, { files, coverage: true, timeoutMs, wholeProject: files.length === 0 });
}

/**
 * Keep every candidate's final code on disk, accepted or not, named by status and
 * hash. This is what a dry run leaves behind for review, and what a rejected
 * candidate leaves behind for debugging the prompt.
 */
async function writeCandidateFiles(dir: string, candidates: Candidate[]): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const c of candidates) {
    const ext = extname(c.specPath) || ".txt";
    const header = [
      `status: ${c.status}`,
      `spec: ${c.specPath}`,
      `source: ${c.segment.path} lines ${c.segment.startLine}-${c.segment.endLine}` +
        (c.segment.symbol ? ` (${c.segment.symbol})` : ""),
      `attempts: ${c.attempts}`,
      c.delta ? `newly covered: ${c.delta.newlyCovered.join(", ")}` : undefined,
      c.lastError ? `last error: ${c.lastError.split("\n")[0]}` : undefined,
    ]
      .filter(Boolean)
      .map((line) => (ext === ".rb" ? `# ${line}` : `// ${line}`))
      .join("\n");
    await writeFile(join(dir, `${c.status}-${c.hash.slice(0, 12)}${ext}`), `${header}\n\n${c.code}\n`, "utf8");
  }
}

/** Lines in a spec file as it stands on disk, 0 when the run has not created it yet. */
async function specFileLines(cwd: string, specPath: string): Promise<number> {
  const abs = resolve(cwd, specPath);
  if (!existsSync(abs)) return 0;
  return countLines(await readFile(abs, "utf8").catch(() => ""));
}

/**
 * Persist an accepted whole-file candidate at its spec path.
 *
 * The gate deletes any spec file it had to create, so without this write the
 * file the run just proved out would not exist, and every later segment of the
 * same target would have to be another whole file. Writing it here lets those
 * segments be regenerated as appendable blocks instead.
 *
 * Returns the directories this call created, shallowest first, so a dry run can
 * take them back out.
 */
async function writeCreatedSpec(cwd: string, specPath: string, code: string): Promise<string[]> {
  const abs = resolve(cwd, specPath);
  const parent = dirname(abs);
  const created: string[] = [];
  for (let dir = parent; !existsSync(dir) && dir !== dirname(dir); dir = dirname(dir)) created.unshift(dir);
  await mkdir(parent, { recursive: true });
  await writeFile(abs, `${code.replace(/\s+$/, "")}\n`, "utf8");
  return created;
}

/** Restore touched specs to their pre-run contents. Best effort: a non-empty created dir is left alone. */
async function restoreSpecs(
  cwd: string,
  originals: Map<string, string | undefined>,
  touched: Iterable<string>,
  dirs: string[],
  log: Logger,
): Promise<void> {
  for (const spec of touched) {
    const original = originals.get(spec);
    const abs = resolve(cwd, spec);
    if (original === undefined) {
      await rm(abs, { force: true }).catch(() => {});
    } else {
      await writeFile(abs, original, "utf8");
    }
    log.info({ spec }, "restored spec file after run rollback");
  }
  for (const dir of [...new Set(dirs)].reverse()) await rmdir(dir).catch(() => {});
}

async function snapshotSpecs(cwd: string, specs: Iterable<string>): Promise<Map<string, string | undefined>> {
  const originals = new Map<string, string | undefined>();
  for (const spec of new Set(specs)) {
    const abs = resolve(cwd, spec);
    originals.set(spec, existsSync(abs) ? await readFile(abs, "utf8") : undefined);
  }
  return originals;
}

/** Prove the combined emitted specs still pass together and satisfy repo validation. */
async function verifyAcceptedOutput(
  repo: RepoConfig,
  runner: Runner,
  specs: string[],
  opts: { k: number; timeoutMs: number },
): Promise<void> {
  if (specs.length === 0) return;

  for (let i = 0; i < opts.k; i += 1) {
    const result = await runner.run(repo, { files: specs, coverage: false, timeoutMs: opts.timeoutMs });
    if (!result.ok) {
      throw new Error(
        `combined accepted specs failed on run ${i + 1} of ${opts.k}:\n${tailOf(result) ?? `exit ${result.exitCode}`}`,
      );
    }
  }

  for (const cmd of repo.validate ?? []) {
    const full = [...(repo.commandPrefix ?? []), ...cmd];
    const result = await runCommand(full, { cwd: repo.cwd, timeoutMs: opts.timeoutMs });
    if (result.exitCode !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim().split("\n").slice(-60).join("\n");
      throw new Error(`combined accepted specs failed validation (${cmd.join(" ")}):\n${output || `exit ${result.exitCode}`}`);
    }
  }
}

/**
 * The section appended to last-run.md when the combined verification fails. The
 * body above it lists accepted tests that are no longer on disk, so it has to say
 * why they are gone.
 */
function revertedNote(reason: string): string {
  return [
    "",
    "## Reverted",
    "",
    "Every test listed above passed the gate on its own, and then the accepted specs",
    "failed when run together. Nothing this run wrote was kept: the spec files are back",
    "to their pre-run contents, so the checkout is as clean as it was found.",
    "",
    "```",
    reason,
    "```",
    "",
  ].join("\n");
}

/** Mark lines as hit in place so the next gate sees them as already covered. */
function markCovered(map: CoverageMap, path: string, lines: number[]): void {
  if (lines.length === 0) return;
  const file = map.get(path) ?? { path, lines: new Map<number, number>() };
  for (const line of lines) file.lines.set(line, Math.max(1, file.lines.get(line) ?? 0));
  map.set(path, file);
}

interface BaselineArgs {
  config: Config;
  repo: RepoConfig;
  runner: Runner;
  log: Logger;
  /** Fast mode baselines only the listed specs and is never cached. */
  fast: boolean;
  baselineFiles: string[];
  refresh?: boolean;
}

/**
 * The baseline coverage map for a run. A whole-suite baseline is slow and
 * depends only on the tree and the entry that ran it, so it is cached under the
 * root state dir keyed by HEAD plus dirty working-tree contents plus the entry
 * key, and sanity checked against the entry's own sources before it is trusted.
 */
async function loadBaseline(args: BaselineArgs): Promise<CoverageMap> {
  const { config, repo, runner, log, fast, baselineFiles } = args;
  const cacheDir = join(stateDirFor(config, repo), "baseline");
  const fingerprint = fast
    ? undefined
    : await treeFingerprint(repo.root, { exclude: [config.state_dir] }).catch(() => undefined);
  // BASELINE_SCHEMA changes whenever what goes into a baseline changes, so a cached
  // file written by an older shape is ignored rather than silently reused. The entry
  // key keeps two entries under one root from sharing a file.
  const cachePath = fingerprint
    ? join(cacheDir, `${fingerprint}-${baselineEntryKey(repo)}-${BASELINE_SCHEMA}.lcov`)
    : undefined;

  if (cachePath && !args.refresh && existsSync(cachePath)) {
    const cached = await readLcov(cachePath, { cwd: repo.cwd });
    const fit = await cachedBaselineFits(repo, cached);
    if (fit.ok) {
      log.info({ repo: repo.name, files: cached.size, cachePath }, "baseline coverage loaded from cache");
      return cached;
    }
    log.warn(
      { repo: repo.name, cachePath, matched: fit.matched, sources: fit.total },
      "cached baseline covers too few of this entry's sources, running the suite again",
    );
  }

  const timeoutMs = fast ? config.gate.timeout_ms : config.gate.baseline_timeout_ms;
  const baselineResult = await baselineRun(repo, runner, baselineFiles, timeoutMs);
  if (!baselineResult.lcovPath) {
    const tail = `${baselineResult.stderr}\n${baselineResult.stdout}`.trim().split("\n").slice(-40).join("\n");
    throw new Error(
      `baseline run produced no lcov for ${repo.name} (exit ${baselineResult.exitCode}). ` +
        `Check that the coverage reporter is wired up. Runner output:\n${tail}`,
    );
  }
  // A baseline that measured everything but had a failing test somewhere is a
  // warning, not a wall. The gate judges each candidate against its own source's
  // lines, so a red test in a crate or package nobody is sweeping changes
  // nothing about that judgement, and dying here strands the whole run.
  if (!baselineResult.ok) {
    const crates = repo.runner === "cargo" ? failingCrates(`${baselineResult.stdout}\n${baselineResult.stderr}`) : [];
    log.warn(
      { repo: repo.name, exitCode: baselineResult.exitCode, crates },
      crates.length > 0
        ? `baseline suite has failing tests in ${crates.join(", ")}; coverage is used as measured. Narrow cargo.packages to the crates covergen sweeps if that crate is not one of them.`
        : "baseline suite has failing tests; coverage is used as measured",
    );
  }
  const baseline = await readLcov(baselineResult.lcovPath, { cwd: repo.cwd });
  if (cachePath) {
    // A cache write failure must never fail the run.
    try {
      await mkdir(cacheDir, { recursive: true });
      await copyFile(baselineResult.lcovPath, cachePath);
    } catch (err) {
      log.warn({ cachePath, err: String(err) }, "could not cache baseline");
    }
  }
  await discardCoverageDir(baselineResult.lcovPath);
  log.info(
    { repo: repo.name, files: baseline.size, fast, durationMs: baselineResult.durationMs, cached: Boolean(cachePath) },
    "baseline coverage parsed",
  );
  return baseline;
}

/**
 * True when this repo has ever had a whole-suite baseline cached, whatever tree
 * state it described. The file proves a real coverage run worked here once,
 * which is the same thing a runner's smoke run proves and rather more of it.
 */
export function hasBaselineCache(config: Config, repo: RepoConfig): boolean {
  const cacheDir = join(stateDirFor(config, repo), "baseline");
  try {
    return readdirSync(cacheDir).some((name) => name.endsWith(".lcov"));
  } catch {
    return false;
  }
}

/**
 * Preflight before a run: deep the first time covergen touches a repo, cheap
 * once a cached baseline exists. The smoke coverage run costs a build and a
 * coverage pass on every invocation, and after the first baseline it re-proves
 * something already on disk.
 */
export async function preflightRepo(args: { config: Config; repo: RepoConfig; runner: Runner; log: Logger }): Promise<void> {
  const { config, repo, runner, log } = args;
  const deep = !hasBaselineCache(config, repo);
  await runner.preflight(repo, { deep });
  log.debug({ repo: repo.name, runner: repo.runner, deep }, "preflight ok");
}

/** Uncovered lines for one cwd-relative path, or -1 when the baseline has no data for it. */
function uncoveredCount(baseline: CoverageMap, path: string): number {
  const file = baseline.get(path);
  if (!file) return -1;
  let uncovered = 0;
  for (const hits of file.lines.values()) if (hits === 0) uncovered += 1;
  return uncovered;
}

export interface OrderArgs {
  config: Config;
  repo: RepoConfig;
  targets: string[];
  log: Logger;
  refreshBaseline?: boolean;
}

/**
 * The whole-suite baseline every ordering mode needs. It is the same one the run
 * itself uses and it is cached by tree state, so ordering costs nothing the run
 * was not already paying.
 */
async function orderingBaseline(args: OrderArgs): Promise<CoverageMap> {
  const { config, repo, log } = args;
  const runner = getRunner(repo.runner);
  await preflightRepo({ config, repo, runner, log });
  return loadBaseline({ config, repo, runner, log, fast: false, baselineFiles: [], refresh: args.refreshBaseline });
}

/**
 * Order sweep targets by what a test on each would be worth: uncovered lines
 * weighted by the branch density of the uncovered text, by churn, and by how
 * many other files import it. The default, because size alone points at
 * declaration-heavy files where a generated test proves nothing. Formula and
 * weights live in `src/value.ts`.
 */
export async function orderTargetsByValue(args: OrderArgs): Promise<string[]> {
  const { repo, targets, log } = args;
  const baseline = await orderingBaseline(args);
  const rows = await rankByValue({ repo, baseline, targets });
  log.info(
    { repo: repo.name, top: rows.slice(0, 5).map((r) => `${r.path} (score ${r.score}, ${r.uncovered} uncovered)`) },
    "targets ordered by value",
  );
  return rows.map((r) => r.path);
}

/**
 * Order sweep targets by the size of the hole in each, biggest first.
 *
 * Glob order is alphabetical, which is arbitrary with respect to value: a
 * limited sweep spent itself inside one directory while the four largest gaps
 * in the repo were never considered.
 */
export async function orderTargetsByGap(args: OrderArgs): Promise<string[]> {
  const { repo, targets, log } = args;
  const baseline = await orderingBaseline(args);
  const ranked = targets.map((path) => ({ path, uncovered: uncoveredCount(baseline, path) }));
  ranked.sort((a, b) => b.uncovered - a.uncovered || a.path.localeCompare(b.path));
  log.info(
    { repo: repo.name, top: ranked.slice(0, 5).map((r) => `${r.path} (${r.uncovered})`) },
    "targets ordered by uncovered lines",
  );
  return ranked.map((r) => r.path);
}

export async function runPipeline(args: PipelineArgs): Promise<RunSummary> {
  const { config, repo, targets, dryRun, log } = args;
  const fast = args.fast ?? false;
  const started = Date.now();

  const runner = getRunner(repo.runner);
  await preflightRepo({ config, repo, runner, log });
  for (const warning of (await runner.warnings?.(repo)) ?? []) log.warn({ repo: repo.name }, warning);

  const exists = (rel: string): boolean => existsSync(resolve(repo.cwd, rel));

  // Resolve the spec file each target will be written into, once.
  const specFor = new Map<string, string>();
  const nearestFor = new Map<string, string>();
  for (const target of targets) {
    const nearest = await findNearestSpec(repo, target, exists);
    if (nearest) nearestFor.set(target, nearest);
    specFor.set(target, nearest ?? repo.specPath(target));
  }
  const originalSpecs = await snapshotSpecs(repo.cwd, specFor.values());

  const baselineFiles = fast
    ? [...new Set([...specFor.values()].filter((spec) => exists(spec)))]
    : [];
  if (fast && baselineFiles.length === 0) {
    log.warn({ repo: repo.name }, "fast mode requested but no target has an existing spec, running the whole suite");
  }

  const baseline = await loadBaseline({ config, repo, runner, log, fast, baselineFiles, refresh: args.refreshBaseline });
  // Read now, because markCovered writes every accepted candidate's lines back
  // into this same map: by the end of the run it is the "after" picture. A fast
  // run measured one spec rather than the repo, so it has no repo figure to
  // report and says nothing rather than something wrong by two orders.
  const coverageBefore = fast ? undefined : scopeCoverage(repo, baseline);

  const state = await loadState(repo, config.state_dir);
  const skip = skipSet(state);

  const idiomPack = await loadIdiomPack(repo.idiomPackPath);
  const rules = rulesText(repo.runner, repo.disableRules);
  const backend = generatorBackend(config, repo);
  const subscription = backend === "claude-code";
  if (subscription) {
    const who = await preflightClaudeCode(
      claudeExec(config.claude_code.binary, tmpdir(), config.claude_code.timeout_ms),
    );
    log.info({ repo: repo.name, auth: who }, "generator claude-code, billed to the subscription");
  }
  const generator = subscription
    ? createClaudeCodeGenerator({
        binary: config.claude_code.binary,
        model: config.anthropic.generator_model,
        timeoutMs: config.claude_code.timeout_ms,
        maxTokensPerSweep: config.claude_code.max_tokens_per_sweep,
      })
    : createGenerator({
        model: config.anthropic.generator_model,
        maxTokens: config.anthropic.max_tokens,
        apiKey: args.apiKey,
      });
  // Repair rounds continue the same chat but may run on a cheaper model. Not on
  // the subscription backend: a repair resumes the generating session and only
  // that instance holds the session id, so one instance does both.
  const repairer =
    subscription || config.anthropic.repair_model === config.anthropic.generator_model
      ? generator
      : createGenerator({
          model: config.anthropic.repair_model,
          maxTokens: config.anthropic.max_tokens,
          apiKey: args.apiKey,
        });

  /** Tokens this run has charged so far, across both models it may use. */
  const spentHere = (): number =>
    totalTokens(readUsage(generator)) + (repairer === generator ? 0 : totalTokens(readUsage(repairer)));

  const candidates: Candidate[] = [];
  /** Which run-wide ceiling stopped this run early, if any. */
  let limitHit: RunSummary["limitHit"];
  /** Spec files an accepted whole-file candidate wrote to disk this run. */
  const createdByRun = new Set<string>();
  /** Directories those writes had to create, for dry-run cleanup. */
  const createdDirs: string[] = [];
  /** Spec files that may need restoring if this run does not commit its changes. */
  const touchedSpecs = new Set<string>();
  /** Spec files already holding an accepted test. Cleanup never takes these back. */
  const persistedSpecs = new Set<string>();
  let keepSpecChanges = false;

  // The journal is what survives a kill: it names the specs this run has already
  // written, so what is in the checkout afterwards can be explained without
  // guessing. A dry run writes no spec file and so has nothing to journal.
  const stateDir = stateDirFor(config, repo);
  const journal = newJournal(repo.name, journalId());
  journal.baseSha = args.baseSha;
  const journalFile = dryRun ? undefined : journalPath(stateDir, journal.id);
  /** True once the journal has been given an outcome, so a crash cannot overwrite one. */
  let journalClosed = false;
  const noteJournal = async (status: JournalStatus = "running", reason?: string): Promise<void> => {
    if (!journalFile) return;
    journal.status = status;
    if (status !== "running") journalClosed = true;
    journal.tokens = spentHere();
    if (reason) journal.reason = reason;
    // A journal that cannot be written must not fail a run that is otherwise fine.
    await writeJournal(journalFile, journal).catch((err) =>
      log.warn({ journalFile, err: String(err) }, "could not write the run journal"),
    );
  };
  /** last-run.md and the candidate files: the record of what this run did, however it ended. */
  const writeRunReport = async (body: string): Promise<void> => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "last-run.md"), body, "utf8");
    await writeCandidateFiles(join(stateDir, "candidates"), candidates);
  };
  const watch = args.abort ?? watchForAbort();

  try {
    for (const target of targets) {
      if (watch.aborted()) break;
      // Between targets, never mid-candidate: the ceiling stops new work, it does
      // not throw away a candidate that has already been paid for.
      const stop = ceilingHit(args.limits, spentHere());
      if (stop) {
        limitHit = stop;
        if (args.limits) args.limits.hit = stop;
        log.warn({ repo: repo.name, ceiling: stop, remaining: targets.length - targets.indexOf(target) }, "run-wide ceiling reached, skipping the remaining targets");
        break;
      }
      const specPath = specFor.get(target) ?? repo.specPath(target);
      let source: string;
      try {
        source = await readFile(resolve(repo.cwd, target), "utf8");
      } catch (err) {
        log.warn({ target, err: String(err) }, "skipping target, source unreadable");
        continue;
      }

      // segments.max_per_file bounds how many candidates one source file gets,
      // not how many lines they add to its spec. A spec that has already reached
      // the per-file ceiling waits for the next run rather than growing past what
      // a reviewer will read in one sitting.
      const perFileCap = config.sweep?.pr_max_lines_per_file ?? 0;
      const specLinesBefore = await specFileLines(repo.cwd, specPath);
      if (specFileFull(specLinesBefore, perFileCap)) {
        log.info({ target, spec: specPath, lines: specLinesBefore, max: perFileCap }, "spec is at the per-file ceiling, leaving it for the next run");
        continue;
      }

      const segments = buildSegments({
        path: target,
        source,
        coverage: baseline.get(target),
        maxLines: config.segments.max_lines,
        maxPerFile: config.segments.max_per_file,
      });
      if (segments.length === 0) {
        log.info({ target }, "no uncovered segments, skipping");
        continue;
      }
      log.info({ target, segments: segments.length, spec: specPath }, "target prepared");

      const nearestSpecPath = nearestFor.get(target);
      const nearestSpecText = nearestSpecPath ? await readFile(resolve(repo.cwd, nearestSpecPath), "utf8") : undefined;
      // No spec on disk means the model has to produce a complete new file.
      const wholeFile = !exists(specPath);

      // Loss is judged against what this spec alone covers, not the whole suite.
      // In fast mode the suite baseline already is the spec-alone run; snapshot it,
      // because markCovered mutates `baseline` as candidates are accepted and lines
      // one accepted candidate adds must not count as lost for the next one.
      let specBaseline: CoverageMap = new Map();
      if (fast) {
        specBaseline = mergeCoverage(baseline, new Map());
      } else if (!wholeFile) {
        const specRun = await runner.run(repo, {
          files: [specPath],
          coverage: true,
          timeoutMs: config.gate.timeout_ms,
          env: { COVERGEN_SOURCE: target },
        });
        if (specRun.lcovPath) {
          specBaseline = await readLcov(specRun.lcovPath, { cwd: repo.cwd });
          await discardCoverageDir(specRun.lcovPath);
        } else {
          log.warn({ target, spec: specPath }, "spec-alone baseline produced no lcov; loss check will use the suite baseline");
          specBaseline = baseline;
        }
      }

      // Generation is pure latency: fan out across the segments of this one file.
      const generateFor = async (
        segs: Segment[],
        asWholeFile: boolean,
        specHintPath?: string,
        specHintText?: string,
      ): Promise<Candidate[]> => {
        const out = await mapLimit(
          segs,
          subscription ? config.claude_code.concurrency : 0,
          async (segment) => {
            const blocks = buildPromptBlocks({
              idiomPack,
              rulesText: rules,
              sourcePath: target,
              sourceText: source,
              nearestSpecPath: specHintPath,
              nearestSpecText: specHintText,
              segment,
              runner: repo.runner,
              specPath,
              wholeFile: asWholeFile,
            });
            try {
              return await generator.generate(blocks, segment, specPath, asWholeFile);
            } catch (err) {
              log.warn({ target, segment: segment.startLine, err: String(err) }, "generation failed");
              return undefined;
            }
          },
        );
        return out.filter((c): c is Candidate => Boolean(c));
      };

      const fresh = dedupeCandidates(await generateFor(segments, wholeFile, nearestSpecPath, nearestSpecText));

      // A whole-file candidate that lands rewrites the plan for the segments after
      // it: the spec now exists, so they are regenerated as appendable blocks.
      const queue = [...fresh];
      for (let i = 0; i < queue.length; i += 1) {
        // A signal stops the run between candidates, where nothing is half done:
        // the one in flight was already rolled back by the signal handler.
        if (watch.aborted()) break;
        const candidate = queue[i] as Candidate;
        if (candidate.wholeFile && createdByRun.has(candidate.specPath)) {
          candidate.status = "frozen";
          candidate.lastError = "spec file created by an earlier candidate this run; rerun to extend it with blocks";
          candidates.push(candidate);
          log.info({ spec: candidate.specPath, hash: candidate.hash.slice(0, 12), status: "frozen" }, "candidate skipped");
          continue;
        }
        if (skip.has(candidate.hash)) {
          candidate.status = "frozen";
          candidate.lastError = "hash seen in a previous run (frozen or already accepted)";
          candidates.push(candidate);
          log.info({ spec: candidate.specPath, hash: candidate.hash.slice(0, 12), status: "frozen" }, "candidate skipped");
          continue;
        }
        skip.add(candidate.hash);

        // Sequential: the gate mutates the repo working tree. Rules run here so
        // repaired candidates cannot bypass the same checks as initial output.
        const gate = async (c: Candidate): Promise<GateResult> => {
          const violations = ruleViolations(c.code, repo.runner, repo.disableRules);
          const verdict = verdictFor(violations);
          if (verdict) {
            return { status: verdict, runs: [], error: violations.map((v) => `${v.id}: ${v.message}`).join("; ") };
          }
          return evaluate({
            repo,
            runner,
            candidate: c,
            baseline,
            specBaseline,
            sourceRel: target,
            opts: { k: config.gate.k, timeoutMs: config.gate.timeout_ms },
            mutation: {
              enabled: config.mutation.enabled,
              maxMutants: config.mutation.max_mutants,
              minKilled: config.mutation.min_killed,
              minKilledRatio: config.mutation.min_killed_ratio,
              allowNoMutants: repo.allowNoMutants,
              timeoutMs: config.mutation.timeout_ms,
            },
          });
        };

        // Everything the gate is about to change, so a signal can put it back
        // synchronously: the spec it splices into and the source it mutates for
        // the spot-check. Cleared once the candidate is decided and persisted.
        const absSpec = resolve(repo.cwd, candidate.specPath);
        watch.guard([
          { path: absSpec, original: existsSync(absSpec) ? await readFile(absSpec, "utf8") : undefined },
          { path: resolve(repo.cwd, target), original: source },
        ]);

        let result = await gate(candidate);
        let finalCandidate = candidate;

        if (result.status !== "accepted" && result.status !== "rule_violation" && config.gate.max_repair_rounds > 0) {
          const repaired = await repairLoop({
            candidate,
            gateResult: result,
            generator: repairer,
            evaluate: gate,
            maxRounds: config.gate.max_repair_rounds,
          });
          finalCandidate = repaired.candidate;
          result = repaired.result;
        }

        finalCandidate.status = result.status;
        finalCandidate.delta = result.delta;
        finalCandidate.mutation = result.mutation;
        // An accepted candidate carries no error, even if earlier rounds failed.
        finalCandidate.lastError = result.status === "accepted" ? undefined : (result.error ?? finalCandidate.lastError);
        candidates.push(finalCandidate);

        if (result.status === "accepted") {
          // Later candidates must cover something beyond what this one already
          // covers, otherwise two tests for the same lines both look like gains.
          markCovered(baseline, target, result.delta?.newlyCovered ?? []);
          const spec = finalCandidate.specPath;
          touchedSpecs.add(spec);

          if (finalCandidate.wholeFile) {
            if (!createdByRun.has(spec)) {
              const dirs = await writeCreatedSpec(repo.cwd, spec, finalCandidate.code);
              createdByRun.add(spec);
              createdDirs.push(...dirs);
              log.info({ spec }, "spec file created on disk for the remaining segments");

              // Everything still queued for this spec was written as a whole file
              // against a spec that no longer needs one. Those candidates were never
              // gated, so drop them and ask for appendable blocks instead.
              const rest = queue.slice(i + 1);
              const stale = rest.filter((c) => c.wholeFile && c.specPath === spec);
              const keep = rest.filter((c) => !(c.wholeFile && c.specPath === spec));
              const regenerated =
                stale.length > 0 ? await generateFor(stale.map((c) => c.segment), false, spec, finalCandidate.code) : [];
              queue.length = i + 1;
              queue.push(...keep, ...regenerated);
            }
          } else {
            // Written here rather than in one batch at the end of the run: a test
            // that has passed the gate is worth keeping even if the process never
            // reaches the end, and cleanup no longer takes it back.
            const emitted = await applyAccepted(repo, [finalCandidate]);
            if (emitted.skipped.length > 0) {
              throw new Error(`could not emit ${spec}: ${emitted.skipped.map((s) => s.reason).join("; ")}`);
            }
            log.info({ spec }, "accepted test written");
          }
          if (!dryRun) persistedSpecs.add(spec);
          // The block that just landed may have taken the spec over the ceiling.
          // Everything still queued for it is dropped rather than gated: those
          // segments are the next run's work, and the file stays reviewable.
          if (!dryRun && specFileFull(await specFileLines(repo.cwd, spec), perFileCap)) {
            const rest = queue.slice(i + 1).filter((c) => c.specPath !== spec);
            if (rest.length < queue.length - i - 1) {
              log.info({ spec, max: perFileCap, dropped: queue.length - i - 1 - rest.length }, "spec reached the per-file ceiling, leaving its remaining segments for the next run");
            }
            queue.length = i + 1;
            queue.push(...rest);
          }
          journal.accepted.push({
            spec,
            hash: finalCandidate.hash,
            // The file as this test left it, so a later `pr --from` can tell the
            // run's own output from something edited after it.
            specHash: journalFile ? await specFileHash(repo.cwd, spec) : undefined,
            source: target,
            symbol: finalCandidate.segment.symbol,
            newlyCovered: result.delta?.newlyCovered.length ?? 0,
          });
        }

        watch.guard([]);
        await noteJournal();

        log.info(
          {
            spec: finalCandidate.specPath,
            hash: finalCandidate.hash.slice(0, 12),
            status: finalCandidate.status,
            attempts: finalCandidate.attempts,
            newlyCovered: result.delta?.newlyCovered.length ?? 0,
            mutantsKilled: `${result.mutation?.killed ?? 0}/${result.mutation?.tried ?? 0}`,
            reason: finalCandidate.lastError,
          },
          "candidate gated",
        );
      }
    }

    const aborted = watch.signal();
    /** Set when the accepted specs pass alone but fail together. */
    let verifyFailure: Error | undefined;
    const accepted = candidates.filter((c) => c.status === "accepted");
    // Generator and repairer can be different models, so price them separately
    // and only then add the dollars up.
    const perModel = [{ model: config.anthropic.generator_model, tokens: readUsage(generator) }];
    if (repairer !== generator) perModel.push({ model: config.anthropic.repair_model, tokens: readUsage(repairer) });
    const summary: RunSummary = {
      repo: repo.name,
      targets,
      candidates,
      accepted,
      tokens: perModel.reduce<RunSummary["tokens"]>((acc, m) => sumUsage(acc, m.tokens), { ...emptyTokens }),
      backend,
      limitHit,
      aborted,
      journal: journalFile,
      // A subscription run has no dollar meter, so it reports tokens and nothing else.
      cost: subscription ? undefined : runCost(perModel, priceTable(config)),
      coverage: coverageBefore ? { before: coverageBefore, after: scopeCoverage(repo, baseline) } : undefined,
      durationMs: 0,
    };
    if (args.limits) args.limits.spent += totalTokens(summary.tokens);

    // Every accepted test is already in its spec file, written as it was accepted.
    // What is left is proving they still pass together, which an aborted run skips:
    // the specs are staying on disk either way and the process is on its way out.
    if (aborted) {
      log.warn(
        { repo: repo.name, signal: aborted, accepted: accepted.length },
        "run aborted, keeping the accepted specs and skipping the combined verification",
      );
    } else {
      try {
        await verifyAcceptedOutput(repo, runner, [...new Set(accepted.map((c) => c.specPath))], {
          k: config.gate.k,
          timeoutMs: config.gate.baseline_timeout_ms,
        });
      } catch (err) {
        verifyFailure = err instanceof Error ? err : new Error(String(err));
      }
    }
    summary.durationMs = Date.now() - started;
    if (dryRun) log.info({ accepted: accepted.length }, "dry run, verified combined specs without keeping them");

    // Each accepted test passed the gate alone and they do not pass together, so
    // the run has no output worth keeping. Everything it wrote comes back out and
    // the checkout is left as it was found. State is deliberately not saved:
    // recording these hashes as accepted would stop them being generated again.
    if (verifyFailure) {
      persistedSpecs.clear();
      await writeRunReport(`${prBody(summary)}${revertedNote(verifyFailure.message)}`);
      await noteJournal("reverted", verifyFailure.message);
      log.error(
        { repo: repo.name, specs: touchedSpecs.size, err: verifyFailure.message },
        "combined verification failed, rolling back every spec this run wrote",
      );
      throw new RunFailed(verifyFailure.message, summary);
    }

    const nextState = recordRun(state, summary, {
      frozen: freezableHashes(candidates),
      dryRun,
    });
    await saveState(repo, nextState, config.state_dir);
    keepSpecChanges = !dryRun;

    // The report is written on an aborted run too: saying what was accepted is
    // the point of keeping the specs.
    await writeRunReport(prBody(summary));
    await noteJournal(aborted ? "aborted" : "finished");

    return summary;
  } catch (err) {
    // A crash leaves the accepted specs on disk exactly as a signal does, and a
    // journal still reading `running` describes a run that is still going. Say
    // aborted with the reason, so the morning report is honest and `pr --from`
    // has something it is allowed to finish. A journal that already has an
    // outcome keeps it: a reverted run threw on purpose and kept nothing.
    if (!journalClosed) await noteJournal("aborted", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    watch.release();
    // Only what never became an accepted test is rolled back. A dry run persists
    // nothing, and a failed verification unpersists everything, so for those two
    // this is still every spec the run touched.
    const revert = [...touchedSpecs].filter((spec) => !persistedSpecs.has(spec));
    if (!keepSpecChanges && revert.length > 0) await restoreSpecs(repo.cwd, originalSpecs, revert, createdDirs, log);
  }
}
