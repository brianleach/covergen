/**
 * covergen audit --pr: the half of the audit that proposes a deletion.
 *
 * The audit names cases that run code without checking it. This turns the ones
 * that are safe to lose into a draft PR and leaves the decision to whoever
 * reads it. Two rules bound what "safe to lose" means, and neither has an
 * override:
 *
 *  - a case that catches even one planted bug is never proposed, whatever its
 *    coverage. It checks something, and this command is not the judge of
 *    whether the thing it checks is worth checking.
 *  - a case that is the only coverage of any line is never proposed, whatever
 *    it asserts. Cutting it would lose coverage, so the PR lists it as a case
 *    to repair rather than delete.
 *
 * What is left is a case that catches nothing and covers nothing of its own:
 * `redundant`, or `weak_static` and `weak_dynamic` together. The cut is
 * textual, at the block the case opens, and the whole suite then runs again
 * with coverage. Unless it passes with the same lines covered, every file is
 * put back and the run reports `reverted`. The restore is in a finally, the way
 * the gate restores a spliced spec, so a killed run cannot leave a suite short
 * of a test.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { stateDirFor, type Config } from "./config.js";
import { journalId, journalPath, newJournal, writeJournal, type RemovalEntry } from "./journal.js";
import { discardCoverageDir, readLcov } from "./lcov.js";
import type { Logger } from "./logger.js";
import { dirtyPaths, openDraftPrs, runCmd, type CmdExec } from "./pr.js";
import { blockSpanAt } from "./segments.js";
import { auditLead, sourceLines, type AuditedCase, type AuditReport } from "./audit.js";
import { getRunner } from "./runners/index.js";
import type { RepoConfig, Runner } from "./types.js";

/** An audited case with the line span a cut would take out of its spec file. */
export interface RemovalCandidate extends AuditedCase {
  start: number;
  end: number;
}

export interface RemovalPlan {
  remove: RemovalCandidate[];
  /** Weak cases held back because they are some line's only coverage. */
  repair: AuditedCase[];
  savedMs: number;
}

/** True when this case catches nothing, covers nothing of its own, and asserts nothing real. */
export function proposable(c: AuditedCase): boolean {
  if (c.caught > 0 || c.uniqueLines > 0) return false;
  if (c.verdict === "redundant") return true;
  return c.flags.includes("weak_static") && c.flags.includes("weak_dynamic");
}

/** True when the case is weak but deleting it would drop a line nothing else reaches. */
export function repairable(c: AuditedCase): boolean {
  return c.caught === 0 && c.uniqueLines > 0 && c.verdict !== "keeps";
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The cases to cut and the cases to hold back, given the audit and the current
 * text of every spec file it read. A case whose block this heuristic cannot
 * bound is left alone: a cut at a guessed line is worse than no proposal.
 */
export function planRemovals(report: AuditReport, texts: Map<string, string>, minSavingsMs = 0): RemovalPlan {
  const remove: RemovalCandidate[] = [];
  const repair: AuditedCase[] = [];
  for (const repo of report.repos) {
    // A runner that cannot name a case audited the file whole, so there is no
    // case to cut and the file itself is not a removal proposal.
    if (repo.granularity !== "case") continue;
    for (const c of repo.auditedCases) {
      if (repairable(c)) repair.push(c);
      if (!proposable(c) || c.durationMs < minSavingsMs) continue;
      const text = texts.get(c.spec);
      if (text === undefined) continue;
      const span = blockSpanAt(c.spec, text.split(/\r?\n/), c.line);
      if (span) remove.push({ ...c, ...span });
    }
  }
  return { remove, repair, savedMs: remove.reduce((sum, c) => sum + c.durationMs, 0) };
}

const COMMENT = /^\s*(\/\/|#|\*|\/\*)/;

/** The file with these spans gone, along with the comment above each and the blank line under it. */
export function cutSpans(text: string, spans: readonly { start: number; end: number }[]): string {
  const lines = text.split(/\r?\n/);
  const drop = new Array<boolean>(lines.length).fill(false);
  for (const span of spans) {
    for (let n = span.start; n <= Math.min(span.end, lines.length); n += 1) drop[n - 1] = true;
    for (let n = span.start - 1; n >= 1 && COMMENT.test(lines[n - 1] ?? ""); n -= 1) drop[n - 1] = true;
    if ((lines[span.end] ?? "x").trim() === "") drop[span.end] = true;
  }
  return lines.filter((_, i) => !drop[i]).join("\n");
}

export interface RemovalArgs {
  config: Config;
  repo: RepoConfig;
  log: Logger;
  report: AuditReport;
  /** Leave a case alone unless cutting it gives back at least this many ms per run. */
  minSavingsMs: number;
  /** Injected in tests so the path runs with no runner, no git and no gh. */
  runner?: Runner;
  openPr?: typeof openDraftPrs;
  exec?: CmdExec;
  now?: Date;
}

export interface RemovalOutcome {
  /** none: nothing met the rules. reverted: the gate refused the cut. opened: the PR is up. */
  status: "none" | "reverted" | "opened";
  reason?: string;
  removed: RemovalCandidate[];
  repair: AuditedCase[];
  urls: string[];
  journal?: string;
}

/** Spec paths of this audit, and the text each had when it was audited. */
async function specTexts(repo: RepoConfig, report: AuditReport): Promise<Map<string, string>> {
  const specs = new Set(report.repos.flatMap((r) => r.auditedCases.map((c) => c.spec)));
  const out = new Map<string, string>();
  for (const spec of specs) {
    const text = await readFile(join(repo.cwd, spec), "utf8").catch(() => undefined);
    if (text !== undefined) out.set(spec, text);
  }
  return out;
}

const entryOf = (c: RemovalCandidate): RemovalEntry => ({
  spec: c.spec,
  case: c.case,
  startLine: c.start,
  endLine: c.end,
  verdict: c.verdict,
  caught: c.caught,
  planted: c.planted,
  uniqueLines: c.uniqueLines,
  durationMs: c.durationMs,
});

/**
 * Plan the cut, make it, prove it changed no coverage, and open the draft PR.
 * Every outcome writes a journal, so a rebuild has the same list of cases the
 * PR was built from whether the gate accepted the cut or reverted it.
 */
export async function runRemoval(args: RemovalArgs): Promise<RemovalOutcome> {
  const { config, repo, log, report } = args;
  const exec = args.exec ?? runCmd;
  const runner = args.runner ?? getRunner(repo.runner);
  const openPr = args.openPr ?? openDraftPrs;
  const texts = await specTexts(repo, report);
  const plan = planRemovals(report, texts, args.minSavingsMs);
  const empty = { removed: plan.remove, repair: plan.repair, urls: [] };
  if (plan.remove.length === 0) return { ...empty, status: "none", reason: "no case both catches nothing and covers nothing the rest of the suite reaches" };

  const specs = [...new Set(plan.remove.map((c) => c.spec))];
  // Named paths are committed, so an edit already sitting on one of these files
  // would be committed with the cut. That is the one thing a PR path may not do.
  const prefix = relative(repo.root, repo.cwd);
  const dirty = (await dirtyPaths(repo.root, [], exec)).filter((p) => specs.includes(prefix ? relative(prefix, p) : p));
  if (dirty.length > 0) return { ...empty, status: "none", reason: `uncommitted changes on ${dirty.join(", ")}: commit or stash them and run the audit again` };

  const journal = { ...newJournal(repo.name, journalId(args.now), args.now), removed: plan.remove.map(entryOf) };
  const path = journalPath(stateDirFor(config, repo), journal.id);
  const before = report.repos.find((r) => r.repo === repo.name)?.suiteLines ?? 0;
  const allowed = plan.remove.reduce((sum, c) => sum + c.uniqueLines, 0);

  let reason: string | undefined;
  let keep = false;
  try {
    for (const spec of specs) {
      const cut = plan.remove.filter((c) => c.spec === spec);
      const all = report.repos.flatMap((r) => r.auditedCases).filter((c) => c.spec === spec);
      const abs = join(repo.cwd, spec);
      // A file whose every case was cut has nothing left to run.
      if (cut.length === all.length) await rm(abs, { force: true });
      else await writeFile(abs, cutSpans(texts.get(spec) ?? "", cut), "utf8");
    }
    const run = await runner.run(repo, { files: [], coverage: true, timeoutMs: config.gate.baseline_timeout_ms });
    if (!run.ok) reason = `the suite failed after the cut (exit ${run.exitCode}), so nothing was proposed`;
    else if (!run.lcovPath) reason = "the suite produced no coverage after the cut, so the cut could not be proven";
    else {
      const map = await readLcov(run.lcovPath, { cwd: repo.cwd });
      await discardCoverageDir(run.lcovPath);
      const lost = before - sourceLines(repo, map).size;
      if (lost > allowed) reason = `the cut lost ${plural(lost, "covered line")} and only ${allowed} may be lost, so every file was put back`;
    }
    keep = reason === undefined;
  } finally {
    if (!keep) for (const spec of specs) await writeFile(join(repo.cwd, spec), texts.get(spec) ?? "", "utf8");
  }

  if (reason !== undefined) {
    await writeJournal(path, { ...journal, status: "reverted", reason });
    log.warn({ repo: repo.name, reason }, "removal reverted");
    return { ...empty, status: "reverted", reason, journal: path };
  }

  const head = await exec("git", ["rev-parse", "HEAD"], repo.root);
  const urls = await openPr({
    repo,
    files: specs,
    title: removalTitle(repo.name, plan),
    body: removalBody(repo.name, report, plan),
    maxLines: config.sweep.pr_max_lines,
    // Line counts of the cut, not of the files: what a reviewer reads here is
    // the removal, and a big file with one case gone is a small diff.
    sizes: specs.map((spec) => ({ path: spec, lines: plan.remove.filter((c) => c.spec === spec).reduce((sum, c) => sum + (c.end - c.start + 1), 0) })),
    baseSha: head.exitCode === 0 ? head.stdout.trim() : undefined,
    now: args.now,
    suffixes: plan.remove.map((_, i) => (i === 0 ? "audit" : `audit-${i + 1}`)),
    exec,
  });
  await writeJournal(path, { ...journal, status: "finished" });
  log.info({ repo: repo.name, urls, removed: plan.remove.length }, "removal PR opened");
  return { status: "opened", removed: plan.remove, repair: plan.repair, urls, journal: path };
}

export function removalTitle(name: string, plan: RemovalPlan): string {
  return `covergen audit: ${plural(plan.remove.length, "test")} proposed for removal in ${name}`;
}

/** The PR body: the audit's lead, the evidence per case, and what was held back. */
export function removalBody(name: string, report: AuditReport, plan: RemovalPlan): string {
  const out = [
    auditLead(report),
    "",
    `Proposed for removal in ${name}: ${plural(plan.remove.length, "case")}, worth ${(plan.savedMs / 1000).toFixed(1)} seconds of every full run.`,
    "",
    "| spec | case | why | planted bugs caught | lines only this case covers | seconds saved per run |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const c of plan.remove) {
    out.push(
      `| ${c.spec}:${c.start} | ${c.case} | ${c.flags.join(", ")} | 0 of ${c.planted} | 0 of ${c.coveredLines} | ${(c.durationMs / 1000).toFixed(1)} |`,
    );
  }
  out.push("");
  if (plan.repair.length > 0) {
    out.push("### Not proposed: repair these instead", "");
    out.push("Each of these checks nothing either, and each is the only thing covering a line. Deleting one would lose coverage, so it wants a real assertion rather than a delete.", "");
    for (const c of plan.repair) {
      out.push(`- ${c.spec}:${c.line} ${c.case}: ${plural(c.uniqueLines, "line")} nothing else covers${c.reason ? `. ${c.reason}` : ""}`);
    }
    out.push("");
  }
  out.push(
    "Read this like any other code change and keep anything you want kept. No model was involved in it: the cases were chosen by the assertion rules and by planting bugs on the lines each case runs, and no case that caught a bug or was a line's only coverage is here. After the cut the suite ran in full and covered the same lines it covered before.",
  );
  return out.join("\n");
}
