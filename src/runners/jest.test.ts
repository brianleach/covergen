import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../types.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { createJestRunner } from "./jest.js";

interface Call {
  cmd: string[];
  opts: ExecOptions;
}

function fakeExec(opts?: { exitCode?: number; writeLcov?: boolean }) {
  const calls: Call[] = [];
  const exec = async (cmd: string[], o: ExecOptions): Promise<ExecResult> => {
    calls.push({ cmd, opts: o });
    const dirArg = cmd.find((a) => a.startsWith("--coverageDirectory="));
    if (dirArg && opts?.writeLcov !== false) {
      const dir = dirArg.slice("--coverageDirectory=".length);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "lcov.info"), "TN:\nend_of_record\n");
    }
    return { exitCode: opts?.exitCode ?? 0, stdout: "", stderr: "", durationMs: 4 };
  };
  return { calls, exec };
}

let root: string;

function makeRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "mobile-app",
    root,
    runner: "jest",
    cwd: root,
    sources: ["src/**/*.tsx"],
    specPath: (rel) => rel.replace(/\.tsx?$/, ".test.tsx"),
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "covergen-jest-"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
});

describe("jest preflight", () => {
  it("passes when jest is in node_modules under cwd", async () => {
    mkdirSync(join(root, "node_modules", "jest"), { recursive: true });
    const { exec } = fakeExec();
    await expect(createJestRunner(exec).preflight(makeRepo())).resolves.toBeUndefined();
  });

  it("passes when jest is hoisted to the repo root", async () => {
    const cwd = join(root, "apps", "mobile");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, "node_modules", "jest"), { recursive: true });
    const { exec } = fakeExec();
    await expect(createJestRunner(exec).preflight(makeRepo({ cwd }))).resolves.toBeUndefined();
  });

  it("throws with an install hint when jest is missing", async () => {
    const { exec } = fakeExec();
    await expect(createJestRunner(exec).preflight(makeRepo())).rejects.toThrow(
      /jest is not installed for mobile-app[\s\S]*npm i -D jest/,
    );
  });

  it("does not shell out at all", async () => {
    mkdirSync(join(root, "node_modules", "jest"), { recursive: true });
    const { calls, exec } = fakeExec();
    await createJestRunner(exec).preflight(makeRepo());
    expect(calls).toHaveLength(0);
  });
});

describe("jest run", () => {
  it("builds the coverage command with a per-run coverage directory", async () => {
    const { calls, exec } = fakeExec();
    const res = await createJestRunner(exec).run(makeRepo(), {
      files: ["src/a.test.tsx"],
      coverage: true,
      timeoutMs: 1000,
    });
    const cmd = calls[0]!.cmd;
    expect(cmd.slice(0, 4)).toEqual(["npx", "jest", "--runTestsByPath", "src/a.test.tsx"]);
    expect(cmd).toContain("--coverage");
    expect(cmd).toContain("--coverageReporters=lcov");
    expect(cmd).toContain("--runInBand");
    expect(cmd).toContain("--forceExit");
    const dirArg = cmd.find((a) => a.startsWith("--coverageDirectory="))!;
    expect(res.lcovPath).toBe(join(dirArg.slice("--coverageDirectory=".length), "lcov.info"));
  });

  it("keeps runInBand and forceExit when coverage is off", async () => {
    const { calls, exec } = fakeExec();
    const res = await createJestRunner(exec).run(makeRepo(), {
      files: ["src/a.test.tsx"],
      coverage: false,
      timeoutMs: 1000,
    });
    expect(calls[0]!.cmd).toEqual(["npx", "jest", "--runTestsByPath", "src/a.test.tsx", "--runInBand", "--forceExit"]);
    expect(res.lcovPath).toBeUndefined();
  });

  it("adds collectCoverageFrom when COVERGEN_SOURCE is set", async () => {
    const { calls, exec } = fakeExec();
    await createJestRunner(exec).run(makeRepo(), {
      files: [],
      coverage: true,
      timeoutMs: 1000,
      env: { COVERGEN_SOURCE: "src/a.tsx" },
    });
    expect(calls[0]!.cmd).toContain("--collectCoverageFrom=src/a.tsx");
  });

  it("escapes glob metacharacters in collectCoverageFrom", async () => {
    const { calls, exec } = fakeExec();
    await createJestRunner(exec).run(makeRepo(), {
      files: [],
      coverage: true,
      timeoutMs: 1000,
      env: { COVERGEN_SOURCE: "src/app/(admin)/[id]/page.tsx" },
    });
    expect(calls[0]!.cmd).toContain("--collectCoverageFrom=src/app/\\(admin\\)/\\[id\\]/page.tsx");
  });

  it("does not add collectCoverageFrom without COVERGEN_SOURCE", async () => {
    const { calls, exec } = fakeExec();
    await createJestRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
    expect(calls[0]!.cmd.some((a) => a.startsWith("--collectCoverageFrom="))).toBe(false);
  });

  it("forwards env, cwd, timeout and commandPrefix", async () => {
    const { calls, exec } = fakeExec();
    await createJestRunner(exec).run(makeRepo({ commandPrefix: ["docker", "exec", "app"] }), {
      files: [],
      coverage: false,
      timeoutMs: 555,
      env: { TZ: "UTC" },
    });
    expect(calls[0]!.cmd.slice(0, 5)).toEqual(["docker", "exec", "app", "npx", "jest"]);
    expect(calls[0]!.opts).toEqual({ cwd: root, timeoutMs: 555, env: { TZ: "UTC" } });
  });

  it("uses a fresh dir per run", async () => {
    const { exec } = fakeExec();
    const runner = createJestRunner(exec);
    const opts = { files: [], coverage: true, timeoutMs: 1000 };
    const a = await runner.run(makeRepo(), opts);
    const b = await runner.run(makeRepo(), opts);
    expect(a.lcovPath).not.toBe(b.lcovPath);
  });

  it("notes a missing lcov without failing the run", async () => {
    const { exec } = fakeExec({ writeLcov: false });
    const res = await createJestRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
    expect(res.ok).toBe(true);
    expect(res.lcovPath).toBeUndefined();
    expect(res.stderr).toContain("expected lcov at");
  });

  it("maps exit code to ok", async () => {
    const { exec } = fakeExec({ exitCode: 1 });
    const res = await createJestRunner(exec).run(makeRepo(), { files: [], coverage: false, timeoutMs: 1000 });
    expect(res.ok).toBe(false);
  });
});

describe("jest specPathFor", () => {
  it("uses repo.specPath", () => {
    const { exec } = fakeExec();
    expect(createJestRunner(exec).specPathFor(makeRepo(), "src/a.tsx")).toBe("src/a.test.tsx");
  });
});
