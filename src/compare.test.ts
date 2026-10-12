import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareReport, gitTreeState, runComparison, verdict, WIN_CRITERION, type CompareRow } from "./compare.js";
import type { Generator } from "./generate.js";
import { RunFailed } from "./pipeline.js";
import type { Candidate, CandidateStatus, GeneratorBackend, PromptBlocks, RunSummary, Segment } from "./types.js";

const segment: Segment = { path: "src/a.ts", startLine: 1, endLine: 4, uncoveredLines: [1, 2], text: "1| a" };
const blocks: PromptBlocks = { stable: "s", semiStable: "m", volatile: "v" };

/** A generator whose nth reply is scripted: a status for the gate to assign, or a failure. */
function stubGenerator(script: Array<CandidateStatus | "error">): Generator {
  let n = 0;
  return {
    async generate(_b, seg, specPath, wholeFile) {
      const step = script[n] ?? "test_failed";
      n += 1;
      if (step === "error") throw new Error("no fenced code block in model reply");
      return { id: String(n), hash: String(n), segment: seg, specPath, code: step, wholeFile, status: "generated", attempts: 1, history: [] };
    },
    continueChat: async () => "",
    usage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
  };
}

/** Stands in for runPipeline: generate one candidate per scripted step and "gate" it by its code. */
async function fakeRun(gen: Generator, steps: number, durationMs: number, usd?: number): Promise<RunSummary> {
  const candidates: Candidate[] = [];
  for (let i = 0; i < steps; i += 1) {
    try {
      const c = await gen.generate(blocks, segment, "src/a.test.ts", false);
      c.status = c.code as CandidateStatus;
      if (c.status === "accepted") c.delta = { path: "src/a.ts", newlyCovered: [1, 2], lost: [], before: { covered: 0, total: 4 }, after: { covered: 2, total: 4 } };
      candidates.push(c);
    } catch {
      // The pipeline logs and drops a failed generation; so does this.
    }
  }
  return {
    repo: "pkg",
    targets: ["src/a.ts"],
    candidates,
    accepted: candidates.filter((c) => c.status === "accepted"),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: usd === undefined ? undefined : { usd, byModel: [], partial: false },
    durationMs,
  };
}

const scripts: Record<string, Array<CandidateStatus | "error">> = {
  "claude-code": ["accepted", "accepted", "no_coverage_gain", "test_failed"],
  "openai-compatible": ["accepted", "error", "build_failed", "weak_assertions"],
};

describe("runComparison", () => {
  it("runs each generator once, in order, and reports them deterministically", async () => {
    const order: string[] = [];
    const rows = await runComparison({
      generators: ["claude-code", "openai-compatible"],
      treeState: async () => "",
      runOne: async (name, wrap) => {
        order.push(name);
        const gen = wrap(stubGenerator(scripts[name]!));
        return fakeRun(gen, 4, name === "claude-code" ? 12_000 : 30_000, name === "claude-code" ? undefined : 0);
      },
    });
    expect(order).toEqual(["claude-code", "openai-compatible"]);
    expect(rows[0]).toMatchObject({ generated: 4, generationErrors: 0, built: 4, passed: 3, accepted: 2, acceptanceRate: 0.5, linesPerCandidate: 1 });
    expect(rows[1]).toMatchObject({ generated: 4, generationErrors: 1, built: 2, passed: 2, accepted: 1, acceptanceRate: 0.25, costUsd: 0 });

    const report = compareReport({ repo: "pkg", targets: ["src/a.ts"], seed: 7 }, rows);
    expect(report).toContain(`Win criterion: ${WIN_CRITERION}`);
    expect(report).toContain("| claude-code | 4 | 0 | 4 | 3 | 2 | 50.0% | 1.00 | 12.0s | n/a (subscription) |");
    expect(report).toContain("| openai-compatible | 4 | 1 | 2 | 2 | 1 | 25.0% | 0.50 | 30.0s | $0.00 |");
    expect(report).toContain("Verdict: miss.");
    expect(report).toContain("Seed: 7");
    // Same inputs, same bytes.
    expect(compareReport({ repo: "pkg", targets: ["src/a.ts"], seed: 7 }, rows)).toBe(report);
  });

  it("keeps the counts of a run that failed its combined verification", async () => {
    const rows = await runComparison({
      generators: ["api"],
      treeState: async () => "",
      runOne: async (_name, wrap) => {
        throw new RunFailed("combined specs failed", await fakeRun(wrap(stubGenerator(["accepted"])), 1, 5, 0.5));
      },
    });
    expect(rows[0]).toMatchObject({ accepted: 1, error: "combined specs failed", costUsd: 0.5 });
  });

  it("stops when a run leaves the working tree different from how it found it", async () => {
    const states = ["", "", " M src/a.test.ts"];
    let reads = 0;
    const ran: GeneratorBackend[] = [];
    await expect(
      runComparison({
        generators: ["claude-code", "openai-compatible", "api"],
        treeState: async () => states[reads++] ?? "",
        runOne: async (name, wrap) => {
          ran.push(name);
          return fakeRun(wrap(stubGenerator([])), 0, 1);
        },
      }),
    ).rejects.toThrow(/openai-compatible run left the working tree changed/);
    expect(ran).toEqual(["claude-code", "openai-compatible"]);
  });
});

describe("verdict", () => {
  const row = (generator: GeneratorBackend, acceptanceRate: number, costUsd?: number): CompareRow => ({
    generator, generated: 10, generationErrors: 0, built: 0, passed: 0, accepted: 0, newlyCovered: 0, acceptanceRate, linesPerCandidate: 0, durationMs: 0, costUsd,
  });

  it("calls a local run within 5 points at zero cost a win, and anything else a miss", () => {
    expect(verdict([row("claude-code", 0.4), row("openai-compatible", 0.36, 0)])).toMatch(/^Verdict: win/);
    expect(verdict([row("api", 0.4, 1.2), row("openai-compatible", 0.5, 0)])).toMatch(/^Verdict: win/);
    expect(verdict([row("claude-code", 0.4), row("openai-compatible", 0.34, 0)])).toMatch(/^Verdict: miss.*data mix, context window, or base model/);
    expect(verdict([row("claude-code", 0.4)])).toBeUndefined();
  });
});

describe("gitTreeState", () => {
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore" });
  };

  it("reads a clean tree as clean between runs, ignoring the state directory, and sees a leftover file", async () => {
    const root = mkdtempSync(join(tmpdir(), "covergen-compare-"));
    try {
      git(root, "init", "-q");
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "init");
      const clean = await gitTreeState(root, ".covergen");
      expect(clean).toBe("");

      // What a dry run writes on purpose does not count.
      mkdirSync(join(root, ".covergen", "candidates"), { recursive: true });
      writeFileSync(join(root, ".covergen", "last-run.md"), "report");
      writeFileSync(join(root, ".covergen", "candidates", "x.ts"), "x");
      expect(await gitTreeState(root, ".covergen")).toBe(clean);

      // A spec a run failed to roll back does.
      writeFileSync(join(root, "a.test.ts"), "it('x', () => {});\n");
      expect(await gitTreeState(root, ".covergen")).toContain("a.test.ts");
      rmSync(join(root, "a.test.ts"));
      writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
      expect(await gitTreeState(root, ".covergen")).toContain(" M a.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
