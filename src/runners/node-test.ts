/**
 * node:test runner, for TypeScript suites that run on Node's built-in test runner
 * through tsx (`node --import tsx --test`, or `tsx --test`). Node writes lcov
 * itself with the lcov reporter, so the target repo needs nothing beyond tsx.
 *
 * Coverage is narrowed with --test-coverage-include and --test-coverage-exclude,
 * which Node added in 22.5.0. On an older Node the lcov is filtered after the run
 * instead, the same way the bun runner narrows it, so both paths report the same
 * files. Node only reports modules a test loaded, so a source file with no test at
 * all is missing from a whole-project baseline rather than reported at 0%.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { glob, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { globToRegExp } from "../git.js";
import { normalizePath } from "../lcov.js";
import type { NodeTestOptions, PreflightOptions, RepoConfig, RunOptions, RunResult, Runner, TestCase } from "../types.js";
import { casesIn, jsCases } from "./cases.js";
import { coverageOutDir, resolveLcov, runCommand, withPrefix, type ExecFn } from "./exec.js";
import { escapeGlob } from "./glob.js";

const DEFAULTS: NodeTestOptions = { command: ["node", "--import", "tsx", "--test"], testGlob: "**/*.test.ts" };
/** The lcov reporter and source-mapped coverage both need Node 22. */
export const MIN_NODE: Version = [22, 0, 0];
/** First release with --test-coverage-include and --test-coverage-exclude. */
export const INCLUDE_FLAG_NODE: Version = [22, 5, 0];
/** A name pattern no real test matches, so the smoke run loads a test file but runs nothing. */
const SMOKE_PATTERN = "^covergen_smoke_selects_nothing$";

type Version = [number, number, number];

/** `v22.5.1` (or `22.5.1`) as a tuple, undefined when the text holds no version. */
export function parseNodeVersion(text: string): Version | undefined {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function atLeast(v: Version, min: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (v[i]! !== min[i]!) return v[i]! > min[i]!;
  }
  return true;
}

/** The repo's node_test settings with every default filled in. */
export function nodeTestSettings(repo: RepoConfig): { command: string[]; testGlob: string; include: string[] } {
  const opts = repo.nodeTest ?? DEFAULTS;
  return {
    command: opts.command.length > 0 ? opts.command : DEFAULTS.command,
    testGlob: opts.testGlob || DEFAULTS.testGlob,
    include: opts.coverageInclude && opts.coverageInclude.length > 0 ? opts.coverageInclude : repo.sources,
  };
}

/**
 * A test file path as a literal `--test` argument. Node 22 expands every file
 * argument as a glob and rejects backslash escapes there, so `app/[id]/x.test.ts`
 * matches nothing and the run passes with zero tests. A one-character class,
 * `[[]`, is the escape its matcher does accept.
 */
export function literalTestPath(path: string): string {
  return path.replace(/[*?[{(]/g, (c) => `[${c}]`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Keep only the lcov records `keep` accepts, by normalized cwd-relative path. Used
 * where the include flag is missing, and for the one-file gate narrowing there.
 */
export function filterLcov(lcovPath: string, cwd: string, keep: (relPath: string) => boolean): void {
  const records = readFileSync(lcovPath, "utf8").split(/^end_of_record\r?$/m);
  const kept = records.filter((record) => {
    const sf = /^SF:(.*)$/m.exec(record)?.[1];
    return sf !== undefined && keep(normalizePath(sf, { cwd }));
  });
  writeFileSync(lcovPath, kept.map((record) => `${record.replace(/^\r?\n/, "")}end_of_record\n`).join(""));
}

/** The lcov filter equivalent to the include and exclude flags. */
function coverageFilter(repo: RepoConfig, include: string[], testGlob: string, source?: string): (p: string) => boolean {
  if (source) {
    const target = normalizePath(source, { cwd: repo.cwd });
    return (p) => p === target;
  }
  const inc = include.map(globToRegExp);
  const exc = [testGlob, ...(repo.exclude ?? [])].map(globToRegExp);
  return (p) => inc.some((re) => re.test(p)) && !exc.some((re) => re.test(p));
}

/** Up to 50 test files matching `pattern`, cwd-relative and sorted, node_modules skipped. */
async function testFiles(cwd: string, pattern: string): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of glob(pattern, { cwd, exclude: (name) => String(name).split(/[\\/]/).includes("node_modules") })) {
      found.push(String(entry).replaceAll("\\", "/"));
      if (found.length >= 50) break;
    }
  } catch {
    return [];
  }
  return found.sort();
}

export function createNodeTestRunner(exec: ExecFn = runCommand): Runner {
  /** `node --version` per cwd and prefix, asked once: every run needs it to pick the include path. */
  const versions = new Map<string, Promise<{ exitCode: number; text: string; version?: Version }>>();

  function nodeVersion(repo: RepoConfig) {
    const key = JSON.stringify([repo.cwd, repo.commandPrefix ?? []]);
    let hit = versions.get(key);
    if (!hit) {
      hit = exec(withPrefix(repo.commandPrefix, ["node", "--version"]), { cwd: repo.cwd, timeoutMs: 60_000 }).then((res) => {
        const text = (res.stdout.trim() || res.stderr.trim()).split("\n")[0] ?? "";
        return { exitCode: res.exitCode, text, version: res.exitCode === 0 ? parseNodeVersion(text) : undefined };
      });
      versions.set(key, hit);
    }
    return hit;
  }

  /**
   * argv for one coverage run: the lcov reporter to `lcovPath`, the spec reporter to
   * stdout so failures still reach the repair loop, and the include flags when Node
   * has them. Without the flags the caller filters the lcov after the run.
   */
  function coverageArgs(repo: RepoConfig, lcovPath: string, flags: boolean, source?: string): string[] {
    const { include, testGlob } = nodeTestSettings(repo);
    const args = [
      "--enable-source-maps",
      "--experimental-test-coverage",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`,
    ];
    if (!flags) return args;
    // COVERGEN_SOURCE is a path and the flag takes a glob, so a dynamic route
    // segment such as [id] has to be escaped or it matches nothing.
    for (const pattern of source ? [escapeGlob(source)] : include) args.push(`--test-coverage-include=${pattern}`);
    if (!source) for (const pattern of [testGlob, ...(repo.exclude ?? [])]) args.push(`--test-coverage-exclude=${pattern}`);
    return args;
  }

  return {
    name: "node-test",

    async preflight(repo: RepoConfig, opts?: PreflightOptions): Promise<void> {
      const { command, testGlob } = nodeTestSettings(repo);
      const shown = command.join(" ");
      const fail = (...lines: (string | undefined)[]) => new Error(lines.filter(Boolean).join("\n"));

      const node = await nodeVersion(repo);
      if (node.exitCode !== 0 || !node.version) {
        throw fail(`node-test preflight failed in ${repo.cwd}: \`node --version\` exited ${node.exitCode}.`, node.text,
          "Put Node 22 or newer on PATH, or set command_prefix if the suite runs inside a container.");
      }
      if (!atLeast(node.version, MIN_NODE)) {
        throw fail(`node-test preflight failed for ${repo.name}: Node ${node.text} is older than ${MIN_NODE.join(".")}, which the lcov reporter needs.`,
          "Upgrade Node to 22 or newer.");
      }

      const probe = await exec(withPrefix(repo.commandPrefix, [...command, "--version"]), { cwd: repo.cwd, timeoutMs: 60_000 });
      if (probe.exitCode !== 0) {
        throw fail(`node-test preflight failed in ${repo.cwd}: \`${shown} --version\` exited ${probe.exitCode}.`,
          probe.stderr.trim() || probe.stdout.trim(),
          "Install tsx with:  npm i -D tsx   or set node_test.command to how this repo runs its tests.");
      }

      const tests = await testFiles(repo.cwd, testGlob);
      if (tests.length === 0) {
        throw fail(`node-test preflight failed for ${repo.name}: no test file matches "${testGlob}" under ${repo.cwd}.`,
          `Set node_test.test_glob to where this repo keeps its tests, for example "test/**/*.test.ts".`);
      }

      // Smoke: load one test file under coverage with a name pattern that runs
      // nothing, and check an SF record came back. That proves tsx loads, the lcov
      // reporter writes, and the include globs match something. Deep tier only: it
      // imports the test file and everything it imports.
      if (!opts?.deep) return;

      const lcovPath = join(coverageOutDir(repo), "lcov.info");
      const flags = atLeast(node.version, INCLUDE_FLAG_NODE);
      const args = [...command, ...coverageArgs(repo, lcovPath, flags), `--test-name-pattern=${SMOKE_PATTERN}`, literalTestPath(tests[0]!)];
      const smoke = await exec(withPrefix(repo.commandPrefix, args), { cwd: repo.cwd, timeoutMs: 120_000 });
      const resolved = resolveLcov(lcovPath);
      if (resolved.lcovPath && !flags) filterLcov(resolved.lcovPath, repo.cwd, coverageFilter(repo, nodeTestSettings(repo).include, testGlob));
      const written = resolved.lcovPath ? readFileSync(resolved.lcovPath, "utf8") : "";
      await rm(dirname(lcovPath), { recursive: true, force: true });
      if (!/^SF:/m.test(written)) {
        throw fail(`node-test preflight failed for ${repo.name}: a coverage run over ${tests[0]} wrote no lcov records.`,
          (smoke.stdout.trim() || smoke.stderr.trim()).split("\n").slice(-15).join("\n") || undefined,
          `Check that ${tests[0]} imports a file matched by ${nodeTestSettings(repo).include.join(", ")}, or set node_test.coverage_include.`);
      }
    },

    async run(repo: RepoConfig, opts: RunOptions): Promise<RunResult> {
      const { command, testGlob, include } = nodeTestSettings(repo);
      const args = [...command];
      let lcovTarget: string | undefined;
      let flags = false;
      const source = opts.env?.COVERGEN_SOURCE;
      if (opts.coverage) {
        const node = await nodeVersion(repo);
        flags = node.version !== undefined && atLeast(node.version, INCLUDE_FLAG_NODE);
        lcovTarget = join(coverageOutDir(repo), "lcov.info");
        args.push(...coverageArgs(repo, lcovTarget, flags, source));
      }
      // Node matches the pattern against each test name, so the case name is escaped.
      if (opts.caseFilter) args.push(`--test-name-pattern=${escapeRegExp(opts.caseFilter)}`);
      // An empty file list is the whole suite. Node expands the glob itself.
      args.push(...(opts.files.length > 0 ? opts.files.map(literalTestPath) : [testGlob]));

      const res = await exec(withPrefix(repo.commandPrefix, args), { cwd: repo.cwd, timeoutMs: opts.timeoutMs, env: opts.env });

      let lcovPath: string | undefined;
      let stderr = res.stderr;
      if (lcovTarget) {
        const resolved = resolveLcov(lcovTarget);
        lcovPath = resolved.lcovPath;
        if (resolved.note) stderr += resolved.note;
        if (lcovPath && !flags) filterLcov(lcovPath, repo.cwd, coverageFilter(repo, include, testGlob, source));
      }

      return { ok: res.exitCode === 0, exitCode: res.exitCode, stdout: res.stdout, stderr, durationMs: res.durationMs, lcovPath };
    },

    async listCases(repo: RepoConfig, specPath: string): Promise<TestCase[]> {
      return casesIn(repo, specPath, jsCases);
    },

    specPathFor(repo: RepoConfig, relSource: string): string {
      return repo.specPath(relSource);
    },
  };
}

export const nodeTestRunner: Runner = createNodeTestRunner();
