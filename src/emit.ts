/**
 * Writing accepted tests into the real spec files, and the PR body that
 * explains what landed.
 *
 * Splice rules, per runner family:
 *  - rspec: append the block just before the outer `describe`'s closing `end`
 *  - vitest / bun / jest: append at end of file
 *
 * One spec file can receive several blocks in a run, so content is accumulated
 * in memory per file and written once.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatUsd } from "./cost.js";
import { limitNote } from "./limits.js";
import { assertionKinds } from "./rules.js";
import type { Candidate, RepoConfig, RunSummary, RunnerName } from "./types.js";

export interface EmitSkip {
  spec: string;
  reason: string;
}

export interface EmitResult {
  /** Spec paths (relative to repo.cwd) that were created or appended to. */
  written: string[];
  skipped: EmitSkip[];
}

function normalizeBlock(code: string): string {
  return `${code.replace(/\s+$/, "")}\n`;
}

/**
 * Insert `block` before the last top-level `end` in an rspec file.
 *
 * "Top level" means column zero, which is where the outer `RSpec.describe`'s
 * `end` sits in every idiomatic spec. If there is none (an empty or unusual
 * file) the block goes at EOF, which still parses.
 */
export function spliceRspec(existing: string, block: string): string {
  const lines = existing.split("\n");
  let target = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^end\s*$/.test(lines[i] ?? "")) {
      target = i;
      break;
    }
  }
  if (target === -1) return `${existing.replace(/\s+$/, "")}\n\n${normalizeBlock(block)}`;
  const body = indent(normalizeBlock(block).replace(/\s+$/, ""), "  ");
  const before = lines.slice(0, target).join("\n").replace(/\s+$/, "");
  const after = lines.slice(target).join("\n").replace(/\s+$/, "");
  return `${before}\n\n${body}\n${after}\n`;
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length === 0 ? line : `${pad}${line}`))
    .join("\n");
}

/** JS runners: a new describe block at EOF is valid and keeps diffs small. */
export function appendJs(existing: string, block: string): string {
  const trimmed = existing.replace(/\s+$/, "");
  if (trimmed.length === 0) return normalizeBlock(block);
  return `${trimmed}\n\n${normalizeBlock(block)}`;
}

export function spliceForRunner(runner: RunnerName, existing: string, block: string): string {
  return runner === "rspec" ? spliceRspec(existing, block) : appendJs(existing, block);
}

/**
 * Write accepted candidates into their spec files.
 *
 * Never overwrites an existing file for a whole-file candidate: a stale
 * generated file clobbering a hand-written spec is the one unrecoverable
 * mistake this tool could make.
 */
export async function applyAccepted(repo: RepoConfig, candidates: Candidate[]): Promise<EmitResult> {
  const written: string[] = [];
  const skipped: EmitSkip[] = [];
  /** spec path (cwd-relative) -> pending content */
  const pending = new Map<string, string>();
  /** spec paths this run created from scratch */
  const created = new Set<string>();

  for (const candidate of candidates) {
    const spec = candidate.specPath;
    if (candidate.status !== "accepted") {
      skipped.push({ spec, reason: `status ${candidate.status}, not accepted` });
      continue;
    }
    const abs = resolve(repo.cwd, spec);
    const onDisk = existsSync(abs);

    if (candidate.wholeFile) {
      if (pending.has(spec) || created.has(spec)) {
        // A second whole file for the same path would duplicate imports and the
        // outer describe. The pipeline stops gating after the first one lands;
        // this is the backstop.
        skipped.push({ spec, reason: "spec file already created by an earlier candidate this run" });
        continue;
      }
      if (onDisk) {
        skipped.push({ spec, reason: "spec file already exists, refusing to overwrite" });
        continue;
      }
      pending.set(spec, normalizeBlock(candidate.code));
      created.add(spec);
      continue;
    }

    let current = pending.get(spec);
    if (current === undefined) {
      if (!onDisk) {
        skipped.push({ spec, reason: "spec file does not exist and candidate is not a whole file" });
        continue;
      }
      current = await readFile(abs, "utf8");
    }
    pending.set(spec, spliceForRunner(repo.runner, current, candidate.code));
  }

  for (const [spec, content] of pending) {
    const abs = resolve(repo.cwd, spec);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    written.push(spec);
  }

  return { written, skipped };
}

/** Mutants killed over mutants tried, across a set of candidates. */
export interface MutationScore {
  killed: number;
  tried: number;
  /** killed/tried, rounded to three decimals. Null when nothing was mutated. */
  score: number | null;
}

/**
 * The headline quality number: of the deliberate breaks covergen made in the code
 * these tests cover, how many did the tests notice. Candidates with nothing to
 * mutate contribute nothing to either side of the ratio.
 */
export function mutationScore(candidates: Candidate[]): MutationScore {
  let killed = 0;
  let tried = 0;
  for (const c of candidates) {
    killed += c.mutation?.killed ?? 0;
    tried += c.mutation?.tried ?? 0;
  }
  return { killed, tried, score: tried === 0 ? null : Number((killed / tried).toFixed(3)) };
}

/** One accepted test, described by what it proves rather than by what it covers. */
export interface SpecQuality {
  spec: string;
  symbol?: string;
  newlyCovered: number;
  mutantsKilled: number;
  mutantsTried: number;
  /** Distinct assertion matchers the test uses, in source order. */
  assertions: string[];
}

export function specQuality(candidates: Candidate[]): SpecQuality[] {
  return candidates.map((c) => ({
    spec: c.specPath,
    symbol: c.segment.symbol,
    newlyCovered: c.delta?.newlyCovered.length ?? 0,
    mutantsKilled: c.mutation?.killed ?? 0,
    mutantsTried: c.mutation?.tried ?? 0,
    assertions: [...new Set(assertionKinds(c.code ?? ""))],
  }));
}

/** "caught 7 of 9 planted bugs (78%)", or the reason there is no figure. */
export function mutationLine(score: MutationScore): string {
  if (score.tried === 0)
    return "Tests that catch regressions: no bug could be planted on the covered lines, so nothing was measured.";
  const percent = ((score.killed / score.tried) * 100).toFixed(0);
  return `Tests that catch regressions: caught ${score.killed} of ${score.tried} planted bugs (${percent}%).`;
}

function assertionsCell(kinds: string[]): string {
  if (kinds.length === 0) return "none";
  return kinds.length <= 4 ? kinds.join(", ") : `${kinds.slice(0, 4).join(", ")}, ...`;
}

function pct(part: { covered: number; total: number } | undefined): string {
  if (!part || part.total === 0) return "n/a";
  return `${((part.covered / part.total) * 100).toFixed(1)}%`;
}

/** killed/tried, or "n/a" when the spot-check found nothing to mutate or was off. */
function mutantsCell(mutation: Candidate["mutation"]): string {
  if (!mutation || mutation.tried === 0) return "n/a";
  return `${mutation.killed}/${mutation.tried}`;
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatLines(lines: number[] | undefined): string {
  if (!lines || lines.length === 0) return "0";
  if (lines.length <= 8) return `${lines.length} (${lines.join(", ")})`;
  return `${lines.length} (${lines.slice(0, 8).join(", ")}, ...)`;
}

/**
 * The dollars line under token usage. Absent when the run carries no cost at
 * all (a summary written before pricing existed, or a run that never called a
 * model), and marked as a floor when a model had no price entry.
 */
export function costLine(summary: RunSummary): string | undefined {
  const cost = summary.cost;
  if (!cost || cost.byModel.length === 0) return undefined;
  const perModel = cost.byModel
    .map((m) => `${m.model} ${m.usd === undefined ? "unpriced" : formatUsd(m.usd)}`)
    .join(", ");
  const total = cost.partial ? `${formatUsd(cost.usd)} or more` : formatUsd(cost.usd);
  return `cost ${total} (${perModel})`;
}

/** The PR title, same headline as the body so `gh pr create --title` matches it. */
export function prTitle(summary: RunSummary): string {
  const n = summary.accepted.length;
  return `covergen: ${n} ${n === 1 ? "test" : "tests"} accepted in ${summary.repo}`;
}

/**
 * Markdown for the draft PR. Every number here comes from a real gate run, so
 * the body is the audit trail a reviewer reads before approving.
 */
export function prBody(summary: RunSummary): string {
  const accepted = summary.accepted;
  const rejected = summary.candidates.filter((c) => c.status !== "accepted");
  const out: string[] = [];

  out.push(`# ${prTitle(summary)}`);
  out.push("");
  // The mutation score leads: a test that raises coverage without noticing a
  // broken line is the failure mode this tool exists to avoid, so the reviewer
  // sees that number before the coverage delta.
  out.push(mutationLine(mutationScore(accepted)));
  out.push("");
  out.push(
    `${summary.targets.length} source ${summary.targets.length === 1 ? "file" : "files"} targeted, ` +
      `${summary.candidates.length} candidates generated, ${accepted.length} accepted in ` +
      `${(summary.durationMs / 1000).toFixed(1)}s.`,
  );
  out.push("");

  out.push("## Accepted tests");
  out.push("");
  if (accepted.length === 0) {
    out.push("None. No candidate both passed repeatedly and raised line coverage.");
  } else {
    out.push("| Spec | Symbol | Lines newly covered | Before | After | Planted bugs caught | Assertions |");
    out.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const c of accepted) {
      const symbol = c.segment.symbol ?? `${c.segment.path}:${c.segment.startLine}`;
      out.push(
        `| \`${escapeCell(c.specPath)}\` | \`${escapeCell(symbol)}\` | ` +
          `${escapeCell(formatLines(c.delta?.newlyCovered))} | ${pct(c.delta?.before)} | ${pct(c.delta?.after)} | ` +
          `${mutantsCell(c.mutation)} | ${escapeCell(assertionsCell([...new Set(assertionKinds(c.code ?? ""))]))} |`,
      );
    }
  }
  out.push("");

  out.push("## Rejected candidates");
  out.push("");
  if (rejected.length === 0) {
    out.push("None.");
  } else {
    const byStatus = new Map<string, Candidate[]>();
    for (const c of rejected) {
      const list = byStatus.get(c.status) ?? [];
      list.push(c);
      byStatus.set(c.status, list);
    }
    const ordered = [...byStatus.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [status, list] of ordered) {
      out.push(`- **${statusLabel(status)}** (${list.length})`);
      for (const c of list) {
        const symbol = c.segment.symbol ?? `${c.segment.path}:${c.segment.startLine}`;
        const reason = c.lastError ? `: ${escapeCell(c.lastError.split("\n")[0] ?? "").slice(0, 160)}` : "";
        out.push(`  - \`${escapeCell(symbol)}\` in \`${escapeCell(c.specPath)}\`${reason}`);
        // Naming the survivors is the whole point of the spot-check: they say
        // which change to the code this test would have let through.
        for (const m of c.mutation?.survivors ?? []) {
          out.push(`    - survived: line ${m.line}, ${escapeCell(m.description)}`);
        }
      }
    }
  }
  out.push("");

  out.push("## Token usage");
  out.push("");
  out.push(
    `input ${summary.tokens.input.toLocaleString("en-US")}, ` +
      `output ${summary.tokens.output.toLocaleString("en-US")}, ` +
      `cache read ${summary.tokens.cacheRead.toLocaleString("en-US")}, ` +
      `cache write ${summary.tokens.cacheWrite.toLocaleString("en-US")}`,
  );
  // A subscription run is labelled instead of priced: the tokens came out of a
  // usage window, not a bill, so any dollar figure here would be invented.
  if (summary.backend === "claude-code") out.push("billed to a Claude subscription (generator: claude-code), no dollar figure");
  const cost = costLine(summary);
  if (cost) out.push(cost);
  const stopped = limitNote(summary.limitHit);
  if (stopped) out.push(stopped);
  out.push("");

  out.push("---");
  out.push("");
  out.push(
    "Every test in this PR was generated by a model and kept only because it built, passed the gate " +
      "repeatedly, and strictly raised line coverage. " +
      "No model runs in CI. Review these tests exactly as you would any hand-written code: check that " +
      "the assertions describe intended behavior and not just current behavior.",
  );
  return `${out.join("\n")}\n`;
}
