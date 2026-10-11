/**
 * Dedupe, token-length percentiles and the size ceiling for the corpus.
 */

import { normalizedHash } from "../../src/normalized-hash.js";

export interface Row {
  repo: string;
  commit: string;
  license: string;
  source_path: string;
  source: string;
  test_path: string;
  test: string;
  vitest_version: string;
}

/** Drop rows whose test text, whitespace-normalized, already appeared in an earlier row (any repo). */
export function dedupe<T extends { test: string }>(rows: T[]): { kept: T[]; dropped: number } {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const row of rows) {
    const h = normalizedHash(row.test);
    if (seen.has(h)) continue;
    seen.add(h);
    kept.push(row);
  }
  return { kept, dropped: rows.length - kept.length };
}

/** Nearest-rank percentile of an unsorted list; 0 for an empty one. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export interface Percentiles {
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export function summarize(values: number[]): Percentiles {
  return {
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

/** The size ceiling: the measured p99 of source-plus-test tokens, rounded up to a multiple of 256. */
export function ceilingFromP99(p99: number): number {
  return Math.max(256, Math.ceil(p99 / 256) * 256);
}
