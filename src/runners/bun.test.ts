import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../types.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { parseLcov } from "../lcov.js";
import { createBunRunner } from "./bun.js";

interface Call {
  cmd: string[];
  opts: ExecOptions;
}

function fakeExec(opts?: { exitCode?: number; stderr?: string; writeLcov?: boolean; lcov?: string }) {
  const calls: Call[] = [];
  const exec = async (cmd: string[], o: ExecOptions): Promise<ExecResult> => {
    calls.push({ cmd, opts: o });
    const dirArg = cmd.find((a) => a.startsWith("--coverage-dir="));
    if (dirArg && opts?.writeLcov !== false) {
      const dir = dirArg.slice("--coverage-dir=".length);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "lcov.info"), opts?.lcov ?? "TN:\nend_of_record\n");
    }
    return { exitCode: opts?.exitCode ?? 0, stdout: "", stderr: opts?.stderr ?? "", durationMs: 3 };
  };
  return { calls, exec };
}

let root: string;

function makeRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "react-app",
    root,
    runner: "bun",
    cwd: root,
    sources: ["src/**/*.ts"],
    specPath: (rel) => rel.replace(/\.tsx?$/, ".test.ts"),
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "covergen-bun-"));
});

describe("bun preflight", () => {
  it("probes bun --version", async () => {
    const { calls, exec } = fakeExec();
    await expect(createBunRunner(exec).preflight(makeRepo())).resolves.toBeUndefined();
    expect(calls[0]!.cmd).toEqual(["bun", "--version"]);
    expect(calls[0]!.opts.cwd).toBe(root);
  });

  it("honors commandPrefix on the probe", async () => {
    const { calls, exec } = fakeExec();
    await createBunRunner(exec).preflight(makeRepo({ commandPrefix: ["docker", "exec", "fe"] }));
    expect(calls[0]!.cmd).toEqual(["docker", "exec", "fe", "bun", "--version"]);
  });

  it("throws an install hint when bun is missing", async () => {
    const { exec } = fakeExec({ exitCode: 127, stderr: "command not found: bun" });
    await expect(createBunRunner(exec).preflight(makeRepo())).rejects.toThrow(
      /bun --version` exited 127[\s\S]*Install bun/,
    );
  });
});

describe("bun run", () => {
  it("builds the coverage command with a per-run coverage dir", async () => {
    const { calls, exec } = fakeExec();
    const res = await createBunRunner(exec).run(makeRepo(), {
      files: ["src/a.test.ts"],
      coverage: true,
      timeoutMs: 1000,
    });
    const cmd = calls[0]!.cmd;
    expect(cmd.slice(0, 3)).toEqual(["bun", "test", "src/a.test.ts"]);
    expect(cmd).toContain("--coverage");
    expect(cmd).toContain("--coverage-reporter=lcov");
    const dirArg = cmd.find((a) => a.startsWith("--coverage-dir="))!;
    expect(dirArg).toMatch(new RegExp(`${root}/\\.covergen/coverage/[^/]+$`));
    expect(res.lcovPath).toBe(join(dirArg.slice("--coverage-dir=".length), "lcov.info"));
  });

  it("omits coverage flags when coverage is false", async () => {
    const { calls, exec } = fakeExec();
    const res = await createBunRunner(exec).run(makeRepo(), {
      files: ["src/a.test.ts"],
      coverage: false,
      timeoutMs: 1000,
    });
    expect(calls[0]!.cmd).toEqual(["bun", "test", "src/a.test.ts"]);
    expect(res.lcovPath).toBeUndefined();
  });

  it("forwards env, cwd, timeout and commandPrefix", async () => {
    const { calls, exec } = fakeExec();
    await createBunRunner(exec).run(makeRepo({ commandPrefix: ["docker", "exec", "fe"] }), {
      files: [],
      coverage: false,
      timeoutMs: 1234,
      env: { NODE_ENV: "test" },
    });
    expect(calls[0]!.cmd).toEqual(["docker", "exec", "fe", "bun", "test"]);
    expect(calls[0]!.opts).toEqual({ cwd: root, timeoutMs: 1234, env: { NODE_ENV: "test" } });
  });

  it("uses a fresh dir per run", async () => {
    const { exec } = fakeExec();
    const runner = createBunRunner(exec);
    const opts = { files: [], coverage: true, timeoutMs: 1000 };
    const a = await runner.run(makeRepo(), opts);
    const b = await runner.run(makeRepo(), opts);
    expect(a.lcovPath).not.toBe(b.lcovPath);
  });

  it("notes a missing lcov without failing the run", async () => {
    const { exec } = fakeExec({ writeLcov: false });
    const res = await createBunRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
    expect(res.ok).toBe(true);
    expect(res.lcovPath).toBeUndefined();
    expect(res.stderr).toContain("expected lcov at");
  });

  describe("with COVERGEN_SOURCE", () => {
    const twoFiles = [
      "TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record",
      "TN:\nSF:src/b.ts\nDA:1,3\nLF:1\nLH:1\nend_of_record\n",
    ].join("\n");
    const opts = { files: ["src/a.test.ts"], coverage: true, timeoutMs: 1000 };

    it("keeps only the target's record", async () => {
      const { exec } = fakeExec({ lcov: twoFiles });
      const res = await createBunRunner(exec).run(makeRepo(), { ...opts, env: { COVERGEN_SOURCE: "src/a.ts" } });
      const map = parseLcov(readFileSync(res.lcovPath!, "utf8"), { cwd: root });
      expect([...map.keys()]).toEqual(["src/a.ts"]);
      expect([...map.get("src/a.ts")!.lines]).toEqual([
        [1, 1],
        [2, 0],
      ]);
    });

    it("matches an absolute SF path against the cwd-relative source", async () => {
      const { exec } = fakeExec({ lcov: twoFiles.replace("SF:src/a.ts", `SF:${join(root, "src/a.ts")}`) });
      const res = await createBunRunner(exec).run(makeRepo(), { ...opts, env: { COVERGEN_SOURCE: "src/a.ts" } });
      expect([...parseLcov(readFileSync(res.lcovPath!, "utf8"), { cwd: root }).keys()]).toEqual(["src/a.ts"]);
    });

    it("leaves every record when the env var is absent", async () => {
      const { exec } = fakeExec({ lcov: twoFiles });
      const res = await createBunRunner(exec).run(makeRepo(), opts);
      expect([...parseLcov(readFileSync(res.lcovPath!, "utf8"), { cwd: root }).keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    });
  });

  it("maps exit code to ok", async () => {
    const { exec } = fakeExec({ exitCode: 2 });
    const res = await createBunRunner(exec).run(makeRepo(), { files: [], coverage: false, timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(2);
  });
});

describe("bun specPathFor", () => {
  it("uses repo.specPath", () => {
    const { exec } = fakeExec();
    expect(createBunRunner(exec).specPathFor(makeRepo(), "src/a.tsx")).toBe("src/a.test.ts");
  });
});
