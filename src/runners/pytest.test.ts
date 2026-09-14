import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../types.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { covTargets, createPytestRunner, pytestSettings } from "./pytest.js";

const BANNER = "This is pytest version 8.3.4\nregistered third-party plugins:\n  pytest-cov-6.0.0 at /x/plugin.py";

/** `banner` answers `--version --version`; `writeLcov: false` makes the run produce none. */
type Options = { banner?: string; versionExit?: number; writeLcov?: boolean; runExit?: number };

function fakeExec(opts: Options = {}) {
  const calls: string[][] = [];
  const exec = async (cmd: string[], o: ExecOptions): Promise<ExecResult> => {
    calls.push(cmd);
    const report = cmd.find((a) => a.startsWith("--cov-report=lcov:"));
    if (report && opts.writeLcov !== false) {
      writeFileSync(report.slice("--cov-report=lcov:".length), "TN:\nSF:src/shop/rates.py\nDA:1,1\nend_of_record\n");
    }
    if (cmd.includes("--version")) {
      return { exitCode: opts.versionExit ?? 0, stdout: opts.banner ?? BANNER, stderr: "", durationMs: 1 };
    }
    return { exitCode: opts.runExit ?? 0, stdout: "", stderr: "", durationMs: 2 };
  };
  return { calls, exec };
}

let cwd: string;

function makeRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "py-lib",
    root: cwd,
    runner: "pytest",
    cwd,
    sources: ["src/**/*.py"],
    specPath: (rel) => `tests/test_${rel.split("/").pop()}`,
    pytest: { command: ["python3", "-m", "pytest"], testGlob: "tests/**/test_*.py" },
    ...over,
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "covergen-pytest-"));
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests", "test_rates.py"), "def test_x():\n    assert 1 == 1\n");
});

describe("pytest preflight", () => {
  it("takes --cov from the static prefix of each source glob, or from pytest.package", () => {
    expect(covTargets(["src/**/*.py"])).toEqual(["src"]);
    expect(covTargets(["shop/*.py", "billing/**/*.py"])).toEqual(["billing", "shop"]);
    expect(covTargets(["src/main.py"])).toEqual(["src"]);
    expect(covTargets(["**/*.py"])).toEqual(["."]);
    const repo = makeRepo({ pytest: { command: ["python3", "-m", "pytest"], package: "shop", testGlob: "t/**/*.py" } });
    expect(pytestSettings(repo).cov).toEqual(["shop"]);
  });

  it("probes the interpreter and the plugin, and stops there by default", async () => {
    const { calls, exec } = fakeExec();
    await expect(createPytestRunner(exec).preflight(makeRepo())).resolves.toBeUndefined();
    expect(calls[0]).toEqual(["python3", "--version"]);
    expect(calls[1]).toEqual(["python3", "-m", "pytest", "--version", "--version"]);
    // The coverage pass is the deep tier: nothing here imports the test module.
    expect(calls).toHaveLength(2);
  });

  it("writes a real lcov under --deep", async () => {
    const { calls, exec } = fakeExec();
    await expect(createPytestRunner(exec).preflight(makeRepo(), { deep: true })).resolves.toBeUndefined();
    expect(calls[2]).toContain("--cov=src");
    expect(calls[2]).toContain("tests/test_rates.py");
    // The smoke run must select nothing: it proves the lcov path, not the suite.
    expect(calls[2]!.includes("-k")).toBe(true);
  });

  it("prepends commandPrefix to every probe", async () => {
    const { calls, exec } = fakeExec();
    await createPytestRunner(exec).preflight(makeRepo({ commandPrefix: ["docker", "compose", "exec", "-T", "api"] }));
    for (const cmd of calls) expect(cmd.slice(0, 2)).toEqual(["docker", "compose"]);
  });
  it("names what is missing, one message per failure", async () => {
    const run = (repo: RepoConfig, opts?: Options) => createPytestRunner(fakeExec(opts).exec).preflight(repo);
    const glob = makeRepo({ pytest: { command: ["python3", "-m", "pytest"], testGlob: "spec/**/test_*.py" } });
    await expect(run(makeRepo(), { versionExit: 127 })).rejects.toThrow(/python3 --version/);
    await expect(run(makeRepo(), { banner: "pytest 8.3.4, no plugins" })).rejects.toThrow(/pytest-cov is not registered/);
    await expect(run(glob)).rejects.toThrow(/no test file matches/);
    await expect(createPytestRunner(fakeExec({ writeLcov: false }).exec).preflight(makeRepo(), { deep: true })).rejects.toThrow(
      /wrote no lcov records/,
    );
  });
});

describe("pytest run", () => {
  it("asks for lcov in a per-run directory and returns the path", async () => {
    const { calls, exec } = fakeExec();
    const res = await createPytestRunner(exec).run(makeRepo(), { files: ["tests/test_rates.py"], coverage: true, timeoutMs: 1000 });
    const cmd = calls[0]!;
    expect(cmd.slice(0, 4)).toEqual(["python3", "-m", "pytest", "tests/test_rates.py"]);
    expect(cmd).toContain("--cov=src");
    expect(cmd.some((a) => a.startsWith("--cov-report=lcov:"))).toBe(true);
    expect(res.lcovPath).toMatch(/lcov\.info$/);
    expect(res.ok).toBe(true);
  });

  it("passes no coverage flags when coverage is off", async () => {
    const { calls, exec } = fakeExec();
    const res = await createPytestRunner(exec).run(makeRepo(), { files: [], coverage: false, timeoutMs: 1000 });
    expect(calls[0]!.some((a) => a.startsWith("--cov"))).toBe(false);
    expect(res.lcovPath).toBeUndefined();
  });

  it("keeps a nonzero exit and notes a missing lcov rather than failing", async () => {
    const res = await createPytestRunner(fakeExec({ runExit: 1, writeLcov: false }).exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.lcovPath).toBeUndefined();
    expect(res.stderr).toMatch(/expected lcov at/);
  });
});

it("returns no tests when the runtime rejects the glob, rather than crashing preflight", async () => {
  const { exec } = fakeExec();
  // A malformed test_glob (not a string) makes fs.glob throw on the first iteration.
  const repo = makeRepo({ pytest: { command: ["python3", "-m", "pytest"], testGlob: 42 as unknown as string } });
  await expect(createPytestRunner(exec).preflight(repo)).rejects.toThrow(
    `pytest preflight failed for py-lib: no test file matches "42" under ${cwd}.`,
  );
});

it("reports a failing pytest --version with its banner and the install hint", async () => {
  const exec = async (cmd: string[]): Promise<ExecResult> => {
    if (cmd.includes("--version") && cmd.includes("pytest")) {
      return { exitCode: 4, stdout: "", stderr: "No module named pytest", durationMs: 1 };
    }
    return { exitCode: 0, stdout: "Python 3.12.1", stderr: "", durationMs: 1 };
  };
  await expect(createPytestRunner(exec).preflight(makeRepo())).rejects.toThrow(
    `pytest preflight failed in ${cwd}: \`python3 -m pytest --version\` exited 4.\nNo module named pytest\nInstall it with:  python -m pip install pytest pytest-cov`,
  );
});

describe("pytest specPathFor", () => {
  it("delegates to the repo's specPath mapping", () => {
    const { exec } = fakeExec();
    expect(createPytestRunner(exec).specPathFor(makeRepo(), "src/shop/rates.py")).toBe("tests/test_rates.py");
  });
});
