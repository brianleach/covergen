/**
 * Run-wide ceilings for an unattended sweep.
 *
 * `claude_code.max_tokens_per_sweep` guards one pipeline run on one backend.
 * These ceilings sit above it: they are counted across every repo in a run and
 * enforced on both backends, so an overnight `sweep --all` cannot spend the
 * whole subscription window or still be running when the workday starts.
 *
 * The object is mutable and shared by every repo in the run. `spent` carries the
 * tokens of the runs that already finished; the pipeline adds the run it is in
 * the middle of before comparing.
 */

import type { RunSummary } from "./types.js";

export type LimitKind = "tokens" | "minutes";

export interface RunLimits {
  /** Tokens the whole run may spend. 0 disables the ceiling. */
  maxTokens: number;
  /** Epoch ms after which no further target starts. Undefined disables it. */
  deadlineAt?: number;
  /** Tokens charged by the runs that have already returned. */
  spent: number;
  /** Set once a ceiling stopped the run, and reported everywhere after that. */
  hit?: LimitKind;
}

export function totalTokens(tokens: RunSummary["tokens"]): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

export function createLimits(opts: { maxTokens?: number; maxMinutes?: number; now?: number }): RunLimits {
  const minutes = opts.maxMinutes ?? 0;
  return {
    maxTokens: opts.maxTokens ?? 0,
    deadlineAt: minutes > 0 ? (opts.now ?? Date.now()) + minutes * 60_000 : undefined,
    spent: 0,
  };
}

/**
 * Which ceiling, if any, says to stop before starting more work. `inFlight` is
 * the token count of the run that is currently open, which `spent` does not
 * hold yet. Sticky: once a ceiling is hit the run stays stopped.
 */
export function ceilingHit(limits: RunLimits | undefined, inFlight = 0, now: number = Date.now()): LimitKind | undefined {
  if (!limits) return undefined;
  if (limits.hit) return limits.hit;
  if (limits.deadlineAt !== undefined && now >= limits.deadlineAt) return "minutes";
  if (limits.maxTokens > 0 && limits.spent + inFlight >= limits.maxTokens) return "tokens";
  return undefined;
}

/** One sentence for a PR body or a run report, or nothing when no ceiling was hit. */
export function limitNote(kind: LimitKind | undefined): string | undefined {
  if (!kind) return undefined;
  return kind === "tokens"
    ? "Stopped early: the run-wide token ceiling was reached, so the remaining targets and repos were skipped."
    : "Stopped early: the run-wide time ceiling was reached, so the remaining targets and repos were skipped.";
}

/** Parse a CLI ceiling. A bad value is a misconfiguration, not a zero. */
export function parseCeiling(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== value.trim()) {
    throw new Error(`${flag} must be a non-negative whole number, got "${value}".`);
  }
  return n;
}
