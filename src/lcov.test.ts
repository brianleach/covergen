import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffCoverage, mergeCoverage, normalizePath, parseLcov, readLcov, summarize } from "./lcov.js";
import type { CoverageMap } from "./types.js";

/** SimpleCov (Ruby) writes repo-relative paths and a TN: header. */
const simplecovLcov = `TN:
SF:app/services/foo.rb
DA:1,1
DA:2,1
DA:5,0
DA:6,0
LF:4
LH:2
end_of_record
TN:
SF:app/models/bar.rb
DA:3,4
DA:4,0
LF:2
LH:1
end_of_record
`;

/** Vitest + v8 writes ./-prefixed paths and function/branch records. */
const v8Lcov = `TN:
SF:./src/lib/money.ts
FN:3,formatCents
FNDA:12,formatCents
FNF:1
FNH:1
DA:3,12
DA:4,12
DA:7,0
BRDA:3,0,0,12
BRDA:3,0,1,0
BRF:2
BRH:1
LF:3
LH:2
end_of_record
`;

/** bun test writes absolute SF paths. */
const bunLcov = `SF:/repo/react-app/src/utils/cart.ts
DA:1,3
DA:2,0
DA:3,0
end_of_record
`;

/** Jest + istanbul: FN/FNDA/BRDA must be ignored without error. */
const jestLcov = `TN:
SF:/repo/web/src/pages/checkout.tsx
FN:10,(anonymous_0)
FN:22,handleSubmit
FNDA:0,(anonymous_0)
FNDA:5,handleSubmit
FNF:2
FNH:1
DA:10,0
DA:11,0
DA:22,5
BRDA:22,1,0,5
BRDA:22,1,1,0
BRF:2
BRH:1
LF:3
LH:1
end_of_record
`;

function map(entries: Record<string, Record<number, number>>): CoverageMap {
  const out: CoverageMap = new Map();
  for (const [path, lines] of Object.entries(entries)) {
    out.set(path, {
      path,
      lines: new Map(Object.entries(lines).map(([n, hits]) => [Number(n), hits])),
    });
  }
  return out;
}

describe("parseLcov", () => {
  it("parses SimpleCov output with repo-relative Ruby paths", () => {
    const cov = parseLcov(simplecovLcov);
    expect([...cov.keys()]).toEqual(["app/services/foo.rb", "app/models/bar.rb"]);
    const foo = cov.get("app/services/foo.rb");
    expect(foo?.lines.get(1)).toBe(1);
    expect(foo?.lines.get(5)).toBe(0);
    expect(foo?.lines.has(3)).toBe(false);
  });

  it("strips a leading ./ from v8 lcov paths and ignores FN/BRDA records", () => {
    const cov = parseLcov(v8Lcov);
    expect([...cov.keys()]).toEqual(["src/lib/money.ts"]);
    const file = cov.get("src/lib/money.ts");
    expect([...(file?.lines.entries() ?? [])]).toEqual([
      [3, 12],
      [4, 12],
      [7, 0],
    ]);
  });

  it("makes bun absolute SF paths relative to cwd", () => {
    const cov = parseLcov(bunLcov, { cwd: "/repo/react-app" });
    expect([...cov.keys()]).toEqual(["src/utils/cart.ts"]);
    expect(cov.get("src/utils/cart.ts")?.lines.get(2)).toBe(0);
  });

  it("parses Jest istanbul output without choking on function or branch lines", () => {
    const cov = parseLcov(jestLcov, { cwd: "/repo/web" });
    const file = cov.get("src/pages/checkout.tsx");
    expect(file).toBeDefined();
    expect(file?.lines.get(10)).toBe(0);
    expect(file?.lines.get(22)).toBe(5);
    expect(file?.lines.size).toBe(3);
  });

  it("keeps absolute paths that do not live under cwd", () => {
    const cov = parseLcov(bunLcov, { cwd: "/somewhere/else" });
    expect([...cov.keys()]).toEqual(["/repo/react-app/src/utils/cart.ts"]);
  });

  it("applies stripPrefix before normalizing", () => {
    const cov = parseLcov("SF:packages/api/src/a.ts\nDA:1,0\nend_of_record\n", { stripPrefix: "packages/api" });
    expect([...cov.keys()]).toEqual(["src/a.ts"]);
  });

  it("merges duplicate SF blocks by summing hits", () => {
    const text = `SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\nSF:src/a.ts\nDA:1,2\nDA:2,0\nDA:3,1\nend_of_record\n`;
    const cov = parseLcov(text);
    expect(cov.size).toBe(1);
    const file = cov.get("src/a.ts");
    expect(file?.lines.get(1)).toBe(3);
    expect(file?.lines.get(2)).toBe(0);
    expect(file?.lines.get(3)).toBe(1);
  });

  it("returns an empty map for empty input", () => {
    expect(parseLcov("").size).toBe(0);
    expect(parseLcov("\n\n  \n").size).toBe(0);
  });

  it("ignores DA records that appear before any SF record", () => {
    expect(parseLcov("DA:1,1\nend_of_record\n").size).toBe(0);
  });

  it("normalizes backslash paths to forward slashes", () => {
    const cov = parseLcov("SF:src\\lib\\a.ts\nDA:1,1\nend_of_record\n");
    expect([...cov.keys()]).toEqual(["src/lib/a.ts"]);
  });
});

describe("normalizePath", () => {
  it("collapses repeated ./ prefixes", () => {
    expect(normalizePath("././src/a.ts")).toBe("src/a.ts");
  });
});

describe("readLcov", () => {
  it("reads and parses a file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "covergen-lcov-"));
    const file = join(dir, "lcov.info");
    await writeFile(file, simplecovLcov, "utf8");
    const cov = await readLcov(file);
    expect(cov.size).toBe(2);
    expect(cov.get("app/models/bar.rb")?.lines.get(3)).toBe(4);
  });
});

describe("mergeCoverage", () => {
  it("sums hits across maps and keeps files unique to one side", () => {
    const a = map({ "src/a.ts": { 1: 1, 2: 0 }, "src/only-a.ts": { 1: 0 } });
    const b = map({ "src/a.ts": { 1: 2, 3: 5 }, "src/only-b.ts": { 9: 1 } });
    const merged = mergeCoverage(a, b);
    expect([...merged.keys()].sort()).toEqual(["src/a.ts", "src/only-a.ts", "src/only-b.ts"]);
    const file = merged.get("src/a.ts");
    expect(file?.lines.get(1)).toBe(3);
    expect(file?.lines.get(2)).toBe(0);
    expect(file?.lines.get(3)).toBe(5);
  });

  it("does not mutate its inputs", () => {
    const a = map({ "src/a.ts": { 1: 1 } });
    const b = map({ "src/a.ts": { 1: 1 } });
    mergeCoverage(a, b);
    expect(a.get("src/a.ts")?.lines.get(1)).toBe(1);
    expect(b.get("src/a.ts")?.lines.get(1)).toBe(1);
  });
});

describe("diffCoverage", () => {
  it("reports newly covered lines and coverage totals", () => {
    const before = map({ "src/a.ts": { 1: 1, 2: 0, 3: 0 } });
    const after = map({ "src/a.ts": { 1: 1, 2: 4, 3: 0 } });
    const delta = diffCoverage(before, after, "src/a.ts");
    expect(delta.newlyCovered).toEqual([2]);
    expect(delta.lost).toEqual([]);
    expect(delta.before).toEqual({ covered: 1, total: 3 });
    expect(delta.after).toEqual({ covered: 2, total: 3 });
  });

  it("reports lost lines as a regression", () => {
    const before = map({ "src/a.ts": { 1: 2, 2: 1 } });
    const after = map({ "src/a.ts": { 1: 2, 2: 0 } });
    const delta = diffCoverage(before, after, "src/a.ts");
    expect(delta.lost).toEqual([2]);
    expect(delta.newlyCovered).toEqual([]);
  });

  it("totals the union of lines instrumented in either map", () => {
    const before = map({ "src/a.ts": { 1: 1, 2: 0 } });
    const after = map({ "src/a.ts": { 2: 1, 3: 0, 4: 1 } });
    const delta = diffCoverage(before, after, "src/a.ts");
    expect(delta.before.total).toBe(4);
    expect(delta.after.total).toBe(4);
    expect(delta.newlyCovered).toEqual([2, 4]);
    expect(delta.lost).toEqual([]);
  });

  it("handles a file missing from the before map", () => {
    const delta = diffCoverage(new Map(), map({ "src/a.ts": { 1: 1, 2: 0 } }), "src/a.ts");
    expect(delta.newlyCovered).toEqual([1]);
    expect(delta.before).toEqual({ covered: 0, total: 2 });
    expect(delta.after).toEqual({ covered: 1, total: 2 });
  });

  it("returns empty results for a path in neither map", () => {
    const delta = diffCoverage(new Map(), new Map(), "src/nope.ts");
    expect(delta).toEqual({
      path: "src/nope.ts",
      newlyCovered: [],
      lost: [],
      before: { covered: 0, total: 0 },
      after: { covered: 0, total: 0 },
    });
  });
});

describe("summarize", () => {
  it("counts covered and instrumented lines across every file", () => {
    const cov = parseLcov(simplecovLcov);
    expect(summarize(cov)).toEqual({ covered: 3, total: 6, pct: 50 });
  });

  it("returns zero percent for an empty map", () => {
    expect(summarize(new Map())).toEqual({ covered: 0, total: 0, pct: 0 });
  });
});

it("drops DA records under an SF path that strips to empty", () => {
  const text = "SF:src/a.ts\nDA:1,1\nSF:packages/api\nDA:2,5\nend_of_record\n";
  const cov = parseLcov(text, { stripPrefix: "packages/api" });
  expect([...cov.keys()]).toEqual(["src/a.ts"]);
  expect([...(cov.get("src/a.ts")?.lines.entries() ?? [])]).toEqual([[1, 1]]);
});
