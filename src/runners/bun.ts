/**
 * bun test runner. lcov via --coverage-reporter=lcov into a per-run directory.
 * No extra dependency is needed in the target repo. bun has no coverage include
 * flag, so COVERGEN_SOURCE narrows the lcov after the run instead.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "../lcov.js";
import type { RepoConfig, RunOptions, RunResult, Runner } from "../types.js";
import { coverageOutDir, resolveLcov, runCommand, withPrefix, type ExecFn } from "./exec.js";

/**
 * Keep only the lcov record for `source`, relative to cwd. bun reports every file the spec
 * loaded, so without this a candidate that imports a second module gets that module's lines
 * counted toward the target's delta. vitest and jest narrow with a coverage include glob;
 * bun offers no such flag (bunfig.toml can only ignore paths), so the record is matched on
 * its normalized path instead, which needs no glob escaping.
 */
function narrowLcov(lcovPath: string, source: string, cwd: string): void {
  const target = normalizePath(source, { cwd });
  const records = readFileSync(lcovPath, "utf8").split(/^end_of_record\r?$/m);
  const kept = records.filter((record) => {
    const sf = /^SF:(.*)$/m.exec(record)?.[1];
    return sf !== undefined && normalizePath(sf, { cwd }) === target;
  });
  writeFileSync(lcovPath, kept.map((record) => `${record.replace(/^\r?\n/, "")}end_of_record\n`).join(""));
}

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
        const source = opts.env?.COVERGEN_SOURCE;
        if (lcovPath && source) narrowLcov(lcovPath, source, repo.cwd);
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
