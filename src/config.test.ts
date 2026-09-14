import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatorBackend, isRunnerName, loadConfig, priceTable, resolveIdiomPack, specPathFromTemplate, findRepo } from "./config.js";
import { getRunner } from "./runners/index.js";
import { DEFAULT_PRICE_PER_MTOK } from "./cost.js";

describe("specPathFromTemplate", () => {
  test("rspec strips app/ prefix", () => {
    expect(specPathFromTemplate("spec/{dir_sans_app}/{base}_spec.rb", "app/services/foo/bar.rb")).toBe(
      "spec/services/foo/bar_spec.rb",
    );
  });
  test("vitest sibling", () => {
    expect(specPathFromTemplate("{dir}/{base}.test{ext}", "src/lib/x.tsx")).toBe("src/lib/x.test.tsx");
  });
  test("bun __tests__ mirror strips src/", () => {
    expect(specPathFromTemplate("src/__tests__/{dir_sans_src}/{base}.test{ext}", "src/hooks/useX.ts")).toBe(
      "src/__tests__/hooks/useX.test.ts",
    );
  });
  test("top-level source in lib/ with rspec template", () => {
    expect(specPathFromTemplate("spec/{dir_sans_app}/{base}_spec.rb", "lib/util.rb")).toBe("spec/lib/util_spec.rb");
  });
});

describe("loadConfig", () => {
  test("reads an explicit mutation block", () => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-"));
    const path = join(dir, "covergen.yaml");
    writeFileSync(
      path,
      `mutation:\n  enabled: false\n  max_mutants: 2\n  min_killed: 0\n  timeout_ms: 1000\nrepos:\n  - name: be\n    root: ../be\n    runner: rspec\n    sources: ["app/**/*.rb"]\n`,
    );
    expect(loadConfig(path).mutation).toEqual({
      enabled: false,
      max_mutants: 2,
      min_killed: 0,
      min_killed_ratio: 0.6,
      timeout_ms: 1000,
    });
  });

  test("reads disable_rules per repo and rejects an unknown id", () => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-"));
    const path = join(dir, "covergen.yaml");
    const repo = (extra: string) =>
      `repos:\n  - name: be\n    root: ../be\n    runner: rspec\n    sources: ["app/**/*.rb"]\n${extra}`;

    writeFileSync(path, repo("    disable_rules: [behavioral-evidence]\n"));
    expect(findRepo(loadConfig(path), "be").disableRules).toEqual(["behavioral-evidence"]);

    writeFileSync(path, repo(""));
    expect(findRepo(loadConfig(path), "be").disableRules).toEqual([]);

    writeFileSync(path, repo("    disable_rules: [behavioural-evidence]\n"));
    expect(() => loadConfig(path)).toThrow(/unknown rule id/);
  });

  test("resolves paths relative to the config file and applies defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-"));
    const path = join(dir, "covergen.yaml");
    writeFileSync(
      path,
      `repos:\n  - name: be\n    root: ../be\n    runner: rspec\n    sources: ["app/**/*.rb"]\n  - name: web\n    root: ../web\n    cwd: apps/web\n    runner: vitest\n    sources: ["src/**/*.ts"]\n`,
    );
    const cfg = loadConfig(path);
    expect(cfg.gate.k).toBe(3);
    expect(cfg.segments.max_lines).toBe(50);
    expect(cfg.mutation).toEqual({ enabled: true, max_mutants: 5, min_killed: 2, min_killed_ratio: 0.6, timeout_ms: 300_000 });
    const be = findRepo(cfg, "be");
    expect(be.root).toBe(join(dir, "..", "be"));
    expect(be.cwd).toBe(be.root);
    expect(be.specPath("app/models/user.rb")).toBe("spec/models/user_spec.rb");
    const web = findRepo(cfg, "web");
    expect(web.cwd).toBe(join(dir, "..", "web", "apps", "web"));
    expect(web.specPath("src/a/b.ts")).toBe("src/a/b.test.ts");
    expect(() => findRepo(cfg, "nope")).toThrow(/Unknown repo/);
    expect(be.exclude).toEqual([]);
  });

  test("carries a repo exclude list through to the resolved repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-"));
    const path = join(dir, "covergen.yaml");
    writeFileSync(
      path,
      `repos:\n  - name: web\n    root: ../web\n    runner: vitest\n    sources: ["src/**/*.ts", "src/**/*.tsx"]\n    exclude: ["**/*.tsx"]\n`,
    );
    expect(findRepo(loadConfig(path), "web").exclude).toEqual(["**/*.tsx"]);
  });
});

describe("cargo and mutation keys on a repo entry", () => {
  test("reads cargo.packages and allow_no_mutants, and defaults both", () => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-"));
    const path = join(dir, "covergen.yaml");
    writeFileSync(
      path,
      [
        "repos:",
        "  - name: engine",
        "    root: ../engine",
        "    runner: cargo",
        '    sources: ["crates/**/*.rs"]',
        "    allow_no_mutants: true",
        "    cargo:",
        '      packages: ["engine-core", "engine-cli"]',
        '      test_args: ["--test-threads=1"]',
        "  - name: plain",
        "    root: ../plain",
        "    runner: cargo",
        '    sources: ["src/**/*.rs"]',
        "",
      ].join("\n"),
    );
    const config = loadConfig(path);
    const [engine, plain] = config.repos;
    expect(engine?.cargo).toEqual({
      command: ["cargo", "llvm-cov"],
      packages: ["engine-core", "engine-cli"],
      testArgs: ["--test-threads=1"],
    });
    expect(engine?.allowNoMutants).toBe(true);
    expect(plain?.cargo?.packages).toEqual([]);
    expect(plain?.allowNoMutants).toBe(false);
  });
});

describe("an unknown runner", () => {
  const write = (repos: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-runner-"));
    const path = join(dir, "covergen.yaml");
    writeFileSync(path, `repos:\n${repos}`);
    return path;
  };
  const known = `  - name: be\n    root: ../be\n    runner: rspec\n    sources: ["app/**/*.rb"]\n`;
  const future = (sweep: string) =>
    `  - name: daemon\n    root: ../daemon\n    runner: zigtest\n    sources: ["**/*.zig"]\n${sweep}`;

  test("loads with a one-line warning when the entry is left out of runs, and the rest of the config survives", () => {
    const config = loadConfig(write(known + future("    sweep: false\n")));
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('repo "daemon" names runner "zigtest"');
    expect(config.warnings[0]).toContain("sweep: false");
    expect(config.warnings[0]!.split("\n")).toHaveLength(1);
    // The point of the change: the known entry is still usable.
    expect(config.repos.map((r) => r.name)).toEqual(["be", "daemon"]);
    expect(findRepo(config, "be").specPath("app/services/foo.rb")).toBe("spec/services/foo_spec.rb");
    // Nothing can quietly run it: there is no spec path template for a runner
    // this build does not have, and getRunner refuses the name outright.
    expect(() => findRepo(config, "daemon").specPath("main.zig")).toThrow(/Unknown runner "zigtest"/);
    expect(() => getRunner(findRepo(config, "daemon").runner)).toThrow(/Unknown runner "zigtest"/);
  });

  test("is still a config error on an entry that will run", () => {
    // Zod renders the issue list as JSON, so the quotes in the message arrive escaped.
    expect(() => loadConfig(write(known + future("")))).toThrow(/unknown runner \\?"zigtest\\?" for repo/);
    expect(() => loadConfig(write(known + future("    sweep: true\n")))).toThrow(/unknown runner \\?"zigtest/);
  });

  test("leaves a config of known runners alone, warnings included", () => {
    const config = loadConfig(write(known));
    expect(config.warnings).toEqual([]);
    expect(isRunnerName("go")).toBe(true);
    expect(isRunnerName("zigtest")).toBe(false);
  });
});

describe("priceTable", () => {
  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-"));
    const path = join(dir, "covergen.yaml");
    writeFileSync(path, `${body}repos:\n  - name: be\n    root: ../be\n    runner: rspec\n    sources: ["app/**/*.rb"]\n`);
    return path;
  };

  test("ships defaults when the config says nothing about prices", () => {
    expect(priceTable(loadConfig(write("")))["claude-opus-5"]).toEqual(DEFAULT_PRICE_PER_MTOK["claude-opus-5"]);
  });

  test("a config entry overrides one model and leaves the rest alone", () => {
    const path = write(
      "price_per_mtok:\n  claude-opus-5:\n    input: 1\n    output: 2\n    cache_read: 0.1\n    cache_write: 1.25\n",
    );
    const table = priceTable(loadConfig(path));
    expect(table["claude-opus-5"]).toEqual({ input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 });
    expect(table["claude-sonnet-5"]).toEqual(DEFAULT_PRICE_PER_MTOK["claude-sonnet-5"]);
  });
});

describe("resolveIdiomPack", () => {
  test("a pack next to the config wins over the bundled one of the same name", () => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-idiom-"));
    mkdirSync(join(dir, "idioms"));
    writeFileSync(join(dir, "idioms", "rspec.md"), "# local");
    expect(resolveIdiomPack(dir, "./idioms/rspec.md")).toBe(join(dir, "idioms", "rspec.md"));
  });

  test("falls back to the pack bundled with covergen when the config has no such file", () => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-idiom-"));
    const resolved = resolveIdiomPack(dir, "./idioms/rspec.md");
    expect(resolved).not.toBe(join(dir, "idioms", "rspec.md"));
    expect(resolved.endsWith(join("idioms", "rspec.md"))).toBe(true);
    expect(readFileSync(resolved, "utf8")).toContain("Test Writer");
  });

  test("returns the config-relative path when neither exists, so the error names it", () => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-idiom-"));
    expect(resolveIdiomPack(dir, "./packs/nope.md")).toBe(join(dir, "packs", "nope.md"));
  });
});

describe("generatorBackend", () => {
  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "covergen-"));
    const path = join(dir, "covergen.yaml");
    writeFileSync(path, body);
    return path;
  };
  const base = `repos:\n  - name: be\n    root: ../be\n    runner: rspec\n    sources: ["app/**/*.rb"]\n  - name: web\n    root: ../web\n    runner: vitest\n    sources: ["src/**/*.ts"]\n    generator: claude-code\n`;

  test("defaults to the subscription backend and the claude_code defaults", () => {
    const cfg = loadConfig(write(base));
    expect(cfg.generator).toBe("claude-code");
    expect(cfg.claude_code).toEqual({ binary: "claude", concurrency: 1, max_tokens_per_sweep: 2_000_000, timeout_ms: 600_000 });
    expect(generatorBackend(cfg, findRepo(cfg, "be"), {})).toBe("claude-code");
  });

  test("an explicit top-level setting and a repo entry both override the default", () => {
    const cfg = loadConfig(write(`generator: api\n${base}`));
    expect(generatorBackend(cfg, findRepo(cfg, "be"), {})).toBe("api");
    expect(generatorBackend(cfg, findRepo(cfg, "web"), {})).toBe("claude-code");
  });

  test("COVERGEN_GENERATOR wins over both, and a bad value is rejected", () => {
    const cfg = loadConfig(write(base));
    expect(generatorBackend(cfg, findRepo(cfg, "web"), { COVERGEN_GENERATOR: "api" })).toBe("api");
    expect(() => generatorBackend(cfg, undefined, { COVERGEN_GENERATOR: "subscription" })).toThrow(/Unknown COVERGEN_GENERATOR/);
  });
});
