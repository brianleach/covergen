import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../types.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { componentEnvironmentWarning, configuredEnvironment, createVitestRunner } from "./vitest.js";

interface Call {
  cmd: string[];
  opts: ExecOptions;
}

function fakeExec(opts?: { exitCode?: number; writeLcov?: boolean }) {
  const calls: Call[] = [];
  const exec = async (cmd: string[], o: ExecOptions): Promise<ExecResult> => {
    calls.push({ cmd, opts: o });
    if (opts?.writeLcov !== false) {
      const dirArg = cmd.find((a) => a.startsWith("--coverage.reportsDirectory="));
      if (dirArg) {
        const dir = dirArg.slice("--coverage.reportsDirectory=".length);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "lcov.info"), "TN:\nend_of_record\n");
      }
    }
    return { exitCode: opts?.exitCode ?? 0, stdout: "", stderr: "", durationMs: 5 };
  };
  return { calls, exec };
}

let root: string;

function makeRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "next-app",
    root,
    runner: "vitest",
    cwd: root,
    sources: ["src/**/*.ts"],
    specPath: (rel) => rel.replace(/\.ts$/, ".test.ts"),
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "covergen-vitest-"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
});

describe("vitest runner preflight", () => {
  it("passes when @vitest/coverage-v8 is installed under cwd", async () => {
    mkdirSync(join(root, "node_modules", "@vitest", "coverage-v8"), { recursive: true });
    const { exec } = fakeExec();
    await expect(createVitestRunner(exec).preflight(makeRepo())).resolves.toBeUndefined();
  });

  it("passes when coverage-istanbul is installed at the repo root of a monorepo", async () => {
    const cwd = join(root, "apps", "web");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, "node_modules", "@vitest", "coverage-istanbul"), { recursive: true });
    const { exec } = fakeExec();
    await expect(createVitestRunner(exec).preflight(makeRepo({ cwd }))).resolves.toBeUndefined();
  });

  it("throws with an install hint when no provider is present", async () => {
    const { exec } = fakeExec();
    await expect(createVitestRunner(exec).preflight(makeRepo())).rejects.toThrow(
      /no coverage provider installed for next-app[\s\S]*npm i -D @vitest\/coverage-v8/,
    );
  });
});

describe("configuredEnvironment", () => {
  it("defaults to node when nothing sets one", () => {
    expect(configuredEnvironment(undefined)).toBe("node");
    expect(configuredEnvironment("export default defineConfig({ test: { globals: true } })")).toBe("node");
  });

  it("reads the configured environment whatever quotes it uses", () => {
    expect(configuredEnvironment(`export default { test: { environment: 'jsdom' } }`)).toBe("jsdom");
    expect(configuredEnvironment(`export default { test: { environment: "happy-dom" } }`)).toBe("happy-dom");
  });
});

describe("vitest runner warnings", () => {
  const componentRepo = (): RepoConfig => makeRepo({ sources: ["src/**/*.ts", "src/**/*.tsx"] });

  it("warns that component targets cannot pass with no DOM environment", async () => {
    writeFileSync(join(root, "vitest.config.ts"), `export default { test: { environment: "node" } }\n`);
    const warnings = await createVitestRunner(fakeExec().exec).warnings!(componentRepo());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/environment "node"/);
    expect(warnings[0]).toMatch(/exclude: \["src\/\*\*\/\*\.tsx"\]/);
  });

  it("warns when there is no vitest config at all, because node is the default", () => {
    expect(componentEnvironmentWarning(componentRepo())).toMatch(/environment "node"/);
  });

  it("stays quiet when the config asks for a DOM environment", () => {
    writeFileSync(join(root, "vitest.config.ts"), `export default { test: { environment: "jsdom" } }\n`);
    expect(componentEnvironmentWarning(componentRepo())).toBeUndefined();
  });

  it("stays quiet when a DOM environment is installed, since a config may set it per file", () => {
    writeFileSync(join(root, "vitest.config.ts"), `export default { test: { environment: "node" } }\n`);
    mkdirSync(join(root, "node_modules", "happy-dom"), { recursive: true });
    expect(componentEnvironmentWarning(componentRepo())).toBeUndefined();
  });

  it("stays quiet when the source globs match no component files", () => {
    writeFileSync(join(root, "vitest.config.ts"), `export default { test: { environment: "node" } }\n`);
    expect(componentEnvironmentWarning(makeRepo({ sources: ["src/**/*.ts"] }))).toBeUndefined();
  });
});

describe("vitest runner run", () => {
  it("builds the coverage command with a per-run reports directory", async () => {
    const { calls, exec } = fakeExec();
    const res = await createVitestRunner(exec).run(makeRepo(), {
      files: ["src/a.test.ts"],
      coverage: true,
      timeoutMs: 1000,
    });
    const cmd = calls[0]!.cmd;
    expect(cmd.slice(0, 4)).toEqual(["npx", "vitest", "run", "src/a.test.ts"]);
    expect(cmd).toContain("--coverage");
    expect(cmd).toContain("--coverage.reporter=lcov");
    expect(cmd).toContain("--coverage.all=false");
    const dirArg = cmd.find((a) => a.startsWith("--coverage.reportsDirectory="))!;
    expect(dirArg).toMatch(new RegExp(`${root}/\\.covergen/coverage/[^/]+$`));
    expect(res.lcovPath).toBe(join(dirArg.slice("--coverage.reportsDirectory=".length), "lcov.info"));
    expect(res.ok).toBe(true);
  });

  it("uses a distinct output dir for every run", async () => {
    const { calls, exec } = fakeExec();
    const runner = createVitestRunner(exec);
    const opts = { files: ["src/a.test.ts"], coverage: true, timeoutMs: 1000 };
    const a = await runner.run(makeRepo(), opts);
    const b = await runner.run(makeRepo(), opts);
    expect(a.lcovPath).not.toBe(b.lcovPath);
    expect(calls).toHaveLength(2);
  });

  it("omits coverage flags when coverage is false", async () => {
    const { calls, exec } = fakeExec();
    const res = await createVitestRunner(exec).run(makeRepo(), {
      files: ["src/a.test.ts"],
      coverage: false,
      timeoutMs: 1000,
    });
    expect(calls[0]!.cmd).toEqual(["npx", "vitest", "run", "src/a.test.ts"]);
    expect(res.lcovPath).toBeUndefined();
  });

  it("reports every matched file when wholeProject is set", async () => {
    const { calls, exec } = fakeExec();
    await createVitestRunner(exec).run(makeRepo(), {
      files: [],
      coverage: true,
      timeoutMs: 1000,
      wholeProject: true,
    });
    expect(calls[0]!.cmd).toContain("--coverage.all=true");
    expect(calls[0]!.cmd).not.toContain("--coverage.all=false");
  });

  it("restricts coverage to COVERGEN_SOURCE when set", async () => {
    const { calls, exec } = fakeExec();
    await createVitestRunner(exec).run(makeRepo(), {
      files: ["src/a.test.ts"],
      coverage: true,
      timeoutMs: 1000,
      env: { COVERGEN_SOURCE: "src/a.ts" },
    });
    expect(calls[0]!.cmd).toContain("--coverage.include=src/a.ts");
  });

  it("escapes glob metacharacters in the COVERGEN_SOURCE include", async () => {
    const { calls, exec } = fakeExec();
    await createVitestRunner(exec).run(makeRepo(), {
      files: ["src/app/api/items/[id]/route.test.ts"],
      coverage: true,
      timeoutMs: 1000,
      env: { COVERGEN_SOURCE: "src/app/api/items/[id]/route.ts" },
    });
    expect(calls[0]!.cmd).toContain("--coverage.include=src/app/api/items/\\[id\\]/route.ts");
  });

  it("passes env and cwd through and honors commandPrefix", async () => {
    const { calls, exec } = fakeExec();
    await createVitestRunner(exec).run(makeRepo({ commandPrefix: ["docker", "compose", "exec", "-T", "web"] }), {
      files: [],
      coverage: false,
      timeoutMs: 4242,
      env: { CI: "1" },
    });
    expect(calls[0]!.cmd.slice(0, 7)).toEqual(["docker", "compose", "exec", "-T", "web", "npx", "vitest"]);
    expect(calls[0]!.opts).toEqual({ cwd: root, timeoutMs: 4242, env: { CI: "1" } });
  });

  it("reports a missing lcov as a note, not a failed run", async () => {
    const { exec } = fakeExec({ writeLcov: false });
    const res = await createVitestRunner(exec).run(makeRepo(), {
      files: ["src/a.test.ts"],
      coverage: true,
      timeoutMs: 1000,
    });
    expect(res.ok).toBe(true);
    expect(res.lcovPath).toBeUndefined();
    expect(res.stderr).toContain("expected lcov at");
  });

  it("sets ok false on a non-zero exit code but still resolves lcov", async () => {
    const { exec } = fakeExec({ exitCode: 1 });
    const res = await createVitestRunner(exec).run(makeRepo(), {
      files: ["src/a.test.ts"],
      coverage: true,
      timeoutMs: 1000,
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.lcovPath).toBeDefined();
  });
});

describe("vitest specPathFor", () => {
  it("delegates to repo.specPath", () => {
    const { exec } = fakeExec();
    expect(createVitestRunner(exec).specPathFor(makeRepo(), "src/a.ts")).toBe("src/a.test.ts");
  });
});

it("treats an unreadable vitest config as no config and stops looking at later ones", () => {
  mkdirSync(join(root, "vitest.config.ts"), { recursive: true });
  writeFileSync(join(root, "vite.config.ts"), `export default { test: { environment: "jsdom" } }\n`);
  const warning = componentEnvironmentWarning(makeRepo({ sources: ["src/**/*.ts", "src/**/*.tsx"] }));
  expect(warning).toMatch(/environment "node"/);
  expect(warning).toMatch(/exclude: \["src\/\*\*\/\*\.tsx"\]/);
});
