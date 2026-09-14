/**
 * Value ordering: which uncovered code is worth a test.
 *
 *   score = sqrt(uncovered) * branchWeight * churnWeight * importWeight
 *
 * Size enters under a square root, so it breaks ties between comparable files
 * without deciding the ranking on its own: a small dense module outranks a large
 * moderately branchy one. branchWeight is the branch density of the uncovered
 * text itself, floored just above zero, which is what sinks a schema or constant
 * table however red it is. churnWeight and importWeight are bounded multipliers,
 * never more than 3x and 2x. Every signal is a tokenizer, one `git log` or a
 * substring index: no AST and no parser dependency, which is what lets one
 * implementation serve Ruby and TypeScript alike. Reasoning in
 * docs/DECISIONS.md entry 19.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { runGit, type GitExec } from "./git.js";
import type { CoverageMap, RepoConfig } from "./types.js";

/** Commit window for the churn signal. */
export const CHURN_DAYS = 180;
/** Bounds: files scanned for imports, and bytes read from each. */
const MAX_SCAN_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;
/** A file with no branches at all still scores above zero, just barely. */
const DENSITY_FLOOR = 0.05;
const DENSITY_CAP = 2;
const CHURN_CAP = 20;
const IMPORT_CAP = 10;
/** An exit is a branch only when it is early, so it counts for less than an `if`. */
const EXIT_WEIGHT = 0.5;

const BRANCH_WORDS = /\b(?:if|elsif|elif|else|unless|switch|case|when|catch|rescue|while|until|for)\b/g;
const EXIT_WORDS = /\b(?:return|break|continue|next|throw|raise)\b/g;
/** `?` counts as a ternary only when whitespace follows, so `name?: string` does not. */
const BRANCH_OPS = /&&|\|\||\?\?|\?\.|\?(?=\s)/g;
const IMPORT_SPEC = /(?:\bfrom\s*|\brequire(?:_relative)?\s*\(?\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

const toPosix = (p: string): string => p.replaceAll("\\", "/");
const stripExt = (p: string): string => p.replace(/\.[A-Za-z0-9]+$/, "");

/**
 * Blank out comments and string literals so their words are not read as code.
 * A single pass, deliberately naive: a `#` starts a line comment, which costs a
 * TypeScript private field the rest of its line, and that only ever undercounts.
 */
export function stripNoise(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "#" || (ch === "/" && next === "/")) {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      out += " ";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < text.length && text[i] !== ch) i += text[i] === "\\" ? 2 : 1;
      out += '""';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Decision points in a chunk of source, comments and string contents excluded. */
export function branchCount(text: string): number {
  const clean = stripNoise(text);
  const hits = (re: RegExp): number => clean.match(re)?.length ?? 0;
  return hits(BRANCH_WORDS) + hits(BRANCH_OPS) + EXIT_WEIGHT * hits(EXIT_WORDS);
}

/** Branch density of the uncovered text, floored and capped. */
export function branchWeight(branches: number, lines: number): number {
  const density = lines > 0 ? branches / lines : 0;
  return DENSITY_FLOOR + Math.min(density, DENSITY_CAP);
}

/**
 * Commits per repo-root-relative path in the last `days`, from one `git log`
 * rather than one per file. A path outside git, or a root that is not a
 * repository, is absent from the map and scores zero churn.
 */
export async function churnCounts(repoRoot: string, days = CHURN_DAYS, exec: GitExec = runGit): Promise<Map<string, number>> {
  const res = await exec(["log", `--since=${days}.days`, "--name-only", "--no-renames", "--format=%n"], repoRoot);
  const counts = new Map<string, number>();
  if (res.exitCode !== 0) return counts;
  for (const raw of res.stdout.split("\n")) {
    const path = toPosix(raw.trim());
    if (path.length === 0) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/**
 * Module specifiers `source` imports, as both the bare stem and, for a relative
 * specifier, the cwd-relative path it resolves to. Two keys because a stem alone
 * confuses every `index` in the tree, and a path alone misses package-style
 * imports of the same file. Read from the raw source, since the specifier is
 * itself a string literal.
 */
export function importKeys(fromPath: string, source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPEC)) {
    const spec = toPosix(match[1] ?? "");
    if (spec.length === 0) continue;
    keys.add(stripExt(basename(spec)));
    if (spec.startsWith(".")) keys.add(stripExt(toPosix(join(dirname(fromPath), spec))));
  }
  return [...keys];
}

export interface ValueRow {
  path: string;
  /** Uncovered lines, or -1 when the baseline has no data for the file. */
  uncovered: number;
  /** Percent of instrumented lines covered. */
  pct: number;
  /** Decision points found in the uncovered text, and per uncovered line. */
  branches: number;
  density: number;
  /** Commits touching the file in the churn window. */
  churn: number;
  /** Other files in the scan that import this one. */
  importers: number;
  score: number;
}

export interface RankArgs {
  repo: RepoConfig;
  /** Whole-suite coverage, keyed by cwd-relative path. */
  baseline: CoverageMap;
  /** Candidate paths, relative to `repo.cwd`. */
  targets: string[];
  exec?: GitExec;
  read?: (absPath: string) => Promise<string>;
}

/** Unreadable is not fatal: the file scores as branchless and sinks. */

const readSource = async (absPath: string): Promise<string> => {
  try {
    return (await readFile(absPath, "utf8")).slice(0, MAX_FILE_BYTES);
  } catch {
    return "";
  }
};

/**
 * Rank targets by value, highest first. Ties break on uncovered lines and then
 * on path, so the order is stable across runs.
 */
export async function rankByValue(args: RankArgs): Promise<ValueRow[]> {
  const { repo, baseline, targets } = args;
  const read = args.read ?? readSource;
  const scanned = targets.slice(0, MAX_SCAN_FILES);
  const sources = new Map<string, string>();
  for (const path of scanned) sources.set(path, await read(resolve(repo.cwd, path)));

  const importedBy = new Map<string, Set<string>>();
  for (const [path, source] of sources) {
    for (const key of importKeys(path, source)) {
      const set = importedBy.get(key) ?? new Set<string>();
      set.add(path);
      importedBy.set(key, set);
    }
  }
  const churn = await churnCounts(repo.root, CHURN_DAYS, args.exec);

  const rows = targets.map((path): ValueRow => {
    const file = baseline.get(path);
    const total = file ? file.lines.size : 0;
    const missing = file ? [...file.lines].filter(([, hits]) => hits === 0).map(([line]) => line) : [];
    const uncovered = file ? missing.length : -1;
    const pct = total > 0 ? ((total - missing.length) / total) * 100 : 100;

    const lines = (sources.get(path) ?? "").split(/\r?\n/);
    const branches = branchCount(missing.map((n) => lines[n - 1] ?? "").join("\n"));
    const rootRel = toPosix(relative(repo.root, resolve(repo.cwd, path)));
    const commits = churn.get(rootRel) ?? 0;
    const byPath = importedBy.get(stripExt(path));
    const importers = (byPath?.size ?? 0) > 0 ? byPath!.size : (importedBy.get(stripExt(basename(path)))?.size ?? 0);

    const weighted =
      Math.sqrt(uncovered) *
      branchWeight(branches, uncovered) *
      (1 + Math.min(commits, CHURN_CAP) / 10) *
      (1 + Math.min(importers, IMPORT_CAP) / 10);
    const density = uncovered > 0 ? branches / uncovered : 0;
    const score = uncovered < 0 ? -1 : Number(weighted.toFixed(2));
    return { path, uncovered, pct, branches, density, churn: commits, importers, score };
  });

  rows.sort((a, b) => b.score - a.score || b.uncovered - a.uncovered || a.path.localeCompare(b.path));
  return rows;
}

/** One padded line per row, with the components that produced the score. */
export function valueTable(rows: ValueRow[]): string {
  const line = (r: ValueRow): string =>
    `${r.score.toFixed(2).padStart(8)}${String(r.uncovered).padStart(7)}${r.pct.toFixed(1).padStart(7)}` +
    `${r.density.toFixed(2).padStart(8)}${String(r.churn).padStart(7)}${String(r.importers).padStart(9)}  ${r.path}`;
  return `${["   score  uncov    pct  branch  churn  imports  file", ...rows.map(line)].join("\n")}\n`;
}
