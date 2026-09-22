/**
 * Which files a reported coverage percentage was measured over.
 *
 * A coverage report instruments whatever the runner told it to, which is almost
 * never the same set of files a repo declares as `sources`. Narrowing `sources`
 * to the logic worth testing changed which files covergen targeted and left the
 * reported percentage exactly where it was, because the percentage came from the
 * whole lcov map: a logic-only run still printed the whole-package figure, and
 * every caller that wanted the real one had to compute its own denominator.
 *
 * So every percentage covergen prints is measured twice, over `sources` minus
 * `exclude` and over the whole map, and says which one it is. `sources` is the
 * default because it is the set covergen can actually move.
 */

import { matchesSources } from "./git.js";
import { summarize } from "./lcov.js";
import type { CoverageMap, CoverageScope, CoverageSummary, RepoConfig, ScopedCoverage } from "./types.js";

export const SCOPES: CoverageScope[] = ["sources", "all"];

/** Parse a `--scope` value, with a message that names the accepted ones. */
export function parseScope(raw: string | undefined): CoverageScope {
  if (raw === undefined) return "sources";
  if (raw === "sources" || raw === "all") return raw;
  throw new Error(`Unknown --scope "${raw}". Use sources or all.`);
}

/** The same map read over the repo's sources and over every instrumented file. */
export function scopeCoverage(repo: RepoConfig, map: CoverageMap): ScopedCoverage {
  return {
    sources: summarize(map, (path) => matchesSources(repo, path)),
    all: summarize(map),
  };
}

export function pickScope(coverage: ScopedCoverage, scope: CoverageScope): CoverageSummary {
  return scope === "all" ? coverage.all : coverage.sources;
}

/**
 * True when the two scopes are measuring different things. Equal totals mean
 * the runner instrumented exactly the declared sources, so printing the figure
 * twice would only be noise.
 */
export function scopesDiffer(coverage: ScopedCoverage): boolean {
  return coverage.sources.total !== coverage.all.total;
}

/** "16.0% (24/150 lines over 12 files)" */
export function summaryText(summary: CoverageSummary): string {
  return `${summary.pct.toFixed(1)}% (${summary.covered}/${summary.total} lines over ${summary.files} ${summary.files === 1 ? "file" : "files"})`;
}

/**
 * One line naming both figures, for a report a human reads without the config
 * in front of them. The whole-map half is dropped when it would repeat the
 * other one.
 */
export function coverageLine(coverage: ScopedCoverage, label = "coverage"): string {
  const scoped = `${label}: sources ${summaryText(coverage.sources)}`;
  return scopesDiffer(coverage) ? `${scoped}, whole package ${summaryText(coverage.all)}` : scoped;
}

/** "14.2% before, 16.0% after" for one scope. */
function movement(before: CoverageSummary, after: CoverageSummary): string {
  return `${before.pct.toFixed(1)}% before, ${after.pct.toFixed(1)}% after`;
}

/**
 * The before/after line for a finished run. The scoped figure leads because it
 * is the one the run could move; the whole-map one follows when it differs, so
 * a reviewer comparing this PR against a dashboard sees both numbers rather
 * than concluding one of them is wrong.
 */
export function movementLine(before: ScopedCoverage, after: ScopedCoverage): string {
  const scoped = `Line coverage over the repo's sources: ${movement(before.sources, after.sources)}`;
  if (!scopesDiffer(before) && !scopesDiffer(after)) return `${scoped}.`;
  return `${scoped} (whole package ${movement(before.all, after.all)}).`;
}
