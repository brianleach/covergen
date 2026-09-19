/**
 * The per-run journal at `<state dir>/runs/<id>.json`.
 *
 * state.json describes runs that are over. The journal describes the run that is
 * still going: every spec it has accepted and written, and what it has spent so
 * far, rewritten after each gate decision. A run killed halfway leaves its
 * accepted specs in the working tree and this file naming them, which is what a
 * later command, or a person, needs to finish what the run started.
 */

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
