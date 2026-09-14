import { describe, expect, it } from "vitest";
import { buildSegments, numberLines, uncoveredLines } from "./segments.js";
import type { FileCoverage } from "./types.js";

function coverage(path: string, lines: Record<number, number>): FileCoverage {
  return { path, lines: new Map(Object.entries(lines).map(([n, hits]) => [Number(n), hits])) };
}

// 1  class Calculator
// 2    def add(a, b)
// 3      a + b
// 4    end
// 5
// 6    def divide(a, b)
// 7      raise ArgumentError, "zero" if b.zero?
// 8
// 9      a / b
// 10   end
// 11 end
const rubySource = [
  "class Calculator",
  "  def add(a, b)",
  "    a + b",
  "  end",
  "",
  "  def divide(a, b)",
  '    raise ArgumentError, "zero" if b.zero?',
  "",
  "    a / b",
  "  end",
  "end",
].join("\n");

// 1  export function formatCents(cents: number): string {
// 2    if (cents < 0) {
// 3      return `-${formatCents(-cents)}`;
// 4    }
// 5    return `$${(cents / 100).toFixed(2)}`;
// 6  }
// 7
// 8  export class Cart {
// 9    private items: number[] = [];
// 10
// 11   add(price: number): void {
// 12     this.items.push(price);
// 13   }
// 14
// 15   total(): number {
// 16     return this.items.reduce((a, b) => a + b, 0);
// 17   }
// 18 }
const tsSource = [
  "export function formatCents(cents: number): string {",
  "  if (cents < 0) {",
  "    return `-${formatCents(-cents)}`;",
  "  }",
  "  return `$${(cents / 100).toFixed(2)}`;",
  "}",
  "",
  "export class Cart {",
  "  private items: number[] = [];",
  "",
  "  add(price: number): void {",
  "    this.items.push(price);",
  "  }",
  "",
  "  total(): number {",
  "    return this.items.reduce((a, b) => a + b, 0);",
  "  }",
  "}",
].join("\n");

// def build spans lines 2..14, longer than the maxLines used in the test.
const longRubySource = [
  "class Report",
  "  def build(rows)",
  "    out = []",
  "    rows.each do |row|",
  "      next if row.nil?",
  "      out << row.to_s",
  "    end",
  '    out << "a"',
  '    out << "b"',
  '    out << "c"',
  '    out << "d"',
  '    out << "e"',
  "    out",
  "  end",
  "end",
].join("\n");

describe("uncoveredLines", () => {
  it("returns instrumented lines with zero hits in ascending order", () => {
    expect(uncoveredLines(coverage("a.rb", { 9: 0, 3: 1, 5: 0, 1: 2 }))).toEqual([5, 9]);
  });

  it("returns an empty list when there is no coverage for the file", () => {
    expect(uncoveredLines(undefined)).toEqual([]);
  });
});

describe("numberLines", () => {
  it("prefixes each line with its 1-based number", () => {
    expect(numberLines(["a", "b", "c"], 2, 3)).toBe("2: b\n3: c");
  });
});

describe("buildSegments (ruby)", () => {
  it("expands a cluster to the enclosing def and names the symbol", () => {
    const segments = buildSegments({
      path: "app/services/calculator.rb",
      source: rubySource,
      coverage: coverage("app/services/calculator.rb", { 2: 1, 3: 1, 6: 1, 7: 0, 9: 0 }),
      maxLines: 50,
      maxPerFile: 8,
    });
    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment.path).toBe("app/services/calculator.rb");
    expect(segment.symbol).toBe("divide");
    expect(segment.startLine).toBe(6);
    expect(segment.endLine).toBe(10);
    expect(segment.uncoveredLines).toEqual([7, 9]);
    expect(segment.text).toBe(
      [
        "6:   def divide(a, b)",
        '7:     raise ArgumentError, "zero" if b.zero?',
        "8: ",
        "9:     a / b",
        "10:   end",
      ].join("\n"),
    );
  });

  it("merges uncovered lines separated by three or fewer intervening lines", () => {
    // Lines 3 and 7 have three lines between them, so they stay in one cluster.
    const merged = buildSegments({
      path: "a.rb",
      source: rubySource,
      coverage: coverage("a.rb", { 3: 0, 7: 0 }),
      maxLines: 4,
      maxPerFile: 8,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.uncoveredLines).toEqual([3, 7]);
  });

  it("splits clusters separated by more than three lines", () => {
    const segments = buildSegments({
      path: "a.rb",
      source: rubySource,
      coverage: coverage("a.rb", { 3: 0, 9: 0 }),
      maxLines: 4,
      maxPerFile: 8,
    });
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.uncoveredLines)).toEqual([[3], [9]]);
  });

  it("keeps one segment when two uncovered runs expand to the same def", () => {
    const segments = buildSegments({
      path: "a.rb",
      source: longRubySource,
      coverage: coverage("a.rb", { 3: 0, 13: 0 }),
      maxLines: 50,
      maxPerFile: 8,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.startLine).toBe(2);
    expect(segments[0]!.endLine).toBe(14);
    expect(segments[0]!.uncoveredLines).toEqual([3, 13]);
    expect(segments[0]!.symbol).toBe("build");
  });

  it("falls back to cluster plus context when the enclosing def exceeds maxLines", () => {
    const segments = buildSegments({
      path: "a.rb",
      source: longRubySource,
      coverage: coverage("a.rb", { 8: 0, 9: 0, 10: 0 }),
      maxLines: 8,
      maxPerFile: 8,
    });
    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment.endLine - segment.startLine + 1).toBeLessThanOrEqual(8);
    expect(segment.startLine).toBeLessThan(8);
    expect(segment.endLine).toBeGreaterThan(10);
    expect(segment.uncoveredLines).toEqual([8, 9, 10]);
    expect(segment.symbol).toBe("build");
    expect(segment.text.split("\n")).toHaveLength(segment.endLine - segment.startLine + 1);
  });

  it("never runs past the end of the file", () => {
    const segments = buildSegments({
      path: "a.rb",
      source: "a = 1\nb = 2\n",
      coverage: coverage("a.rb", { 2: 0 }),
      maxLines: 50,
      maxPerFile: 8,
    });
    expect(segments[0]!.startLine).toBe(1);
    expect(segments[0]!.endLine).toBeLessThanOrEqual(3);
  });
});

describe("buildSegments (typescript)", () => {
  it("expands to the enclosing function declaration", () => {
    const segments = buildSegments({
      path: "src/lib/money.ts",
      source: tsSource,
      coverage: coverage("src/lib/money.ts", { 1: 4, 2: 4, 3: 0, 5: 4 }),
      maxLines: 50,
      maxPerFile: 8,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.symbol).toBe("formatCents");
    expect(segments[0]!.startLine).toBe(1);
    expect(segments[0]!.endLine).toBe(6);
  });

  it("expands to the enclosing class method", () => {
    const segments = buildSegments({
      path: "src/lib/cart.ts",
      source: tsSource,
      coverage: coverage("src/lib/cart.ts", { 11: 1, 12: 0 }),
      maxLines: 50,
      maxPerFile: 8,
    });
    expect(segments[0]!.symbol).toBe("add");
    expect(segments[0]!.startLine).toBe(11);
    expect(segments[0]!.endLine).toBe(13);
  });

  it("handles an arrow function assigned to a const", () => {
    const source = [
      "export const clamp = (n: number, lo: number, hi: number): number => {",
      "  if (n < lo) {",
      "    return lo;",
      "  }",
      "  return Math.min(n, hi);",
      "};",
    ].join("\n");
    const segments = buildSegments({
      path: "src/clamp.ts",
      source,
      coverage: coverage("src/clamp.ts", { 1: 2, 3: 0 }),
      maxLines: 50,
      maxPerFile: 8,
    });
    expect(segments[0]!.symbol).toBe("clamp");
    expect(segments[0]!.startLine).toBe(1);
    expect(segments[0]!.endLine).toBe(6);
  });

  it("ranks branchy holes above longer straight-line ones and caps at maxPerFile", () => {
    const source = [
      "export function a(n: number) {",
      "  if (n > 0) return 1;",
      "}",
      "",
      "export function b() {",
      "  const x = 1;",
      "  const y = 2;",
      "  return x + y;",
      "}",
      "",
      "export function c() {",
      "  const p = 1;",
      "  const q = 2;",
      "  const r = 3;",
      "  const s = 4;",
      "  return p + q + r + s;",
      "}",
    ].join("\n");
    const segments = buildSegments({
      path: "src/many.ts",
      source,
      coverage: coverage("src/many.ts", { 2: 0, 8: 0, 13: 0, 14: 0, 15: 0 }),
      maxLines: 50,
      maxPerFile: 2,
    });
    // c has the most uncovered lines and none of them decide anything, so it is
    // the one dropped by the cap.
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.symbol)).toEqual(["a", "b"]);
    expect(segments[0]!.uncoveredLines).toEqual([2]);
  });

  it("returns nothing when the file has no coverage entry or nothing is uncovered", () => {
    const args = { path: "src/lib/cart.ts", source: tsSource, maxLines: 50, maxPerFile: 8 };
    expect(buildSegments({ ...args, coverage: undefined })).toEqual([]);
    expect(buildSegments({ ...args, coverage: coverage("src/lib/cart.ts", { 1: 1, 2: 3 }) })).toEqual([]);
  });

  it("falls back to a context window for a file with no detectable declarations", () => {
    const source = Array.from({ length: 20 }, (_, i) => `value${i + 1} = ${i};`).join("\n");
    const segments = buildSegments({
      path: "src/consts.txt",
      source,
      coverage: coverage("src/consts.txt", { 10: 0 }),
      maxLines: 50,
      maxPerFile: 8,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.startLine).toBe(5);
    expect(segments[0]!.endLine).toBe(15);
    expect(segments[0]!.symbol).toBeUndefined();
  });
});

  it("falls back to a context window when a ruby def has no matching end", () => {
    const source = ["def broken(rows)", ...Array.from({ length: 11 }, (_, i) => `  x${i + 1} = ${i}`)].join("\n");
    const segments = buildSegments({
      path: "a.rb",
      source,
      coverage: coverage("a.rb", { 8: 0 }),
      maxLines: 50,
      maxPerFile: 8,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.startLine).toBe(3);
    expect(segments[0]!.endLine).toBe(12);
    expect(segments[0]!.uncoveredLines).toEqual([8]);
    expect(segments[0]!.symbol).toBeUndefined();
  });

  it("falls back to a context window when a declaration's braces never close", () => {
    const source = [
      "export function broken(n: number) {",
      "  if (n > 0) {",
      "    return n;",
      "  }",
      "  const x = 1;",
      "  const y = 2;",
    ].join("\n");
    const segments = buildSegments({
      path: "src/broken.ts",
      source,
      coverage: coverage("src/broken.ts", { 1: 1, 3: 0 }),
      maxLines: 50,
      maxPerFile: 8,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.symbol).toBeUndefined();
    expect(segments[0]!.startLine).toBe(1);
    expect(segments[0]!.endLine).toBe(6);
    expect(segments[0]!.uncoveredLines).toEqual([3]);
  });

  it("stops trimming instead of spinning when the cluster bounds stop shrinking the window", () => {
    // A coverage entry whose line number reports inconsistent values: the clip
    // loop sees a window it can neither trim from the left (`leading` is not
    // positive) nor balance against the right, so it bails out of the loop and
    // falls back to the hard `maxLines` clamp.
    const source = Array.from({ length: 30 }, (_, i) => `value${i + 1} = ${i};`).join("\n");
    let reads = 0;
    const flakyLine = {
      valueOf() {
        reads += 1;
        // 1-2: range filter, 3: window start, 4: window end, 5: loop condition.
        if (reads <= 5) return 10;
        if (reads === 6) return NaN; // the `leading` computation
        return 0;
      },
    };

    const segments = buildSegments({
      path: "src/flaky.txt",
      source,
      coverage: { path: "src/flaky.txt", lines: new Map([[flakyLine, 0]]) } as unknown as FileCoverage,
      maxLines: 3,
      maxPerFile: 8,
    });

    expect(segments).toHaveLength(1);
    // Window opened at 5..15, the loop bailed out, and the clamp cut it to 3 lines.
    expect(segments[0]!.startLine).toBe(5);
    expect(segments[0]!.endLine).toBe(7);
    expect(segments[0]!.symbol).toBeUndefined();
    expect(segments[0]!.text).toBe("5: value5 = 4;\n6: value6 = 5;\n7: value7 = 6;");
  });
