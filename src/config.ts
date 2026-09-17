/**
 * Config schema and loading. covergen.yaml is validated with Zod, repo roots are
 * resolved relative to the config file, and spec_template turns a source path
 * into the conventional spec path for each runner. Idiom packs resolve against
 * the config first and against the packs bundled with covergen second.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_PRICE_PER_MTOK, type Price } from "./cost.js";
import { ruleIds } from "./rules.js";
import type { GeneratorBackend, RepoConfig, RunnerName } from "./types.js";

const runnerNames = ["rspec", "vitest", "bun", "jest", "pytest", "go", "cargo"] as const;
const generatorBackends = ["api", "claude-code"] as const;

/** True when this build has an adapter for `value`. */
export function isRunnerName(value: string): value is RunnerName {
  return (runnerNames as readonly string[]).includes(value);
}

/**
 * The package root, which is what `idioms/` ships under. `import.meta.url` is
 * `<root>/dist/config.js` for the built CLI and `<root>/src/config.ts` under tsx,
 * so the parent directory is the root either way.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolve an `idiom_pack` value to a file. A path relative to covergen.yaml wins,
 * so a repo can ship its own pack. When no such file exists, fall back to the
 * bundled pack with the same basename: once covergen is installed globally the
 * config lives in someone else's repo, where `./idioms/rspec.md` means the pack
 * that came with covergen, not a directory the user is expected to have created.
 * When neither exists the config-relative path is returned so the read fails with
 * the path the user actually wrote.
 */
export function resolveIdiomPack(configDir: string, value: string): string {
  const local = resolve(configDir, value);
  if (existsSync(local)) return local;
  const bundled = join(packageRoot, "idioms", basename(value));
  if (existsSync(bundled)) return bundled;
  return local;
}

const RepoSchema = z.object({
  name: z.string().min(1),
  root: z.string().min(1),
  /**
   * Checked against the known runners below rather than by a closed enum, so an
   * entry that will not run can name a runner this build does not have.
   */
  runner: z.string().min(1),
  cwd: z.string().default("."),
  sources: z.array(z.string()).min(1),
  /** Globs subtracted from `sources`, e.g. one extension a runner cannot execute. */
  exclude: z.array(z.string()).default([]),
  /** Template: "{dir}/{base}.test{ext}" or "spec/{dir}/{base}_spec.rb". {dir} is the source dir relative to cwd. */
  spec_template: z.string().optional(),
  idiom_pack: z.string().optional(),
  /** Overrides the top-level `generator` for this repo only. */
  generator: z.enum(generatorBackends).optional(),
  /** false leaves this repo out of `sweep --all`. Named targets still work. */
  sweep: z.boolean().default(true),
  command_prefix: z.array(z.string()).optional(),
  /** e.g. [["bun","run","type-check"]] */
  validate: z.array(z.array(z.string().min(1))).default([]),
  /** pytest only: how to invoke it, what to measure, and where its tests live. */
  pytest: z
    .object({
      command: z.array(z.string().min(1)).min(1).default(["python", "-m", "pytest"]),
      package: z.string().min(1).optional(),
      test_glob: z.string().min(1).default("tests/**/test_*.py"),
    })
    .default({}),
  /** go only: how to invoke it, which packages to measure, and how to build them. */
  go: z
    .object({
      command: z.array(z.string().min(1)).min(1).default(["go", "test"]),
      packages: z.array(z.string().min(1)).min(1).default(["./..."]),
      // On by default, and only on the gate runs: a race the detector catches is
      // exactly a test that would flake in the repo's CI later.
      race: z.boolean().default(true),
      build_tags: z.array(z.string().min(1)).min(1).optional(),
    })
    .default({}),
  /** cargo only: how to invoke cargo-llvm-cov, which crates to measure, and what to pass the harness. */
  cargo: z
    .object({
      command: z.array(z.string().min(1)).min(1).default(["cargo", "llvm-cov"]),
      /** Crates to test, each as `-p <crate>`. Empty means the whole workspace. */
      packages: z.array(z.string().min(1)).default([]),
      test_args: z.array(z.string()).default([]),
    })
    .default({}),
  /**
   * Explore mode's target. Absent means this repo has no explorable web app.
   * The URL and the session file are named, never written: both are environment
   * variables so a private preview URL and a path to the owner's session stay
   * out of the config file and out of this repository.
   */
  explore: z
    .object({
      base_url_env: z.string().min(1).default("COVERGEN_EXPLORE_BASE_URL"),
      storage_state_env: z.string().min(1).default("COVERGEN_EXPLORE_STORAGE_STATE"),
      /** Route patterns whose writes may be generated against. Default is read-only. */
      allow_mutations: z.array(z.string().min(1)).default([]),
      max_pages: z.number().int().positive().max(500).default(25),
      ignore_patterns: z.array(z.string().min(1)).default(["/logout", "/logout/**", "/signout", "/sign-out"]),
      /** Where the end to end specs that already exist live, relative to cwd. */
      spec_glob: z.string().min(1).default("e2e/**/*.spec.ts"),
    })
    .optional(),
  /** Accept candidates the mutation spot-check found nothing to mutate on. */
  allow_no_mutants: z.boolean().default(false),
  /**
   * Rule ids from src/rules.ts to turn off for this repo. A typo here would
   * silently enforce a rule the repo meant to drop, so unknown ids are an error.
   */
  disable_rules: z
    .array(z.string().min(1))
    .default([])
    .refine((ids) => ids.every((id) => ruleIds.includes(id)), {
      message: `unknown rule id in disable_rules. Known ids: ${ruleIds.join(", ")}`,
    }),
})
  /**
   * An unknown runner is only fatal for an entry that can run. A config written
   * for a runner a newer covergen has used to fail the whole file at parse time,
   * before `sweep: false` was even read, which took every other repo in an
   * unattended sweep down with it. Such an entry now loads with a warning, and
   * anything that tries to run it still dies on getRunner.
   */
  .superRefine((repo, ctx) => {
    if (repo.sweep && !isRunnerName(repo.runner)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runner"],
        message: `unknown runner "${repo.runner}" for repo "${repo.name}". Known: ${runnerNames.join(", ")}. Set sweep: false to keep an entry this build cannot run.`,
      });
    }
  });

const ConfigSchema = z.object({
  /**
   * Which backend makes the model calls, overridable per repo. The subscription
   * is the default and the metered API is the backup someone has to ask for.
   */
  generator: z.enum(generatorBackends).default("claude-code"),
  /**
   * Options for the `claude-code` backend. `concurrency` is 1 by default because
   * headless runs share one subscription usage window with every interactive
   * session and scheduled routine on the account.
   */
  claude_code: z
    .object({
      binary: z.string().default("claude"),
      concurrency: z.number().int().min(1).default(1),
      /** Tokens this backend may spend before it refuses to call again. 0 disables. */
      max_tokens_per_sweep: z.number().int().min(0).default(2_000_000),
      timeout_ms: z.number().int().positive().default(600_000),
    })
    .default({}),
  anthropic: z
    .object({
      api_key_env: z.string().default("ANTHROPIC_API_KEY"),
      generator_model: z.string().default("claude-opus-5"),
      repair_model: z.string().default("claude-sonnet-5"),
      max_tokens: z.number().int().positive().default(16384),
    })
    .default({}),
  gate: z
    .object({
      k: z.number().int().min(1).default(3),
      timeout_ms: z.number().int().positive().default(300_000),
      /** Whole-suite baseline runs are long; give them their own ceiling. */
      baseline_timeout_ms: z.number().int().positive().default(1_800_000),
      max_repair_rounds: z.number().int().min(0).default(3),
    })
    .default({}),
  /** Bounded mutation spot-check on the lines an accepted candidate newly covered. */
  mutation: z
    .object({
      enabled: z.boolean().default(true),
      max_mutants: z.number().int().positive().default(5),
      /**
       * Absolute floor, clamped to the number of mutants actually generated so a
       * line with one mutant is judged on that one rather than rejected outright.
       */
      min_killed: z.number().int().min(0).default(2),
      /** Share of the mutants tried that must be killed. 0 leaves only the floor. */
      min_killed_ratio: z.number().min(0).max(1).default(0.6),
      timeout_ms: z.number().int().positive().default(300_000),
    })
    .default({}),
  /**
   * Ceilings for one unattended run, counted across every repo in it and applied
   * on both backends. They sit above claude_code.max_tokens_per_sweep, which
   * guards a single pipeline run on the subscription backend only.
   */
  sweep: z
    .object({
      /** Tokens the whole run may spend. 0 disables the ceiling. */
      max_tokens_per_run: z.number().int().min(0).default(0),
      /** Wall-clock minutes before the run stops starting new work. 0 disables it. */
      max_minutes: z.number().int().min(0).default(300),
      /**
       * Lines of accepted spec one draft PR may hold. A run over this opens
       * several PRs instead, each mergeable on its own. 0 opens one PR however
       * large the run was.
       */
      pr_max_lines: z.number().int().min(0).default(600),
      /**
       * Lines one spec file may reach before the run stops adding segments to
       * it and leaves the rest for the next run. 0 disables the ceiling.
       */
      pr_max_lines_per_file: z.number().int().min(0).default(500),
    })
    .default({}),
  segments: z
    .object({
      max_lines: z.number().int().positive().default(50),
      max_per_file: z.number().int().positive().default(8),
    })
    .default({}),
  /**
   * Dollars per million tokens, per model id, merged over the shipped defaults.
   * Prices move; this is the escape hatch that keeps the summary honest without
   * a release.
   */
  price_per_mtok: z
    .record(
      z.object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cache_read: z.number().nonnegative(),
        cache_write: z.number().nonnegative(),
      }),
    )
    .default({}),
  state_dir: z.string().default(".covergen"),
  /**
   * Fast-forward each target checkout to its default branch before an unattended
   * run, so the tests are proven against the base they will be merged onto. Only
   * ever a fast-forward: a checkout that is dirty, or on a branch holding commits
   * of its own, is left exactly where it is. false keeps the older behavior.
   */
  refresh_base: z.boolean().default(true),
  repos: z.array(RepoSchema).min(1),
});

export type Config = Omit<z.infer<typeof ConfigSchema>, "repos"> & {
  repos: RepoConfig[];
  /**
   * Non-fatal problems found while loading, one line each, for the caller to
   * log. Not a config key: the CLI prints these when it builds its context.
   */
  warnings: string[];
};

const defaultTemplates: Record<RunnerName, string> = {
  rspec: "spec/{dir_sans_app}/{base}_spec.rb",
  vitest: "{dir}/{base}.test{ext}",
  bun: "src/__tests__/{dir_sans_src}/{base}.test{ext}",
  jest: "{dir}/__tests__/{base}.test{ext}",
  pytest: "tests/{dir_sans_src}/test_{base}.py",
  // Go wants an internal test beside the source, in the same package.
  go: "{dir}/{base}_test.go",
  // Rust unit tests live in the source file itself, in a #[cfg(test)] module, so
  // the spec path is the source path. Repos that prefer integration tests set
  // spec_template: "tests/{base}.rs".
  cargo: "{dir}/{base}{ext}",
};

export function specPathFromTemplate(template: string, relSource: string): string {
  const dir = dirname(relSource);
  const ext = extname(relSource);
  const base = basename(relSource, ext);
  const strip = (prefix: string) => (dir === prefix ? "." : dir.startsWith(prefix + "/") ? dir.slice(prefix.length + 1) : dir);
  const out = template
    .replaceAll("{dir}", dir)
    .replaceAll("{dir_sans_app}", strip("app"))
    .replaceAll("{dir_sans_src}", strip("src"))
    .replaceAll("{base}", base)
    .replaceAll("{ext}", ext);
  return out.replaceAll("/./", "/").replace(/^\.\//, "");
}

export function loadConfig(path: string): Config {
  const raw = parse(readFileSync(path, "utf8"));
  const parsed = ConfigSchema.parse(raw);
  const configDir = dirname(resolve(path));
  const warnings: string[] = [];
  const repos: RepoConfig[] = parsed.repos.map((r) => {
    const root = resolve(configDir, r.root);
    // Only reachable with sweep: false, which the schema is what enforces. The
    // cast is the one place the widened `runner` string meets RunnerName, and
    // getRunner refuses the value the moment anything tries to use it.
    const known = isRunnerName(r.runner);
    if (!known) {
      warnings.push(
        `repo "${r.name}" names runner "${r.runner}", which this build does not have (${runnerNames.join(", ")}). It has sweep: false, so it is skipped rather than run.`,
      );
    }
    const template = r.spec_template ?? (isRunnerName(r.runner) ? defaultTemplates[r.runner] : undefined);
    return {
      name: r.name,
      root,
      runner: r.runner as RunnerName,
      cwd: resolve(root, r.cwd),
      sources: r.sources,
      exclude: r.exclude,
      specPath: (rel) => {
        if (template === undefined) throw new Error(`Unknown runner "${r.runner}" for repo "${r.name}"; no spec path template for it.`);
        return specPathFromTemplate(template, rel);
      },
      idiomPackPath: r.idiom_pack ? resolveIdiomPack(configDir, r.idiom_pack) : undefined,
      generator: r.generator,
      sweep: r.sweep,
      commandPrefix: r.command_prefix,
      validate: r.validate,
      disableRules: r.disable_rules,
      allowNoMutants: r.allow_no_mutants,
      pytest: { command: r.pytest.command, package: r.pytest.package, testGlob: r.pytest.test_glob },
      go: { command: r.go.command, packages: r.go.packages, race: r.go.race, buildTags: r.go.build_tags },
      cargo: { command: r.cargo.command, packages: r.cargo.packages, testArgs: r.cargo.test_args },
      explore: r.explore
        ? {
            baseUrlEnv: r.explore.base_url_env,
            storageStateEnv: r.explore.storage_state_env,
            allowMutations: r.explore.allow_mutations,
            maxPages: r.explore.max_pages,
            ignorePatterns: r.explore.ignore_patterns,
            specGlob: r.explore.spec_glob,
          }
        : undefined,
    };
  });
  return { ...parsed, repos, warnings };
}

/** The shipped price table with the config's overrides applied, per model id. */
export function priceTable(config: Config): Record<string, Price> {
  return { ...DEFAULT_PRICE_PER_MTOK, ...config.price_per_mtok };
}

/**
 * The backend for one repo: the COVERGEN_GENERATOR override first, so a nightly
 * job can move to the subscription without editing the config, then the repo
 * entry, then the top-level default.
 */
export function generatorBackend(config: Config, repo?: RepoConfig, env: NodeJS.ProcessEnv = process.env): GeneratorBackend {
  const override = env.COVERGEN_GENERATOR?.trim();
  if (override) {
    const match = generatorBackends.find((b) => b === override);
    if (!match) throw new Error(`Unknown COVERGEN_GENERATOR "${override}". Use ${generatorBackends.join(" or ")}.`);
    return match;
  }
  return repo?.generator ?? config.generator;
}

export function findRepo(config: Config, name: string): RepoConfig {
  const repo = config.repos.find((r) => r.name === name);
  if (!repo) throw new Error(`Unknown repo "${name}". Known: ${config.repos.map((r) => r.name).join(", ")}`);
  return repo;
}

export function stateDirFor(config: Config, repo: RepoConfig): string {
  return join(repo.root, config.state_dir);
}
