import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rollback, type AbortWatch, type Guarded } from "./abort.js";
import { specFileHash } from "./journal.js";
import type { RuleViolation } from "./rules.js";
import type { Candidate, CoverageDelta, GateResult, RepoConfig, RunResult, Segment } from "./types.js";
import type { Config } from "./config.js";

const h = vi.hoisted(() => {
  const state = { frozen: [] as string[], accepted: [] as string[], runs: [] as unknown[] };
  return {
    state,
    preflight: vi.fn(async () => undefined),
    runnerRun: vi.fn(
      async (..._args: unknown[]): Promise<RunResult> => ({
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 7,
        lcovPath: "/nowhere/lcov.info",
      }),
    ),
    getRunner: vi.fn(),
    readLcov: vi.fn(async () => new Map()),
    buildSegments: vi.fn(),
    findNearestSpec: vi.fn(async () => undefined as string | undefined),
    loadIdiomPack: vi.fn(async () => "IDIOMS"),
    buildPromptBlocks: vi.fn(() => ({ stable: "s", semiStable: "ss", volatile: "v" })),
    ruleViolations: vi.fn(() => [] as RuleViolation[]),
    rulesText: vi.fn(() => "RULES"),
    generate: vi.fn(),
    dedupeCandidates: vi.fn((list: Candidate[]) => list),
    usage: vi.fn(() => ({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 })),
    createGenerator: vi.fn(),
    evaluate: vi.fn(),
    repairLoop: vi.fn(),
    applyAccepted: vi.fn(async () => ({ written: ["spec/services/foo_spec.rb"], skipped: [] })),
    prBody: vi.fn(() => "PR BODY\n"),
    loadState: vi.fn(async () => ({ version: 1, ...state })),
    saveState: vi.fn(async () => "state.json"),
    recordRun: vi.fn((s: unknown, _summary: unknown, opts: { frozen?: string[] }) => ({
      ...(s as object),
      lastFrozen: opts.frozen ?? [],
    })),
    listSources: vi.fn(async (): Promise<string[]> => []),
    order: [] as string[],
  };
});

vi.mock("./runners/index.js", () => ({
  getRunner: (name: string) => {
    h.getRunner(name);
    return {
      name,
      preflight: async (repo: RepoConfig) => {
        h.order.push("preflight");
        void repo;
        return h.preflight();
      },
      run: async (...args: unknown[]) => {
        h.order.push("baseline");
        return h.runnerRun(...(args as []));
      },
      specPathFor: (_repo: RepoConfig, rel: string) => rel,
    };
  },
}));

vi.mock("./git.js", () => ({
  treeFingerprint: async () => "fp1234567890abcd",
  listSources: async () => h.listSources(),
}));

vi.mock("./lcov.js", () => ({
  readLcov: (...a: unknown[]) => h.readLcov(...(a as [])),
  discardCoverageDir: async () => undefined,
  mergeCoverage: (m: Map<string, unknown>) => new Map(m),
}));
vi.mock("./segments.js", () => ({ buildSegments: (...a: unknown[]) => h.buildSegments(...(a as [])) }));
vi.mock("./prompt.js", () => ({
  loadIdiomPack: (...a: unknown[]) => h.loadIdiomPack(...(a as [])),
  buildPromptBlocks: (...a: unknown[]) => h.buildPromptBlocks(...(a as [])),
  findNearestSpec: (...a: unknown[]) => h.findNearestSpec(...(a as [])),
}));
// verdictFor and violationText are the real ones: the point of these tests is
// that the pipeline turns whatever the registry says into the right status.
vi.mock("./rules.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rules.js")>()),
  ruleViolations: (...a: unknown[]) => h.ruleViolations(...(a as [])),
  rulesText: (...a: unknown[]) => h.rulesText(...(a as [])),
}));
vi.mock("./generate.js", () => ({
  createGenerator: (opts: unknown) => {
    h.createGenerator(opts);
    return { generate: (...a: unknown[]) => h.generate(...(a as [])), continueChat: vi.fn(), usage: () => h.usage() };
  },
  dedupeCandidates: (list: Candidate[]) => h.dedupeCandidates(list),
}));
vi.mock("./gate.js", () => ({
  evaluate: (...a: unknown[]) => h.evaluate(...(a as [])),
  tailOf: (run: RunResult | undefined) => (run ? [run.stderr, run.stdout].filter(Boolean).join("\n") : undefined),
}));
vi.mock("./repair.js", () => ({ repairLoop: (...a: unknown[]) => h.repairLoop(...(a as [])) }));
vi.mock("./emit.js", () => ({
  applyAccepted: (...a: unknown[]) => {
    h.order.push("applyAccepted");
    return h.applyAccepted(...(a as []));
  },
  prBody: (...a: unknown[]) => h.prBody(...(a as [])),
}));
vi.mock("./state.js", async (importOriginal) => ({
  // The journal writes through the real atomic writer: these tests assert on the
  // file it leaves behind.
  writeJsonAtomic: (await importOriginal<typeof import("./state.js")>()).writeJsonAtomic,
  loadState: (...a: unknown[]) => h.loadState(...(a as [])),
  saveState: (...a: unknown[]) => {
    h.order.push("saveState");
    return h.saveState(...(a as []));
  },
  recordRun: (...a: unknown[]) => h.recordRun(...(a as [never, never, never])),
  freezableHashes: (list: Candidate[]) =>
    list.filter((c) => ["build_failed", "test_failed", "flaky", "no_coverage_gain", "rule_violation"].includes(c.status)).map((c) => c.hash),
  skipSet: (s: { frozen: string[]; accepted: string[] }) => new Set([...s.frozen, ...s.accepted]),
}));

const { baselineEntryKey, hasBaselineCache, mapLimit, orderTargetsByGap, preflightRepo, runPipeline } =
  await import("./pipeline.js");
const { findRepo, loadConfig } = await import("./config.js");
const { silentLogger } = await import("./logger.js");

const TARGET = "app/services/foo.rb";
const TARGET2 = "app/services/bar.rb";
const TARGET3 = "app/services/baz.rb";
const SPEC = "spec/services/foo_spec.rb";
const SPEC2 = "spec/services/bar_spec.rb";
const SOURCE_TEXT = "class Foo\n  def call\n    :ok\n  end\nend\n";
const WHOLE_FILE_CODE = "RSpec.describe Foo do\n  it 'works' do\n  end\nend";

/** An AbortWatch the test drives directly, so no real signal handler is installed. */
function fakeWatch(): AbortWatch & { trip: (signal: NodeJS.Signals) => void; guards: Guarded[][] } {
  let hit: NodeJS.Signals | undefined;
  let files: Guarded[] = [];
  const guards: Guarded[][] = [];
  return {
    guards,
    aborted: () => hit !== undefined,
    signal: () => hit,
    guard: (next) => {
      files = next;
      guards.push(next);
    },
    release: () => undefined,
    // The real rollback, so a test abort takes back exactly what a signal would.
    trip: (signal) => {
      hit = signal;
      rollback(files);
      files = [];
    },
  };
}

async function fixtureRepo(): Promise<RepoConfig> {
  const root = await mkdtemp(join(tmpdir(), "covergen-pipeline-"));
  await mkdir(join(root, "app/services"), { recursive: true });
  for (const target of [TARGET, TARGET2, TARGET3]) await writeFile(join(root, target), SOURCE_TEXT, "utf8");
  return {
    name: "fixture",
    root,
    runner: "rspec",
    cwd: root,
    sources: ["app/**/*.rb"],
    specPath: (rel) => `spec/${rel.replace(/^app\//, "").replace(/\.rb$/, "_spec.rb")}`,
  };
}

function config(repo: RepoConfig, over: Partial<Config> = {}): Config {
  return {
    anthropic: { api_key_env: "ANTHROPIC_API_KEY", generator_model: "m", repair_model: "r", max_tokens: 4096 },
    gate: { k: 3, timeout_ms: 1000, baseline_timeout_ms: 5000, max_repair_rounds: 2 },
    mutation: { enabled: true, max_mutants: 5, min_killed: 1, timeout_ms: 9000 },
    segments: { max_lines: 50, max_per_file: 8 },
    state_dir: ".covergen",
    repos: [repo],
    ...over,
  } as Config;
}

function segment(startLine: number): Segment {
  return {
    path: TARGET,
    startLine,
    endLine: startLine + 2,
    uncoveredLines: [startLine + 1],
    text: `${startLine}: def call`,
    symbol: `Foo#call${startLine}`,
  };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: over.id ?? "c1",
    hash: over.hash ?? "h1",
    segment: over.segment ?? segment(1),
    specPath: over.specPath ?? "spec/services/foo_spec.rb",
    code: over.code ?? "it 'x' do\nend",
    wholeFile: over.wholeFile ?? true,
    status: over.status ?? "generated",
    attempts: over.attempts ?? 0,
    history: over.history ?? [],
    ...over,
  };
}

const delta: CoverageDelta = {
  path: TARGET,
  newlyCovered: [2, 3],
  lost: [],
  before: { covered: 1, total: 5 },
  after: { covered: 3, total: 5 },
};

const accepted: GateResult = { status: "accepted", runs: [], delta };
const failed: GateResult = { status: "test_failed", runs: [], error: "boom" };

async function run(
  repo: RepoConfig,
  over: { dryRun?: boolean; fast?: boolean; cfg?: Partial<Config>; targets?: string[]; abort?: AbortWatch } = {},
) {
  return runPipeline({
    config: config(repo, over.cfg ?? {}),
    repo,
    targets: over.targets ?? [TARGET],
    dryRun: over.dryRun ?? false,
    fast: over.fast ?? false,
    log: silentLogger(),
    abort: over.abort,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.state.frozen = [];
  h.state.accepted = [];
  h.loadState.mockImplementation(async () => ({ version: 1, ...h.state }));
  h.runnerRun.mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 7, lcovPath: "/nowhere/lcov.info" });
  h.readLcov.mockResolvedValue(new Map());
  h.listSources.mockResolvedValue([]);
  h.buildSegments.mockReturnValue([segment(1)]);
  h.findNearestSpec.mockResolvedValue(undefined);
  h.ruleViolations.mockReturnValue([]);
  h.generate.mockResolvedValue(candidate());
  h.dedupeCandidates.mockImplementation((list: Candidate[]) => list);
  h.evaluate.mockResolvedValue(accepted);
  h.applyAccepted.mockResolvedValue({ written: ["spec/services/foo_spec.rb"], skipped: [] });
  h.prBody.mockReturnValue("PR BODY\n");
});

describe("runPipeline", () => {
  it("preflights the runner before taking a baseline", async () => {
    const repo = await fixtureRepo();
    await run(repo);
    expect(h.order.indexOf("preflight")).toBeLessThan(h.order.indexOf("baseline"));
  });

  it("baselines the whole suite by default and only the target spec in fast mode", async () => {
    const repo = await fixtureRepo();
    await run(repo);
    // wholeProject: a file no test loads has to appear in the map, or it is never targeted.
    expect(h.runnerRun.mock.calls[0]?.[1]).toMatchObject({ files: [], coverage: true, wholeProject: true });

    const spec = "spec/services/foo_spec.rb";
    await mkdir(join(repo.cwd, "spec/services"), { recursive: true });
    await writeFile(join(repo.cwd, spec), "RSpec.describe Foo do\nend\n", "utf8");
    h.findNearestSpec.mockResolvedValue(spec);
    h.runnerRun.mockClear();
    await run(repo, { fast: true });
    expect(h.runnerRun.mock.calls[0]?.[1]).toMatchObject({ files: [spec], coverage: true, wholeProject: false });
  });

  it("throws a fix hint when the baseline produces no lcov", async () => {
    const repo = await fixtureRepo();
    h.runnerRun.mockResolvedValue({ ok: false, exitCode: 1, stdout: "", stderr: "", durationMs: 1 });
    await expect(run(repo)).rejects.toThrow(/no lcov/i);
  });

  it("accepts a gated block candidate and applies it", async () => {
    const repo = await fixtureRepo();
    await mkdir(join(repo.cwd, "spec/services"), { recursive: true });
    await writeFile(join(repo.cwd, SPEC), "RSpec.describe Foo do\nend\n", "utf8");
    h.findNearestSpec.mockResolvedValue(SPEC);
    h.generate.mockResolvedValue(candidate({ wholeFile: false }));

    const summary = await run(repo);
    expect(summary.accepted).toHaveLength(1);
    expect(summary.accepted[0]?.status).toBe("accepted");
    expect(summary.accepted[0]?.delta).toEqual(delta);
    expect(h.applyAccepted).toHaveBeenCalledTimes(1);
    expect((h.applyAccepted.mock.calls[0] as unknown[])?.[1]).toHaveLength(1);
  });

  it("leaves a spec that has reached the per-file ceiling for the next run", async () => {
    const repo = await fixtureRepo();
    await mkdir(join(repo.cwd, "spec/services"), { recursive: true });
    await writeFile(join(repo.cwd, SPEC), "# line\n".repeat(60), "utf8");
    const cfg = { sweep: { max_tokens_per_run: 0, max_minutes: 0, pr_max_lines: 600, pr_max_lines_per_file: 50 } };

    const summary = await run(repo, { cfg: cfg as Partial<Config> });
    expect(h.buildSegments).not.toHaveBeenCalled();
    expect(summary.candidates).toHaveLength(0);
    // The same spec is generated for again once the ceiling is lifted.
    h.generate.mockResolvedValue(candidate({ wholeFile: false }));
    const next = await run(repo, { cfg: { ...cfg, sweep: { ...cfg.sweep, pr_max_lines_per_file: 0 } } as Partial<Config> });
    expect(next.candidates).toHaveLength(1);
  });

  it("passes the mutation settings to the gate and carries the tally onto the candidate", async () => {
    const repo = await fixtureRepo();
    const mutation = { tried: 3, killed: 2, survivors: [{ id: "m2-boolean", line: 2, description: "boolean: true to false" }] };
    h.evaluate.mockResolvedValue({ ...accepted, mutation });

    const summary = await run(repo);
    const gateArgs = (h.evaluate.mock.calls[0] as [{ mutation: unknown }])[0];
    expect(gateArgs.mutation).toEqual({ enabled: true, maxMutants: 5, minKilled: 1, timeoutMs: 9000 });
    expect(summary.accepted[0]?.mutation).toEqual(mutation);
  });

  it("freezes a candidate the gate rejected for weak assertions", async () => {
    const repo = await fixtureRepo();
    h.evaluate.mockResolvedValue({ status: "weak_assertions", runs: [], delta, error: "killed 0 of 2 mutants" });
    h.repairLoop.mockImplementation(async ({ candidate: c }: { candidate: Candidate }) => ({
      candidate: { ...c, status: "frozen" as const },
      result: { status: "weak_assertions" as const, runs: [], error: "killed 0 of 2 mutants" },
    }));

    const summary = await run(repo);
    expect(summary.accepted).toHaveLength(0);
    expect(summary.candidates[0]?.status).toBe("weak_assertions");
    expect(summary.candidates[0]?.lastError).toContain("killed 0 of 2 mutants");
  });

  it("writes an accepted whole-file candidate itself instead of leaving it to applyAccepted", async () => {
    const repo = await fixtureRepo();
    h.generate.mockResolvedValue(candidate({ wholeFile: true, code: WHOLE_FILE_CODE }));
    const summary = await run(repo);
    expect(summary.accepted).toHaveLength(1);
    expect(await readFile(join(repo.cwd, SPEC), "utf8")).toBe(`${WHOLE_FILE_CODE}\n`);
    expect(h.applyAccepted).not.toHaveBeenCalled();
  });

  it("skips the gate for a rule violation", async () => {
    const repo = await fixtureRepo();
    h.ruleViolations.mockReturnValue([
      { id: "no-sleep", status: "rule_violation", message: "uses sleep" },
      { id: "no-real-network", status: "rule_violation", message: "makes a real HTTP call" },
    ]);
    const summary = await run(repo);
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.repairLoop).not.toHaveBeenCalled();
    expect(summary.candidates[0]?.status).toBe("rule_violation");
    expect(summary.candidates[0]?.lastError).toBe("no-sleep: uses sleep; no-real-network: makes a real HTTP call");
    expect(summary.accepted).toHaveLength(0);
    expect(h.applyAccepted).not.toHaveBeenCalled();
  });

  it("sends an assertion verdict to repair instead of freezing it as a rule violation", async () => {
    const repo = await fixtureRepo();
    h.ruleViolations.mockReturnValue([
      { id: "behavioral-evidence", status: "tautological", message: "every assertion is a weak matcher (toBeDefined)" },
    ]);
    h.repairLoop.mockImplementation(async ({ candidate: c, gateResult }: { candidate: Candidate; gateResult: GateResult }) => ({
      candidate: c,
      result: gateResult,
    }));

    const summary = await run(repo);

    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.repairLoop).toHaveBeenCalledTimes(1);
    expect(h.repairLoop.mock.calls[0]?.[0]?.gateResult?.status).toBe("tautological");
    expect(summary.candidates[0]?.status).toBe("tautological");
    expect(summary.candidates[0]?.lastError).toContain("weak matcher");
  });

  it("skips hashes already frozen or accepted in state", async () => {
    const repo = await fixtureRepo();
    h.state.frozen = ["h1"];
    const summary = await run(repo);
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(summary.candidates[0]?.status).toBe("frozen");

    h.state.frozen = [];
    h.state.accepted = ["h1"];
    h.evaluate.mockClear();
    const second = await run(repo);
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(second.candidates[0]?.status).toBe("frozen");
  });

  it("does not write spec files on a dry run but still saves state", async () => {
    const repo = await fixtureRepo();
    const summary = await run(repo, { dryRun: true });
    expect(summary.accepted).toHaveLength(1);
    expect(h.applyAccepted).not.toHaveBeenCalled();
    expect(h.saveState).toHaveBeenCalledTimes(1);
  });

  it("repairs a failed candidate and uses the repaired result", async () => {
    const repo = await fixtureRepo();
    h.evaluate.mockResolvedValue(failed);
    const repaired = candidate({ id: "c1r", hash: "h1", attempts: 2 });
    h.repairLoop.mockResolvedValue({ candidate: repaired, result: accepted });

    const summary = await run(repo);
    expect(h.repairLoop).toHaveBeenCalledTimes(1);
    expect(h.repairLoop.mock.calls[0]?.[0]).toMatchObject({ maxRounds: 2 });
    expect(summary.accepted).toHaveLength(1);
    expect(summary.accepted[0]?.id).toBe("c1r");
  });

  it("checks rules on repaired candidates before running the gate again", async () => {
    const repo = await fixtureRepo();
    h.evaluate.mockResolvedValue(failed);
    h.ruleViolations.mockImplementation((...args: unknown[]) =>
      String(args[0]).includes("sleep") ? [{ id: "no-sleep", status: "rule_violation" as const, message: "uses sleep" }] : [],
    );
    h.repairLoop.mockImplementation(
      async ({ candidate: current, evaluate: runGate }: { candidate: Candidate; evaluate: (c: Candidate) => Promise<GateResult> }) => {
        const repaired = candidate({ ...current, hash: "h2", code: "sleep(1)" });
        return { candidate: repaired, result: await runGate(repaired) };
      },
    );

    const summary = await run(repo);

    expect(h.evaluate).toHaveBeenCalledTimes(1);
    expect(summary.candidates[0]?.status).toBe("rule_violation");
    expect(summary.candidates[0]?.lastError).toContain("uses sleep");
  });

  it("does not repair when max_repair_rounds is zero", async () => {
    const repo = await fixtureRepo();
    h.evaluate.mockResolvedValue(failed);
    const summary = await run(repo, {
      cfg: { gate: { k: 3, timeout_ms: 1000, baseline_timeout_ms: 5000, max_repair_rounds: 0 } } as Partial<Config>,
    });
    expect(h.repairLoop).not.toHaveBeenCalled();
    expect(summary.candidates[0]?.status).toBe("test_failed");
    expect(summary.candidates[0]?.lastError).toBe("boom");
  });

  it("generates segments concurrently but gates them one at a time", async () => {
    const repo = await fixtureRepo();
    h.buildSegments.mockReturnValue([segment(1), segment(10), segment(20)]);
    let generating = 0;
    let maxGenerating = 0;
    let gating = 0;
    let maxGating = 0;
    let n = 0;
    h.generate.mockImplementation(async () => {
      generating += 1;
      maxGenerating = Math.max(maxGenerating, generating);
      await new Promise((r) => setTimeout(r, 5));
      generating -= 1;
      n += 1;
      return candidate({ id: `c${n}`, hash: `h${n}`, wholeFile: false });
    });
    h.evaluate.mockImplementation(async () => {
      gating += 1;
      maxGating = Math.max(maxGating, gating);
      await new Promise((r) => setTimeout(r, 5));
      gating -= 1;
      return accepted;
    });

    const summary = await run(repo);
    expect(maxGenerating).toBe(3);
    expect(maxGating).toBe(1);
    expect(summary.accepted).toHaveLength(3);
  });

  it("regenerates the remaining whole-file candidates as blocks once the first one lands", async () => {
    const repo = await fixtureRepo();
    h.buildSegments.mockReturnValue([segment(1), segment(10)]);
    let n = 0;
    h.generate.mockImplementation(async (...args: unknown[]) => {
      const whole = Boolean(args[3]);
      n += 1;
      return candidate({
        id: `c${n}`,
        hash: `h${n}`,
        wholeFile: whole,
        code: whole ? WHOLE_FILE_CODE : "it 'block' do\nend",
      });
    });

    const summary = await run(repo);

    expect(h.evaluate).toHaveBeenCalledTimes(2);
    expect(h.generate).toHaveBeenCalledTimes(3);
    // The third generation is the regenerated block for the second segment.
    expect(h.generate.mock.calls[2]?.[3]).toBe(false);
    expect((h.buildPromptBlocks.mock.calls[2] as unknown[])?.[0]).toMatchObject({
      wholeFile: false,
      nearestSpecPath: SPEC,
      nearestSpecText: WHOLE_FILE_CODE,
    });
    expect(summary.accepted).toHaveLength(2);
    expect(summary.accepted[0]?.wholeFile).toBe(true);
    expect(summary.accepted[1]?.wholeFile).toBe(false);
    expect(summary.candidates.some((c) => c.status === "frozen")).toBe(false);
  });

  it("removes the created spec file at the end of a dry run, after gating the blocks against it", async () => {
    const repo = await fixtureRepo();
    const abs = join(repo.cwd, SPEC);
    h.buildSegments.mockReturnValue([segment(1), segment(10)]);
    let n = 0;
    h.generate.mockImplementation(async (...args: unknown[]) => {
      const whole = Boolean(args[3]);
      n += 1;
      return candidate({ id: `c${n}`, hash: `h${n}`, wholeFile: whole, code: whole ? WHOLE_FILE_CODE : "block" });
    });
    const seen: boolean[] = [];
    h.evaluate.mockImplementation(async () => {
      seen.push(existsSync(abs));
      return accepted;
    });

    const summary = await run(repo, { dryRun: true });

    expect(seen).toEqual([false, true]);
    expect(await readFile(abs, "utf8").catch(() => undefined)).toBeUndefined();
    expect(summary.accepted).toHaveLength(2);
    expect(h.applyAccepted).toHaveBeenCalledTimes(1);
  });

  it("restores a whole-file spec when a later dry-run gate throws", async () => {
    const repo = await fixtureRepo();
    const abs = join(repo.cwd, SPEC);
    h.buildSegments.mockReturnValue([segment(1), segment(10)]);
    let generated = 0;
    h.generate.mockImplementation(async (...args: unknown[]) => {
      const whole = Boolean(args[3]);
      generated += 1;
      return candidate({ id: `c${generated}`, hash: `h${generated}`, wholeFile: whole, code: whole ? WHOLE_FILE_CODE : "block" });
    });
    h.evaluate.mockResolvedValueOnce(accepted).mockRejectedValueOnce(new Error("gate crashed"));

    await expect(run(repo, { dryRun: true })).rejects.toThrow("gate crashed");
    expect(await readFile(abs, "utf8").catch(() => undefined)).toBeUndefined();
  });

  it("rolls back every spec it wrote when their combined verification fails", async () => {
    const repo = await fixtureRepo();
    const original = "RSpec.describe Foo do\nend\n";
    await mkdir(join(repo.cwd, "spec/services"), { recursive: true });
    await writeFile(join(repo.cwd, SPEC), original, "utf8");
    h.findNearestSpec.mockResolvedValue(SPEC);
    h.generate.mockResolvedValue(candidate({ wholeFile: false }));
    h.applyAccepted.mockImplementation(async (...args: unknown[]) => {
      const targetRepo = args[0] as RepoConfig;
      await writeFile(join(targetRepo.cwd, SPEC), "broken combined spec\n", "utf8");
      return { written: [SPEC], skipped: [] };
    });
    h.runnerRun.mockImplementation(async (...args: unknown[]) => {
      const opts = args[1] as { coverage: boolean };
      return {
        ok: opts.coverage,
        exitCode: opts.coverage ? 0 : 1,
        stdout: "",
        stderr: opts.coverage ? "" : "SyntaxError: duplicate declaration",
        durationMs: 1,
        lcovPath: opts.coverage ? "/nowhere/lcov.info" : undefined,
      };
    });

    const summary = await run(repo).catch((err: Error) => err);
    expect(String(summary)).toMatch(/combined accepted specs failed/);
    const combinedRun = h.runnerRun.mock.calls.find((call) => !(call[1] as { coverage: boolean }).coverage);
    expect(combinedRun?.[1]).toMatchObject({ timeoutMs: 5000 });
    // Accepted tests are written as they are accepted, but tests that pass alone
    // and fail together are not output worth keeping: the checkout goes back to
    // what it was, and nothing is recorded as accepted.
    expect(await readFile(join(repo.cwd, SPEC), "utf8")).toBe(original);
    expect(h.saveState).not.toHaveBeenCalled();

    // The report and the journal still say what happened and why.
    const report = await readFile(join(repo.root, ".covergen", "last-run.md"), "utf8");
    expect(report).toContain("## Reverted");
    expect(report).toContain("SyntaxError: duplicate declaration");
    const runs = await readdir(join(repo.root, ".covergen", "runs"));
    const journal = JSON.parse(
      await readFile(join(repo.root, ".covergen", "runs", runs[0] as string), "utf8"),
    ) as { status: string; reason: string; accepted: unknown[] };
    expect(journal.status).toBe("reverted");
    expect(journal.reason).toMatch(/combined accepted specs failed/);
    // The journal still lists what the run had accepted, so the reason is readable
    // against the tests it is talking about.
    expect(journal.accepted).toHaveLength(1);
  });

  it("leaves the created spec file on disk and hands applyAccepted only the block", async () => {
    const repo = await fixtureRepo();
    const abs = join(repo.cwd, SPEC);
    h.buildSegments.mockReturnValue([segment(1), segment(10)]);
    let n = 0;
    h.generate.mockImplementation(async (...args: unknown[]) => {
      const whole = Boolean(args[3]);
      n += 1;
      return candidate({ id: `c${n}`, hash: `h${n}`, wholeFile: whole, code: whole ? WHOLE_FILE_CODE : "block" });
    });

    const summary = await run(repo);

    expect(await readFile(abs, "utf8")).toBe(`${WHOLE_FILE_CODE}\n`);
    const applied = (h.applyAccepted.mock.calls[0] as unknown[])?.[1] as Candidate[];
    expect(applied).toHaveLength(1);
    expect(applied[0]?.wholeFile).toBe(false);
    expect(applied[0]?.id).toBe("c3");
    // The whole file still shows up as accepted in the summary and the PR body.
    expect(summary.accepted.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("survives a generation failure for one segment", async () => {
    const repo = await fixtureRepo();
    h.buildSegments.mockReturnValue([segment(1), segment(10)]);
    let call = 0;
    h.generate.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error("429");
      return candidate({ id: "c2", hash: "h2" });
    });
    const summary = await run(repo);
    expect(summary.candidates).toHaveLength(1);
    expect(summary.accepted).toHaveLength(1);
  });

  it("skips a target with no uncovered segments", async () => {
    const repo = await fixtureRepo();
    h.buildSegments.mockReturnValue([]);
    const summary = await run(repo);
    expect(h.generate).not.toHaveBeenCalled();
    expect(summary.candidates).toHaveLength(0);
    expect(h.saveState).toHaveBeenCalledTimes(1);
  });

  it("saves state after emitting and freezes terminal failures", async () => {
    const repo = await fixtureRepo();
    h.evaluate.mockResolvedValue(failed);
    h.repairLoop.mockResolvedValue({ candidate: candidate({ hash: "h1" }), result: failed });
    await run(repo);
    expect(h.recordRun.mock.calls[0]?.[2]).toEqual({ frozen: ["h1"], dryRun: false });
    expect(h.saveState).toHaveBeenCalledWith(repo, expect.anything(), ".covergen");
  });

  it("writes last-run.md from the PR body", async () => {
    const repo = await fixtureRepo();
    await run(repo);
    expect(h.prBody).toHaveBeenCalledTimes(1);
    const text = await readFile(join(repo.root, ".covergen", "last-run.md"), "utf8");
    expect(text).toBe("PR BODY\n");
  });

  it("returns a summary carrying repo, targets and token usage", async () => {
    const repo = await fixtureRepo();
    const summary = await run(repo);
    expect(summary.repo).toBe("fixture");
    expect(summary.targets).toEqual([TARGET]);
    // generator_model and repair_model differ in the fixture, so two generators
    // are created and their usage is summed.
    expect(summary.tokens).toEqual({ input: 200, output: 40, cacheRead: 10, cacheWrite: 0 });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("caches the whole-suite baseline by tree fingerprint and reuses it", async () => {
    const repo = await fixtureRepo();
    const lcovPath = join(repo.root, "fake-lcov.info");
    await writeFile(lcovPath, "SF:app/services/foo.rb\nDA:1,1\nend_of_record\n", "utf8");
    h.runnerRun.mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 7, lcovPath });
    await run(repo);
    const cached = join(repo.root, ".covergen", "baseline", `fp1234567890abcd-${baselineEntryKey(repo)}-v2.lcov`);
    expect(await readFile(cached, "utf8")).toContain("SF:app/services/foo.rb");
    const runsBefore = h.runnerRun.mock.calls.length;
    await run(repo);
    // Second run: no whole-suite baseline call (files: []) was made.
    const suiteRuns = h.runnerRun.mock.calls.slice(runsBefore).filter((c) => (c[1] as { files: string[] }).files.length === 0);
    expect(suiteRuns).toHaveLength(0);
  });

  it("gives two entries sharing a root but not a cwd distinct cache files", async () => {
    const repo = await fixtureRepo();
    const one: RepoConfig = { ...repo, name: "pkg-one", cwd: join(repo.root, "packages/one") };
    const two: RepoConfig = { ...repo, name: "pkg-two", cwd: join(repo.root, "packages/two") };
    expect(baselineEntryKey(one)).not.toBe(baselineEntryKey(two));
    // The runner and the source globs are part of the key too.
    expect(baselineEntryKey(one)).not.toBe(baselineEntryKey({ ...one, runner: "vitest" }));
    expect(baselineEntryKey(one)).not.toBe(baselineEntryKey({ ...one, sources: ["lib/**/*.rb"] }));
    // Same entry, checked out somewhere else: same key.
    expect(baselineEntryKey({ ...one, root: "/elsewhere", cwd: "/elsewhere/packages/one" })).toBe(baselineEntryKey(one));
  });

  it("reruns the suite when a cached baseline knows too few of the entry's sources", async () => {
    const repo = await fixtureRepo();
    const lcovPath = join(repo.root, "fake-lcov.info");
    await writeFile(lcovPath, "SF:app/services/foo.rb\nDA:1,1\nend_of_record\n", "utf8");
    h.runnerRun.mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 7, lcovPath });
    // The cached map belongs to a sibling package: none of this entry's sources are in it.
    h.listSources.mockResolvedValue(["app/services/foo.rb", "app/services/bar.rb"]);
    // The pipeline marks lines on the map it is handed, so hand out a fresh copy each call.
    h.readLcov.mockImplementation(async () => new Map([["../other/lib/thing.rb", { path: "../other/lib/thing.rb", lines: new Map() }]]));
    await run(repo);
    const runsBefore = h.runnerRun.mock.calls.length;
    await run(repo);
    const suiteRuns = h.runnerRun.mock.calls.slice(runsBefore).filter((c) => (c[1] as { files: string[] }).files.length === 0);
    expect(suiteRuns).toHaveLength(1);
  });

  it("trusts a cached baseline that covers most of the entry's sources", async () => {
    const repo = await fixtureRepo();
    const lcovPath = join(repo.root, "fake-lcov.info");
    await writeFile(lcovPath, "SF:app/services/foo.rb\nDA:1,1\nend_of_record\n", "utf8");
    h.runnerRun.mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 7, lcovPath });
    h.listSources.mockResolvedValue(["app/services/foo.rb", "app/services/bar.rb"]);
    h.readLcov.mockImplementation(
      async () =>
        new Map([
          ["app/services/foo.rb", { path: "app/services/foo.rb", lines: new Map() }],
          ["app/services/bar.rb", { path: "app/services/bar.rb", lines: new Map() }],
        ]),
    );
    await run(repo);
    const runsBefore = h.runnerRun.mock.calls.length;
    await run(repo);
    const suiteRuns = h.runnerRun.mock.calls.slice(runsBefore).filter((c) => (c[1] as { files: string[] }).files.length === 0);
    expect(suiteRuns).toHaveLength(0);
  });

  it("keeps every accepted spec on disk when a signal aborts the run, and journals them", async () => {
    const repo = await fixtureRepo();
    const watch = fakeWatch();
    let n = 0;
    h.generate.mockImplementation(async (...args: unknown[]) => {
      n += 1;
      return candidate({ id: `c${n}`, hash: `h${n}`, specPath: String(args[2]), code: `${WHOLE_FILE_CODE} # ${n}` });
    });
    let gated = 0;
    h.evaluate.mockImplementation(async () => {
      gated += 1;
      // The harness kills the run while the second candidate is at the gate.
      if (gated === 2) watch.trip("SIGTERM");
      return accepted;
    });

    const summary = await run(repo, { targets: [TARGET, TARGET2, TARGET3], abort: watch });

    expect(summary.aborted).toBe("SIGTERM");
    expect(summary.accepted).toHaveLength(2);
    // Both accepted specs are still there, and the third target was never started.
    expect(await readFile(join(repo.cwd, SPEC), "utf8")).toContain("# 1");
    expect(await readFile(join(repo.cwd, SPEC2), "utf8")).toContain("# 2");
    expect(h.generate).toHaveBeenCalledTimes(2);
    // No combined verification: every runner call was a coverage baseline.
    expect(h.runnerRun.mock.calls.filter((c) => !(c[1] as { coverage: boolean }).coverage)).toHaveLength(0);

    const journal = JSON.parse(await readFile(String(summary.journal), "utf8")) as {
      status: string;
      accepted: { spec: string; hash: string }[];
    };
    expect(journal.status).toBe("aborted");
    expect(journal.accepted.map((e) => e.spec)).toEqual([SPEC, SPEC2]);
    expect(journal.accepted.map((e) => e.hash)).toEqual(["h1", "h2"]);
    // The gate's in-flight files are guarded before it runs: the spec it splices
    // into and the source the mutation spot-check rewrites.
    expect(watch.guards[0]?.map((g) => g.path)).toEqual([join(repo.cwd, SPEC), join(repo.cwd, TARGET)]);
    expect(watch.guards[0]?.[1]?.original).toBe(SOURCE_TEXT);
  });

  it("journals an unexpected crash as aborted, with the error as the reason", async () => {
    const repo = await fixtureRepo();
    let n = 0;
    h.generate.mockImplementation(async (...args: unknown[]) => {
      n += 1;
      return candidate({ id: `c${n}`, hash: `h${n}`, specPath: String(args[2]), code: `${WHOLE_FILE_CODE} # ${n}` });
    });
    let gated = 0;
    h.evaluate.mockImplementation(async () => {
      gated += 1;
      // Not a signal and not a verdict: the kind of failure that used to leave
      // the journal reading `running` forever.
      if (gated === 2) throw new Error("runner vanished mid-gate");
      return accepted;
    });

    await expect(run(repo, { targets: [TARGET, TARGET2] })).rejects.toThrow("runner vanished mid-gate");

    const runs = join(repo.root, ".covergen", "runs");
    const journal = JSON.parse(await readFile(join(runs, String((await readdir(runs))[0])), "utf8")) as {
      status: string;
      reason: string;
      accepted: { spec: string; specHash: string }[];
    };
    expect(journal.status).toBe("aborted");
    expect(journal.reason).toBe("runner vanished mid-gate");
    // The one accepted spec is still on disk, and the hash the journal recorded
    // is the file sitting there, which is what `pr --from` checks before it opens.
    expect(journal.accepted.map((e) => e.spec)).toEqual([SPEC]);
    expect(journal.accepted[0]?.specHash).toBe(await specFileHash(repo.cwd, SPEC));
  });

  it("rolls back only the candidate in flight, mutant included, and keeps the accepted one", async () => {
    const repo = await fixtureRepo();
    const watch = fakeWatch();
    let n = 0;
    h.generate.mockImplementation(async (...args: unknown[]) => {
      n += 1;
      return candidate({ id: `c${n}`, hash: `h${n}`, specPath: String(args[2]), code: `${WHOLE_FILE_CODE} # ${n}` });
    });
    let gated = 0;
    h.evaluate.mockImplementation(async () => {
      gated += 1;
      if (gated === 1) return accepted;
      // Mid-gate when the signal lands: a mutant in the source and the candidate
      // spliced into a spec file that did not exist before this run.
      await writeFile(join(repo.cwd, TARGET2), "class Bar # mutant\nend\n", "utf8");
      await writeFile(join(repo.cwd, SPEC2), "candidate under test\n", "utf8");
      watch.trip("SIGINT");
      return failed;
    });

    const summary = await run(repo, {
      targets: [TARGET, TARGET2],
      abort: watch,
      cfg: { gate: { k: 3, timeout_ms: 1000, baseline_timeout_ms: 5000, max_repair_rounds: 0 } } as Partial<Config>,
    });

    expect(summary.aborted).toBe("SIGINT");
    expect(summary.accepted).toHaveLength(1);
    expect(await readFile(join(repo.cwd, SPEC), "utf8")).toContain("# 1");
    expect(existsSync(join(repo.cwd, SPEC2))).toBe(false);
    expect(await readFile(join(repo.cwd, TARGET2), "utf8")).toBe(SOURCE_TEXT);
  });

});

describe("orderTargetsByGap", () => {
  const cov = (path: string, hits: number[]) => [path, { path, lines: new Map(hits.map((h2, i) => [i + 1, h2])) }] as const;

  it("puts the biggest hole first and keeps a stable order within a tie", async () => {
    const repo = await fixtureRepo();
    h.readLcov.mockResolvedValue(
      new Map([cov("a.rb", [1, 1, 0]), cov("big.rb", [0, 0, 0, 0]), cov("b.rb", [1, 1, 0])]),
    );
    const ordered = await orderTargetsByGap({
      config: config(repo),
      repo,
      targets: ["b.rb", "a.rb", "big.rb"],
      log: silentLogger(),
    });
    expect(ordered).toEqual(["big.rb", "a.rb", "b.rb"]);
  });

  it("sorts a target the baseline knows nothing about last rather than first", async () => {
    const repo = await fixtureRepo();
    h.readLcov.mockResolvedValue(new Map([cov("known.rb", [0, 0])]));
    const ordered = await orderTargetsByGap({
      config: config(repo),
      repo,
      targets: ["unknown.rb", "known.rb"],
      log: silentLogger(),
    });
    expect(ordered).toEqual(["known.rb", "unknown.rb"]);
  });
});

describe("mapLimit", () => {
  /** Runs 5 tasks at the given limit and reports the results and the peak overlap. */
  const peakAt = async (limit: number): Promise<{ out: number[]; peak: number }> => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], limit, async (n) => {
      peak = Math.max(peak, (inFlight += 1));
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 2;
    });
    return { out, peak };
  };

  it("keeps at most `limit` calls in flight and returns results in input order", async () => {
    expect(await peakAt(1)).toEqual({ out: [2, 4, 6, 8, 10], peak: 1 });
    expect(await peakAt(2)).toMatchObject({ peak: 2 });
  });

  it("runs everything at once when the limit is 0", async () => {
    expect(await peakAt(0)).toMatchObject({ peak: 5 });
  });
});

  it("rolls back when a repo validation command fails after the combined run passes", async () => {
    const repo: RepoConfig = {
      ...(await fixtureRepo()),
      commandPrefix: ["sh", "-c", 'i=1; while [ $i -le 70 ]; do echo "$0 $i" >&2; i=$((i+1)); done; exit 1'],
      validate: [["lint"]],
    };

    const err = await run(repo).catch((e: Error) => e);

    // Exit 1 is a failure, and only the last 60 lines of output make it into the error.
    const tail = Array.from({ length: 60 }, (_, k) => `lint ${k + 11}`).join("\n");
    expect((err as Error).message).toBe(`combined accepted specs failed validation (lint):\n${tail}`);
    expect(existsSync(join(repo.cwd, SPEC))).toBe(false);
    expect(h.saveState).not.toHaveBeenCalled();
  });

  it("stops before the next target once the run-wide token ceiling is reached", async () => {
    const repo = await fixtureRepo();
    // The mocked generator already reports usage, so the ceiling is over before the first target.
    const limits = { spent: 0, maxTokens: 1 } as NonNullable<Parameters<typeof runPipeline>[0]["limits"]>;

    const summary = await runPipeline({
      config: config(repo),
      repo,
      targets: [TARGET, TARGET2],
      dryRun: false,
      log: silentLogger(),
      limits,
      abort: fakeWatch(),
    });

    expect(summary.limitHit).toBeTruthy();
    expect(limits.hit).toBe(summary.limitHit);
    expect(h.buildSegments).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(summary.candidates).toHaveLength(0);
  });

  it("preflights and generates through the claude-code subscription backend", async () => {
    const repo = await fixtureRepo();
    const cc = await import("./claude-code.js");
    const cfgMod = await import("./config.js");
    const exec = vi.fn();
    const backendSpy = vi.spyOn(cfgMod, "generatorBackend").mockReturnValue("claude-code");
    const execSpy = vi.spyOn(cc, "claudeExec").mockReturnValue(exec as never);
    const preflightSpy = vi.spyOn(cc, "preflightClaudeCode").mockResolvedValue("me@example.com" as never);
    const createSpy = vi.spyOn(cc, "createClaudeCodeGenerator").mockReturnValue({
      generate: (...a: unknown[]) => h.generate(...(a as [])),
      continueChat: vi.fn(),
      usage: () => h.usage(),
    } as never);
    const log = silentLogger();
    const info = vi.spyOn(log, "info");
    try {
      const summary = await runPipeline({
        config: config(repo, {
          claude_code: { binary: "claude-bin", timeout_ms: 1234, max_tokens_per_sweep: 5000, concurrency: 1 },
        } as Partial<Config>),
        repo,
        targets: [TARGET],
        dryRun: false,
        fast: false,
        log,
      });

      expect(execSpy).toHaveBeenCalledWith("claude-bin", tmpdir(), 1234);
      expect(preflightSpy).toHaveBeenCalledWith(exec);
      expect(info).toHaveBeenCalledWith({ repo: "fixture", auth: "me@example.com" }, expect.any(String));
      expect(createSpy).toHaveBeenCalledWith({ binary: "claude-bin", model: "m", timeoutMs: 1234, maxTokensPerSweep: 5000 });
      expect(h.createGenerator).not.toHaveBeenCalled();
      expect(summary.backend).toBe("claude-code");
      expect(summary.cost).toBeUndefined();
      // One instance both generates and repairs, so usage is counted once.
      expect(summary.tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 });
      expect(summary.accepted).toHaveLength(1);
    } finally {
      for (const spy of [backendSpy, execSpy, preflightSpy, createSpy]) spy.mockRestore();
    }
  });

it("orders targets by value, putting the file with the most uncovered branching code first", async () => {
  // value.ts reads churn through runGit, which the file-level git mock does not provide.
  vi.resetModules();
  vi.doMock("./git.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./git.js")>()),
    treeFingerprint: async () => "fp1234567890abcd",
    listSources: async () => h.listSources(),
    runGit: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
  }));
  const { orderTargetsByValue } = await import("./pipeline.js");
  const repo = await fixtureRepo();
  const big = "app/services/zed.rb";
  const small = "app/services/able.rb";
  const branchy = ["class Zed", ...Array.from({ length: 12 }, (_, i) => `  return ${i} if x == ${i}`), "end", ""].join("\n");
  await writeFile(join(repo.cwd, big), branchy, "utf8");
  await writeFile(join(repo.cwd, small), SOURCE_TEXT, "utf8");
  const lines = (count: number, hits: number) => new Map(Array.from({ length: count }, (_, i) => [i + 1, hits]));
  h.readLcov.mockResolvedValue(
    new Map([
      [big, { path: big, lines: lines(14, 0) }],
      [small, { path: small, lines: lines(5, 1) }],
    ]),
  );
  const log = silentLogger();
  const info = vi.spyOn(log, "info");

  const ordered = await orderTargetsByValue({
    config: config(repo),
    repo,
    targets: [small, big],
    log,
  });

  expect(ordered[0]).toBe(big);
  // The reported top of the ranking starts with the same file the order does.
  const ranking = info.mock.calls.find((c) => Array.isArray((c[0] as { top?: unknown } | undefined)?.top));
  const top = (ranking?.[0] as { top: string[] }).top;
  expect(top[0]).toContain(big);
  expect(top).toHaveLength(ordered.length);
});

  it("freezes a whole-file candidate aimed at a spec an earlier candidate created this run", async () => {
    const repo = await fixtureRepo();
    h.buildSegments.mockReturnValue([segment(1), segment(10)]);
    let n = 0;
    // The generator ignores the request for a block and keeps returning whole files.
    h.generate.mockImplementation(async () => {
      n += 1;
      return candidate({ id: `c${n}`, hash: `h${n}-0123456789abcdef`, wholeFile: true, code: WHOLE_FILE_CODE });
    });
    const log = silentLogger();
    const info = vi.spyOn(log, "info");

    const summary = await runPipeline({ config: config(repo), repo, targets: [TARGET], dryRun: false, fast: false, log });

    expect(h.evaluate).toHaveBeenCalledTimes(1);
    expect(summary.accepted.map((c) => c.id)).toEqual(["c1"]);
    const frozen = summary.candidates.find((c) => c.id === "c3");
    expect(frozen?.status).toBe("frozen");
    expect(frozen?.lastError).toContain("spec file created by an earlier candidate this run");
    expect(await readFile(join(repo.cwd, SPEC), "utf8")).toBe(`${WHOLE_FILE_CODE}\n`);
    // The skip is reported with the candidate's short hash, its first 12 characters.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ spec: SPEC, hash: "h3-012345678", status: "frozen" }),
      expect.any(String),
    );
  });

  it("skips a target whose source cannot be read and carries on with the next one", async () => {
    const repo = await fixtureRepo();
    const missing = "app/services/missing.rb";
    const log = silentLogger();
    const warn = vi.spyOn(log, "warn");

    const summary = await runPipeline({
      config: config(repo),
      repo,
      targets: [missing, TARGET],
      dryRun: false,
      fast: false,
      log,
    });

    expect(h.buildSegments.mock.calls.map((c) => (c[0] as { path: string }).path)).toEqual([TARGET]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(summary.candidates).toHaveLength(1);
    expect(summary.accepted[0]?.segment.path).toBe(TARGET);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ target: missing }), expect.any(String));
  });

  it("reports zero tokens when a generator's usage meter throws", async () => {
    const repo = await fixtureRepo();
    h.usage.mockImplementation(() => {
      throw new Error("usage meter unavailable");
    });
    try {
      const summary = await run(repo);
      expect(summary.accepted).toHaveLength(1);
      expect(summary.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      const journal = JSON.parse(await readFile(String(summary.journal), "utf8")) as { tokens: number };
      expect(journal.tokens).toBe(0);
    } finally {
      h.usage.mockImplementation(() => ({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 }));
    }
  });

  it("throws with the reasons when applyAccepted cannot write an accepted block", async () => {
    const repo = await fixtureRepo();
    await mkdir(join(repo.cwd, "spec/services"), { recursive: true });
    await writeFile(join(repo.cwd, SPEC), "RSpec.describe Foo do\nend\n", "utf8");
    h.findNearestSpec.mockResolvedValue(SPEC);
    h.generate.mockResolvedValue(candidate({ wholeFile: false }));
    h.applyAccepted.mockResolvedValue({
      written: [],
      skipped: [{ spec: SPEC, reason: "anchor not found" }, { spec: SPEC, reason: "file changed on disk" }],
    } as never);

    const err = await run(repo).catch((e: Error) => e);

    expect((err as Error).message).toBe(
      `could not emit ${SPEC}: anchor not found; file changed on disk`,
    );
    expect(h.saveState).not.toHaveBeenCalled();
    // The run threw before persisting, so the spec is back to what it was found as.
    expect(await readFile(join(repo.cwd, SPEC), "utf8")).toBe("RSpec.describe Foo do\nend\n");
  });

  it("falls back to the suite baseline for the loss check when the spec-alone run produces no lcov", async () => {
    const repo = await fixtureRepo();
    await mkdir(join(repo.cwd, "spec/services"), { recursive: true });
    await writeFile(join(repo.cwd, SPEC), "RSpec.describe Foo do\nend\n", "utf8");
    h.findNearestSpec.mockResolvedValue(SPEC);
    h.generate.mockResolvedValue(candidate({ wholeFile: false }));
    h.readLcov.mockResolvedValue(new Map([[TARGET, { path: TARGET, lines: new Map([[1, 1], [5, 0]]) }]]));
    // The whole-suite baseline reports coverage; the spec-alone run does not.
    h.runnerRun.mockImplementation(async (...args: unknown[]) => {
      const opts = args[1] as { files: string[] };
      const suite = opts.files.length === 0;
      return {
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        lcovPath: suite ? "/nowhere/lcov.info" : undefined,
      };
    });
    const log = silentLogger();
    const warn = vi.spyOn(log, "warn");

    const summary = await runPipeline({ config: config(repo), repo, targets: [TARGET], dryRun: false, fast: false, log });

    const gateArgs = h.evaluate.mock.calls[0]?.[0] as {
      specBaseline: Map<string, { lines: Map<number, number> }>;
    };
    expect([...gateArgs.specBaseline.keys()]).toEqual([TARGET]);
    expect(gateArgs.specBaseline.get(TARGET)?.lines.get(5)).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ target: TARGET, spec: SPEC }), expect.any(String));
    expect(summary.accepted).toHaveLength(1);
  });

  it("warns and falls back to the whole suite when fast mode finds no existing spec", async () => {
    const repo = await fixtureRepo();
    const log = silentLogger();
    const warn = vi.spyOn(log, "warn");

    const summary = await runPipeline({
      config: config(repo),
      repo,
      targets: [TARGET],
      dryRun: false,
      fast: true,
      log,
    });

    expect(warn).toHaveBeenCalledWith(
      { repo: "fixture" },
      "fast mode requested but no target has an existing spec, running the whole suite",
    );
    // No spec to narrow to, so the baseline is still the whole project.
    expect(h.runnerRun.mock.calls[0]?.[1]).toMatchObject({ files: [], coverage: true, wholeProject: true });
    expect(summary.accepted).toHaveLength(1);
  });

  it("warns and finishes the run when the journal cannot be written", async () => {
    const repo = await fixtureRepo();
    // A file where the runs directory belongs: every journal write for this run fails.
    await mkdir(join(repo.root, ".covergen"), { recursive: true });
    await writeFile(join(repo.root, ".covergen", "runs"), "not a directory\n", "utf8");
    const log = silentLogger();
    const warn = vi.spyOn(log, "warn");

    const summary = await runPipeline({
      config: config(repo),
      repo,
      targets: [TARGET],
      dryRun: false,
      fast: false,
      log,
    });

    // The run still produces its accepted test and its report.
    expect(summary.accepted).toHaveLength(1);
    expect(await readFile(join(repo.root, ".covergen", "last-run.md"), "utf8")).toBe("PR BODY\n");
    expect(warn).toHaveBeenCalledWith(
      { journalFile: summary.journal, err: expect.stringContaining("Error") },
      expect.any(String),
    );
  });

describe("preflight tiers", () => {
  /** The self-hosted config (root: .), with the state dir pointed at a scratch root. */
  async function selfHosted(): Promise<{ config: Config; repo: RepoConfig }> {
    const loaded = loadConfig(join(import.meta.dirname, "..", "covergen.covergen.example.yaml"));
    const root = await mkdtemp(join(tmpdir(), "covergen-tiers-"));
    const entry = findRepo(loaded, "covergen");
    return { config: loaded, repo: { ...entry, root } };
  }

  function recordingRunner(): { runner: Parameters<typeof preflightRepo>[0]["runner"]; deep: (boolean | undefined)[] } {
    const deep: (boolean | undefined)[] = [];
    const runner = {
      name: "vitest" as const,
      preflight: async (_repo: RepoConfig, opts?: { deep?: boolean }) => {
        deep.push(opts?.deep);
      },
      run: async (): Promise<RunResult> => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      specPathFor: (_repo: RepoConfig, rel: string) => rel,
    };
    return { runner, deep };
  }

  it("reads the config's own entry, so the tier decision is not hypothetical", async () => {
    const { config, repo } = await selfHosted();
    expect(repo.runner).toBe("vitest");
    expect(config.state_dir).toBe(".covergen");
    expect(repo.allowNoMutants).toBe(false);
  });

  it("goes deep the first time and cheap once a baseline is cached", async () => {
    const { config, repo } = await selfHosted();
    const { runner, deep } = recordingRunner();

    expect(hasBaselineCache(config, repo)).toBe(false);
    await preflightRepo({ config, repo, runner, log: silentLogger() });
    expect(deep).toEqual([true]);

    const cacheDir = join(repo.root, config.state_dir, "baseline");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "abc-def-v2.lcov"), "SF:src/a.ts\nend_of_record\n", "utf8");

    expect(hasBaselineCache(config, repo)).toBe(true);
    await preflightRepo({ config, repo, runner, log: silentLogger() });
    expect(deep).toEqual([true, false]);
  });

  it("ignores a state dir that holds no baseline", async () => {
    const { config, repo } = await selfHosted();
    await mkdir(join(repo.root, config.state_dir, "baseline"), { recursive: true });
    await writeFile(join(repo.root, config.state_dir, "baseline", "notes.txt"), "not coverage\n", "utf8");
    expect(hasBaselineCache(config, repo)).toBe(false);
  });
});
