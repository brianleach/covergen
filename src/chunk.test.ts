import { describe, expect, it } from "vitest";
import { countLines, packSpecFiles, partBody, partTitle, specFileFull, type SpecFile } from "./chunk.js";

const files = (...sizes: number[]): SpecFile[] => sizes.map((lines, i) => ({ path: `spec/s${i}_spec.rb`, lines }));
const shape = (parts: SpecFile[][]): number[][] => parts.map((part) => part.map((f) => f.lines));

describe("countLines", () => {
  it("counts lines without inventing one for the trailing newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
  });
});

describe("packSpecFiles", () => {
  it("keeps a run that fits in one part", () => {
    expect(shape(packSpecFiles(files(100, 200), 600))).toEqual([[100, 200]]);
    expect(packSpecFiles([], 600)).toEqual([]);
  });

  it("packs greedily in accepted order", () => {
    expect(shape(packSpecFiles(files(400, 300, 200, 100), 600))).toEqual([
      [400],
      [300, 200, 100],
    ]);
    expect(shape(packSpecFiles(files(400, 300, 200, 150), 600))).toEqual([
      [400],
      [300, 200],
      [150],
    ]);
  });

  it("gives a file larger than the whole budget a part of its own", () => {
    expect(shape(packSpecFiles(files(1044), 600))).toEqual([[1044]]);
    expect(shape(packSpecFiles(files(100, 1044, 50), 600))).toEqual([[100], [1044], [50]]);
  });

  it("treats an exact fit as fitting", () => {
    expect(shape(packSpecFiles(files(300, 300), 600))).toEqual([[300, 300]]);
    expect(shape(packSpecFiles(files(300, 301), 600))).toEqual([[300], [301]]);
    expect(shape(packSpecFiles(files(600, 600), 600))).toEqual([[600], [600]]);
  });

  it("opens one PR when the ceiling is disabled", () => {
    expect(shape(packSpecFiles(files(5000, 5000), 0))).toEqual([[5000, 5000]]);
  });
});

describe("partTitle and partBody", () => {
  it("numbers the title and heads the body with this part's files", () => {
    expect(partTitle("covergen: 9 tests accepted in api", 2, 3)).toBe("covergen: 9 tests accepted in api (part 2 of 3)");
    const body = partBody("# the whole run\n", {
      index: 2,
      total: 3,
      files: files(120, 1),
      siblings: ["https://example.test/pr/1", undefined, undefined],
    });
    expect(body).toContain("**Part 2 of 3**");
    expect(body).toContain("`spec/s0_spec.rb` (120 lines)");
    expect(body).toContain("`spec/s1_spec.rb` (1 line)");
    // Its own number is never listed as a sibling, and a part that is not open
    // yet says so rather than showing an empty link.
    expect(body).toContain("- part 1: https://example.test/pr/1");
    expect(body).not.toContain("- part 2:");
    expect(body).toContain("- part 3: not opened yet");
    expect(body.endsWith("# the whole run\n")).toBe(true);
  });
});

describe("specFileFull", () => {
  it("is reached at the ceiling and disabled at 0", () => {
    expect(specFileFull(499, 500)).toBe(false);
    expect(specFileFull(500, 500)).toBe(true);
    expect(specFileFull(1044, 500)).toBe(true);
    expect(specFileFull(5000, 0)).toBe(false);
  });
});
