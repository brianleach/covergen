/**
 * The per-run journal at `<state dir>/runs/<id>.json`.
 *
 * state.json describes runs that are over. The journal describes the run that is
 * still going: every spec it has accepted and written, and what it has spent so
 * far, rewritten after each gate decision. A run killed halfway leaves its
 * accepted specs in the working tree and this file naming them, which is what a
 * later command, or a person, needs to finish what the run started.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./state.js";

export const JOURNAL_VERSION = 1;

/**
 * running: still gating. aborted: a signal stopped it, and the accepted specs
 * stayed on disk. reverted: the accepted specs failed together and every one of
 * them was rolled back. finished: the loop ended and the output verified.
 */
export type JournalStatus = "running" | "aborted" | "reverted" | "finished";

export interface JournalEntry {
  /** Spec path relative to repo.cwd, which is what the PR step commits. */
  spec: string;
  hash: string;
  /**
   * The whole spec file as this test left it, hashed the way candidates are. A
   * second test accepted into the same file records its own, so the last entry
   * naming a spec is the one that describes the file on disk. Absent on a
   * journal written before this field existed, which only means the file cannot
   * be checked for drift.
   */
  specHash?: string;
  /** Source file the test was generated for, relative to repo.cwd. */
  source: string;
  symbol?: string;
  /** How many previously uncovered lines this test brought in. */
  newlyCovered: number;
}

/**
 * One case `audit --pr` cut, with the evidence that allowed the cut and the
 * span it came out of, which is what rebuilding the PR from a journal needs.
 */
export interface RemovalEntry {
  /** Spec path relative to repo.cwd. */
  spec: string;
  case: string;
  startLine: number;
  endLine: number;
  verdict: string;
  /** Planted bugs this case failed on, over the ones it was re-run against. Always 0 over P. */
  caught: number;
  planted: number;
  /** Lines nothing else covers. Always 0: a case with any is never cut. */
  uniqueLines: number;
  durationMs: number;
}

export interface RunJournal {
  version: number;
  id: string;
  /** Repo name from covergen.yaml, so a journal can find its way back to a config entry. */
  repo: string;
  startedAt: string;
  updatedAt: string;
  status: JournalStatus;
  /**
   * HEAD when the run started. The PR step cuts its branch from this commit, and
   * a run finished by hand has to know which commit its tests were proven on.
   */
  baseSha?: string;
  accepted: JournalEntry[];
  /** Cases `audit --pr` proposed for removal. Empty on a generation run. */
  removed?: RemovalEntry[];
  /** Why the run ended the way it did, when the status alone does not say it. */
  reason?: string;
  /** Total tokens charged so far, across generator and repairer. */
  tokens: number;
}

/** Sortable and unique enough that two runs on one repo never collide. */
export function journalId(now: Date = new Date(), rand: string = Math.random().toString(36).slice(2, 8)): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${rand}`;
}

export function journalPath(stateDir: string, id: string): string {
  return join(stateDir, "runs", `${id}.json`);
}

export function newJournal(repo: string, id: string, now: Date = new Date()): RunJournal {
  const at = now.toISOString();
  return { version: JOURNAL_VERSION, id, repo, startedAt: at, updatedAt: at, status: "running", accepted: [], tokens: 0 };
}

export async function writeJournal(path: string, journal: RunJournal): Promise<string> {
  return writeJsonAtomic(path, { ...journal, updatedAt: new Date().toISOString() });
}

/** Reject anything that is not a journal outright, rather than half reading it. */
function asJournal(raw: unknown, path: string): RunJournal {
  const j = raw as Partial<RunJournal> | null;
  if (!j || typeof j !== "object" || typeof j.id !== "string" || typeof j.repo !== "string" || !Array.isArray(j.accepted)) {
    throw new Error(`${path} is not a covergen run journal.`);
  }
  if (j.version !== JOURNAL_VERSION) {
    throw new Error(`${path} is a version ${String(j.version)} journal and this covergen reads version ${JOURNAL_VERSION}.`);
  }
  return { ...j, tokens: j.tokens ?? 0, status: j.status ?? "running" } as RunJournal;
}

export async function readJournal(path: string): Promise<RunJournal> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`no run journal at ${path}. The run that wrote one names it in its abort message.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not readable JSON.`);
  }
  return asJournal(raw, path);
}

/**
 * The spec file as it sits in the checkout. Missing reads as undefined, never as
 * empty. Whitespace is collapsed first, the same normalization `hashCode` gives
 * a candidate, so a reformatted file is not reported as a changed one. Hashed
 * here rather than through generate.ts, which journal reading has no other
 * reason to load.
 */
export async function specFileHash(cwd: string, spec: string): Promise<string | undefined> {
  const text = await readFile(join(cwd, spec), "utf8").catch(() => undefined);
  return text === undefined ? undefined : createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

/**
 * Why each spec the journal named can no longer be trusted, empty when they all
 * can. Checked per file rather than per entry: two tests in one spec leave two
 * entries and only the later hash describes the file.
 */
export async function driftedSpecs(cwd: string, journal: RunJournal): Promise<string[]> {
  const latest = new Map<string, JournalEntry>();
  for (const entry of journal.accepted) latest.set(entry.spec, entry);
  const out: string[] = [];
  for (const [spec, entry] of latest) {
    const now = await specFileHash(cwd, spec);
    if (now === undefined) out.push(`${spec} is gone from the checkout`);
    else if (entry.specHash && now !== entry.specHash) out.push(`${spec} has changed since the run wrote it`);
  }
  return out;
}

export function journalTitle(journal: RunJournal): string {
  const n = journal.accepted.length;
  return `covergen: ${n} ${n === 1 ? "test" : "tests"} accepted in ${journal.repo}`;
}

/**
 * The PR body for a run finished by hand. Everything in it is what the run
 * recorded as it went, so no gate is re-run and no model is called to build it.
 */
export function journalBody(journal: RunJournal): string {
  const n = journal.accepted.length;
  const out = [
    `# ${journalTitle(journal)}`,
    "",
    `Opened from the run journal \`${journal.id}\`, a run that ended ${journal.status}${journal.reason ? `: ${journal.reason}` : "."}`,
    "",
    `${n} ${n === 1 ? "test" : "tests"} in the checkout, each accepted by the gate before the run ended, for ` +
      `${journal.tokens.toLocaleString("en-US")} tokens.`,
    "",
    "| Spec | Source | Symbol | Lines newly covered |",
    "| --- | --- | --- | --- |",
  ];
  for (const e of journal.accepted) {
    out.push(`| \`${e.spec}\` | \`${e.source}\` | ${e.symbol ? `\`${e.symbol}\`` : ""} | ${e.newlyCovered} |`);
  }
  out.push(
    "",
    "Nothing was regenerated for this PR. Every test here passed the gate during that run and the files are the ones it left behind, checked against the hashes it recorded. The run never reached the step that proves the accepted specs pass together, so run the suite once before merging.",
  );
  return out.join("\n");
}
