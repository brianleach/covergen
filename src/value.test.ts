import { describe, expect, it } from "vitest";
import type { CoverageMap, RepoConfig } from "./types.js";
import { branchCount, churnCounts, importKeys, rankByValue, stripNoise, valueTable } from "./value.js";

const repo: RepoConfig = {
  name: "fixture",
  root: "/repo",
  runner: "vitest",
  cwd: "/repo",
  sources: ["src/**/*.ts"],
  specPath: (rel) => rel.replace(/\.ts$/, ".test.ts"),
};

const file = (path: string, source: string): [string, string] => [path, source];

/** Coverage in which every line of every fixture file is instrumented and unhit. */
function allUncovered(files: Array<[string, string]>): CoverageMap {
  const map: CoverageMap = new Map();
  for (const [path, source] of files) {
    const lines = new Map(source.split("\n").map((_, i) => [i + 1, 0]));
    map.set(path, { path, lines });
  }
  return map;
}

/** A root that is not a git repository: churn must degrade to zero, not throw. */
const noGit = async () => ({ stdout: "", stderr: "not a git repository", exitCode: 128 });

const rank = async (files: Array<[string, string]>, exec = noGit) =>
  rankByValue({
    repo,
    baseline: allUncovered(files),
    targets: files.map(([path]) => path),
    read: async (abs) => files.find(([path]) => abs.endsWith(path))?.[1] ?? "",
    exec,
  });

// A schema: 24 uncovered lines, no decisions in any of them.
const SCHEMA = file(
  "src/schema.ts",
  ["export const columns = {", ...Array.from({ length: 22 }, (_, i) => `  field${i}: "text",`), "};"].join("\n"),
);
// A router: 40 uncovered lines, moderately branchy. Bigger and busier than the
// limiter below, and still worth less, because size enters under a square root.
const ROUTER = file(
  "src/router.ts",
  Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? `  if (p === ${i}) return ${i};` : `  const v${i} = ${i};`)).join("\n"),
);
// A rate limiter: 6 uncovered lines, four of them decisions.
const LIMITER = file(
  "src/limiter.ts",
  [
    "export function allow(hits: number, cap: number, burst?: number) {",
    "  if (hits < 0) throw new Error('negative');",
    "  const ceiling = burst ?? cap;",
    "  if (hits >= ceiling) return false;",
    "  return hits < cap || burst !== undefined;",
    "}",
  ].join("\n"),
);

describe("stripNoise and branchCount", () => {
  it("does not count decisions that only appear in comments or strings", () => {
    expect(stripNoise('const a = "if b && c"; // if d\n')).not.toMatch(/if|&&/);
    expect(branchCount('const msg = "if this && that"; // unless x\n')).toBe(0);
    expect(branchCount("/* if a || b */\nconst n = 1;\n")).toBe(0);
    expect(branchCount("# if a\nvalue = 1\n")).toBe(0);
  });

  it("counts branches, weights bare exits at half, and ignores optional markers", () => {
    expect(branchCount("if (a && b) { return 1; }")).toBe(2.5);
    expect(branchCount("const x = ok ? 1 : 2;")).toBe(1);
    expect(branchCount("interface Row { id?: string; name?: string }")).toBe(0);
  });

  it("reads an import specifier as both its stem and the path it resolves to", () => {
    expect(importKeys("src/cli.ts", 'import { rank } from "./value.js";')).toEqual(["value", "src/value"]);
    expect(importKeys("lib/a.rb", 'require "json"')).toEqual(["json"]);
  });
});

describe("churnCounts", () => {
  it("counts one commit per file per appearance and tolerates a non-git root", async () => {
    const log = ["", "src/a.ts", "src/b.ts", "", "src/a.ts", ""].join("\n");
    const counts = await churnCounts("/repo", 180, async () => ({ stdout: log, stderr: "", exitCode: 0 }));
    expect(counts.get("src/a.ts")).toBe(2);
    expect(counts.get("src/b.ts")).toBe(1);
    expect(await churnCounts("/repo", 180, noGit)).toEqual(new Map());
  });
});

describe("rankByValue", () => {
  it("ranks a small branchy module over a large flat schema, which gap order does not", async () => {
    const rows = await rank([SCHEMA, LIMITER]);
    expect(rows.map((r) => r.path)).toEqual(["src/limiter.ts", "src/schema.ts"]);

    // The same two files by uncovered lines alone, which is what --order gap does.
    const byGap = [...rows].sort((a, b) => b.uncovered - a.uncovered).map((r) => r.path);
    expect(byGap).toEqual(["src/schema.ts", "src/limiter.ts"]);
    expect(rows[0]!.uncovered).toBeLessThan(rows[1]!.uncovered);
    expect(rows[1]!.branches).toBe(0);
  });

  it("ranks a small dense module over a large moderately branchy one", async () => {
    const rows = await rank([ROUTER, LIMITER]);
    expect(rows.map((r) => r.path)).toEqual(["src/limiter.ts", "src/router.ts"]);
    // Both have real branches, so only the square root on size separates them:
    // multiplied by uncovered lines instead, the router would win.
    expect(rows[1]!.density).toBeGreaterThan(0);
    expect(rows[1]!.uncovered * rows[1]!.density).toBeGreaterThan(rows[0]!.uncovered * rows[0]!.density);
  });

  it("lets churn and importers break a tie between equally branchy files", async () => {
    const body = "export function f(a: number) {\n  if (a > 1) return 1;\n  return 2;\n}";
    const files = [file("src/hot.ts", body), file("src/cold.ts", body), file("src/uses.ts", 'import "./hot.js";')];
    const rows = await rank(files, async () => ({
      stdout: ["", "src/hot.ts", "", "src/hot.ts", ""].join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    expect(rows[0]!.path).toBe("src/hot.ts");
    expect(rows[0]!.churn).toBe(2);
    expect(rows[0]!.importers).toBe(1);
    expect(rows[0]!.score).toBeGreaterThan(rows.find((r) => r.path === "src/cold.ts")!.score);
  });

  it("sorts a file the baseline knows nothing about last", async () => {
    const rows = await rankByValue({
      repo,
      baseline: allUncovered([LIMITER]),
      targets: ["src/unknown.ts", LIMITER[0]],
      read: async () => LIMITER[1],
      exec: noGit,
    });
    expect(rows.map((r) => r.path)).toEqual([LIMITER[0], "src/unknown.ts"]);
    expect(rows[1]!.uncovered).toBe(-1);
  });
});

describe("valueTable", () => {
  it("prints every component of the score next to the file", async () => {
    const rows = await rank([LIMITER]);
    const table = valueTable(rows);
    expect(table.split("\n")[0]).toContain("score");
    expect(table).toMatch(/score\s+uncov\s+pct\s+branch\s+churn\s+imports\s+file/);
    expect(table).toContain("src/limiter.ts");
    expect(table).toContain(rows[0]!.score.toFixed(2));
  });
});

describe("rankByValue without a reader", () => {
  it("reads targets from disk and scores an unreadable one as branchless", async () => {
    const cwd = new URL(".", import.meta.url).pathname;
    const rows = await rankByValue({
      repo: { ...repo, cwd },
      baseline: allUncovered([file("value.ts", "\n".repeat(199)), file("missing.ts", "\n".repeat(9))]),
      targets: ["value.ts", "missing.ts"],
      exec: noGit,
    });
    const real = rows.find((r) => r.path === "value.ts")!;
    const missing = rows.find((r) => r.path === "missing.ts")!;
    expect(real.uncovered).toBe(200);
    expect(real.branches).toBeGreaterThan(0);
    expect(missing.uncovered).toBe(10);
    expect(missing.branches).toBe(0);
    expect(missing.density).toBe(0);
    expect(rows.map((r) => r.path)).toEqual(["value.ts", "missing.ts"]);
  });
});
