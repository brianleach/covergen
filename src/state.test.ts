import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATE_DIR,
  MAX_RUNS,
  STATE_VERSION,
  emptyState,
  freezableHashes,
  loadState,
  recordRun,
  saveState,
  skipSet,
  statePath,
  type CovergenState,
} from "./state.js";
import type { Candidate, CandidateStatus, RepoConfig, RunSummary, Segment } from "./types.js";

async function tempRepo(): Promise<RepoConfig> {
  const root = await mkdtemp(join(tmpdir(), "covergen-state-"));
  return {
    name: "fixture",
    root,
    runner: "rspec",
    cwd: root,
    sources: ["app/**/*.rb"],
    specPath: (rel) => `spec/${rel}`,
  };
}

const segment: Segment = {
  path: "app/services/foo.rb",
  startLine: 1,
  endLine: 3,
  uncoveredLines: [2],
  text: "1: def call",
};

function candidate(hash: string, status: CandidateStatus): Candidate {
  return {
    id: hash,
    hash,
    segment,
    specPath: "spec/services/foo_spec.rb",
    code: "it 'x' do\nend",
    wholeFile: false,
    status,
    attempts: 1,
    history: [],
  };
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    repo: "fixture",
    targets: ["app/services/foo.rb"],
    candidates: [],
    accepted: [],
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 },
    durationMs: 10,
    ...over,
  };
}

describe("statePath", () => {
  it("defaults to .covergen/state.json under the repo root", async () => {
    const repo = await tempRepo();
    expect(statePath(repo)).toBe(join(repo.root, DEFAULT_STATE_DIR, "state.json"));
  });

  it("honors a custom state dir", async () => {
    const repo = await tempRepo();
    expect(statePath(repo, ".cg")).toBe(join(repo.root, ".cg", "state.json"));
  });
});

describe("loadState", () => {
  it("returns empty state when the file is missing", async () => {
    const repo = await tempRepo();
    expect(await loadState(repo)).toEqual(emptyState());
  });

  it("returns empty state when the file is corrupt rather than throwing", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo.root, DEFAULT_STATE_DIR), { recursive: true });
    await writeFile(statePath(repo), "{not json", "utf8");
    expect(await loadState(repo)).toEqual(emptyState());
  });
});

describe("save and load round trip", () => {
  it("preserves frozen, accepted and runs", async () => {
    const repo = await tempRepo();
    const state: CovergenState = {
      version: STATE_VERSION,
      frozen: ["f1", "f2"],
      accepted: ["a1"],
      runs: [{ at: "2026-01-01T00:00:00.000Z", targets: ["x.rb"], candidates: 3, accepted: 1, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 }, durationMs: 5 }],
    };
    await saveState(repo, state);
    expect(await loadState(repo)).toEqual(state);
  });

  it("leaves no temp file behind", async () => {
    const repo = await tempRepo();
    await saveState(repo, emptyState());
    const entries = await readdir(join(repo.root, DEFAULT_STATE_DIR));
    expect(entries).toEqual(["state.json"]);
  });

  it("writes pretty JSON ending in a newline", async () => {
    const repo = await tempRepo();
    await saveState(repo, emptyState());
    const text = await readFile(statePath(repo), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"frozen": []');
  });

  it("dedupes hashes on save", async () => {
    const repo = await tempRepo();
    await saveState(repo, { ...emptyState(), frozen: ["a", "a", "b"] });
    expect((await loadState(repo)).frozen).toEqual(["a", "b"]);
  });
});

describe("recordRun", () => {
  it("adds accepted hashes and the given frozen hashes", () => {
    const next = recordRun(emptyState(), summary({ accepted: [candidate("acc", "accepted")] }), {
      frozen: ["bad"],
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(next.accepted).toEqual(["acc"]);
    expect(next.frozen).toEqual(["bad"]);
    expect(next.runs).toHaveLength(1);
    expect(next.runs[0]?.at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("summarizes counts and tokens", () => {
    const accepted = [candidate("a", "accepted")];
    const candidates = [...accepted, candidate("b", "test_failed")];
    const next = recordRun(emptyState(), summary({ accepted, candidates }));
    expect(next.runs[0]).toMatchObject({ candidates: 2, accepted: 1, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 } });
  });

  it("keeps only the last 20 runs", () => {
    let state = emptyState();
    for (let i = 0; i < MAX_RUNS + 5; i += 1) {
      state = recordRun(state, summary({ durationMs: i }));
    }
    expect(state.runs).toHaveLength(MAX_RUNS);
    expect(state.runs[MAX_RUNS - 1]?.durationMs).toBe(MAX_RUNS + 4);
    expect(state.runs[0]?.durationMs).toBe(5);
  });

  it("never drops previously frozen hashes", () => {
    const start: CovergenState = { ...emptyState(), frozen: ["old"] };
    const next = recordRun(start, summary(), { frozen: ["new"] });
    expect(next.frozen.sort()).toEqual(["new", "old"]);
  });
});

describe("freezableHashes", () => {
  it("freezes terminal failures and rule violations, not accepted or frozen", () => {
    const list = [
      candidate("a", "accepted"),
      candidate("b", "test_failed"),
      candidate("c", "build_failed"),
      candidate("d", "flaky"),
      candidate("e", "no_coverage_gain"),
      candidate("f", "rule_violation"),
      candidate("i", "weak_assertions"),
      candidate("g", "frozen"),
      candidate("h", "generated"),
    ];
    expect(freezableHashes(list).sort()).toEqual(["b", "c", "d", "e", "f", "i"]);
  });
});

describe("skipSet", () => {
  it("is the union of frozen and accepted", () => {
    const set = skipSet({ ...emptyState(), frozen: ["f"], accepted: ["a"] });
    expect(set.has("f")).toBe(true);
    expect(set.has("a")).toBe(true);
    expect(set.has("other")).toBe(false);
  });

  it("does not record accepted hashes for a dry run", () => {
    const accepted = [{ hash: "acc", status: "accepted" } as unknown as Candidate];
    const next = recordRun(emptyState(), summary({ candidates: accepted, accepted }), { dryRun: true, frozen: ["fz"] });
    expect(next.accepted).toEqual([]);
    expect(next.frozen).toEqual(["fz"]);
  });

});

it("removes the temp file and rethrows when the rename fails", async () => {
  const repo = await tempRepo();
  await mkdir(statePath(repo), { recursive: true });
  await expect(saveState(repo, emptyState())).rejects.toThrow();
  const entries = await readdir(join(repo.root, DEFAULT_STATE_DIR));
  expect(entries).toEqual(["state.json"]);
});
