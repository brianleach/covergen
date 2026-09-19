/**
 * The removal path end to end, on the audit fixture and with no runner, no git
 * and no gh: a stub runner decides what the suite covers after the cut, and a
 * fake command executor stands in for the push. What is real is the fixture's
 * text, the line spans, the cut, the restore and the journal.
 */

import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditReport, AuditedCase } from "./audit.js";
import { loadConfig } from "./config.js";
import type { GitExecResult } from "./git.js";
import { createLogger } from "./logger.js";
import { cutSpans, planRemovals, proposable, repairable, runRemoval } from "./removal.js";
import type { RepoConfig, RunResult, Runner } from "./types.js";

const log = createLogger({ level: "silent" });
const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");
const config = loadConfig(join(FIXTURES, "covergen.fixtures.yaml"));
const SPEC = "src/rates.test.ts";

const one = (over: Partial<AuditedCase>): AuditedCase => ({
  spec: SPEC,
  case: "adds the rate and rounds",
  line: 13,
  verdict: "keeps",
  flags: [],
  caught: 0,
  planted: 0,
  coveredLines: 0,
  uniqueLines: 0,
  durationMs: 0,
  ...over,
});

/** The four cases of fixtures/audit-vitest, as the audit reports them. */
const keeps = one({ caught: 1, planted: 2, coveredLines: 2, durationMs: 400 });
const redundant = one({ case: "leaves its arguments alone", line: 19, verdict: "redundant", flags: ["weak_dynamic", "redundant"], planted: 2, coveredLines: 2, durationMs: 300 });
const onlyCoverage = one({ case: "handles a high amount", line: 26, verdict: "weak_dynamic", flags: ["weak_static", "weak_dynamic"], reason: "no-tautology: asserts a literal", planted: 2, coveredLines: 3, uniqueLines: 3, durationMs: 200 });
const declaration = one({ case: "exports the rate helpers", line: 32, verdict: "weak_static", flags: ["weak_static"], reason: "behavioral-evidence: never calls the code", durationMs: 100 });

const report = (over: Partial<AuditReport["repos"][number]> = {}): AuditReport => ({
  startedAt: "2026-09-19T00:00:00.000Z",
  endedAt: "2026-09-19T00:00:10.000Z",
  durationMs: 10_000,
  deep: false,
  totals: { cases: 4, keeps: 1, weakStatic: 2, weakDynamic: 2, redundant: 1, planted: 6, caught: 1, wastedMs: 600 },
  repos: [{ repo: "audit-vitest", runner: "vitest", granularity: "case", specs: 1, suiteLines: 5, auditedCases: [keeps, redundant, onlyCoverage, declaration], slowestSpecs: [], ...over }],
});

const fixtureText = (): Promise<string> => readFile(join(FIXTURES, "audit-vitest", SPEC), "utf8");

describe("the two never-rules", () => {
  it("never proposes a case that caught a planted bug, however redundant it looks", () => {
    expect(proposable(one({ verdict: "redundant", flags: ["weak_dynamic", "redundant"], caught: 1, planted: 2 }))).toBe(false);
  });

  it("never proposes a case that is some line's only coverage, and calls it a repair instead", () => {
    expect(proposable(onlyCoverage)).toBe(false);
    expect(repairable(onlyCoverage)).toBe(true);
  });

  it("proposes a case that catches nothing and covers nothing of its own", () => {
    expect(proposable(redundant)).toBe(true);
    expect(repairable(redundant)).toBe(false);
  });
});

describe("planRemovals", () => {
  it("cuts the redundant case at its own block and holds the rest back", async () => {
    const plan = planRemovals(report(), new Map([[SPEC, await fixtureText()]]));
    expect(plan.remove.map((c) => [c.case, c.start, c.end])).toEqual([["leaves its arguments alone", 19, 23]]);
    expect(plan.repair.map((c) => c.case)).toEqual(["handles a high amount"]);
    expect(plan.savedMs).toBe(300);
  });

  it("leaves a case alone when cutting it saves less than the floor asks for", async () => {
    expect(planRemovals(report(), new Map([[SPEC, await fixtureText()]]), 500).remove).toEqual([]);
  });

  it("proposes nothing for a runner that cannot name a single case", async () => {
    const plan = planRemovals(report({ granularity: "spec" }), new Map([[SPEC, await fixtureText()]]));
    expect(plan.remove).toEqual([]);
  });
});

describe("cutSpans", () => {
  it("takes the case, the comment that introduces it and the blank line under it", async () => {
    const cut = cutSpans(await fixtureText(), [{ start: 19, end: 23 }]);
    expect(cut).not.toContain("leaves its arguments alone");
    expect(cut).not.toContain("redundant: same lines as the case above");
    expect(cut).toContain("adds the rate and rounds");
    expect(cut).toContain("handles a high amount");
    expect(cut).toContain("exports the rate helpers");
    // The file is still a file: the describe it sat in still closes.
    expect(cut.trimEnd().endsWith("});")).toBe(true);
  });
});

/** A copy of the fixture repo, with the config pointed at it. */
async function checkout(): Promise<RepoConfig> {
  const dir = await mkdtemp(join(tmpdir(), "covergen-removal-"));
  await cp(join(FIXTURES, "audit-vitest"), dir, { recursive: true });
  const repo = config.repos.find((r) => r.name === "audit-vitest") as RepoConfig;
  return { ...repo, root: dir, cwd: dir };
}

/** An lcov file covering `lines` of the fixture's one source file. */
async function lcov(dir: string, lines: number[]): Promise<string> {
  const path = join(dir, "coverage", "lcov.info");
  await mkdir(join(dir, "coverage"), { recursive: true });
  await writeFile(path, ["SF:src/rates.ts", ...lines.map((n) => `DA:${n},1`), "end_of_record", ""].join("\n"), "utf8");
  return path;
}

const stubRunner = (result: Partial<RunResult>): Runner => ({
  name: "vitest",
  preflight: async () => undefined,
  run: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 10, ...result }),
  specPathFor: (_repo, relSource) => relSource,
});

const noExec = async (): Promise<GitExecResult> => ({ stdout: "", stderr: "", exitCode: 0 });

describe("runRemoval", () => {
  it("cuts the case, proves the coverage is unchanged and opens one draft PR", async () => {
    const repo = await checkout();
    const opened: { files: string[]; title: string; body: string }[] = [];
    const outcome = await runRemoval({
      config,
      repo,
      log,
      report: report(),
      minSavingsMs: 0,
      runner: stubRunner({ lcovPath: await lcov(repo.cwd, [2, 3, 8, 9, 11]) }),
      exec: noExec,
      openPr: async (args) => {
        opened.push({ files: args.files, title: args.title, body: args.body });
        return ["https://github.com/example/repo/pull/1"];
      },
    });

    expect(outcome.status).toBe("opened");
    expect(outcome.urls).toEqual(["https://github.com/example/repo/pull/1"]);
    expect(await readFile(join(repo.cwd, SPEC), "utf8")).not.toContain("leaves its arguments alone");
    expect(opened[0]?.files).toEqual([SPEC]);
    expect(opened[0]?.title).toBe("covergen audit: 1 test proposed for removal in audit-vitest");
    expect(opened[0]?.body).toContain("| src/rates.test.ts:19 | leaves its arguments alone | weak_dynamic, redundant | 0 of 2 | 0 of 2 | 0.3 |");
    expect(opened[0]?.body).toContain("Not proposed: repair these instead");
    expect(opened[0]?.body).toContain("handles a high amount: 3 lines nothing else covers");
    expect(opened[0]?.body).toContain("No model was involved");
    const journal = JSON.parse(await readFile(outcome.journal as string, "utf8")) as { status: string; removed: { case: string; endLine: number }[] };
    expect(journal.status).toBe("finished");
    expect(journal.removed).toEqual([expect.objectContaining({ case: "leaves its arguments alone", startLine: 19, endLine: 23 })]);
  });

  it("puts the file back and opens nothing when the cut lost a covered line", async () => {
    const repo = await checkout();
    const before = await readFile(join(repo.cwd, SPEC), "utf8");
    const outcome = await runRemoval({
      config,
      repo,
      log,
      report: report(),
      minSavingsMs: 0,
      runner: stubRunner({ lcovPath: await lcov(repo.cwd, [2, 3, 8, 9]) }),
      exec: noExec,
      openPr: async () => {
        throw new Error("a reverted removal must not open a PR");
      },
    });

    expect(outcome.status).toBe("reverted");
    expect(outcome.reason).toContain("lost 1 covered line");
    expect(await readFile(join(repo.cwd, SPEC), "utf8")).toBe(before);
    const journal = JSON.parse(await readFile(outcome.journal as string, "utf8")) as { status: string; reason: string };
    expect(journal.status).toBe("reverted");
  });

  it("puts the file back when the suite failed after the cut", async () => {
    const repo = await checkout();
    const before = await readFile(join(repo.cwd, SPEC), "utf8");
    const outcome = await runRemoval({
      config,
      repo,
      log,
      report: report(),
      minSavingsMs: 0,
      runner: stubRunner({ ok: false, exitCode: 1 }),
      exec: noExec,
      openPr: async () => {
        throw new Error("a reverted removal must not open a PR");
      },
    });

    expect(outcome.status).toBe("reverted");
    expect(outcome.reason).toContain("the suite failed after the cut");
    expect(await readFile(join(repo.cwd, SPEC), "utf8")).toBe(before);
  });
});
