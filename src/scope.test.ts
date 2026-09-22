import { describe, expect, it } from "vitest";
import { baselineSummaryText } from "./cli.js";
import { parseLcov } from "./lcov.js";
import { coverageLine, movementLine, parseScope, pickScope, scopeCoverage, scopesDiffer, summaryText } from "./scope.js";
import type { RepoConfig } from "./types.js";

/**
 * A report that measured more than the repo declares: two source files, a spec
 * file, a build config and a vendored bundle. Only `src/**` minus the excluded
 * generated file is what a sweep of this repo could ever move, and it is much
 * better covered than the report as a whole. That gap is the whole point.
 */
const lcov = `SF:src/a.ts
DA:1,1
DA:2,1
DA:3,0
end_of_record
SF:src/b.ts
DA:1,1
DA:2,0
end_of_record
SF:src/generated.ts
DA:1,0
DA:2,0
end_of_record
SF:src/a.test.ts
DA:1,1
DA:2,1
end_of_record
SF:build.config.ts
DA:1,0
DA:2,0
DA:3,0
end_of_record
SF:vendor/big.js
DA:1,0
DA:2,0
DA:3,0
DA:4,0
DA:5,0
end_of_record
`;

const repo: RepoConfig = {
  name: "fixture",
  root: "/repo",
  runner: "vitest",
  cwd: "/repo",
  sources: ["src/**/*.ts"],
  exclude: ["src/generated.ts"],
  specPath: (rel) => rel.replace(/\.ts$/, ".test.ts"),
};

describe("scopeCoverage", () => {
  it("measures the repo's sources and the whole report separately", () => {
    const coverage = scopeCoverage(repo, parseLcov(lcov));
    // src/a.ts and src/b.ts only: the excluded generated file, the spec file,
    // the build config and the vendored bundle are all outside `sources`.
    expect(coverage.sources).toEqual({ covered: 3, total: 5, pct: 60, files: 2 });
    expect(coverage.all).toEqual({ covered: 5, total: 17, pct: (5 / 17) * 100, files: 6 });
    expect(scopesDiffer(coverage)).toBe(true);
  });

  it("reports one figure when the report instrumented exactly the sources", () => {
    const narrow = parseLcov("SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n");
    const coverage = scopeCoverage(repo, narrow);
    expect(coverage.sources).toEqual(coverage.all);
    expect(scopesDiffer(coverage)).toBe(false);
    expect(coverageLine(coverage)).toBe("coverage: sources 50.0% (1/2 lines over 1 file)");
  });

  it("picks the scope asked for", () => {
    const coverage = scopeCoverage(repo, parseLcov(lcov));
    expect(pickScope(coverage, "sources")).toBe(coverage.sources);
    expect(pickScope(coverage, "all")).toBe(coverage.all);
  });

  it("names both figures on one line when they differ", () => {
    expect(coverageLine(scopeCoverage(repo, parseLcov(lcov)))).toBe(
      "coverage: sources 60.0% (3/5 lines over 2 files), whole package 29.4% (5/17 lines over 6 files)",
    );
  });

  it("formats a summary with its own denominator", () => {
    expect(summaryText({ covered: 3, total: 5, pct: 60, files: 2 })).toBe("60.0% (3/5 lines over 2 files)");
  });
});

describe("parseScope", () => {
  it("defaults to the repo's sources", () => {
    expect(parseScope(undefined)).toBe("sources");
    expect(parseScope("sources")).toBe("sources");
    expect(parseScope("all")).toBe("all");
  });

  it("names the accepted values when given something else", () => {
    expect(() => parseScope("logic")).toThrow('Unknown --scope "logic". Use sources or all.');
  });
});

describe("movementLine", () => {
  it("leads with the scoped figure and keeps the whole-package one beside it", () => {
    const before = scopeCoverage(repo, parseLcov(lcov));
    // One more covered line in src/b.ts, which is the only thing a run moves.
    const after = scopeCoverage(repo, parseLcov(lcov.replace("SF:src/b.ts\nDA:1,1\nDA:2,0", "SF:src/b.ts\nDA:1,1\nDA:2,3")));
    expect(movementLine(before, after)).toBe(
      "Line coverage over the repo's sources: 60.0% before, 80.0% after (whole package 29.4% before, 35.3% after).",
    );
  });

  it("says it once when the report measured only the sources", () => {
    const before = scopeCoverage(repo, parseLcov("SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n"));
    const after = scopeCoverage(repo, parseLcov("SF:src/a.ts\nDA:1,1\nDA:2,1\nend_of_record\n"));
    expect(movementLine(before, after)).toBe(
      "Line coverage over the repo's sources: 50.0% before, 100.0% after.",
    );
  });
});

describe("baselineSummaryText", () => {
  const coverage = scopeCoverage(repo, parseLcov(lcov));

  it("prints the scoped figure and the whole one under the default scope", () => {
    expect(baselineSummaryText("fixture", coverage, "sources")).toBe(
      "fixture sources: 3/5 lines covered (60.0%) across 2 files\n" +
        "fixture whole report: 5/17 lines covered (29.4%) across 6 files\n\n",
    );
  });

  it("prints the whole-report figure alone under --scope all", () => {
    expect(baselineSummaryText("fixture", coverage, "all")).toBe(
      "fixture whole report: 5/17 lines covered (29.4%) across 6 files\n\n",
    );
  });

  it("prints one line when the two scopes agree", () => {
    const narrow = scopeCoverage(repo, parseLcov("SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n"));
    expect(baselineSummaryText("fixture", narrow, "sources")).toBe(
      "fixture sources: 1/2 lines covered (50.0%) across 1 file\n\n",
    );
  });
});
