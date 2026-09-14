/**
 * RSpec runner. Coverage comes from SimpleCov: the run sets COVERAGE,
 * SIMPLECOV_LCOV, SIMPLECOV_LCOV_PATH and SIMPLECOV_COVERAGE_DIR, and the
 * repo spec_helper is expected to install simplecov-lcov when it sees them
 * (see RSPEC_SIMPLECOV_SNIPPET). Preflight checks the bundle and the gem.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig, RunOptions, RunResult, Runner } from "../types.js";
import { coverageOutDir, resolveLcov, runCommand, withPrefix, type ExecFn } from "./exec.js";

/**
 * What covergen needs the target repo's spec_helper to do. We cannot inject a formatter into a
 * Ruby process from the outside, so the repo has to opt in once. Printed verbatim by the CLI when
 * preflight fails.
 */
export const RSPEC_SIMPLECOV_SNIPPET = `# spec/spec_helper.rb (or rails_helper.rb), at the very top, before any app code is required.
if ENV["COVERAGE"]
  require "simplecov"

  if ENV["SIMPLECOV_LCOV"]
    require "simplecov-lcov"
    SimpleCov::Formatter::LcovFormatter.config do |c|
      c.report_with_single_file = true
      c.single_report_path = ENV.fetch("SIMPLECOV_LCOV_PATH", "coverage/lcov.info")
    end
    SimpleCov.formatter = SimpleCov::Formatter::LcovFormatter
  end

  SimpleCov.start "rails" do
    enable_coverage :line
    add_filter "/spec/"
  end
end`;

const BUNDLE_ADD_HINT = "bundle add simplecov-lcov --group test";

function gemfileLockPaths(repo: RepoConfig): string[] {
  const seen = new Set<string>();
  for (const base of [repo.cwd, repo.root]) {
    seen.add(join(base, "Gemfile.lock"));
  }
  return [...seen];
}

export function createRspecRunner(exec: ExecFn = runCommand): Runner {
  return {
    name: "rspec",

    async preflight(repo: RepoConfig): Promise<void> {
      const version = await exec(withPrefix(repo.commandPrefix, ["bundle", "exec", "rspec", "--version"]), {
        cwd: repo.cwd,
        timeoutMs: 60_000,
      });
      if (version.exitCode !== 0) {
        throw new Error(
          [
            `rspec preflight failed in ${repo.cwd}: \`bundle exec rspec --version\` exited ${version.exitCode}.`,
            version.stderr.trim() || version.stdout.trim(),
            "Install the bundle (bundle install) or set command_prefix if the suite runs inside a container.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      const locks = gemfileLockPaths(repo);
      const found = locks.filter((p) => existsSync(p));
      if (found.length === 0) {
        throw new Error(
          `rspec preflight failed: no Gemfile.lock at ${locks.join(" or ")}. Run bundle install in the target repo.`,
        );
      }
      const hasLcov = found.some((p) => readFileSync(p, "utf8").includes("simplecov-lcov"));
      if (!hasLcov) {
        throw new Error(
          [
            `rspec preflight failed: simplecov-lcov is not in ${found.join(" or ")}.`,
            `Add it with:  ${BUNDLE_ADD_HINT}`,
            "",
            "Then make spec_helper emit lcov when covergen asks for it:",
            "",
            RSPEC_SIMPLECOV_SNIPPET,
          ].join("\n"),
        );
      }
    },

    async run(repo: RepoConfig, opts: RunOptions): Promise<RunResult> {
      const cmd = withPrefix(repo.commandPrefix, ["bundle", "exec", "rspec", ...opts.files, "--format", "progress"]);

      const env: Record<string, string> = { ...(opts.env ?? {}) };
      let lcovTarget: string | undefined;
      if (opts.coverage) {
        const dir = coverageOutDir(repo);
        lcovTarget = join(dir, "lcov.info");
        env.COVERAGE = "1";
        env.SIMPLECOV_LCOV = "1";
        env.SIMPLECOV_LCOV_PATH = lcovTarget;
        // SimpleCov's own artifacts land beside the lcov file rather than in the repo's coverage/.
        env.SIMPLECOV_COVERAGE_DIR = dir;
      }

      const res = await exec(cmd, { cwd: repo.cwd, timeoutMs: opts.timeoutMs, env });

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

export const rspecRunner: Runner = createRspecRunner();
