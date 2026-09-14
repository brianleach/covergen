/**
 * The unattended multi-repo sweep: every repo in covergen.yaml, in config order,
 * under one pair of run-wide ceilings, with a draft PR per repo that accepted a
 * test and a JSON report of the whole run.
 *
 * A per-repo failure is logged and skipped, never fatal: an overnight run that
 * dies on the third of seven repos is worse than one that reports four PRs and
 * three reasons.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "./config.js";
import { mutationScore, prBody, prTitle, specQuality, type MutationScore, type SpecQuality } from "./emit.js";
import { changedFiles, listSources, matchesSources, toCwdRelative } from "./git.js";
import { ceilingHit, limitNote, totalTokens, type RunLimits } from "./limits.js";
import type { Logger } from "./logger.js";
import { orderTargetsByGap, orderTargetsByValue, runPipeline } from "./pipeline.js";
import { dirtyPaths, openDraftPr } from "./pr.js";
import type { RepoConfig, RunSummary } from "./types.js";

export interface TargetArgs {
  config: Config;
  repo: RepoConfig;
  log: Logger;
  changedSince?: string;
  /** "value" (branch-weighted, the default), "gap" (most uncovered lines first) or "glob". */
  order: string;
  limit: number;
  refreshBaseline?: boolean;
}

/** The sweep target list for one repo, ordered and capped. Shared by --repo and --all. */
export async function sweepTargets(args: TargetArgs): Promise<string[]> {
  const { config, repo, log, order, limit } = args;
  if (order !== "value" && order !== "gap" && order !== "glob") {
    throw new Error(`Unknown --order "${order}". Use value, gap or glob.`);
  }
  let targets: string[];
  if (args.changedSince) {
    const changed = await changedFiles(repo.root, args.changedSince);
    targets = toCwdRelative(repo, changed).filter((rel) => matchesSources(repo, rel));
  } else {
    targets = await listSources(repo);
  }
  if (targets.length === 0) return [];
  // Order before the cap, or the cap decides which files matter by filename.
  if (order !== "glob" && targets.length > 1) {
    const rank = order === "value" ? orderTargetsByValue : orderTargetsByGap;
    targets = await rank({ config, repo, targets, log, refreshBaseline: args.refreshBaseline });
  }
  if (targets.length > limit) {
    log.info({ repo: repo.name, matched: targets.length, limit }, "capping targets at the limit");
    targets = targets.slice(0, limit);
  }
  return targets;
}

export interface RepoReport {
  repo: string;
  status: "ran" | "skipped" | "failed";
  targetsAttempted: number;
  accepted: number;
  /** Rejected candidate counts, keyed by candidate status. */
  rejected: Record<string, number>;
  tokens: number;
  durationMs: number;
  prUrl?: string;
  /** Why nothing ran, or why no PR was opened. */
  reason?: string;
  /** The signal that stopped this repo's run, when one did. */
  aborted?: string;
  /** Journal path, which names the accepted specs an aborted run left in the checkout. */
  journal?: string;
  /**
   * Mutants killed over mutants tried by the accepted tests. This is the quality
   * number the coverage ledger reads: `repos[].mutation.score`.
   */
  mutation: MutationScore;
  /** One line per accepted test: what it covers, what it killed, what it asserts. */
  acceptedSpecs: SpecQuality[];
}

export interface SweepReport {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  dryRun: boolean;
  tokens: number;
  /** The run-wide mutation score, summed over every repo. Read as `mutation.score`. */
  mutation: MutationScore;
  ceilingHit?: string;
  /** Set when a signal stopped the sweep. The repos after that one never started. */
  abortedBy?: string;
  repos: RepoReport[];
}

export interface SweepAllArgs extends Omit<TargetArgs, "repo"> {
  apiKey?: string;
  dryRun: boolean;
  /** Open a draft PR per repo that accepted a test. */
  pr: boolean;
  limits: RunLimits;
  /** Injected in tests so the loop can be exercised without a model or a runner. */
  runOne?: typeof runPipeline;
  openPr?: typeof openDraftPr;
  dirty?: typeof dirtyPaths;
}

function countRejected(summary: RunSummary): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of summary.candidates) if (c.status !== "accepted") out[c.status] = (out[c.status] ?? 0) + 1;
  return out;
}

/** The report fields one finished pipeline run contributes. Shared by `sweep` and `run --report`. */
export function runFields(summary: RunSummary): Pick<RepoReport, "accepted" | "rejected" | "mutation" | "acceptedSpecs"> {
  return {
    accepted: summary.accepted.length,
    rejected: countRejected(summary),
    mutation: mutationScore(summary.accepted),
    acceptedSpecs: specQuality(summary.accepted),
  };
}

/** Every repo's mutation score added up, for the run-wide figure. */
export function totalMutation(repos: RepoReport[]): MutationScore {
  const killed = repos.reduce((sum, r) => sum + r.mutation.killed, 0);
  const tried = repos.reduce((sum, r) => sum + r.mutation.tried, 0);
  return { killed, tried, score: tried === 0 ? null : Number((killed / tried).toFixed(3)) };
}

/** Run every sweepable repo in config order under one set of ceilings. */
export async function sweepAll(args: SweepAllArgs): Promise<SweepReport> {
  const { config, log, limits } = args;
  const runOne = args.runOne ?? runPipeline;
  const openPr = args.openPr ?? openDraftPr;
  const dirty = args.dirty ?? dirtyPaths;
  const started = Date.now();
  const repos: RepoReport[] = [];
  /** The signal that stopped a repo's run, which stops the sweep with it. */
  let abortedBy: string | undefined;

  for (const repo of config.repos) {
    // A killed run ends the sweep: the process is going away, and starting the
    // next repo would only buy work it cannot finish.
    if (abortedBy) break;
    const repoStarted = Date.now();
    const add = (report: Omit<RepoReport, "durationMs">): void => {
      repos.push({ ...report, durationMs: Date.now() - repoStarted });
    };
    const empty = {
      repo: repo.name,
      targetsAttempted: 0,
      accepted: 0,
      rejected: {},
      tokens: 0,
      mutation: { killed: 0, tried: 0, score: null },
      acceptedSpecs: [],
    };

    if (repo.sweep === false) {
      add({ ...empty, status: "skipped", reason: "sweep: false in covergen.yaml" });
      continue;
    }
    const stop = ceilingHit(limits);
    if (stop) {
      limits.hit = stop;
      add({ ...empty, status: "skipped", reason: `run-wide ${stop} ceiling reached` });
      continue;
    }

    try {
      // Before the run, not after: the commit names the paths covergen wrote, so
      // anything already modified would either be swept into the PR or block it.
      if (args.pr && !args.dryRun) {
        const already = await dirty(repo.root, [config.state_dir]);
        if (already.length > 0) {
          add({
            ...empty,
            status: "skipped",
            reason: `checkout is dirty (${already.slice(0, 5).join(", ")}${already.length > 5 ? ", ..." : ""}), commit or stash before an unattended run`,
          });
          continue;
        }
      }

      const targets = await sweepTargets({ ...args, repo });
      if (targets.length === 0) {
        add({ ...empty, status: "skipped", reason: "no source files matched" });
        continue;
      }

      const summary = await runOne({
        config,
        repo,
        targets,
        dryRun: args.dryRun,
        fast: false,
        log,
        apiKey: args.apiKey,
        refreshBaseline: args.refreshBaseline,
        limits,
      });
      abortedBy = summary.aborted;
      const base = {
        repo: repo.name,
        targetsAttempted: targets.length,
        tokens: totalTokens(summary.tokens),
        aborted: summary.aborted,
        journal: summary.journal,
        ...runFields(summary),
      };

      if (!args.pr || summary.accepted.length === 0) {
        add({ ...base, status: "ran", reason: args.pr ? "no test accepted, nothing to open a PR with" : undefined });
        continue;
      }
      if (args.dryRun) {
        // A dry run writes no spec file, so there is nothing to commit and --pr
        // has nothing to do. Saying so beats printing a PR that does not exist.
        add({ ...base, status: "ran", reason: "--dry-run writes no files, so --pr opened nothing" });
        continue;
      }

      const url = await openPr({
        repo,
        files: [...new Set(summary.accepted.map((c) => c.specPath))],
        title: prTitle(summary),
        body: prBody(summary),
      });
      log.info({ repo: repo.name, url }, "draft PR opened");
      add({ ...base, status: "ran", prUrl: url });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error({ repo: repo.name, err: reason }, "repo failed, continuing with the next one");
      add({ ...empty, status: "failed", reason });
    }
  }

  const ended = Date.now();
  return {
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    dryRun: args.dryRun,
    tokens: repos.reduce((sum, r) => sum + r.tokens, 0),
    mutation: totalMutation(repos),
    ceilingHit: limits.hit,
    abortedBy,
    repos,
  };
}

/** One line per repo, plus the ceiling note when a ceiling stopped the run. */
export function reportLines(report: SweepReport): string {
  const n = report.repos.length;
  const out = [`covergen sweep --all: ${n} ${n === 1 ? "repo" : "repos"} in ${(report.durationMs / 1000).toFixed(1)}s`];
  for (const r of report.repos) {
    const rejected = Object.entries(r.rejected).map(([status, count]) => `${count} ${status}`).join(", ");
    const detail = r.prUrl ?? r.reason ?? rejected;
    out.push(
      `  ${r.status.padEnd(7)} ${r.repo}: ${r.accepted}/${r.targetsAttempted} accepted, ` +
        `${r.tokens.toLocaleString("en-US")} tokens${detail ? `, ${detail}` : ""}`,
    );
  }
  const score = report.mutation;
  if (score.tried > 0) {
    out.push(`  mutants killed ${score.killed}/${score.tried} (${((score.killed / score.tried) * 100).toFixed(0)}%)`);
  }
  const note = limitNote(report.ceilingHit as "tokens" | "minutes" | undefined);
  if (note) out.push(note);
  return `${out.join("\n")}\n`;
}

export async function writeReport(path: string, report: SweepReport): Promise<void> {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
