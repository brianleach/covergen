import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../types.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { RSPEC_SIMPLECOV_SNIPPET, createRspecRunner } from "./rspec.js";

interface Call {
  cmd: string[];
  opts: ExecOptions;
}

function fakeExec(opts?: { exitCode?: number; stderr?: string; writeLcov?: boolean }) {
  const calls: Call[] = [];
  const exec = async (cmd: string[], o: ExecOptions): Promise<ExecResult> => {
    calls.push({ cmd, opts: o });
    const target = o.env?.SIMPLECOV_LCOV_PATH;
    if (target && opts?.writeLcov !== false) {
      writeFileSync(target, "TN:\nend_of_record\n");
    }
    return { exitCode: opts?.exitCode ?? 0, stdout: "", stderr: opts?.stderr ?? "", durationMs: 7 };
  };
  return { calls, exec };
}

let root: string;

function makeRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "rails-api",
    root,
    runner: "rspec",
    cwd: root,
    sources: ["app/**/*.rb"],
    specPath: (rel) => `spec/${rel.replace(/^app\//, "").replace(/\.rb$/, "_spec.rb")}`,
    ...over,
  };
}

function writeLock(dir: string, contents: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Gemfile.lock"), contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "covergen-rspec-"));
});

describe("rspec preflight", () => {
  it("passes when rspec runs and simplecov-lcov is locked", async () => {
    writeLock(root, "GEM\n  specs:\n    simplecov-lcov (0.8.0)\n");
    const { calls, exec } = fakeExec();
    await expect(createRspecRunner(exec).preflight(makeRepo())).resolves.toBeUndefined();
    expect(calls[0]!.cmd).toEqual(["bundle", "exec", "rspec", "--version"]);
  });

  it("prepends commandPrefix to the version probe", async () => {
    writeLock(root, "simplecov-lcov (0.8.0)");
    const { calls, exec } = fakeExec();
    await createRspecRunner(exec).preflight(makeRepo({ commandPrefix: ["docker", "compose", "exec", "-T", "api"] }));
    expect(calls[0]!.cmd).toEqual([
      "docker",
      "compose",
      "exec",
      "-T",
      "api",
      "bundle",
      "exec",
      "rspec",
      "--version",
    ]);
  });

  it("throws when bundle exec rspec fails", async () => {
    writeLock(root, "simplecov-lcov (0.8.0)");
    const { exec } = fakeExec({ exitCode: 127, stderr: "bundler: command not found: rspec" });
    await expect(createRspecRunner(exec).preflight(makeRepo())).rejects.toThrow(
      /bundle exec rspec --version` exited 127[\s\S]*command not found/,
    );
  });

  it("throws when there is no Gemfile.lock", async () => {
    const { exec } = fakeExec();
    await expect(createRspecRunner(exec).preflight(makeRepo())).rejects.toThrow(/no Gemfile.lock at/);
  });

  it("throws with the bundle add hint and the spec_helper snippet when simplecov-lcov is missing", async () => {
    writeLock(root, "GEM\n  specs:\n    simplecov (0.22.0)\n");
    const { exec } = fakeExec();
    const err = await createRspecRunner(exec)
      .preflight(makeRepo())
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("bundle add simplecov-lcov --group test");
    expect(message).toContain(RSPEC_SIMPLECOV_SNIPPET);
  });

  it("finds Gemfile.lock at the repo root when cwd is nested", async () => {
    const cwd = join(root, "engines", "api");
    mkdirSync(cwd, { recursive: true });
    writeLock(root, "simplecov-lcov (0.8.0)");
    const { exec } = fakeExec();
    await expect(createRspecRunner(exec).preflight(makeRepo({ cwd }))).resolves.toBeUndefined();
  });
});

describe("RSPEC_SIMPLECOV_SNIPPET", () => {
  it("documents the formatter contract covergen depends on", () => {
    expect(RSPEC_SIMPLECOV_SNIPPET).toContain("SimpleCov.start");
    expect(RSPEC_SIMPLECOV_SNIPPET).toContain("SimpleCov::Formatter::LcovFormatter");
    expect(RSPEC_SIMPLECOV_SNIPPET).toContain("report_with_single_file = true");
    expect(RSPEC_SIMPLECOV_SNIPPET).toContain('ENV.fetch("SIMPLECOV_LCOV_PATH"');
    expect(RSPEC_SIMPLECOV_SNIPPET).toContain('ENV["SIMPLECOV_LCOV"]');
  });
});

describe("rspec run", () => {
  it("builds the progress-format command and sets the SimpleCov env", async () => {
    const { calls, exec } = fakeExec();
    const res = await createRspecRunner(exec).run(makeRepo(), {
      files: ["spec/models/user_spec.rb"],
      coverage: true,
      timeoutMs: 9000,
    });
    expect(calls[0]!.cmd).toEqual([
      "bundle",
      "exec",
      "rspec",
      "spec/models/user_spec.rb",
      "--format",
      "progress",
    ]);
    const env = calls[0]!.opts.env!;
    expect(env.COVERAGE).toBe("1");
    expect(env.SIMPLECOV_LCOV).toBe("1");
    expect(env.SIMPLECOV_LCOV_PATH).toMatch(new RegExp(`^${root}/\\.covergen/coverage/[^/]+/lcov\\.info$`));
    expect(res.lcovPath).toBe(env.SIMPLECOV_LCOV_PATH);
    expect(calls[0]!.opts.timeoutMs).toBe(9000);
    expect(res.ok).toBe(true);
  });

  it("merges caller env with the coverage env", async () => {
    const { calls, exec } = fakeExec();
    await createRspecRunner(exec).run(makeRepo(), {
      files: [],
      coverage: true,
      timeoutMs: 1000,
      env: { RAILS_ENV: "test", COVERGEN_SOURCE: "app/models/user.rb" },
    });
    const env = calls[0]!.opts.env!;
    expect(env.RAILS_ENV).toBe("test");
    expect(env.COVERGEN_SOURCE).toBe("app/models/user.rb");
    expect(env.COVERAGE).toBe("1");
  });

  it("sets no coverage env when coverage is false", async () => {
    const { calls, exec } = fakeExec();
    const res = await createRspecRunner(exec).run(makeRepo(), { files: [], coverage: false, timeoutMs: 1000 });
    expect(calls[0]!.opts.env).toEqual({});
    expect(res.lcovPath).toBeUndefined();
  });

  it("gives each run its own lcov path", async () => {
    const { exec } = fakeExec();
    const runner = createRspecRunner(exec);
    const opts = { files: [], coverage: true, timeoutMs: 1000 };
    const a = await runner.run(makeRepo(), opts);
    const b = await runner.run(makeRepo(), opts);
    expect(a.lcovPath).not.toBe(b.lcovPath);
  });

  it("notes a missing lcov without failing the run", async () => {
    const { exec } = fakeExec({ writeLcov: false });
    const res = await createRspecRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
    expect(res.ok).toBe(true);
    expect(res.lcovPath).toBeUndefined();
    expect(res.stderr).toContain("expected lcov at");
  });

  it("marks a non-zero exit as not ok", async () => {
    const { exec } = fakeExec({ exitCode: 1 });
    const res = await createRspecRunner(exec).run(makeRepo(), { files: [], coverage: false, timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
  });
});

describe("rspec specPathFor", () => {
  it("uses repo.specPath", () => {
    const { exec } = fakeExec();
    expect(createRspecRunner(exec).specPathFor(makeRepo(), "app/models/user.rb")).toBe("spec/models/user_spec.rb");
  });
});
