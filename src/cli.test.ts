import { describe, expect, test } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryPoint } from "./cli.js";

describe("isEntryPoint", () => {
  test("matches the module's own path", () => {
    const here = fileURLToPath(import.meta.url).replace(/\.test\.ts$/, ".ts");
    expect(isEntryPoint(pathToFileURL(here).href, here)).toBe(true);
  });

  test("matches through a symlink, which is how a global install invokes the bin", () => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-bin-"));
    const target = join(dir, "cli.js");
    writeFileSync(target, "");
    const link = join(dir, "covergen");
    symlinkSync(target, link);
    expect(isEntryPoint(pathToFileURL(target).href, link)).toBe(true);
  });

  test("is false when the module is imported rather than run", () => {
    expect(isEntryPoint("file:///a/cli.js", "/b/other.js")).toBe(false);
  });

  test("is false with no entry at all", () => {
    expect(isEntryPoint("file:///a/cli.js", undefined)).toBe(false);
  });

  test("does not throw when the entry path does not exist", () => {
    expect(isEntryPoint("file:///a/cli.js", "/nope/does/not/exist.js")).toBe(false);
  });
});

  test("sweep routes --all and --pr through sweepAll, one repo through runPipeline, and rejects bad flags", async () => {
    const { vi } = await import("vitest");
    const repo = { name: "app", runner: "vitest", cwd: "/repo/app" };
    const config = {
      anthropic: { api_key_env: "COVERGEN_CLI_TEST_KEY" },
      repos: [repo],
      sweep: { max_tokens_per_run: 1000, max_minutes: 5 },
      warnings: [],
    };
    const sweepAll = vi.fn();
    const sweepTargets = vi.fn();
    const writeReport = vi.fn(async () => {});
    const runPipeline = vi.fn();
    const log: Record<string, unknown> = {};
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) log[level] = vi.fn();
    log.child = () => log;
    vi.doMock("./logger.js", async (orig) => ({
      ...(await orig<typeof import("./logger.js")>()),
      createLogger: () => log,
    }));
    vi.doMock("./config.js", async (orig) => ({
      ...(await orig<typeof import("./config.js")>()),
      loadConfig: () => config,
      findRepo: (c: typeof config, name: string) => c.repos.find((r) => r.name === name),
      generatorBackend: () => "claude-code",
    }));
    vi.doMock("./sweep.js", async (orig) => ({
      ...(await orig<typeof import("./sweep.js")>()),
      sweepAll,
      sweepTargets,
      writeReport,
      reportLines: () => "REPORT\n",
      runFields: (s: { accepted: unknown[] }) => ({ accepted: s.accepted.length }),
    }));
    vi.doMock("./pipeline.js", () => ({ runPipeline }));
    vi.doMock("./emit.js", async (orig) => ({
      ...(await orig<typeof import("./emit.js")>()),
      prBody: () => "PR BODY\n",
      mutationScore: () => undefined,
    }));
    vi.doMock("./limits.js", async (orig) => ({ ...(await orig<typeof import("./limits.js")>()), totalTokens: () => 42 }));
    vi.resetModules();
    const { main } = await import("./cli.js");
    const { EXIT_ABORTED } = await import("./abort.js");

    let out = "";
    let err = "";
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
      out += String(c);
      return true;
    }) as typeof process.stdout.write);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
      err += String(c);
      return true;
    }) as typeof process.stderr.write);
    const dir = mkdtempSync(join(tmpdir(), "covergen-cfg-"));
    writeFileSync(join(dir, ".env"), "COVERGEN_CLI_TEST_KEY=sk-from-dotenv\n");
    const cfg = join(dir, "covergen.yaml");
    const argv = ["node", "covergen", "--config", cfg, "--log-level", "silent", "sweep"];
    try {
      await main([...argv, "--all", "--repo", "app"]);
      expect(process.exitCode).toBe(1);
      expect(err).toContain("--all sweeps every repo");
      expect(log.debug).toHaveBeenCalledWith({ envPath: join(dir, ".env") }, expect.any(String));

      await main(argv);
      expect(process.exitCode).toBe(1);
      expect(err).toContain("sweep needs --repo <name> or --all.");

      sweepAll.mockResolvedValueOnce({
        abortedBy: "SIGINT",
        repos: [{ repo: "app", accepted: 2, aborted: true, journal: "/runs/j.jsonl" }],
      });
      await main([...argv, "--all", "--limit", "nope", "--report", "all.json"]);
      expect(sweepAll).toHaveBeenLastCalledWith(
        expect.objectContaining({ config, limit: 10, pr: false, dryRun: false, apiKey: "sk-from-dotenv" }),
      );
      expect(writeReport).toHaveBeenLastCalledWith("all.json", expect.objectContaining({ abortedBy: "SIGINT" }));
      expect(out).toContain("REPORT");
      expect(out).toContain("Aborted on SIGINT. 2 accepted tests are on disk");
      expect(out).toContain("/runs/j.jsonl");
      expect(process.exitCode).toBe(EXIT_ABORTED);

      sweepAll.mockResolvedValueOnce({ repos: [{ repo: "app", accepted: 0, prUrl: "https://example.test/pr/1" }] });
      await main([...argv, "--repo", "app", "--pr"]);
      expect(sweepAll.mock.lastCall?.[0]).toMatchObject({ config: { repos: [repo] }, pr: true });
      expect(process.exitCode).toBe(0);

      sweepTargets.mockResolvedValueOnce([]);
      await main([...argv, "--repo", "app", "--changed-since", "main"]);
      expect(sweepTargets).toHaveBeenLastCalledWith(expect.objectContaining({ repo, changedSince: "main" }));
      expect(runPipeline).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      out = "";
      sweepTargets.mockResolvedValueOnce(["a.ts", "b.ts"]);
      runPipeline.mockResolvedValueOnce({ accepted: [{ file: "a.test.ts" }], durationMs: 5000, tokens: {} });
      await main([...argv, "--repo", "app", "--limit", "3", "--dry-run", "--report", "one.json"]);
      expect(sweepTargets).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 3 }));
      expect(runPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ repo, targets: ["a.ts", "b.ts"], dryRun: true, fast: false, apiKey: "sk-from-dotenv" }),
      );
      expect(writeReport).toHaveBeenLastCalledWith(
        "one.json",
        expect.objectContaining({
          startedAt: "2026-01-01T00:00:05.000Z",
          endedAt: "2026-01-01T00:00:10.000Z",
          dryRun: true,
          tokens: 42,
          repos: [expect.objectContaining({ repo: "app", status: "ran", targetsAttempted: 2, accepted: 1 })],
        }),
      );
      expect(out).toContain("PR BODY");
      expect(process.exitCode).toBe(0);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      vi.useRealTimers();
      process.exitCode = undefined;
      for (const m of ["./logger.js", "./config.js", "./sweep.js", "./pipeline.js", "./emit.js", "./limits.js"]) vi.doUnmock(m);
      vi.resetModules();
    }
  });

  test("resumeNote points at the journal only when accepted tests are on disk", async () => {
    const { resumeNote } = await import("./cli.js");
    expect(resumeNote(0, "/tmp/j.json", "SIGTERM")).toBe(
      "\nAborted on SIGTERM. 0 accepted tests are on disk, not rolled back.\n",
    );
    expect(resumeNote(1, "/tmp/j.json", "SIGINT")).toBe(
      "\nAborted on SIGINT. 1 accepted test is on disk, not rolled back.\n" +
        "Open the draft PR for them without regenerating:\n  covergen pr --from /tmp/j.json\n",
    );
  });

  test("run exits aborted with a resume note, then OK once tests are accepted", async () => {
    const { vi } = await import("vitest");
    const repo = { name: "web", runner: "vitest", cwd: "/repo" };
    const config = {
      repos: [repo],
      anthropic: { api_key_env: "COVERGEN_TEST_KEY" },
      sweep: { max_tokens_per_run: 1000, max_minutes: 5 },
      warnings: [],
    };
    const runPipeline = vi
      .fn()
      .mockResolvedValueOnce({ accepted: [{}], aborted: "SIGINT", journal: "/tmp/j.json", durationMs: 0 })
      .mockResolvedValueOnce({ accepted: [{}], durationMs: 0 });
    vi.resetModules();
    vi.doMock("./config.js", async (orig) => ({
      ...(await orig<typeof import("./config.js")>()),
      loadConfig: () => config,
      findRepo: () => repo,
      generatorBackend: () => "claude-code",
    }));
    vi.doMock("./pipeline.js", () => ({ runPipeline }));
    vi.doMock("./emit.js", async (orig) => ({ ...(await orig<typeof import("./emit.js")>()), prBody: () => "PR BODY\n" }));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { buildProgram } = await import("./cli.js");
      const { EXIT_ABORTED } = await import("./abort.js");
      const argv = ["node", "covergen", "--log-level", "silent", "run", "--repo", "web", "--file", "src/a.ts", "--dry-run"];

      await buildProgram().parseAsync(argv);
      expect(process.exitCode).toBe(EXIT_ABORTED);
      const written = out.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain("PR BODY");
      expect(written).toContain("1 accepted test is on disk, not rolled back.");
      expect(written).toContain("covergen pr --from /tmp/j.json");
      expect(runPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ repo, targets: ["src/a.ts"], dryRun: true, fast: false, refreshBaseline: false }),
      );

      await buildProgram().parseAsync(argv);
      expect(process.exitCode).toBe(0);
    } finally {
      out.mockRestore();
      process.exitCode = undefined;
      vi.doUnmock("./config.js");
      vi.doUnmock("./pipeline.js");
      vi.doUnmock("./emit.js");
      vi.resetModules();
    }
  });

  test("baseline surfaces the runner output without lcov, and ranks files with it", async () => {
    const { vi } = await import("vitest");
    const repo = { name: "web", runner: "vitest", cwd: "/repo", sources: ["src/**/*.ts"] };
    const config = { repos: [repo], anthropic: { api_key_env: "COVERGEN_TEST_KEY" }, gate: { timeout_ms: 1000 }, warnings: [] };
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 3, stderr: "boom", stdout: "ran 0 files" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "", lcovPath: "/repo/lcov.info" });
    vi.resetModules();
    vi.doMock("./config.js", async (orig) => ({
      ...(await orig<typeof import("./config.js")>()),
      loadConfig: () => config,
      findRepo: () => repo,
      generatorBackend: () => "claude-code",
    }));
    vi.doMock("./runners/index.js", async (orig) => ({
      ...(await orig<typeof import("./runners/index.js")>()),
      getRunner: () => ({ preflight: async () => {}, run }),
    }));
    vi.doMock("./lcov.js", async (orig) => ({
      ...(await orig<typeof import("./lcov.js")>()),
      readLcov: () => new Map([["src/a.ts", { path: "src/a.ts", lines: new Map([[1, 1], [2, 0]]) }], ["vite.config.ts", { path: "vite.config.ts", lines: new Map([[1, 0], [2, 0]]) }]]),
    }));
    vi.doMock("./value.js", async (orig) => ({
      ...(await orig<typeof import("./value.js")>()),
      rankByValue: async ({ targets }: { targets: string[] }) => targets,
      valueTable: (rows: string[]) => rows.join("\n"),
    }));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { buildProgram } = await import("./cli.js");
      const argv = ["node", "covergen", "--log-level", "silent", "baseline", "--repo", "web"];

      await expect(buildProgram().parseAsync(argv)).rejects.toThrow(
        "no lcov produced for web (exit 3). Runner output:\nboom\nran 0 files",
      );
      expect(run).toHaveBeenCalledWith(repo, { files: [], coverage: true, timeoutMs: 1000, wholeProject: true });

      await buildProgram().parseAsync(argv);
      const written = out.mock.calls.map((c) => String(c[0])).join("");
      // The scoped figure is the repo's sources only; the whole report, which
      // also instrumented a config file the sweep would never target, follows it.
      expect(written).toContain("web sources: 1/2 lines covered (50.0%) across 1 file");
      expect(written).toContain("web whole report: 1/4 lines covered (25.0%) across 2 files");
      expect(written).toContain("src/a.ts");
      expect(written).not.toContain("vite.config.ts");
    } finally {
      out.mockRestore();
      process.exitCode = undefined;
      vi.doUnmock("./config.js");
      vi.doUnmock("./runners/index.js");
      vi.doUnmock("./lcov.js");
      vi.doUnmock("./value.js");
      vi.resetModules();
    }
  });

test("loadProjectEnv reads the .env beside the config into a private map", async () => {
  const { loadProjectEnv } = await import("./cli.js");
  const dir = mkdtempSync(join(tmpdir(), "covergen-env-"));
  const configPath = join(dir, "covergen.yaml");
  expect(loadProjectEnv(configPath)).toEqual({ values: {} });
  writeFileSync(join(dir, ".env"), "COVERGEN_TEST_SECRET=from-dotenv\n");
  expect(loadProjectEnv(configPath)).toEqual({
    path: join(dir, ".env"),
    values: { COVERGEN_TEST_SECRET: "from-dotenv" },
  });
  expect(process.env.COVERGEN_TEST_SECRET).toBeUndefined();
});

test("resolveApiKey prefers the project .env and falls back to the environment", async () => {
  const { resolveApiKey } = await import("./cli.js");
  const config = { anthropic: { api_key_env: "COVERGEN_TEST_KEY" } } as Parameters<typeof resolveApiKey>[0];
  process.env.COVERGEN_TEST_KEY = "from-shell";
  try {
    expect(resolveApiKey(config, { COVERGEN_TEST_KEY: "from-dotenv" })).toBe("from-dotenv");
    expect(resolveApiKey(config, {})).toBe("from-shell");
  } finally {
    delete process.env.COVERGEN_TEST_KEY;
  }
  expect(resolveApiKey(config, {})).toBeUndefined();
});

test("a command loads the config and project .env before it validates its own flags", async () => {
  const { buildProgram } = await import("./cli.js");
  const dir = mkdtempSync(join(tmpdir(), "covergen-ctx-"));
  writeFileSync(join(dir, ".env"), "UNRELATED=1\n");
  const configPath = join(dir, "covergen.yaml");
  writeFileSync(
    configPath,
    JSON.stringify({
      anthropic: { api_key_env: "COVERGEN_TEST_UNSET_KEY" },
      repos: [{ name: "demo", runner: "vitest", root: dir, sources: ["src/**/*.ts"], generator: "api" }],
    }),
  );
  await expect(
    buildProgram().parseAsync([
      "node",
      "covergen",
      "--config",
      configPath,
      "--log-level",
      "silent",
      "sweep",
      "--all",
      "--repo",
      "demo",
    ]),
  ).rejects.toThrow("--all sweeps every repo; do not also pass --repo.");
});

  test("runs main when the module is executed as the entry point", async () => {
    const { vi } = await import("vitest");
    const here = fileURLToPath(import.meta.url).replace(/\.test\.ts$/, ".ts");
    const missing = join(mkdtempSync(join(tmpdir(), "covergen-entry-")), "covergen.yaml");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.argv = [process.execPath, here, "--config", missing, "preflight", "--repo", "x"];
    try {
      vi.resetModules();
      await import("./cli.js");
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^covergen: /));
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      stderr.mockRestore();
    }
  });

  test("preflight prints OK, the claude-code login and warnings, then FAIL when the runner rejects", async () => {
    const { vi } = await import("vitest");
    const repo = { name: "web", runner: "vitest", cwd: "/repo" };
    const config = {
      repos: [repo],
      anthropic: { api_key_env: "COVERGEN_TEST_KEY" },
      claude_code: { binary: "claude", timeout_ms: 4242 },
      warnings: [],
    };
    const preflight = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("vitest is not installed"));
    vi.resetModules();
    vi.doMock("./config.js", async (orig) => ({
      ...(await orig<typeof import("./config.js")>()),
      loadConfig: () => config,
      findRepo: () => repo,
      generatorBackend: () => "claude-code",
    }));
    vi.doMock("./runners/index.js", async (orig) => ({
      ...(await orig<typeof import("./runners/index.js")>()),
      getRunner: () => ({ preflight, run: async () => ({}), warnings: async () => ["coverage provider is v8"] }),
    }));
    vi.doMock("./claude-code.js", async (orig) => ({
      ...(await orig<typeof import("./claude-code.js")>()),
      claudeExec: (binary: string, cwd: string, timeoutMs: number) => `${binary}@${cwd}#${timeoutMs}`,
      preflightClaudeCode: async (exec: unknown) => `token:${String(exec)}`,
    }));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { buildProgram } = await import("./cli.js");
      const argv = ["node", "covergen", "--log-level", "silent", "preflight", "--repo", "web"];

      await buildProgram().parseAsync(argv);
      expect(out.mock.calls.map((c) => String(c[0])).join("")).toBe(
        `OK web (vitest) in /repo\nOK generator claude-code, logged in via token:claude@${tmpdir()}#4242\nWARN coverage provider is v8\n`,
      );
      expect(process.exitCode).toBe(0);
      // The cheap tier is the default, and --deep is what asks for the rest.
      expect(preflight).toHaveBeenLastCalledWith(repo, { deep: false });

      out.mockClear();
      await buildProgram().parseAsync([...argv, "--deep"]);
      expect(out.mock.calls.map((c) => String(c[0])).join("")).toBe("FAIL web (vitest)\nvitest is not installed\n");
      expect(process.exitCode).toBe(1);
      expect(preflight).toHaveBeenLastCalledWith(repo, { deep: true });
    } finally {
      out.mockRestore();
      process.exitCode = undefined;
      vi.doUnmock("./config.js");
      vi.doUnmock("./runners/index.js");
      vi.doUnmock("./claude-code.js");
      vi.resetModules();
    }
  });
