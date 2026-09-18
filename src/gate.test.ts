import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyFailure,
  evaluate,
  mutantCompiled,
  MUTANT_ATTEMPT_FACTOR,
  mutationShortfall,
  spliceBlock,
  tailOf,
} from "./gate.js";
import { parseLcov } from "./lcov.js";
import type {
  Candidate,
  CoverageMap,
  RepoConfig,
  RunOptions,
  RunResult,
  Runner,
  RunnerName,
  Segment,
} from "./types.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "covergen-gate-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SOURCE = "app/services/charger.rb";
const SPEC = "spec/services/charger_spec.rb";

const segment: Segment = {
  path: SOURCE,
  startLine: 1,
  endLine: 3,
  uncoveredLines: [2, 3],
  text: "1 | def charge\n2 |   pay\n3 | end",
};

function repoFor(runner: RunnerName = "rspec"): RepoConfig {
  return {
    name: "demo",
    root: tmp,
    runner,
    cwd: tmp,
    sources: ["app/**/*.rb"],
    specPath: () => SPEC,
  };
}

function candidateFor(over: Partial<Candidate> = {}): Candidate {
  return {
    id: "abcd1234",
    hash: "hash",
    segment,
    specPath: SPEC,
    code: "it 'charges' do\n  expect(subject.charge).to eq(:ok)\nend",
    wholeFile: false,
    status: "generated",
    attempts: 1,
    history: [],
    ...over,
  };
}

function writeRel(rel: string, text: string): string {
  const abs = join(tmp, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
  return abs;
}

function lcov(lines: Record<number, number>): string {
  const body = Object.entries(lines).map(([line, hits]) => `DA:${line},${hits}`);
  return ["TN:", `SF:${SOURCE}`, ...body, "end_of_record", ""].join("\n");
}

function baselineOf(lines: Record<number, number>): CoverageMap {
  return parseLcov(lcov(lines), { cwd: tmp });
}

interface Scripted {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  /** Line hits written to an lcov file for this run. */
  coverage?: Record<number, number>;
}

interface FakeRunner extends Runner {
  calls: RunOptions[];
  /** Spec file contents as seen by each run. */
  seen: string[];
  /** Source file contents as seen by each run. */
  sourceSeen: string[];
}

function fakeRunner(script: Scripted[], runner: RunnerName = "rspec", specRel: string = SPEC): FakeRunner {
  const calls: RunOptions[] = [];
  const seen: string[] = [];
  const sourceSeen: string[] = [];
  let n = 0;
  return {
    name: runner,
    calls,
    seen,
    sourceSeen,
    preflight: async () => {},
    specPathFor: () => specRel,
    async run(_repo, opts): Promise<RunResult> {
      const step = script[n] ?? script.at(-1) ?? { ok: true };
      n += 1;
      calls.push(opts);
      const abs = join(tmp, specRel);
      seen.push(existsSync(abs) ? readFileSync(abs, "utf8") : "<missing>");
      const src = join(tmp, SOURCE);
      sourceSeen.push(existsSync(src) ? readFileSync(src, "utf8") : "<missing>");
      let lcovPath: string | undefined;
      if (opts.coverage && step.coverage) {
        lcovPath = join(tmp, `lcov-${n}.info`);
        writeFileSync(lcovPath, lcov(step.coverage), "utf8");
      }
      return {
        ok: step.ok,
        exitCode: step.ok ? 0 : 1,
        stdout: step.stdout ?? "",
        stderr: step.stderr ?? "",
        durationMs: 1,
        ...(lcovPath ? { lcovPath } : {}),
      };
    },
  };
}

describe("classifyFailure", () => {
  it("maps compile and load errors to build_failed", () => {
    for (const output of [
      "SyntaxError: unexpected end",
      "NameError: undefined local variable",
      "Error: Cannot find module './x'",
      "src/a.ts(3,1): error TS2304: cannot find name",
      "Failed to load spec_helper",
      "uninitialized constant Charger",
    ]) {
      expect(classifyFailure(output)).toBe("build_failed");
    }
  });

  it("maps an ordinary assertion failure to test_failed", () => {
    expect(classifyFailure("1 example, 1 failure\nexpected :ok got :denied")).toBe("test_failed");
  });
});

describe("mutantCompiled", () => {
  const run = (ok: boolean, stderr: string): RunResult => ({ ok, exitCode: ok ? 0 : 1, stdout: "", stderr, durationMs: 1 });

  it("counts a parse failure as not applicable and everything else as a result", () => {
    for (const out of ["IndentationError: unexpected indent", "E   SyntaxError: invalid syntax"]) {
      expect(mutantCompiled(run(false, out))).toBe(false);
    }
    for (const out of ["assert 10 == 11", "NameError: name 'x' is not defined"]) expect(mutantCompiled(run(false, out))).toBe(true);
    expect(mutantCompiled(run(true, ""))).toBe(true);
  });
});

describe("tailOf", () => {
  const run = (stdout: string, stderr = ""): RunResult => ({ ok: false, exitCode: 1, stdout, stderr, durationMs: 1 });

  it("keeps only the last 60 lines", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const out = tailOf(run(text))!;
    expect(out.split("\n")).toHaveLength(60);
    expect(out.split("\n")[59]).toBe("line 199");
  });

  it("puts stderr before stdout", () => {
    expect(tailOf(run("OUT", "ERR"))).toBe("ERR\nOUT");
  });

  it("returns undefined for no run and for empty output", () => {
    expect(tailOf(undefined)).toBeUndefined();
    expect(tailOf(run("", "  "))).toBeUndefined();
  });
});

describe("spliceBlock", () => {
  it("inserts before the final end for rspec", () => {
    const original = "RSpec.describe Charger do\n  it 'a' do\n    expect(1).to eq(1)\n  end\nend\n";
    const out = spliceBlock(original, "it 'b' do\n  expect(2).to eq(2)\nend", "rspec");
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.at(-1)).toBe("end");
    expect(out).toContain("  it 'b' do");
    expect(out.indexOf("it 'b'")).toBeGreaterThan(out.indexOf("it 'a'"));
    expect(out).toContain("RSpec.describe Charger do");
  });

  it("appends at the end of file for JS runners", () => {
    const original = "describe('a', () => {\n  it('a', () => { expect(1).toBe(1); });\n});\n";
    const out = spliceBlock(original, "describe('b', () => {});", "vitest");
    expect(out.trimEnd().endsWith("describe('b', () => {});")).toBe(true);
    expect(out).toContain("describe('a'");
  });

  it("falls back to appending when an rspec file has no trailing end", () => {
    const out = spliceBlock("# empty spec\n", "it 'b' do\nend", "rspec");
    expect(out).toContain("# empty spec");
    expect(out.trimEnd().endsWith("end")).toBe(true);
  });
});

describe("evaluate", () => {
  it("accepts a candidate that builds, passes k times and covers new lines", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([
      { ok: true, coverage: { 1: 1, 2: 1, 3: 1 } },
      { ok: true },
      { ok: true },
    ]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 1: 1, 2: 0, 3: 0 }),
      sourceRel: SOURCE,
      opts: { k: 3, timeoutMs: 1000 },
    });

    expect(result.status).toBe("accepted");
    expect(result.runs).toHaveLength(3);
    expect(result.delta?.newlyCovered).toEqual([2, 3]);
    expect(result.delta?.lost).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("splices the candidate in for the run and restores the original bytes afterwards", async () => {
    const original = "RSpec.describe Charger do\n  it 'a' do\n    expect(1).to eq(1)\n  end\nend\n";
    writeRel(SPEC, original);
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
    });

    expect(runner.seen[0]).toContain("it 'charges' do");
    expect(runner.seen[0]).toContain("it 'a' do");
    expect(readFileSync(join(tmp, SPEC), "utf8")).toBe(original);
  });

  it("writes a whole new file and deletes it afterwards", async () => {
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    const code = "RSpec.describe Charger do\n  it 'charges' do\n    expect(1).to eq(1)\n  end\nend";
    await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor({ wholeFile: true, code }),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
    });

    expect(runner.seen[0]).toBe(`${code}\n`);
    expect(existsSync(join(tmp, SPEC))).toBe(false);
  });

  it("restores the file even when the runner throws", async () => {
    const original = "RSpec.describe Charger do\nend\n";
    writeRel(SPEC, original);
    const runner = fakeRunner([{ ok: true }]);
    runner.run = async () => {
      throw new Error("runner exploded");
    };
    await expect(
      evaluate({
        repo: repoFor(),
        runner,
        candidate: candidateFor(),
        baseline: baselineOf({ 2: 0 }),
        sourceRel: SOURCE,
        opts: { k: 1, timeoutMs: 1000 },
      }),
    ).rejects.toThrow("runner exploded");
    expect(readFileSync(join(tmp, SPEC), "utf8")).toBe(original);
  });

  it("refuses a whole-file candidate when the spec already exists", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: true }]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor({ wholeFile: true }),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
    });

    expect(result.status).toBe("build_failed");
    expect(result.error).toContain("already exists");
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses an appendable candidate when the spec does not exist", async () => {
    const runner = fakeRunner([{ ok: true }]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
    });

    expect(result.status).toBe("build_failed");
    expect(result.error).toContain("does not exist");
    expect(runner.calls).toHaveLength(0);
  });

  it("runs the candidate spec alone, with coverage first and COVERGEN_SOURCE set", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }, { ok: true }, { ok: true }]);
    await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 3, timeoutMs: 4321 },
    });

    expect(runner.calls.map((c) => c.coverage)).toEqual([true, false, false]);
    for (const call of runner.calls) {
      expect(call.files).toEqual([SPEC]);
      expect(call.env).toEqual({ COVERGEN_SOURCE: SOURCE });
      expect(call.timeoutMs).toBe(4321);
    }
  });

  it("maps a first-run compile error to build_failed and stops", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: false, stderr: "SyntaxError: unexpected keyword_end" }]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 3, timeoutMs: 1000 },
    });

    expect(result.status).toBe("build_failed");
    expect(result.error).toContain("SyntaxError");
    expect(runner.calls).toHaveLength(1);
  });

  it("maps a first-run assertion failure to test_failed", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: false, stdout: "1 example, 1 failure\nexpected :ok, got :denied" }]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 3, timeoutMs: 1000 },
    });

    expect(result.status).toBe("test_failed");
    expect(result.error).toContain("got :denied");
  });

  it("maps a failure on a repeat run to flaky", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([
      { ok: true, coverage: { 2: 1 } },
      { ok: false, stdout: "random order failure" },
      { ok: true },
    ]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 3, timeoutMs: 1000 },
    });

    expect(result.status).toBe("flaky");
    expect(result.runs).toHaveLength(2);
    expect(result.error).toContain("random order failure");
  });

  it("returns no_coverage_gain when nothing new is covered", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: true, coverage: { 1: 5, 2: 0 } }]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 1: 1, 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
    });

    expect(result.status).toBe("no_coverage_gain");
    expect(result.delta?.newlyCovered).toEqual([]);
    expect(result.error).toContain("covered no new lines");
  });

  it("returns no_coverage_gain when a line was lost", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: true, coverage: { 1: 0, 2: 1 } }]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 1: 1, 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
    });

    expect(result.status).toBe("no_coverage_gain");
    expect(result.delta?.lost).toEqual([1]);
    expect(result.error).toContain("lost coverage on lines 1");
  });

  it("returns no_coverage_gain when the runner produced no lcov", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: true }]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
    });

    expect(result.status).toBe("no_coverage_gain");
    expect(result.error).toContain("no lcov");
  });

  it("appends at end of file for a JS runner", async () => {
    const jsSpec = "src/lib/pay.test.ts";
    writeRel(jsSpec, "describe('pay', () => {\n  it('a', () => { expect(1).toBe(1); });\n});\n");
    const repo = { ...repoFor("vitest"), specPath: () => jsSpec };
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }], "vitest", jsSpec);
    const candidate = candidateFor({ specPath: jsSpec, code: "describe('more', () => { it('b', () => { expect(2).toBe(2); }); });" });
    const result = await evaluate({
      repo,
      runner,
      candidate,
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
    });

    expect(result.status).toBe("accepted");
    expect(runner.seen[0]!.trimEnd().endsWith("});")).toBe(true);
    expect(runner.seen[0]).toContain("describe('more'");
  });

  it("runs repo.validate commands with the candidate in place and rejects on nonzero exit", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    const seen: { cmd: string[]; specAtRun: string }[] = [];
    const exec = async (cmd: string[]) => {
      seen.push({ cmd, specAtRun: readFileSync(join(tmp, SPEC), "utf8") });
      return { exitCode: cmd.includes("fail") ? 2 : 0, stdout: "", stderr: "TS4111: index signature", durationMs: 1 };
    };
    const repo = { ...repoFor(), commandPrefix: ["docker", "run"], validate: [["tsc"], ["lint", "fail"]] };
    const result = await evaluate({
      repo,
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
      exec,
    });
    expect(seen.map((s) => s.cmd)).toEqual([["docker", "run", "tsc"], ["docker", "run", "lint", "fail"]]);
    expect(seen[0]?.specAtRun).toContain("it 'charges' do");
    expect(result.status).toBe("build_failed");
    expect(result.error).toContain("lint fail");
    expect(result.error).toContain("TS4111");
    expect(readFileSync(join(tmp, SPEC), "utf8")).toBe("RSpec.describe Charger do\nend\n");
  });

  it("accepts when every validate command exits zero", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    const exec = async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
    const result = await evaluate({
      repo: { ...repoFor(), validate: [["tsc"]] },
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
      exec,
    });
    expect(result.status).toBe("accepted");
    expect(result.runs).toHaveLength(2);
  });


  it("judges loss against the spec-alone baseline, not the suite baseline", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    const runner = fakeRunner([{ ok: true, coverage: { 1: 0, 2: 1 } }]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 1: 1, 2: 0 }),
      specBaseline: baselineOf({ 1: 0, 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
    });
    expect(result.status).toBe("accepted");
    expect(result.delta?.newlyCovered).toEqual([2]);
    expect(result.delta?.lost).toEqual([]);
  });

});

describe("evaluate mutation spot-check", () => {
  const MUTABLE = "def charge(amount)\n  return :ok if amount == 0\nend\n";
  const INERT = "def charge(amount)\n  do_the_thing\nend\n";
  const on = { enabled: true, maxMutants: 2, minKilled: 1, timeoutMs: 2222 };

  function args(over: Record<string, unknown>) {
    return {
      repo: repoFor(),
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
      ...over,
    } as Parameters<typeof evaluate>[0];
  }

  it("accepts and reports the tally when a mutant is killed", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, MUTABLE);
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }, { ok: false }, { ok: true }]);
    const result = await evaluate(args({ runner, mutation: on }));

    expect(result.status).toBe("accepted");
    expect(result.mutation).toEqual({
      tried: 2,
      killed: 1,
      survivors: [{ id: "m2-condition", line: 2, description: "condition: if to unless" }],
    });
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls.slice(1).map((c) => c.timeoutMs)).toEqual([2222, 2222]);
    expect(readFileSync(join(tmp, SOURCE), "utf8")).toBe(MUTABLE);
  });

  it("runs each mutant against the source it mutated, with the candidate still spliced in", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, MUTABLE);
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }, { ok: false }, { ok: false }]);
    await evaluate(args({ runner, mutation: on }));

    expect(runner.sourceSeen[0]).toBe(MUTABLE);
    expect(runner.sourceSeen[1]).toContain("amount != 0");
    expect(runner.sourceSeen[2]).toContain("return :ok unless amount == 0");
    for (const spec of runner.seen) expect(spec).toContain("it 'charges' do");
  });

  it("rejects as weak_assertions when no mutant fails, listing the survivors", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, MUTABLE);
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }, { ok: true }, { ok: true }]);
    const result = await evaluate(args({ runner, mutation: on }));

    expect(result.status).toBe("weak_assertions");
    expect(result.delta?.newlyCovered).toEqual([2]);
    expect(result.mutation).toMatchObject({ tried: 2, killed: 0 });
    expect(result.mutation?.survivors.map((s) => s.id)).toEqual(["m2-relational", "m2-condition"]);
    expect(result.error).toContain("caught 0 of 2 planted bugs");
    expect(result.error).toContain("line 2: relational: == to !=");
    expect(result.error).toContain("line 2: condition: if to unless");
    expect(readFileSync(join(tmp, SOURCE), "utf8")).toBe(MUTABLE);
  });

  it("rejects when no operator applies to the covered lines, rather than accepting on coverage", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, INERT);
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    const result = await evaluate(args({ runner, mutation: on }));

    expect(result.status).toBe("weak_assertions");
    expect(result.mutation).toEqual({ tried: 0, killed: 0, survivors: [] });
    expect(result.error).toContain("no bug could be planted");
    expect(result.error).toContain(`lines 2 of ${SOURCE}`);
    expect(result.delta?.newlyCovered).toEqual([2]);
    // Nothing was mutated, so the only run is the candidate's own.
    expect(runner.calls).toHaveLength(1);
  });

  it("accepts an unjudgeable candidate when the repo opts in with allowNoMutants", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, INERT);
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    const result = await evaluate(args({ runner, mutation: { ...on, allowNoMutants: true } }));

    expect(result.status).toBe("accepted");
    expect(result.mutation).toEqual({ tried: 0, killed: 0, survivors: [] });
  });

  it("refills the slots a mutant the parser rejected would have burned", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, MUTABLE);
    // Two slots. The first two mutants never compiled, so they score nothing and
    // take no slot; the next two are the real results.
    const runner = fakeRunner([
      { ok: true, coverage: { 2: 1 } },
      { ok: false, stderr: "SyntaxError: unexpected keyword" },
      { ok: false, stderr: "SyntaxError: unexpected keyword" },
      { ok: false },
      { ok: false },
      { ok: false },
    ]);
    const result = await evaluate(args({ runner, mutation: on }));

    expect(result.status).toBe("accepted");
    expect(result.mutation).toMatchObject({ tried: 2, killed: 2 });
    // One candidate run plus four mutant runs: two rejected, two counted, then stop.
    expect(runner.calls).toHaveLength(5);
  });

  it("stops at the attempt cap when almost nothing compiles", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, MUTABLE);
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }, { ok: false, stderr: "SyntaxError: nope" }]);
    const result = await evaluate(args({ runner, mutation: { ...on, maxMutants: 1 } }));

    expect(result.status).toBe("weak_assertions");
    expect(result.error).toContain("no bug could be planted");
    expect(result.mutation).toEqual({ tried: 0, killed: 0, survivors: [] });
    // maxMutants 1, so at most 3 attempts, and the source offers 3 mutants for line 2.
    expect(runner.calls.length).toBeLessThanOrEqual(1 + MUTANT_ATTEMPT_FACTOR);
    expect(runner.calls.length).toBeGreaterThan(1);
  });

  it("skips the spot-check entirely when it is disabled or not requested", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, MUTABLE);
    const off = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    const disabled = await evaluate(args({ runner: off, mutation: { ...on, enabled: false } }));
    expect(disabled.status).toBe("accepted");
    expect(disabled.mutation).toBeUndefined();
    expect(off.calls).toHaveLength(1);

    const absent = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    const none = await evaluate(args({ runner: absent }));
    expect(none.status).toBe("accepted");
    expect(none.mutation).toBeUndefined();
    expect(absent.calls).toHaveLength(1);
  });

  it("restores the source and the spec even when a mutant run throws", async () => {
    const originalSpec = "RSpec.describe Charger do\nend\n";
    writeRel(SPEC, originalSpec);
    writeRel(SOURCE, MUTABLE);
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    const real = runner.run.bind(runner);
    let calls = 0;
    runner.run = async (repo, opts) => {
      calls += 1;
      if (calls > 1) throw new Error("mutant run exploded");
      return real(repo, opts);
    };

    await expect(evaluate(args({ runner, mutation: on }))).rejects.toThrow("mutant run exploded");
    expect(readFileSync(join(tmp, SOURCE), "utf8")).toBe(MUTABLE);
    expect(readFileSync(join(tmp, SPEC), "utf8")).toBe(originalSpec);
  });

  it("accepts when min_killed is zero even though every mutant survived", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, MUTABLE);
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }, { ok: true }, { ok: true }]);
    const result = await evaluate(args({ runner, mutation: { ...on, minKilled: 0 } }));
    expect(result.status).toBe("accepted");
    expect(result.mutation).toMatchObject({ tried: 2, killed: 0 });
  });

  it("rejects on the ratio even when the absolute floor is met", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    writeRel(SOURCE, MUTABLE);
    // One of two killed clears minKilled: 1 but not a 60% ratio.
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }, { ok: false }, { ok: true }]);
    const result = await evaluate(args({ runner, mutation: { ...on, minKilledRatio: 0.6 } }));

    expect(result.status).toBe("weak_assertions");
    expect(result.error).toContain("caught 1 of 2 planted bugs (50%), need 60%");
    expect(result.error).toContain("line 2: condition: if to unless");
  });
});

describe("mutationShortfall", () => {
  const summary = (tried: number, killed: number) => ({ tried, killed, survivors: [] });

  it("calls no bug that could be planted a shortfall, unless the repo allows it", () => {
    expect(mutationShortfall(summary(0, 0), 2, 0.6)).toBe("no bug could be planted");
    expect(mutationShortfall(summary(0, 0), 2, 0.6, true)).toBeUndefined();
  });

  it("clamps the floor to the mutants actually generated", () => {
    // One mutant, killed, and a floor of 2: the candidate is judged on what
    // existed rather than rejected for a threshold it could never reach.
    expect(mutationShortfall(summary(1, 1), 2, 0.6)).toBeUndefined();
    expect(mutationShortfall(summary(1, 0), 2, 0.6)).toContain("need at least 1");
  });

  it("applies the floor and the ratio together", () => {
    expect(mutationShortfall(summary(5, 1), 2, 0.6)).toContain("need at least 2");
    expect(mutationShortfall(summary(5, 2), 2, 0.6)).toContain("(40%), need 60%");
    expect(mutationShortfall(summary(5, 3), 2, 0.6)).toBeUndefined();
    expect(mutationShortfall(summary(5, 2), 2, 0)).toBeUndefined();
  });
});

describe("evaluate mutation spot-check with an unreadable source", () => {
  it("accepts with an empty tally when the source file cannot be read", async () => {
    writeRel(SPEC, "RSpec.describe Charger do\nend\n");
    // SOURCE is deliberately never written, so reading it for mutation throws.
    const runner = fakeRunner([{ ok: true, coverage: { 2: 1 } }]);
    const result = await evaluate({
      repo: repoFor(),
      runner,
      candidate: candidateFor(),
      baseline: baselineOf({ 2: 0 }),
      sourceRel: SOURCE,
      opts: { k: 1, timeoutMs: 1000 },
      mutation: { enabled: true, maxMutants: 2, minKilled: 1, timeoutMs: 2222 },
    });

    expect(result.status).toBe("accepted");
    expect(result.mutation).toEqual({ tried: 0, killed: 0, survivors: [] });
    expect(result.delta?.newlyCovered).toEqual([2]);
    expect(result.error).toBeUndefined();
    expect(runner.calls).toHaveLength(1);
    expect(existsSync(join(tmp, SOURCE))).toBe(false);
  });
});
