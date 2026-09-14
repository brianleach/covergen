/**
 * Per-repo state at `<repo.root>/.covergen/state.json`.
 *
 * Three things live here and nothing else:
 *  - frozen candidate hashes: chronic non-improvers, never generated again
 *  - accepted candidate hashes: already written into a spec file
 *  - the last 20 run summaries, for a quick "what did this thing do lately"
 *
 * Writes are atomic (temp file plus rename) because a sweep can be killed
 * mid-run and a half-written state file would lose every freeze we learned.
 */

import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Candidate, RepoConfig, RunSummary } from "./types.js";

export const STATE_VERSION = 1;
export const MAX_RUNS = 20;
export const DEFAULT_STATE_DIR = ".covergen";

export interface StateRun {
  /** ISO timestamp of when the run finished. */
  at: string;
  targets: string[];
  candidates: number;
  accepted: number;
  tokens: RunSummary["tokens"];
  durationMs: number;
}

export interface CovergenState {
  version: number;
  frozen: string[];
  accepted: string[];
  runs: StateRun[];
}

export function emptyState(): CovergenState {
  return { version: STATE_VERSION, frozen: [], accepted: [], runs: [] };
}

export function statePath(repo: RepoConfig, stateDir: string = DEFAULT_STATE_DIR): string {
  return join(repo.root, stateDir, "state.json");
}

function normalize(raw: unknown): CovergenState {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<CovergenState>;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    version: typeof obj.version === "number" ? obj.version : STATE_VERSION,
    frozen: [...new Set(strings(obj.frozen))],
    accepted: [...new Set(strings(obj.accepted))],
    runs: Array.isArray(obj.runs) ? (obj.runs as StateRun[]).slice(-MAX_RUNS) : [],
  };
}

/** Missing or corrupt state is not an error: start fresh rather than block a run. */
export async function loadState(repo: RepoConfig, stateDir: string = DEFAULT_STATE_DIR): Promise<CovergenState> {
  const path = statePath(repo, stateDir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return emptyState();
  }
  try {
    return normalize(JSON.parse(text));
  } catch {
    return emptyState();
  }
}

/**
 * Temp file plus rename. Shared with the run journal, which is rewritten after
 * every gate decision and must never be found half written.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return path;
}

export async function saveState(
  repo: RepoConfig,
  state: CovergenState,
  stateDir: string = DEFAULT_STATE_DIR,
): Promise<string> {
  return writeJsonAtomic(statePath(repo, stateDir), normalize(state));
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Fold one run into the state: freeze the hashes that failed for good, remember
 * the accepted ones, and push a summary, keeping the newest MAX_RUNS.
 */
export function recordRun(
  state: CovergenState,
  summary: RunSummary,
  opts: { frozen?: string[]; at?: string; dryRun?: boolean } = {},
): CovergenState {
  // A dry run wrote nothing, so its accepted hashes must stay eligible for a real run.
  const acceptedHashes = opts.dryRun ? [] : summary.accepted.map((c) => c.hash);
  const run: StateRun = {
    at: opts.at ?? new Date().toISOString(),
    targets: summary.targets,
    candidates: summary.candidates.length,
    accepted: summary.accepted.length,
    tokens: summary.tokens,
    durationMs: summary.durationMs,
  };
  return {
    version: STATE_VERSION,
    frozen: union(state.frozen, opts.frozen ?? []),
    accepted: union(state.accepted, acceptedHashes),
    runs: [...state.runs, run].slice(-MAX_RUNS),
  };
}

/** Statuses that mean "do not spend tokens on this hash again". */
const FROZEN_STATUSES = new Set([
  "build_failed",
  "test_failed",
  "flaky",
  "no_coverage_gain",
  "rule_violation",
  "tautological",
  "declaration_snapshot",
  "weak_assertions",
]);

export function freezableHashes(candidates: Candidate[]): string[] {
  return [...new Set(candidates.filter((c) => FROZEN_STATUSES.has(c.status)).map((c) => c.hash))];
}

/** Hashes we should not regenerate: frozen plus already accepted. */
export function skipSet(state: CovergenState): Set<string> {
  return new Set([...state.frozen, ...state.accepted]);
}
