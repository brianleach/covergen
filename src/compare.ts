/**
 * Comparison eval: the same targets through the same pipeline once per
 * generator backend, one table out.
 *
 * Every run is a dry run, which is the pipeline's own isolation: accepted specs
 * are verified and then rolled back, so the next generator starts from the tree
 * the first one found. That is checked rather than assumed: the target's git
 * status is read before the first run and after each one, and any difference
 * outside the state directory stops the eval. Runs also leave state.json alone,
 * so one generator's frozen hashes cannot skip another's candidates.
 */

import type { Generator } from "./generate.js";
import { runGit, type GitExec } from "./git.js";
import { RunFailed } from "./pipeline.js";
import { formatUsd } from "./cost.js";
import type { CandidateStatus, GeneratorBackend, RunSummary } from "./types.js";

/** Written before any fine-tune ran, and printed at the top of every report. */
export const WIN_CRITERION =
  "The local model wins if its acceptance rate is within 5 percentage points of the Claude path's on the same targets, or better, at zero API cost. " +
  "A miss is recorded with a diagnosis (data mix, context window, base model), not treated as a stop.";

/** Rejected before anything ran: these never reached a build. */
const NOT_BUILT: CandidateStatus[] = ["build_failed", "rule_violation", "tautological", "declaration_snapshot", "os_specific", "frozen", "generated"];
/** Built but did not pass k times. */
const NOT_PASSED: CandidateStatus[] = [...NOT_BUILT, "test_failed", "flaky"];

export interface CompareRow {
  generator: GeneratorBackend;
  /** generate() calls, including the ones whose reply could not be used. */
  generated: number;
  /** generate() calls that threw: no reply, an empty one, or no single code block. */
  generationErrors: number;
  built: number;
  passed: number;
  accepted: number;
  newlyCovered: number;
  /** accepted / generated, 0 when nothing was generated. */
  acceptanceRate: number;
  linesPerCandidate: number;
  durationMs: number;
  /** Dollars, or undefined when the backend has no meter (a subscription). */
  costUsd?: number;
  /** Set when the run itself failed; the counts are what it decided before that. */
  error?: string;
}

export interface CallCounts {
  calls: number;
  errors: number;
}

/** Count generate() calls and failures without changing what they return. */
export function countingGenerator(inner: Generator, counts: CallCounts): Generator {
  return {
    async generate(...args) {
      counts.calls += 1;
      try {
        return await inner.generate(...args);
      } catch (err) {
        counts.errors += 1;
        throw err;
      }
    },
    continueChat: (...args) => inner.continueChat(...args),
    usage: () => inner.usage(),
  };
}

export function compareRow(generator: GeneratorBackend, summary: RunSummary, counts: CallCounts, error?: string): CompareRow {
  const statuses = summary.candidates.map((c) => c.status);
  const accepted = summary.accepted.length;
  const newlyCovered = summary.accepted.reduce((n, c) => n + (c.delta?.newlyCovered.length ?? 0), 0);
  const generated = counts.calls;
  return {
    generator,
    generated,
    generationErrors: counts.errors,
    built: statuses.filter((s) => !NOT_BUILT.includes(s)).length,
    passed: statuses.filter((s) => !NOT_PASSED.includes(s)).length,
    accepted,
    newlyCovered,
    acceptanceRate: generated > 0 ? accepted / generated : 0,
    linesPerCandidate: generated > 0 ? newlyCovered / generated : 0,
    durationMs: summary.durationMs,
    costUsd: summary.cost?.usd,
    ...(error ? { error } : {}),
  };
}

export interface CompareArgs {
  generators: GeneratorBackend[];
  /** One dry pipeline run for `generator`, its generator wrapped by `wrap`. */
  runOne: (generator: GeneratorBackend, wrap: (g: Generator) => Generator) => Promise<RunSummary>;
  /** The target's working tree as text (git status), state directory excluded. */
  treeState: () => Promise<string>;
}

export async function runComparison(args: CompareArgs): Promise<CompareRow[]> {
  const before = await args.treeState();
  const rows: CompareRow[] = [];
  for (const generator of args.generators) {
    const counts: CallCounts = { calls: 0, errors: 0 };
    try {
      const summary = await args.runOne(generator, (g) => countingGenerator(g, counts));
      rows.push(compareRow(generator, summary, counts));
    } catch (err) {
      // A run that failed after gating still decided every candidate it saw.
      if (!(err instanceof RunFailed)) throw err;
      rows.push(compareRow(generator, err.summary, counts, err.message));
    }
    const after = await args.treeState();
    if (after !== before) {
      throw new Error(
        `the ${generator} run left the working tree changed, so the next run would not start from the same tree. git status before:\n${before || "(clean)"}\nafter:\n${after || "(clean)"}`,
      );
    }
  }
  return rows;
}

/**
 * `git status --porcelain` under `root`, untracked files listed one by one, with
 * the state directory (relative to `root`) excluded by pathspec: the runs write
 * their reports there by design.
 */
export async function gitTreeState(root: string, stateDir: string, exec: GitExec = runGit): Promise<string> {
  const args = ["status", "--porcelain", "--untracked-files=all", "--", ".", `:(exclude)${stateDir}`];
  const res = await exec(args, root);
  if (res.exitCode !== 0) throw new Error(`git status failed in ${root}: ${res.stderr.trim()}`);
  return res.stdout.trimEnd();
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** True for the backends that call Claude, the reference the local model is judged against. */
const isClaude = (g: GeneratorBackend): boolean => g === "api" || g === "claude-code";

/** The verdict line, when the rows hold both a Claude run and a local run. */
export function verdict(rows: CompareRow[]): string | undefined {
  const claude = rows.find((r) => isClaude(r.generator));
  const local = rows.find((r) => r.generator === "openai-compatible");
  if (!claude || !local) return undefined;
  const gap = (claude.acceptanceRate - local.acceptanceRate) * 100;
  const free = (local.costUsd ?? 0) === 0;
  if (gap <= 5 && free) {
    return `Verdict: win. Local acceptance ${pct(local.acceptanceRate)} against ${pct(claude.acceptanceRate)} on the Claude path, at zero API cost.`;
  }
  return `Verdict: miss. Local acceptance ${pct(local.acceptanceRate)} against ${pct(claude.acceptanceRate)} on the Claude path (${gap.toFixed(1)} points behind). Record a diagnosis: data mix, context window, or base model.`;
}

export interface ReportMeta {
  repo: string;
  targets: string[];
  seed?: number;
}

export function compareReport(meta: ReportMeta, rows: CompareRow[]): string {
  const out = [
    `# covergen compare: ${meta.repo}`,
    "",
    `Win criterion: ${WIN_CRITERION}`,
    "",
    `Targets (${meta.targets.length}, same list and order for every generator): ${meta.targets.join(", ")}`,
    `Seed: ${meta.seed ?? "none"} (sent to the openai-compatible backend only; the Claude backends take none)`,
    "",
    "| generator | generated | gen errors | built | passed | accepted | acceptance | lines/candidate | wall time | API cost |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const cost = r.costUsd === undefined ? "n/a (subscription)" : formatUsd(r.costUsd);
    out.push(
      `| ${r.generator} | ${r.generated} | ${r.generationErrors} | ${r.built} | ${r.passed} | ${r.accepted} | ${pct(r.acceptanceRate)} | ${r.linesPerCandidate.toFixed(2)} | ${(r.durationMs / 1000).toFixed(1)}s | ${cost} |`,
    );
  }
  for (const r of rows.filter((x) => x.error)) out.push("", `${r.generator} run failed: ${r.error}`);
  const line = verdict(rows);
  if (line) out.push("", line);
  out.push(
    "",
    "Acceptance is accepted over generated. Built excludes candidates rejected before a build (static rules, build failures, frozen). Passed means pass^k held. Wall time includes the baseline, which a later run may read from cache.",
  );
  return `${out.join("\n")}\n`;
}
