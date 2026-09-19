import { describe, expect, it } from "vitest";
import { auditMarkdown, caseBody, sourceLines, staticReason, totalsOf, verdictFor, type AuditedCase } from "./audit.js";
import type { CoverageMap, RepoConfig } from "./types.js";

const one = (over: Partial<AuditedCase> = {}): AuditedCase => ({
  spec: "src/rates.test.ts",
  case: "adds the rate",
  line: 2,
  verdict: "keeps",
  flags: [],
  caught: 0,
  planted: 0,
  coveredLines: 0,
  uniqueLines: 0,
  durationMs: 0,
  ...over,
});

describe("staticReason", () => {
  it("flags a case with no assertion at all", () => {
    expect(staticReason("it('runs', () => { applyRate(100, 0.1); });", "vitest")).toMatch(/has-assertion/);
  });

  it("flags a literal asserted against itself", () => {
    expect(staticReason("it('x', () => { tierFor(5000); expect(true).toBe(true); });", "vitest")).toMatch(/no-tautology/);
  });

  it("flags a case that never calls the code under test", () => {
    const reason = staticReason("it('x', () => { expect(Object.keys(mod).sort()).toEqual(['a']); });", "vitest");
    expect(reason).toMatch(/behavioral-evidence/);
  });

  it("says nothing about a case that calls the code and checks the result", () => {
    expect(staticReason("it('x', () => { expect(applyRate(100, 0.1)).toBe(110); });", "vitest")).toBeUndefined();
  });

  it("flags a Go case whose body asserts nothing", () => {
    expect(staticReason("func TestApplyRate(t *testing.T) {\n\tApplyRate(100, 10)\n}", "go")).toMatch(/has-assertion/);
  });

  it("ignores a rule the repo turned off", () => {
    expect(staticReason("it('x', () => { applyRate(1, 2); });", "vitest", ["has-assertion"])).toBeUndefined();
  });
});

describe("verdictFor", () => {
  it("keeps a case that catches a planted bug", () => {
    expect(verdictFor({ weakStatic: false, planted: 3, caught: 1, coveredLines: 4, uniqueLines: 0 })).toEqual({ verdict: "keeps", flags: [] });
  });

  it("reports a flagged case that catches nothing as both weak_static and weak_dynamic", () => {
    expect(verdictFor({ weakStatic: true, planted: 2, caught: 0, coveredLines: 5, uniqueLines: 5 })).toEqual({
      verdict: "weak_dynamic",
      flags: ["weak_static", "weak_dynamic"],
    });
  });

  it("reports a case that catches nothing and covers nothing of its own as redundant", () => {
    expect(verdictFor({ weakStatic: false, planted: 2, caught: 0, coveredLines: 4, uniqueLines: 0 })).toEqual({
      verdict: "redundant",
      flags: ["weak_dynamic", "redundant"],
    });
  });

  it("leaves a case no bug could be planted against to the static pass", () => {
    expect(verdictFor({ weakStatic: true, planted: 0, caught: 0, coveredLines: 2, uniqueLines: 0 })).toEqual({
      verdict: "weak_static",
      flags: ["weak_static"],
    });
  });
});

describe("caseBody", () => {
  const text = ["describe('rates', () => {", "  it('a', () => {", "    expect(1).toBe(1);", "  });", "  it('b', () => {", "    expect(2).toBe(2);", "  });", "});"].join("\n");
  const cases = [
    { name: "a", line: 2 },
    { name: "b", line: 5 },
  ];

  it("stops at the next case", () => {
    expect(caseBody(text, cases, 0)).toBe("  it('a', () => {\n    expect(1).toBe(1);\n  });");
  });

  it("runs to the end of the file for the last case", () => {
    expect(caseBody(text, cases, 1)).toMatch(/expect\(2\)/);
  });
});

describe("sourceLines", () => {
  it("keeps covered source lines and drops spec files and unhit lines", () => {
    const repo = { sources: ["src/**/*.ts"] } as RepoConfig;
    const map: CoverageMap = new Map([
      ["src/rates.ts", { path: "src/rates.ts", lines: new Map([[2, 1], [3, 0]]) }],
      ["src/rates.test.ts", { path: "src/rates.test.ts", lines: new Map([[1, 1]]) }],
    ]);
    expect([...sourceLines(repo, map)]).toEqual(["src/rates.ts:2"]);
  });
});

describe("the report", () => {
  const cases = [
    one({ case: "adds the rate", caught: 1, planted: 2, coveredLines: 3, durationMs: 400 }),
    one({ case: "leaves its arguments alone", verdict: "redundant", flags: ["weak_dynamic", "redundant"], planted: 2, coveredLines: 3, durationMs: 300 }),
    one({ case: "handles a high amount", verdict: "weak_dynamic", flags: ["weak_static", "weak_dynamic"], reason: "no-tautology: ...", planted: 2, coveredLines: 4, uniqueLines: 4, durationMs: 200 }),
  ];

  it("counts every flag, not only the verdict", () => {
    expect(totalsOf(cases)).toEqual({
      cases: 3,
      keeps: 1,
      weakStatic: 1,
      weakDynamic: 2,
      redundant: 1,
      planted: 6,
      caught: 1,
      wastedMs: 500,
    });
  });

  it("leads with a sentence naming the count, the redundant share and the seconds", () => {
    const markdown = auditMarkdown({
      startedAt: "2026-09-19T00:00:00.000Z",
      endedAt: "2026-09-19T00:00:10.000Z",
      durationMs: 10_000,
      deep: false,
      totals: totalsOf(cases),
      repos: [{ repo: "audit-vitest", runner: "vitest", granularity: "case", specs: 1, auditedCases: cases, slowestSpecs: [{ spec: "src/rates.test.ts", cases: 3, durationMs: 900 }] }],
    });
    expect(markdown).toContain("2 cases run code without checking it, 1 of them cover nothing the rest of the suite does not, and together they cost 0.5 seconds per run.");
    expect(markdown).toContain("| weak_dynamic, redundant | src/rates.test.ts:2 | leaves its arguments alone | 0/2 | 0/3 |");
    expect(markdown).toContain("- src/rates.test.ts: 0.9s over 3 cases");
    // The kept case is not in the table: the report is a list of findings.
    expect(markdown).not.toContain("| adds the rate |");
  });
});
