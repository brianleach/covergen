import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { specPathFromTemplate } from "./config.js";
import { buildPromptBlocks, findNearestSpec, loadIdiomPack, numberLines, specCandidates } from "./prompt.js";
import { rulesText } from "./rules.js";
import type { RepoConfig, RunnerName, Segment } from "./types.js";

const tmp = mkdtempSync(join(tmpdir(), "covergen-prompt-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function repoFor(runner: RunnerName, template: string): RepoConfig {
  return {
    name: "demo",
    root: "/repo",
    runner,
    cwd: "/repo",
    sources: ["**/*"],
    specPath: (rel) => specPathFromTemplate(template, rel),
  };
}

const segment: Segment = {
  path: "app/services/charger.rb",
  startLine: 10,
  endLine: 14,
  uncoveredLines: [11, 12, 13],
  text: "10 | def charge\n11 |   raise Denied unless ok?\n12 |   gateway.call\n13 | end",
  symbol: "charge",
};

const baseArgs = {
  idiomPack: "# RSpec idioms\nUse FactoryBot.",
  rulesText: rulesText("rspec"),
  sourcePath: "app/services/charger.rb",
  sourceText: "class Charger\n  def charge\n  end\nend",
  segment,
  runner: "rspec" as RunnerName,
  specPath: "spec/services/charger_spec.rb",
  wholeFile: false,
};

describe("loadIdiomPack", () => {
  it("returns an empty string when no path is given", () => {
    expect(loadIdiomPack()).toBe("");
    expect(loadIdiomPack(undefined)).toBe("");
  });

  it("reads the pack verbatim", () => {
    const path = join(tmp, "pack.md");
    writeFileSync(path, "# Pack\n\nBody line.\n");
    expect(loadIdiomPack(path)).toBe("# Pack\n\nBody line.\n");
  });

  it("throws when the configured pack is missing", () => {
    expect(() => loadIdiomPack(join(tmp, "nope.md"))).toThrow();
  });
});

describe("numberLines", () => {
  it("prefixes every line with a right-aligned number", () => {
    expect(numberLines("a\nb")).toBe("1 | a\n2 | b");
  });

  it("pads to the widest number", () => {
    const out = numberLines(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"));
    expect(out.split("\n")[0]).toBe(" 1 | l0");
    expect(out.split("\n")[9]).toBe("10 | l9");
  });

  it("honors a start offset", () => {
    expect(numberLines("x", 42)).toBe("42 | x");
  });
});

describe("specCandidates / findNearestSpec", () => {
  const rspecRepo = repoFor("rspec", "spec/{dir_sans_app}/{base}_spec.rb");
  const vitestRepo = repoFor("vitest", "{dir}/{base}.test{ext}");

  it("puts the configured spec path first", () => {
    expect(specCandidates(rspecRepo, "app/services/charger.rb")[0]).toBe("spec/services/charger_spec.rb");
  });

  it("returns the conventional path when it exists", () => {
    const found = findNearestSpec(rspecRepo, "app/services/charger.rb", (p) => p === "spec/services/charger_spec.rb");
    expect(found).toBe("spec/services/charger_spec.rb");
  });

  it("falls back to a sibling spec in the source directory", () => {
    const found = findNearestSpec(rspecRepo, "app/services/charger.rb", (p) => p === "app/services/charger_spec.rb");
    expect(found).toBe("app/services/charger_spec.rb");
  });

  it("finds a .spec sibling for a JS runner", () => {
    const found = findNearestSpec(vitestRepo, "src/lib/pay.ts", (p) => p === "src/lib/pay.spec.ts");
    expect(found).toBe("src/lib/pay.spec.ts");
  });

  it("finds a __tests__ sibling for a JS runner", () => {
    const found = findNearestSpec(vitestRepo, "src/lib/pay.ts", (p) => p === "src/lib/__tests__/pay.test.ts");
    expect(found).toBe("src/lib/__tests__/pay.test.ts");
  });

  it("returns undefined when nothing exists", () => {
    expect(findNearestSpec(rspecRepo, "app/services/charger.rb", () => false)).toBeUndefined();
  });

  it("never returns a duplicate candidate", () => {
    const list = specCandidates(vitestRepo, "src/lib/pay.ts");
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("buildPromptBlocks", () => {
  it("puts the idiom pack, the rules and the output format in the stable block", () => {
    const blocks = buildPromptBlocks(baseArgs);
    expect(blocks.stable).toContain("Use FactoryBot.");
    expect(blocks.stable).toContain("Never sleep or wait on a timer");
    expect(blocks.stable).toContain("Return exactly one fenced code block and nothing else");
    expect(blocks.stable).toContain("refactor would break");
  });

  it("keeps the segment out of the stable and semi-stable blocks", () => {
    const blocks = buildPromptBlocks(baseArgs);
    expect(blocks.stable).not.toContain("raise Denied");
    expect(blocks.semiStable).not.toContain("Uncovered lines");
  });

  it("puts the numbered source file in the semi-stable block", () => {
    const blocks = buildPromptBlocks(baseArgs);
    expect(blocks.semiStable).toContain("app/services/charger.rb");
    expect(blocks.semiStable).toContain("1 | class Charger");
  });

  it("includes the nearest spec when there is one", () => {
    const blocks = buildPromptBlocks({
      ...baseArgs,
      nearestSpecPath: "spec/services/charger_spec.rb",
      nearestSpecText: "RSpec.describe Charger do\nend",
    });
    expect(blocks.semiStable).toContain("Existing spec at spec/services/charger_spec.rb");
    expect(blocks.semiStable).toContain("RSpec.describe Charger do");
  });

  it("says a whole new file is needed when no spec exists", () => {
    const blocks = buildPromptBlocks({ ...baseArgs, wholeFile: true });
    expect(blocks.semiStable).toContain("There is no existing spec");
    expect(blocks.semiStable).toContain("complete new spec file at spec/services/charger_spec.rb");
  });

  it("puts the segment, the uncovered lines and the spec path in the volatile block", () => {
    const blocks = buildPromptBlocks(baseArgs);
    expect(blocks.volatile).toContain("raise Denied");
    expect(blocks.volatile).toContain("lines 10 to 14");
    expect(blocks.volatile).toContain("Uncovered lines that this test must execute: 11, 12, 13");
    expect(blocks.volatile).toContain("spec/services/charger_spec.rb");
    expect(blocks.volatile).toContain("`charge`");
  });

  it("asks for an appendable block when the spec file exists", () => {
    const blocks = buildPromptBlocks(baseArgs);
    expect(blocks.stable).toContain("RSpec.describe ... do");
    expect(blocks.stable).toContain("no describe wrapper of its own");
    expect(blocks.volatile).toContain("return only an appendable block");
  });

  it("asks for a complete file when it does not", () => {
    const blocks = buildPromptBlocks({ ...baseArgs, wholeFile: true });
    expect(blocks.stable).toContain("complete contents of a new spec file");
    expect(blocks.volatile).toContain("return the complete file");
  });

  it("names the JS top-level describe for JS runners", () => {
    const blocks = buildPromptBlocks({ ...baseArgs, runner: "vitest", rulesText: rulesText("vitest") });
    expect(blocks.stable).toContain("top-level `describe` block");
    expect(blocks.stable).not.toContain("RSpec.describe");
  });

  it("handles a missing idiom pack without leaving an empty section", () => {
    const blocks = buildPromptBlocks({ ...baseArgs, idiomPack: "" });
    expect(blocks.stable).toContain("There is no idiom pack for this repository");
    expect(blocks.stable).not.toContain("Repository test conventions");
  });

  it("omits the symbol phrase when the segment has none", () => {
    const { symbol, ...rest } = segment;
    const blocks = buildPromptBlocks({ ...baseArgs, segment: rest });
    expect(blocks.volatile).not.toContain("inside `");
  });
});

  it("asks pytest for appendable module-level test functions", () => {
    const blocks = buildPromptBlocks({ ...baseArgs, runner: "pytest" as RunnerName });
    expect(blocks.stable).toContain(
      "- The block must contain one or more module-level `def test_*` functions that can be appended verbatim at the end of that file, at top level, with no imports of their own.",
    );
    expect(blocks.stable).not.toContain("describe wrapper");
  });

  it("asks pytest for a complete new test file when none exists", () => {
    const blocks = buildPromptBlocks({ ...baseArgs, runner: "pytest" as RunnerName, wholeFile: true });
    expect(blocks.stable).toContain(
      "- The block must contain the complete contents of a new test file, including every import.",
    );
    expect(blocks.stable).not.toContain("new spec file");
  });

  it("offers pytest sibling and tests/ candidates for a pytest runner", () => {
    const pytestRepo = repoFor("pytest", "{dir}/{base}.test{ext}");
    const list = specCandidates(pytestRepo, "pkg/billing/pay.py");
    expect(list.slice(1)).toEqual(["pkg/billing/test_pay.py", "tests/test_pay.py"]);
    expect(findNearestSpec(pytestRepo, "pkg/billing/pay.py", (p) => p === "tests/test_pay.py")).toBe("tests/test_pay.py");
  });

  it("asks go for appendable test functions and gofmt output", () => {
    const blocks = buildPromptBlocks({ ...baseArgs, runner: "go" as RunnerName });
    expect(blocks.stable).toContain(
      "- The block must contain one or more `func TestXxx(t *testing.T)` functions that can be appended verbatim at the end of that file, at top level, with no package clause and no imports of their own.",
    );
    expect(blocks.stable).toContain(
      "- The code must be gofmt formatted: tabs for indentation, one statement per line. Unformatted code is rejected before it is run.",
    );
  });

  it("asks go for a complete new test file with a package clause when none exists", () => {
    const blocks = buildPromptBlocks({ ...baseArgs, runner: "go" as RunnerName, wholeFile: true });
    expect(blocks.stable).toContain(
      "- The block must contain the complete contents of a new test file, including the package clause (the same package as the file under test) and every import.",
    );
    expect(blocks.stable).not.toContain("new spec file");
  });

  it("offers only the sibling internal test for a go runner", () => {
    const goRepo = repoFor("go", "{dir}/{base}.test{ext}");
    expect(specCandidates(goRepo, "internal/pay/pay.go")).toEqual([
      "internal/pay/pay.test.go",
      "internal/pay/pay_test.go",
    ]);
    expect(findNearestSpec(goRepo, "internal/pay/pay.go", (p) => p === "internal/pay/pay_test.go")).toBe(
      "internal/pay/pay_test.go",
    );
  });

  it("offers a tests/ candidate for a cargo runner", () => {
    const cargoRepo = repoFor("cargo", "{dir}/{base}.test{ext}");
    const list = specCandidates(cargoRepo, "src/billing/pay.rs");
    expect(list).toEqual(["src/billing/pay.test.rs", "tests/pay.rs"]);
    expect(findNearestSpec(cargoRepo, "src/billing/pay.rs", (p) => p === "tests/pay.rs")).toBe("tests/pay.rs");
  });
