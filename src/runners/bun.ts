/**
 * bun test runner. lcov via --coverage-reporter=lcov into a per-run directory.
 * No extra dependency is needed in the target repo.
 */

import { join } from "node:path";
import type { RepoConfig, RunOptions, RunResult, Runner } from "../types.js";
import { coverageOutDir, resolveLcov, runCommand, withPrefix, type ExecFn } from "./exec.js";

export function createBunRunner(exec: ExecFn = runCommand): Runner {
  return {
    name: "bun",

    async preflight(repo: RepoConfig): Promise<void> {
      const res = await exec(withPrefix(repo.commandPrefix, ["bun", "--version"]), {
        cwd: repo.cwd,
        timeoutMs: 60_000,
      });
      if (res.exitCode !== 0) {
        throw new Error(
          [
            `bun preflight failed in ${repo.cwd}: \`bun --version\` exited ${res.exitCode}.`,
            res.stderr.trim() || res.stdout.trim(),
            "Install bun (https://bun.sh) or set command_prefix if the suite runs inside a container.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    },

    async run(repo: RepoConfig, opts: RunOptions): Promise<RunResult> {
      const args = ["bun", "test", ...opts.files];

      let lcovTarget: string | undefined;
      if (opts.coverage) {
        const dir = coverageOutDir(repo);
        // bun writes lcov.info inside --coverage-dir.
        lcovTarget = join(dir, "lcov.info");
        args.push("--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`);
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

export const bunRunner: Runner = createBunRunner();
