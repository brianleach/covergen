/**
 * Jest runner. lcov via --coverageReporters=lcov; files are passed with
 * --runTestsByPath because Jest treats positional args as regexes and paths
 * like src/app/(app)/x.test.tsx would match nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig, RunOptions, RunResult, Runner, TestCase } from "../types.js";
import { casesIn, jsCases } from "./cases.js";
import { coverageOutDir, resolveLcov, runCommand, withPrefix, type ExecFn } from "./exec.js";
import { escapeGlob } from "./glob.js";

function jestPaths(repo: RepoConfig): string[] {
  return [...new Set([repo.cwd, repo.root])].map((base) => join(base, "node_modules", "jest"));
}

export function createJestRunner(exec: ExecFn = runCommand): Runner {
  return {
    name: "jest",

    async preflight(repo: RepoConfig): Promise<void> {
      const candidates = jestPaths(repo);
      if (candidates.some((p) => existsSync(p))) return;
      throw new Error(
        [
          `jest preflight failed: jest is not installed for ${repo.name}.`,
          `Looked in ${candidates.join(" and ")}.`,
          `Install it with:  npm i -D jest`,
        ].join("\n"),
      );
    },

    async listCases(repo: RepoConfig, specPath: string): Promise<TestCase[]> {
      return casesIn(repo, specPath, jsCases);
    },

    async run(repo: RepoConfig, opts: RunOptions): Promise<RunResult> {
      // Positional args are regexes to Jest, so a path like src/app/(app)/x.test.tsx
      // matches nothing. --runTestsByPath makes them literal paths.
      const args = ["npx", "jest", ...(opts.files.length > 0 ? ["--runTestsByPath", ...opts.files] : [])];
      if (opts.caseFilter) args.push("-t", opts.caseFilter);

      let lcovTarget: string | undefined;
      if (opts.coverage) {
        const dir = coverageOutDir(repo);
        lcovTarget = join(dir, "lcov.info");
        args.push("--coverage", "--coverageReporters=lcov", `--coverageDirectory=${dir}`);
        // COVERGEN_SOURCE is the source file under test, relative to cwd. Jest's default
        // collectCoverageFrom pulls in the whole project, which buries the one file the gate cares
        // about, so restrict it when the gate tells us what it is. The value is a glob, so escape
        // the path: picomatch happens to also try a character class literally, but nothing about
        // collectCoverageFrom promises that, and the other metacharacters get no such fallback.
        const source = opts.env?.COVERGEN_SOURCE;
        if (source) args.push(`--collectCoverageFrom=${escapeGlob(source)}`);
      }

      // Serial and force-exit: the gate runs the same spec k times and cannot tolerate a worker
      // pool holding the coverage file open or a stray handle hanging the run.
      args.push("--runInBand", "--forceExit");

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

export const jestRunner: Runner = createJestRunner();
