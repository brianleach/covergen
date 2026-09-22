import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyAccepted,
  appendJs,
  mutationScore,
  prBody,
  specQuality,
  spliceForRunner,
  spliceRspec,
} from "./emit.js";
import type { Candidate, CoverageDelta, RepoConfig, RunSummary, RunnerName, Segment } from "./types.js";

async function tempRepo(runner: RunnerName = "rspec"): Promise<RepoConfig> {
  const root = await mkdtemp(join(tmpdir(), "covergen-emit-"));
  return {
    name: "fixture",
    root,
    runner,
    cwd: root,
    sources: ["app/**/*.rb"],
    specPath: (rel) => `spec/${rel.replace(/\.rb$/, "_spec.rb")}`,
  };
}

function segment(over: Partial<Segment> = {}): Segment {
  return {
    path: "app/services/foo.rb",
    startLine: 10,
    endLine: 14,
    uncoveredLines: [11, 12],
    text: "10: def call\n11:   :ok\n12: end",
    symbol: "Foo#call",
    ...over,
  };
}

function delta(over: Partial<CoverageDelta> = {}): CoverageDelta {
  return {
    path: "app/services/foo.rb",
    newlyCovered: [11, 12],
    lost: [],
    before: { covered: 4, total: 10 },
    after: { covered: 6, total: 10 },
    ...over,
  };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: over.id ?? "c1",
    hash: over.hash ?? "hash-1",
    segment: over.segment ?? segment(),
    specPath: over.specPath ?? "spec/services/foo_spec.rb",
    code: over.code ?? 'it "returns ok" do\n  expect(Foo.new.call).to eq(:ok)\nend',
    wholeFile: over.wholeFile ?? false,
    status: over.status ?? "accepted",
    attempts: over.attempts ?? 1,
    lastError: over.lastError,
    delta: "delta" in over ? over.delta : delta(),
    mutation: over.mutation,
    history: over.history ?? [],
  };
}

describe("spliceRspec", () => {
  const existing = ['RSpec.describe Foo do', '  it "exists" do', "    expect(Foo).to be", "  end", "end", ""].join("\n");

  it("inserts the block before the outer closing end", () => {
    const out = spliceRspec(existing, 'it "added" do\n  expect(1).to eq(1)\nend');
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toBe("end");
    expect(out).toContain('  it "added" do');
    expect(out.indexOf('it "added"')).toBeGreaterThan(out.indexOf('it "exists"'));
    expect(out.endsWith("end\n")).toBe(true);
  });

  it("indents the inserted block by two spaces", () => {
    const out = spliceRspec(existing, 'it "added" do\nend');
    expect(out).toContain('\n  it "added" do\n  end\n');
  });

  it("keeps only one closing end", () => {
    const out = spliceRspec(existing, 'it "added" do\nend');
    expect(out.split("\n").filter((l) => l === "end")).toHaveLength(1);
  });

  it("appends at EOF when there is no top level end", () => {
    const out = spliceRspec("# just a comment\n", 'it "added" do\nend');
    expect(out).toContain("# just a comment");
    expect(out.trimEnd().endsWith('it "added" do\nend')).toBe(true);
  });
});

describe("appendJs", () => {
  it("appends at end of file with one blank line", () => {
    const out = appendJs('describe("a", () => {});\n', 'describe("b", () => {});');
    expect(out).toBe('describe("a", () => {});\n\ndescribe("b", () => {});\n');
  });

  it("handles an empty file", () => {
    expect(appendJs("", "x")).toBe("x\n");
  });
});

describe("spliceForRunner", () => {
  it("uses the rspec splice for rspec and EOF append for JS runners", () => {
    const rb = spliceForRunner("rspec", "RSpec.describe Foo do\nend\n", "it 'x' do\nend");
    expect(rb.trimEnd().endsWith("end")).toBe(true);
    expect(rb).toContain("  it 'x' do");
    const js = spliceForRunner("vitest", 'test("a", () => {});\n', 'test("b", () => {});');
    expect(js).toContain('test("b"');
  });
});

describe("applyAccepted", () => {
  it("appends a block into an existing spec file", async () => {
    const repo = await tempRepo("rspec");
    const spec = join(repo.cwd, "spec/services/foo_spec.rb");
    await mkdir(join(repo.cwd, "spec/services"), { recursive: true });
    await writeFile(spec, 'RSpec.describe Foo do\n  it "old" do\n  end\nend\n', "utf8");

    const res = await applyAccepted(repo, [candidate()]);
    expect(res.written).toEqual(["spec/services/foo_spec.rb"]);
    expect(res.skipped).toEqual([]);
    const content = await readFile(spec, "utf8");
    expect(content).toContain('it "old"');
    expect(content).toContain('it "returns ok"');
  });

  it("writes several blocks into one spec file with a single write", async () => {
    const repo = await tempRepo("rspec");
    const spec = join(repo.cwd, "spec/services/foo_spec.rb");
    await mkdir(join(repo.cwd, "spec/services"), { recursive: true });
    await writeFile(spec, "RSpec.describe Foo do\nend\n", "utf8");

    const res = await applyAccepted(repo, [
      candidate({ id: "a", hash: "h1", code: "it 'one' do\nend" }),
      candidate({ id: "b", hash: "h2", code: "it 'two' do\nend" }),
    ]);
    expect(res.written).toEqual(["spec/services/foo_spec.rb"]);
    const content = await readFile(spec, "utf8");
    expect(content).toContain("it 'one'");
    expect(content).toContain("it 'two'");
    expect(content.split("\n").filter((l) => l === "end")).toHaveLength(1);
  });

  it("creates a new file for a whole file candidate", async () => {
    const repo = await tempRepo("vitest");
    const res = await applyAccepted(repo, [
      candidate({ specPath: "src/foo.test.ts", wholeFile: true, code: 'test("x", () => {});' }),
    ]);
    expect(res.written).toEqual(["src/foo.test.ts"]);
    const content = await readFile(join(repo.cwd, "src/foo.test.ts"), "utf8");
    expect(content).toBe('test("x", () => {});\n');
  });

  it("never overwrites an existing file for a whole file candidate", async () => {
    const repo = await tempRepo("vitest");
    await mkdir(join(repo.cwd, "src"), { recursive: true });
    await writeFile(join(repo.cwd, "src/foo.test.ts"), "// hand written\n", "utf8");

    const res = await applyAccepted(repo, [
      candidate({ specPath: "src/foo.test.ts", wholeFile: true, code: 'test("x", () => {});' }),
    ]);
    expect(res.written).toEqual([]);
    expect(res.skipped[0]?.spec).toBe("src/foo.test.ts");
    expect(res.skipped[0]?.reason).toMatch(/refusing to overwrite/);
    expect(await readFile(join(repo.cwd, "src/foo.test.ts"), "utf8")).toBe("// hand written\n");
  });

  it("skips a block candidate whose spec file does not exist", async () => {
    const repo = await tempRepo("rspec");
    const res = await applyAccepted(repo, [candidate({ wholeFile: false })]);
    expect(res.written).toEqual([]);
    expect(res.skipped[0]?.reason).toMatch(/does not exist/);
  });

  it("skips candidates that are not accepted", async () => {
    const repo = await tempRepo("rspec");
    const res = await applyAccepted(repo, [candidate({ status: "test_failed" })]);
    expect(res.written).toEqual([]);
    expect(res.skipped[0]?.reason).toMatch(/not accepted/);
  });

  it("skips a second whole file candidate for a path the first one created", async () => {
    const repo = await tempRepo("vitest");
    const res = await applyAccepted(repo, [
      candidate({ id: "a", hash: "h1", specPath: "src/foo.test.ts", wholeFile: true, code: 'test("a", () => {});' }),
      candidate({ id: "b", hash: "h2", specPath: "src/foo.test.ts", wholeFile: true, code: 'test("b", () => {});' }),
    ]);
    expect(res.written).toEqual(["src/foo.test.ts"]);
    expect(res.skipped).toEqual([{ spec: "src/foo.test.ts", reason: expect.stringMatching(/already created/) }]);
    const content = await readFile(join(repo.cwd, "src/foo.test.ts"), "utf8");
    expect(content).toContain('test("a"');
    expect(content).not.toContain('test("b"');
  });
});

function summary(over: Partial<RunSummary> = {}): RunSummary {
  const accepted = over.accepted ?? [candidate()];
  return {
    repo: "rails-api",
    targets: ["app/services/foo.rb"],
    candidates: over.candidates ?? accepted,
    accepted,
    tokens: over.tokens ?? { input: 12000, output: 3400, cacheRead: 88000, cacheWrite: 0 },
    durationMs: over.durationMs ?? 42_000,
    ...over,
  };
}

describe("mutationScore and specQuality", () => {
  it("adds the tallies up and reports the ratio", () => {
    const accepted = [
      candidate({ mutation: { tried: 4, killed: 3, survivors: [] } }),
      candidate({ mutation: { tried: 4, killed: 2, survivors: [] } }),
    ];
    expect(mutationScore(accepted)).toEqual({ killed: 5, tried: 8, score: 0.625 });
  });

  it("reports a null score when nothing was mutated", () => {
    expect(mutationScore([candidate()])).toEqual({ killed: 0, tried: 0, score: null });
    expect(mutationScore([])).toEqual({ killed: 0, tried: 0, score: null });
  });

  it("describes each accepted test by what it asserts", () => {
    const accepted = [candidate({ mutation: { tried: 4, killed: 3, survivors: [] } })];
    expect(specQuality(accepted)).toEqual([
      {
        spec: "spec/services/foo_spec.rb",
        symbol: "Foo#call",
        newlyCovered: 2,
        mutantsKilled: 3,
        mutantsTried: 4,
        assertions: ["eq"],
      },
    ]);
  });
});

describe("prBody", () => {
  it("leads with the mutation score, above the coverage table", () => {
    const accepted = [candidate({ mutation: { tried: 4, killed: 3, survivors: [] } })];
    const body = prBody(summary({ accepted }));
    expect(body).toContain("Tests that catch regressions: caught 3 of 4 planted bugs (75%).");
    expect(body.indexOf("Tests that catch regressions")).toBeLessThan(body.indexOf("## Accepted tests"));
  });

  it("says so rather than inventing a score when nothing was mutated", () => {
    expect(prBody(summary())).toContain("no bug could be planted on the covered lines");
  });

  it("moves the coverage line over the repo's sources, with the whole package beside it", () => {
    const coverage = {
      before: { sources: { covered: 3, total: 5, pct: 60, files: 2 }, all: { covered: 5, total: 17, pct: 29.41, files: 6 } },
      after: { sources: { covered: 4, total: 5, pct: 80, files: 2 }, all: { covered: 6, total: 17, pct: 35.29, files: 6 } },
    };
    const body = prBody(summary({ coverage }));
    expect(body).toContain(
      "Line coverage over the repo's sources: 60.0% before, 80.0% after (whole package 29.4% before, 35.3% after).",
    );
    expect(body.indexOf("Line coverage over the repo's sources")).toBeLessThan(body.indexOf("## Accepted tests"));
  });

  it("leaves the coverage line out when the run measured no repo figure", () => {
    expect(prBody(summary())).not.toContain("Line coverage over the repo's sources");
  });

  it("names the assertions each accepted test uses", () => {
    const body = prBody(summary());
    expect(body).toContain("| Planted bugs caught | Assertions |");
    expect(body).toContain("| n/a | eq |");
  });

  it("names the surviving mutants under a rejected candidate", () => {
    const rejected = [
      candidate({
        status: "weak_assertions",
        lastError: "caught 1 of 3 planted bugs (33%), need 60%",
        mutation: { tried: 3, killed: 1, survivors: [{ id: "m4-relational", line: 4, description: "relational: > to >=" }] },
      }),
    ];
    const body = prBody(summary({ accepted: [], candidates: rejected }));
    expect(body).toContain("survived: line 4, relational: > to >=");
  });

  it("has a title line naming the repo and the accepted count", () => {
    const body = prBody(summary());
    expect(body.split("\n")[0]).toBe("# covergen: 1 test accepted in rails-api");
  });

  it("renders a table row per accepted test with symbol, lines and percentages", () => {
    const body = prBody(summary());
    expect(body).toContain("| Spec | Symbol | Lines newly covered | Before | After | Planted bugs caught |");
    expect(body).toContain("`spec/services/foo_spec.rb`");
    expect(body).toContain("`Foo#call`");
    expect(body).toContain("2 (11, 12)");
    expect(body).toContain("40.0%");
    expect(body).toContain("60.0%");
  });

  it("shows killed over tried in the mutants column", () => {
    const accepted = [candidate({ mutation: { tried: 4, killed: 3, survivors: [] } })];
    expect(prBody(summary({ accepted }))).toContain("| 40.0% | 60.0% | 3/4 |");
  });

  it("shows n/a when nothing was mutated or the spot-check was off", () => {
    expect(prBody(summary())).toContain("| 40.0% | 60.0% | n/a |");
    const accepted = [candidate({ mutation: { tried: 0, killed: 0, survivors: [] } })];
    expect(prBody(summary({ accepted }))).toContain("| 40.0% | 60.0% | n/a |");
  });

  it("renders the weak_assertions status as words", () => {
    const rejected = [candidate({ status: "weak_assertions", lastError: "caught 0 of 3 planted bugs" })];
    const body = prBody(summary({ accepted: [], candidates: rejected }));
    expect(body).toContain("- **weak assertions** (1)");
    expect(body).toContain("caught 0 of 3 planted bugs");
  });

  it("groups rejected candidates by status with counts", () => {
    const accepted = [candidate({ id: "ok", hash: "h-ok" })];
    const rejected = [
      candidate({ id: "r1", hash: "h1", status: "test_failed", lastError: "expected :ok got nil" }),
      candidate({ id: "r2", hash: "h2", status: "test_failed" }),
      candidate({ id: "r3", hash: "h3", status: "no_coverage_gain" }),
    ];
    const body = prBody(summary({ accepted, candidates: [...accepted, ...rejected] }));
    expect(body).toContain("- **test failed** (2)");
    expect(body).toContain("- **no coverage gain** (1)");
    expect(body).toContain("expected :ok got nil");
  });

  it("reports token usage", () => {
    const body = prBody(summary());
    expect(body).toContain("input 12,000");
    expect(body).toContain("output 3,400");
    expect(body).toContain("cache read 88,000");
  });

  it("prints dollars per model beside the tokens when the run was priced", () => {
    const cost = {
      usd: 1.5,
      byModel: [
        { model: "gen", usd: 1.25 },
        { model: "rep", usd: 0.25 },
      ],
      partial: false,
    };
    expect(prBody(summary({ cost }))).toContain("cost $1.50 (gen $1.25, rep $0.25)");
  });

  it("marks the total a floor when a model had no price", () => {
    const cost = { usd: 1.25, byModel: [{ model: "gen", usd: 1.25 }, { model: "mystery" }], partial: true };
    expect(prBody(summary({ cost }))).toContain("cost $1.25 or more (gen $1.25, mystery unpriced)");
  });

  it("omits the cost line entirely for a summary that carries no pricing", () => {
    expect(prBody(summary())).not.toContain("cost $");
  });

  it("states that every test was generated and gated automatically and must be reviewed", () => {
    const body = prBody(summary());
    expect(body).toContain("generated by a model");
    expect(body).toContain("strictly raised line coverage");
    expect(body.toLowerCase()).toContain("review these tests");
  });

  it("says so plainly when nothing was accepted", () => {
    const rejected = [candidate({ status: "flaky" })];
    const body = prBody(summary({ accepted: [], candidates: rejected }));
    expect(body).toContain("# covergen: 0 tests accepted in rails-api");
    expect(body).toContain("No candidate both passed repeatedly and raised line coverage.");
  });

  it("contains no em dashes", () => {
    expect(prBody(summary())).not.toContain("—");
  });
});

describe("prBody line lists", () => {
  it("truncates the newly covered lines after the first eight", () => {
    const accepted = [
      candidate({ delta: delta({ newlyCovered: [11, 12, 13, 14, 15, 16, 17, 18, 19] }) }),
    ];
    const body = prBody(summary({ accepted }));
    expect(body).toContain("9 (11, 12, 13, 14, 15, 16, 17, 18, ...)");
    expect(body).not.toContain("19");
  });
});
