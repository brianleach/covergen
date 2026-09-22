/**
 * lcov.info parsing, merging and diffing.
 *
 * Only line coverage is used. Function (FN/FNDA/FNF/FNH) and branch
 * (BRDA/BRF/BRH) records are tolerated and ignored, so Jest and v8 reports
 * parse the same way SimpleCov ones do.
 */

import { readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CoverageDelta, CoverageMap, CoverageSummary, FileCoverage } from "./types.js";

export interface ParseLcovOptions {
  /** Absolute paths are made relative to this directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Leading prefix stripped from every path before normalizing. */
  stripPrefix?: string;
}

function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Normalize an SF path to a forward-slash path relative to cwd. */
export function normalizePath(raw: string, opts: ParseLcovOptions = {}): string {
  let p = toPosix(raw.trim());
  const stripPrefix = opts.stripPrefix ? toPosix(opts.stripPrefix).replace(/\/+$/, "") : undefined;
  if (stripPrefix && stripPrefix.length > 0) {
    if (p === stripPrefix) p = "";
    else if (p.startsWith(stripPrefix + "/")) p = p.slice(stripPrefix.length + 1);
  }
  if (isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
    const rel = toPosix(relative(cwd, p));
    // Only take the relative form when the file actually lives under cwd.
    if (rel.length > 0 && !rel.startsWith("../")) p = rel;
  }
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

function addHits(file: FileCoverage, line: number, hits: number): void {
  if (!Number.isFinite(line) || line <= 0) return;
  file.lines.set(line, (file.lines.get(line) ?? 0) + (Number.isFinite(hits) ? hits : 0));
}

/** Parse an lcov.info document into a CoverageMap. Duplicate SF blocks merge by summing hits. */
export function parseLcov(text: string, opts: ParseLcovOptions = {}): CoverageMap {
  const map: CoverageMap = new Map();
  let current: FileCoverage | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line === "end_of_record") {
      current = undefined;
      continue;
    }
    const colon = line.indexOf(":");
    const tag = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1);

    switch (tag) {
      case "SF": {
        const path = normalizePath(value, opts);
        if (path.length === 0) {
          current = undefined;
          break;
        }
        let file = map.get(path);
        if (!file) {
          file = { path, lines: new Map() };
          map.set(path, file);
        }
        current = file;
        break;
      }
      case "DA": {
        if (!current) break;
        const parts = value.split(",");
        const line = Number(parts[0]);
        const hits = Number(parts[1]);
        addHits(current, line, hits);
        break;
      }
      // Summary and non-line records are recomputed or ignored.
      case "LF":
      case "LH":
      case "TN":
      case "FN":
      case "FNDA":
      case "FNF":
      case "FNH":
      case "BRDA":
      case "BRF":
      case "BRH":
      default:
        break;
    }
  }

  return map;
}

/** Read and parse an lcov.info file from disk. */
/** Remove a per-run coverage dir, but only one covergen itself created. */
export async function discardCoverageDir(lcovPath: string): Promise<void> {
  const dir = dirname(lcovPath).replaceAll("\\", "/");
  if (!/\/\.covergen\/coverage\/[^/]+$/.test(dir)) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function readLcov(path: string, opts: ParseLcovOptions = {}): Promise<CoverageMap> {
  const text = await readFile(path, "utf8");
  return parseLcov(text, opts);
}

/** Union of two coverage maps, summing hit counts per line. Inputs are not mutated. */
export function mergeCoverage(a: CoverageMap, b: CoverageMap): CoverageMap {
  const out: CoverageMap = new Map();
  for (const source of [a, b]) {
    for (const [path, file] of source) {
      let target = out.get(path);
      if (!target) {
        target = { path, lines: new Map() };
        out.set(path, target);
      }
      for (const [line, hits] of file.lines) {
        target.lines.set(line, (target.lines.get(line) ?? 0) + hits);
      }
    }
  }
  return out;
}

function countCovered(file: FileCoverage | undefined, lines: Iterable<number>): number {
  if (!file) return 0;
  let covered = 0;
  for (const line of lines) {
    if ((file.lines.get(line) ?? 0) > 0) covered += 1;
  }
  return covered;
}

/**
 * Compare one file across two coverage maps.
 * `total` is the union of lines instrumented in either map.
 */
export function diffCoverage(before: CoverageMap, after: CoverageMap, path: string): CoverageDelta {
  const b = before.get(path);
  const a = after.get(path);
  const union = new Set<number>();
  for (const line of b?.lines.keys() ?? []) union.add(line);
  for (const line of a?.lines.keys() ?? []) union.add(line);
  const all = [...union].sort((x, y) => x - y);

  const newlyCovered: number[] = [];
  const lost: number[] = [];
  for (const line of all) {
    const beforeHits = b?.lines.get(line);
    const afterHits = a?.lines.get(line);
    const wasCovered = (beforeHits ?? 0) > 0;
    const isCovered = (afterHits ?? 0) > 0;
    if (!wasCovered && isCovered) newlyCovered.push(line);
    // A line that vanished from the "after" map was not re-measured, not lost.
    else if (wasCovered && afterHits !== undefined && !isCovered) lost.push(line);
  }

  return {
    path,
    newlyCovered,
    lost,
    before: { covered: countCovered(b, all), total: all.length },
    after: { covered: countCovered(a, all), total: all.length },
  };
}

/**
 * Line coverage totals over the map, or over the files `include` accepts.
 * `pct` is 0 when nothing is instrumented.
 *
 * The predicate is what lets a caller report the percentage for the files a
 * repo actually declares as sources instead of everything the runner happened
 * to instrument. A file the predicate rejects contributes to neither side of
 * the ratio, so it cannot dilute the figure.
 */
export function summarize(map: CoverageMap, include?: (path: string) => boolean): CoverageSummary {
  let covered = 0;
  let total = 0;
  let files = 0;
  for (const file of map.values()) {
    if (include && !include(file.path)) continue;
    let instrumented = false;
    for (const hits of file.lines.values()) {
      total += 1;
      instrumented = true;
      if (hits > 0) covered += 1;
    }
    if (instrumented) files += 1;
  }
  return { covered, total, pct: total === 0 ? 0 : (covered / total) * 100, files };
}
