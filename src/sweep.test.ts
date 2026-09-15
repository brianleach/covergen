import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "./config.js";
import { ceilingHit, createLimits, parseCeiling, type RunLimits } from "./limits.js";
import { createLogger } from "./logger.js";
import type { openDraftPrs } from "./pr.js";
import { reportLines, sweepAll, writeReport, type SweepAllArgs } from "./sweep.js";
import type { Candidate, RunSummary } from "./types.js";

const log = createLogger({ level: "silent" });

/** Three repos on disk, one of them marked `sweep: false`. */
async function workspace(): Promise<Config> {
  const tmp = await mkdtemp(join(tmpdir(), "covergen-sweep-test-"));
  for (const name of ["r1", "r2", "r3"]) {
    await mkdir(join(tmp, name, "src"), { recursive: true });
    await writeFile(join(tmp, name, "src", "a.ts"), "export const a = 1;\n", "utf8");
  }
  const yaml = [
    "repos:",
    ...["r1", "r2", "r3"].flatMap((name) => [
      `  - name: ${name}`,
      `    root: ./${name}`,
      "    runner: vitest",
      '    sources: ["src/**/*.ts"]',
      ...(name === "r3" ? ["    sweep: false"] : []),
    ]),
  ].join("\n");
  const path = join(tmp, "covergen.yaml");
  await writeFile(path, `${yaml}\n`, "utf8");
  return loadConfig(path);
}

function summaryFor(repo: string, accepted: number): RunSummary {
  const segment = { path: "src/a.ts", startLine: 1, endLine: 2, uncoveredLines: [1], text: "1| a", symbol: "a" };
  const candidates = Array.from({ length: accepted + 1 }, (_, i) => ({
    specPath: `src/a${i}.test.ts`,
    status: i < accepted ? "accepted" : "test_failed",
    segment,
    code: 'it("adds", () => { expect(add(1, 2)).toBe(3); });',
    delta: { path: "src/a.ts", newlyCovered: [1], lost: [], before: { covered: 0, total: 2 }, after: { covered: 1, total: 2 } },
    mutation: { tried: 4, killed: 3, survivors: [] },
  })) as unknown as Candidate[];
  return {
    repo,
    targets: ["src/a.ts"],
    candidates,
    accepted: candidates.filter((c) => c.status === "accepted"),
    tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
    durationMs: 10,
  };
}

function args(config: Config, over: Partial<SweepAllArgs> = {}): SweepAllArgs {
  return {
    config,
    log,
    order: "glob",
    limit: 5,
    dryRun: false,
    pr: false,
    limits: createLimits({}),
    runOne: vi.fn(async (a) => summaryFor(a.repo.name, 1)) as unknown as SweepAllArgs["runOne"],
    openPr: vi.fn(async () => ["https://github.com/example/repo/pull/1"]) as unknown as typeof openDraftPrs,
    dirty: vi.fn(async () => []),
    ...over,
  };
}

describe("limits", () => {
  it("stops on tokens, on the deadline, and stays stopped", () => {
    const limits: RunLimits = { maxTokens: 100, spent: 60 };
    expect(ceilingHit(limits, 20)).toBeUndefined();
    expect(ceilingHit(limits, 40)).toBe("tokens");
    expect(ceilingHit({ maxTokens: 0, spent: 0, deadlineAt: 500 }, 0, 600)).toBe("minutes");
    expect(ceilingHit({ maxTokens: 0, spent: 0, hit: "minutes" })).toBe("minutes");
    expect(ceilingHit(undefined)).toBeUndefined();
  });

  it("treats a bad ceiling as a misconfiguration, not a zero", () => {
    expect(parseCeiling(undefined, "--max-tokens", 7)).toBe(7);
    expect(parseCeiling("0", "--max-tokens", 7)).toBe(0);
    expect(() => parseCeiling("lots", "--max-tokens", 7)).toThrow(/non-negative whole number/);
    expect(() => parseCeiling("-1", "--max-minutes", 7)).toThrow(/non-negative whole number/);
  });
});

describe("sweepAll", () => {
  it("runs each repo in config order and skips sweep: false", async () => {
    const config = await workspace();
    const a = args(config);
    const report = await sweepAll(a);
    expect(report.repos.map((r) => [r.repo, r.status])).toEqual([
      ["r1", "ran"],
      ["r2", "ran"],
      ["r3", "skipped"],
    ]);
    expect(report.repos[2]?.reason).toMatch(/sweep: false/);
    expect(a.runOne).toHaveBeenCalledTimes(2);
    expect(report.tokens).toBe(3000);
    expect(report.repos[0]?.rejected).toEqual({ test_failed: 1 });
  });

  it("keeps going when one repo throws", async () => {
    const config = await workspace();
    const runOne = vi.fn(async (a: { repo: { name: string } }) => {
      if (a.repo.name === "r1") throw new Error("baseline run produced no lcov");
      return summaryFor(a.repo.name, 1);
    });
    const report = await sweepAll(args(config, { runOne: runOne as unknown as SweepAllArgs["runOne"] }));
    expect(report.repos[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/no lcov/) });
    expect(report.repos[1]).toMatchObject({ status: "ran", accepted: 1 });
  });

  it("opens one draft PR per repo that accepted a test", async () => {
    const config = await workspace();
    const a = args(config, { pr: true });
    const report = await sweepAll(a);
    expect(report.repos[0]?.prUrl).toBe("https://github.com/example/repo/pull/1");
    expect(a.openPr).toHaveBeenCalledTimes(2);
    expect(vi.mocked(a.openPr!).mock.calls[0]?.[0]).toMatchObject({ files: ["src/a0.test.ts"], maxLines: 600 });
    expect(report.repos[0]?.prUrls).toEqual(["https://github.com/example/repo/pull/1"]);
    expect(reportLines(report)).toContain("https://github.com/example/repo/pull/1");
  });

  it("records every part PR when one repo's output was split", async () => {
    const config = await workspace();
    const urls = ["https://example.test/pr/1", "https://example.test/pr/2"];
    const openPr = vi.fn(async () => urls) as unknown as typeof openDraftPrs;
    const a = args(config, { pr: true, prMaxLines: 200, openPr });
    const report = await sweepAll(a);
    expect(vi.mocked(a.openPr!).mock.calls[0]?.[0]).toMatchObject({ maxLines: 200 });
    expect(report.repos[0]).toMatchObject({ prUrl: urls[0], prUrls: urls });
    expect(reportLines(report)).toContain(`${urls[0]}, ${urls[1]}`);
  });

  it("refuses to touch a dirty checkout and never runs it", async () => {
    const config = await workspace();
    const a = args(config, { pr: true, dirty: vi.fn(async (root: string) => (root.endsWith("r1") ? ["src/a.ts"] : [])) });
    const report = await sweepAll(a);
    expect(report.repos[0]).toMatchObject({ status: "skipped", reason: expect.stringMatching(/dirty/) });
    expect(a.runOne).toHaveBeenCalledTimes(1);
    expect(a.openPr).toHaveBeenCalledTimes(1);
  });

  it("says --pr did nothing on a dry run, because a dry run writes no files", async () => {
    const config = await workspace();
    const a = args(config, { pr: true, dryRun: true });
    const report = await sweepAll(a);
    expect(report.repos[0]).toMatchObject({ status: "ran", accepted: 1 });
    expect(report.repos[0]?.prUrl).toBeUndefined();
    expect(report.repos[0]?.reason).toMatch(/--dry-run writes no files/);
    expect(a.openPr).not.toHaveBeenCalled();
    expect(a.dirty).not.toHaveBeenCalled();
  });

  it("stops at the run-wide token ceiling and reports it", async () => {
    const config = await workspace();
    const limits = createLimits({ maxTokens: 1000 });
    // Stand in for the pipeline, which charges the run-wide budget as it goes.
    const runOne = vi.fn(async (a: { repo: { name: string }; limits?: RunLimits }) => {
      if (a.limits) a.limits.spent += 1500;
      return summaryFor(a.repo.name, 1);
    });
    const report = await sweepAll(args(config, { limits, runOne: runOne as unknown as SweepAllArgs["runOne"] }));
    expect(runOne).toHaveBeenCalledTimes(1);
    expect(report.repos[1]).toMatchObject({ status: "skipped", reason: "run-wide tokens ceiling reached" });
    expect(report.ceilingHit).toBe("tokens");
    expect(reportLines(report)).toMatch(/Stopped early: the run-wide token ceiling/);
  });

  it("stops the sweep when a run is aborted, and carries its journal into the report", async () => {
    const config = await workspace();
    const runOne = vi.fn(async (a: { repo: { name: string } }) => ({
      ...summaryFor(a.repo.name, 1),
      aborted: "SIGTERM",
      journal: "/repo/.covergen/runs/20260910T000000Z-abc123.json",
    }));
    const report = await sweepAll(args(config, { pr: true, runOne: runOne as unknown as SweepAllArgs["runOne"] }));
    expect(runOne).toHaveBeenCalledTimes(1);
    expect(report.abortedBy).toBe("SIGTERM");
    expect(report.repos).toHaveLength(1);
    // The PR still opens: the accepted specs are on disk and the run paid for them.
    expect(report.repos[0]).toMatchObject({
      repo: "r1",
      aborted: "SIGTERM",
      journal: "/repo/.covergen/runs/20260910T000000Z-abc123.json",
      prUrl: "https://github.com/example/repo/pull/1",
    });
  });

  it("writes a JSON report with a row per repo", async () => {
    const config = await workspace();
    const report = await sweepAll(args(config));
    const path = join(await mkdtemp(join(tmpdir(), "covergen-report-")), "nested", "run.json");
    await writeReport(path, report);
    const parsed = JSON.parse(await readFile(path, "utf8")) as typeof report;
    expect(parsed.repos).toHaveLength(3);
    expect(parsed.repos[0]).toMatchObject({ repo: "r1", status: "ran", targetsAttempted: 1, accepted: 1, tokens: 1500 });
    expect(Date.parse(parsed.startedAt)).toBeLessThanOrEqual(Date.parse(parsed.endedAt));
    expect(parsed.dryRun).toBe(false);
  });

  it("carries the mutation score and a quality line per accepted spec", async () => {
    const config = await workspace();
    const report = await sweepAll(args(config));

    // Two repos ran with one accepted test each, 3 of 4 mutants killed apiece.
    expect(report.mutation).toEqual({ killed: 6, tried: 8, score: 0.75 });
    expect(report.repos[0]?.mutation).toEqual({ killed: 3, tried: 4, score: 0.75 });
    expect(report.repos[0]?.acceptedSpecs).toEqual([
      {
        spec: "src/a0.test.ts",
        symbol: "a",
        newlyCovered: 1,
        mutantsKilled: 3,
        mutantsTried: 4,
        assertions: ["toBe"],
      },
    ]);
    // A repo that never ran reports an empty score rather than a missing field.
    expect(report.repos[2]?.mutation).toEqual({ killed: 0, tried: 0, score: null });
    expect(reportLines(report)).toContain("mutants killed 6/8 (75%)");
  });

  it("counts rejected candidates by status, including the assertion verdicts", async () => {
    const config = await workspace();
    const summary = summaryFor("r1", 1);
    (summary.candidates[1] as { status: string }).status = "declaration_snapshot";
    const report = await sweepAll(args(config, { runOne: vi.fn(async () => summary) }));
    expect(report.repos[0]?.rejected).toEqual({ declaration_snapshot: 1 });
  });
});

  it("ranks before capping, keeps only changed source files, and rejects an unknown order", async () => {
    const config = await workspace();
    const repo = config.repos[0]!;
    for (const name of ["b", "c"]) {
      await writeFile(join(repo.root, "src", `${name}.ts`), `export const ${name} = 1;\n`, "utf8");
    }
    const byValue = vi.fn(async ({ targets }: { targets: string[] }) => [...targets].reverse());
    vi.doMock("./pipeline.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./pipeline.js")>()),
      orderTargetsByValue: byValue,
      orderTargetsByGap: vi.fn(async ({ targets }: { targets: string[] }) => targets),
    }));
    vi.doMock("./git.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./git.js")>()),
      changedFiles: vi.fn(async () => ["src/a.ts", "README.md"]),
    }));
    vi.resetModules();
    const info = vi.spyOn(log, "info");
    try {
      const { sweepTargets } = await import("./sweep.js");
      const base = { config, repo, log, order: "value", limit: 2 };

      const capped = await sweepTargets(base);
      const ranked = [...byValue.mock.calls[0]![0].targets].reverse();
      expect(ranked).toHaveLength(3);
      expect(capped).toEqual(ranked.slice(0, 2));
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ matched: 3, limit: 2 }), expect.any(String));

      const all = await sweepTargets({ ...base, order: "glob", limit: 5 });
      const changed = await sweepTargets({ ...base, order: "glob", changedSince: "main" });
      expect(changed).toHaveLength(1);
      expect(changed).toEqual(all.filter((t) => t.endsWith("a.ts")));

      await expect(sweepTargets({ ...base, order: "random" })).rejects.toThrow(/Unknown --order "random"/);
    } finally {
      info.mockRestore();
      vi.doUnmock("./pipeline.js");
      vi.doUnmock("./git.js");
      vi.resetModules();
    }
  });

  it("skips a repo whose sources match no files and never runs it", async () => {
    const config = await workspace();
    (config.repos[0] as unknown as { sources: string[] }).sources = ["lib/**/*.ts"];
    const a = args(config);
    const report = await sweepAll(a);
    expect(report.repos[0]).toMatchObject({
      repo: "r1",
      status: "skipped",
      reason: "no source files matched",
      targetsAttempted: 0,
      tokens: 0,
    });
    expect(report.repos[1]).toMatchObject({ repo: "r2", status: "ran" });
    expect(a.runOne).toHaveBeenCalledTimes(1);
  });

describe("the base a sweep runs on", () => {
  it("records the base for each repo and hands it to the run and the PR", async () => {
    const config = await workspace();
    const a = args(config, { pr: true });
    const report = await sweepAll(a);

    // The fixture repos are directories, not checkouts, which is the case that
    // must report a reason rather than take the sweep down with it.
    expect(report.repos[0]).toMatchObject({ repo: "r1", status: "ran", baseSha: "", baseRefresh: "no commit to refresh from" });
    expect(a.runOne).toHaveBeenCalledWith(expect.objectContaining({ baseSha: "" }));
    expect(a.openPr).toHaveBeenCalledWith(expect.objectContaining({ baseSha: "" }));
  });
});

describe("open covergen PRs", () => {
  it("leaves a repo whose targets an open covergen PR already writes to that PR", async () => {
    const config = await workspace();
    const cover = {
      paths: new Set(["src/a.test.ts"]),
      prs: [{ number: 11, url: "https://github.com/example/repo/pull/11", branch: "covergen/20260914-aaa" }],
    };
    const a = args(config, { pr: true, cover });
    const report = await sweepAll(a);

    expect(report.repos[0]).toMatchObject({
      repo: "r1",
      status: "skipped",
      openPrBacklog: 1,
      reason: "open_pr_backlog: 1 target already written by an open covergen PR",
    });
    expect(a.runOne).not.toHaveBeenCalled();
    expect(reportLines(report)).toContain("r1: 1 target left to an open covergen PR");
  });
});
