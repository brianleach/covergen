/**
 * Vitest runner. lcov via @vitest/coverage-v8 flags on the command line;
 * COVERGEN_SOURCE narrows coverage.include to the file under test so the
 * delta stays attributable to it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig, RunOptions, RunResult, Runner } from "../types.js";
import { coverageOutDir, resolveLcov, runCommand, withPrefix, type ExecFn } from "./exec.js";
import { escapeGlob } from "./glob.js";

const PROVIDERS = ["@vitest/coverage-v8", "@vitest/coverage-istanbul"] as const;
const DOM_ENVIRONMENTS = ["jsdom", "happy-dom"] as const;
const CONFIG_NAMES = ["vitest.config", "vite.config"] as const;
const CONFIG_EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs"] as const;
/** Extensions that mean component files in every mainstream setup. */
const COMPONENT_EXTENSIONS = [".tsx", ".jsx"] as const;

function moduleBases(repo: RepoConfig): string[] {
  return [...new Set([repo.cwd, repo.root])];
}

function providerPaths(repo: RepoConfig): string[] {
  const out: string[] = [];
  for (const base of moduleBases(repo)) {
    for (const p of PROVIDERS) out.push(join(base, "node_modules", p));
  }
  return out;
}

/** The first vitest or vite config in cwd, as text. */
function readVitestConfig(repo: RepoConfig): string | undefined {
  for (const name of CONFIG_NAMES) {
    for (const ext of CONFIG_EXTENSIONS) {
      const path = join(repo.cwd, `${name}.${ext}`);
      if (!existsSync(path)) continue;
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The configured test environment, or "node" when nothing sets one, which is
 * vitest's own default. Text matching rather than evaluation: loading a target
 * repo's config would run that repo's code inside covergen.
 */
export function configuredEnvironment(configText: string | undefined): string {
  if (configText === undefined) return "node";
  const match = /environment\s*:\s*["'`]([\w-]+)["'`]/.exec(configText);
  return match?.[1] ?? "node";
}

/**
 * A package with no DOM environment whose source globs still match component
 * files. Nothing detected this before, and component targets picked in that
 * state cannot pass however good the generated test is: they spend a full
 * generate plus every repair round and are rejected at the end.
 */
export function componentEnvironmentWarning(repo: RepoConfig): string | undefined {
  const globs = repo.sources.filter((pattern) => COMPONENT_EXTENSIONS.some((ext) => pattern.includes(ext)));
  if (globs.length === 0) return undefined;
  if (configuredEnvironment(readVitestConfig(repo)) !== "node") return undefined;
  const installed = DOM_ENVIRONMENTS.some((dom) => moduleBases(repo).some((base) => existsSync(join(base, "node_modules", dom))));
  if (installed) return undefined;
  return (
    `${repo.name}: vitest runs with environment "node" here and neither ${DOM_ENVIRONMENTS.join(" nor ")} is installed, ` +
    `so component targets matched by ${globs.join(", ")} cannot pass however good the generated test is. ` +
    `Install a DOM environment, or drop them with exclude: [${globs.map((g) => `"${g}"`).join(", ")}].`
  );
}

export function createVitestRunner(exec: ExecFn = runCommand): Runner {
  return {
    name: "vitest",

    async preflight(repo: RepoConfig): Promise<void> {
      const candidates = providerPaths(repo);
      if (candidates.some((p) => existsSync(p))) return;
      throw new Error(
        [
          `vitest preflight failed: no coverage provider installed for ${repo.name}.`,
          `Looked for ${PROVIDERS.join(" or ")} under ${moduleBases(repo)
            .map((base) => `${base}/node_modules`)
            .join(" and ")}.`,
          `Install one with:  npm i -D @vitest/coverage-v8`,
        ].join("\n"),
      );
    },

    async warnings(repo: RepoConfig): Promise<string[]> {
      const component = componentEnvironmentWarning(repo);
      return component ? [component] : [];
    },

    async run(repo: RepoConfig, opts: RunOptions): Promise<RunResult> {
      const args = ["npx", "vitest", "run", ...opts.files];

      let lcovTarget: string | undefined;
      if (opts.coverage) {
        const dir = coverageOutDir(repo);
        lcovTarget = join(dir, "lcov.info");
        args.push(
          "--coverage",
          "--coverage.reporter=lcov",
          `--coverage.reportsDirectory=${dir}`,
          // The gate compares two runs of the same file, so instrumenting the whole project just
          // makes the lcov huge and the diff noisy: report only files the run actually touched.
          // A whole-project baseline needs the opposite, because a file with no test at all never
          // gets loaded and would otherwise be missing from the map instead of showing 0%.
          opts.wholeProject ? "--coverage.all=true" : "--coverage.all=false",
        );
        // COVERGEN_SOURCE is set by the gate to the source file under test, relative to cwd.
        // Narrowing coverage.include to it keeps the delta attributable to that one file even when
        // a candidate spec happens to exercise unrelated modules. The value is a glob, so a path
        // with a dynamic route segment in it has to be escaped or it matches nothing.
        const source = opts.env?.COVERGEN_SOURCE;
        if (source) args.push(`--coverage.include=${escapeGlob(source)}`);
      }

      const res = await exec(withPrefix(repo.commandPrefix, args), {
        cwd: repo.cwd,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
      });

      let lcovPath: string | undefined;
      let stderr = res.stderr;
      if (lcovTarget) {
        const resolved = resolveLcov(lcovTarget);
        lcovPath = resolved.lcovPath;
        if (resolved.note) stderr += resolved.note;
      }

      return {
        ok: res.exitCode === 0,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr,
        durationMs: res.durationMs,
        lcovPath,
      };
    },

    specPathFor(repo: RepoConfig, relSource: string): string {
      return repo.specPath(relSource);
    },
  };
}

export const vitestRunner: Runner = createVitestRunner();
