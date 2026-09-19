/**
 * pytest runner. pytest-cov writes lcov natively (`--cov-report=lcov:<path>`), so
 * the target repo needs nothing beyond the plugin.
 *
 * Two things differ from the JS runners. coverage.py reports every file under a
 * `--cov` directory, imported or not, so `opts.wholeProject` needs no extra flag.
 * And coverage cannot be narrowed to one file, because `--cov=path/to/file.py`
 * collects nothing, so both sides of the gate's diff carry the whole package; the
 * delta is per path, so that is still attributable. Runs leave nothing in the repo:
 * COVERAGE_FILE and the lcov go to scratch, bytecode and the pytest cache are off.
 */

import { existsSync, readFileSync } from "node:fs";
import { glob, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PreflightOptions, PytestOptions, RepoConfig, RunOptions, RunResult, Runner, TestCase } from "../types.js";
import { casesIn, pytestCases } from "./cases.js";
import { coverageOutDir, resolveLcov, runCommand, withPrefix, type ExecFn } from "./exec.js";

const DEFAULTS: PytestOptions = { command: ["python", "-m", "pytest"], testGlob: "tests/**/test_*.py" };
const PIP_HINT = "python -m pip install pytest pytest-cov";
/** A -k expression no real test matches, so the smoke run collects but runs nothing. */
const SMOKE_SELECTOR = "covergen_smoke_selects_nothing";
/** Bytecode in the target repo would dirty the tree the baseline cache fingerprints. */
const NO_BYTECODE = { PYTHONDONTWRITEBYTECODE: "1" };

/** The repo's pytest settings with every default filled in. */
export function pytestSettings(repo: RepoConfig): { command: string[]; cov: string[]; testGlob: string } {
  const opts = repo.pytest ?? DEFAULTS;
  const command = opts.command.length > 0 ? opts.command : DEFAULTS.command;
  return { command, cov: opts.package ? [opts.package] : covTargets(repo.sources), testGlob: opts.testGlob || DEFAULTS.testGlob };
}

/**
 * `--cov` targets from the source globs: the static directory prefix of each, deduped.
 * `src/shop/**` + `/*.py` gives `src/shop`, `src/main.py` gives `src`, and a glob with
 * no static prefix gives `.`, the whole working directory.
 */
export function covTargets(sources: string[]): string[] {
  const out = new Set<string>();
  for (const pattern of sources) {
    const stat: string[] = [];
    for (const segment of pattern.replaceAll("\\", "/").split("/")) {
      if (/[*?[{]/.test(segment)) break;
      stat.push(segment);
    }
    if ((stat[stat.length - 1] ?? "").includes(".")) stat.pop();
    out.add(stat.filter((seg) => seg.length > 0 && seg !== ".").join("/") || ".");
  }
  return [...out].sort();
}

/** Up to 50 test files matching `testGlob`, cwd-relative and sorted. */
async function testFiles(cwd: string, pattern: string): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of glob(pattern, { cwd })) {
      found.push(String(entry).replaceAll("\\", "/"));
      if (found.length >= 50) break;
    }
  } catch {
    return [];
  }
  return found.sort();
}

/** A scratch lcov path, with coverage.py's own data file beside it rather than in the repo. */
function scratch(repo: RepoConfig, env: Record<string, string>): { lcovPath: string; env: Record<string, string> } {
  const dir = coverageOutDir(repo);
  return { lcovPath: join(dir, "lcov.info"), env: { ...env, COVERAGE_FILE: join(dir, ".coverage") } };
}

export function createPytestRunner(exec: ExecFn = runCommand): Runner {
  return {
    name: "pytest",

    async preflight(repo: RepoConfig, opts?: PreflightOptions): Promise<void> {
      const { command, cov, testGlob } = pytestSettings(repo);
      const shown = command.join(" ");
      const fail = (...lines: (string | undefined)[]) => new Error(lines.filter(Boolean).join("\n"));

      const interpreter = command[0]!;
      const probe = { cwd: repo.cwd, timeoutMs: 60_000 };
      const version = await exec(withPrefix(repo.commandPrefix, [interpreter, "--version"]), probe);
      if (version.exitCode !== 0) {
        throw fail(`pytest preflight failed in ${repo.cwd}: \`${interpreter} --version\` exited ${version.exitCode}.`,
          version.stderr.trim() || version.stdout.trim(),
          `Put ${interpreter} on PATH, or set pytest.command (["uv","run","pytest"]) or command_prefix.`);
      }

      // `--version --version` prints the registered plugins, so one call answers
      // both "is pytest importable" and "is pytest-cov installed".
      const pytest = await exec(withPrefix(repo.commandPrefix, [...command, "--version", "--version"]), probe);
      const banner = `${pytest.stdout}\n${pytest.stderr}`;
      if (pytest.exitCode !== 0) {
        throw fail(`pytest preflight failed in ${repo.cwd}: \`${shown} --version\` exited ${pytest.exitCode}.`, banner.trim(), `Install it with:  ${PIP_HINT}`);
      }
      if (!/pytest[-_]cov/i.test(banner)) {
        throw fail(`pytest preflight failed for ${repo.name}: pytest-cov is not registered with \`${shown}\`, so no lcov can be written.`, `Install it with:  ${PIP_HINT}`);
      }

      const tests = await testFiles(repo.cwd, testGlob);
      if (tests.length === 0) {
        throw fail(`pytest preflight failed for ${repo.name}: no test file matches "${testGlob}" under ${repo.cwd}.`,
          `Set pytest.test_glob to where this repo keeps its tests, for example "test/**/test_*.py".`);
      }

      // Smoke: collect one test module, deselect everything in it, and check that
      // pytest-cov still wrote lcov records. Cheapest proof that the --cov target is
      // right, and a wrong one is otherwise silent: no records, and then every
      // candidate is rejected for adding no coverage. Deep tier only: it imports
      // the test module and its dependencies, and the first baseline proves the
      // same thing about --cov on its way to a real measurement.
      if (!opts?.deep) return;

      const { lcovPath, env } = scratch(repo, NO_BYTECODE);
      const args = [...command, tests[0]!, "-q", "-p", "no:cacheprovider", "-k", SMOKE_SELECTOR];
      for (const target of cov) args.push(`--cov=${target}`);
      args.push(`--cov-report=lcov:${lcovPath}`);
      const smoke = await exec(withPrefix(repo.commandPrefix, args), { cwd: repo.cwd, timeoutMs: 120_000, env });
      const written = existsSync(lcovPath) ? readFileSync(lcovPath, "utf8") : "";
      await rm(dirname(lcovPath), { recursive: true, force: true });
      if (!/^SF:/m.test(written)) {
        throw fail(`pytest preflight failed for ${repo.name}: a coverage run over ${tests[0]} wrote no lcov records.`,
          `--cov was ${cov.join(", ")}, from ${repo.pytest?.package ? "pytest.package" : "sources"}.`,
          (smoke.stderr.trim() || smoke.stdout.trim()).split("\n").slice(-15).join("\n") || undefined,
          "Set pytest.package to the package directory this repo measures, for example src/yourpkg.");
      }
    },

    async run(repo: RepoConfig, opts: RunOptions): Promise<RunResult> {
      const { command, cov } = pytestSettings(repo);
      const args = [...command, ...opts.files, "-q", "-p", "no:cacheprovider"];
      // -k rather than a node id: the file is already in `files`, and a node id
      // would have to spell the class path of a method-shaped test as well.
      if (opts.caseFilter) args.push("-k", opts.caseFilter);
      let lcovTarget: string | undefined;
      let env: Record<string, string> = { ...opts.env, ...NO_BYTECODE };
      if (opts.coverage) {
        const s = scratch(repo, env);
        lcovTarget = s.lcovPath;
        env = s.env;
        for (const target of cov) args.push(`--cov=${target}`);
        args.push(`--cov-report=lcov:${lcovTarget}`);
      }

      const res = await exec(withPrefix(repo.commandPrefix, args), { cwd: repo.cwd, timeoutMs: opts.timeoutMs, env });
      let lcovPath: string | undefined;
      let stderr = res.stderr;
      if (lcovTarget) {
        const resolved = resolveLcov(lcovTarget);
        lcovPath = resolved.lcovPath;
        if (resolved.note) stderr += resolved.note;
      }

      return { ok: res.exitCode === 0, exitCode: res.exitCode, stdout: res.stdout, stderr, durationMs: res.durationMs, lcovPath };
    },

    async listCases(repo: RepoConfig, specPath: string): Promise<TestCase[]> {
      return casesIn(repo, specPath, pytestCases);
    },

    specPathFor(repo: RepoConfig, relSource: string): string {
      return repo.specPath(relSource);
    },
  };
}

export const pytestRunner: Runner = createPytestRunner();
