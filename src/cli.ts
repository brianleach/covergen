#!/usr/bin/env node
/**
 * covergen CLI.
 *
 * Exit codes: 0 at least one test accepted, 2 nothing accepted (a normal
 * outcome, not an error), 1 something broke.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { EXIT_ABORTED } from "./abort.js";
import { auditMarkdown, runAudit, writeAudit, writeAuditJson } from "./audit.js";
import { claudeExec, preflightClaudeCode } from "./claude-code.js";
import { findRepo, generatorBackend, loadConfig, type Config } from "./config.js";
import { buildFlows, crawl, exploreEnv, renderReport } from "./explore.js";
import { openBrowserReader } from "./explore-browser.js";
import { indexSpecs, loadSpecs } from "./explore-specs.js";
import { readLcov, summarize } from "./lcov.js";
import { createLimits, parseCeiling, totalTokens } from "./limits.js";
import { createLogger, type Logger } from "./logger.js";
import { mutationScore, prBody } from "./emit.js";
import { runPipeline } from "./pipeline.js";
import { runRemoval } from "./removal.js";
import { reportLines, runFields, sweepAll, sweepTargets, writeReport } from "./sweep.js";
import { getRunner } from "./runners/index.js";
import { rankByValue, valueTable } from "./value.js";
import type { CoverageMap, RepoConfig, RunSummary } from "./types.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_NONE_ACCEPTED = 2;

const DEFAULT_CONFIG = "./covergen.yaml";
const DEFAULT_SWEEP_LIMIT = 10;

interface GlobalOpts {
  config: string;
  logLevel?: string;
}

/**
 * Load a project-local .env next to covergen.yaml, so the Anthropic key lives
 * with this checkout and never has to be exported into the shell. Variables
 * already set in the environment win.
 */
export function loadProjectEnv(configPath: string): { path?: string; values: Record<string, string> } {
  const envPath = join(dirname(configPath), ".env");
  if (!existsSync(envPath)) return { values: {} };
  // Parsed into a private map, never into process.env: the test runners inherit
  // process.env, and a leaked Anthropic key makes suites that check for one
  // (some do) call the real API and time out.
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envPath, "utf8")))) if (v !== undefined) values[k] = v;
  return { path: envPath, values };
}

/** The Anthropic key from the project .env or the ambient environment, .env first. */
export function resolveApiKey(config: Config, secrets: Record<string, string>): string | undefined {
  const keyEnv = config.anthropic.api_key_env;
  return secrets[keyEnv] ?? process.env[keyEnv];
}

function context(program: Command): { config: Config; log: Logger; apiKey?: string } {
  const opts = program.opts<GlobalOpts>();
  const log = createLogger({ level: opts.logLevel });
  const configPath = resolve(opts.config ?? DEFAULT_CONFIG);
  const env = loadProjectEnv(configPath);
  if (env.path) log.debug({ envPath: env.path }, "loaded project .env");
  const config = loadConfig(configPath);
  for (const warning of config.warnings) log.warn({ config: configPath }, warning);
  const apiKey = resolveApiKey(config, env.values);
  // Only a repo that still calls the metered API needs a key; a claude-code repo
  // authenticates through the local Claude Code login instead.
  const needsKey = config.repos.some((repo) => generatorBackend(config, repo) === "api");
  if (!apiKey && needsKey) {
    log.warn(
      { keyEnv: config.anthropic.api_key_env, envPath: join(dirname(configPath), ".env") },
      "Anthropic key not set; run/sweep will fail at generation",
    );
  }
  return { config, log, apiKey };
}

/**
 * What to tell someone whose run was killed. The accepted tests are still in the
 * checkout rather than rolled back, so the next move is a human one: commit them,
 * or read the journal that says exactly which files the run put there.
 */
export function resumeNote(accepted: number, journal: string | undefined, signal: string): string {
  const head = `\nAborted on ${signal}. ${accepted} accepted ${accepted === 1 ? "test is" : "tests are"} on disk, not rolled back.\n`;
  if (accepted === 0 || !journal) return head;
  return `${head}The run journal lists them:\n  ${journal}\n`;
}

function finish(summary: RunSummary): number {
  process.stdout.write(prBody(summary));
  if (summary.aborted) {
    process.stdout.write(resumeNote(summary.accepted.length, summary.journal, summary.aborted));
    return EXIT_ABORTED;
  }
  return summary.accepted.length > 0 ? EXIT_OK : EXIT_NONE_ACCEPTED;
}

async function baselineCoverage(repo: RepoConfig, timeoutMs: number): Promise<CoverageMap> {
  const runner = getRunner(repo.runner);
  await runner.preflight(repo);
  const result = await runner.run(repo, { files: [], coverage: true, timeoutMs, wholeProject: true });
  if (!result.lcovPath) {
    const tail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-30).join("\n");
    throw new Error(`no lcov produced for ${repo.name} (exit ${result.exitCode}). Runner output:\n${tail}`);
  }
  return readLcov(result.lcovPath, { cwd: repo.cwd });
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("covergen")
    .description("Coverage-gated LLM test generation. Keeps only tests that build, pass k times, and raise coverage.")
    .option("--config <path>", "path to covergen.yaml", DEFAULT_CONFIG)
    .option("--log-level <level>", "trace, debug, info, warn, error, fatal or silent")
    .showHelpAfterError();

  program
    .command("run")
    .description("Generate tests for specific source files")
    .requiredOption("--repo <name>", "repo name from covergen.yaml")
    .requiredOption("--file <rel...>", "source file(s), relative to the repo cwd")
    .option("--dry-run", "gate everything but do not write spec files", false)
    .option("--fast", "baseline only the target's existing spec instead of the whole suite", false)
    .option("--refresh-baseline", "ignore the cached whole-suite baseline", false)
    .action(async (opts: { repo: string; file: string[]; dryRun: boolean; fast: boolean; refreshBaseline: boolean }) => {
      const { config, log, apiKey } = context(program);
      const repo = findRepo(config, opts.repo);
      const summary = await runPipeline({
        config,
        repo,
        targets: opts.file,
        dryRun: opts.dryRun,
        fast: opts.fast,
        log,
        apiKey,
        refreshBaseline: opts.refreshBaseline,
        limits: createLimits({ maxTokens: config.sweep.max_tokens_per_run, maxMinutes: config.sweep.max_minutes }),
      });
      process.exitCode = finish(summary);
    });

  program
    .command("sweep")
    .description("Generate tests across one repo or, with --all, every repo in covergen.yaml")
    .option("--repo <name>", "repo name from covergen.yaml")
    .option("--all", "sweep every repo in covergen.yaml, in config order", false)
    .option("--pr", "commit the accepted tests on a covergen/ branch and open a draft PR", false)
    .option("--changed-since <ref>", "only files changed since this git ref")
    .option("--limit <n>", "maximum source files to target per repo", String(DEFAULT_SWEEP_LIMIT))
    .option(
      "--order <mode>",
      "target order before --limit: value (branch-weighted), gap (most uncovered lines first) or glob",
      "value",
    )
    .option("--pr-max-lines <n>", "lines of accepted spec one draft PR may hold, overriding sweep.pr_max_lines. 0 opens one PR")
    .option("--max-tokens <n>", "run-wide token ceiling, overriding sweep.max_tokens_per_run")
    .option("--max-minutes <n>", "run-wide wall-clock ceiling, overriding sweep.max_minutes")
    .option("--report <path>", "write a JSON report of the run to this path")
    .option("--dry-run", "gate everything but do not write spec files", false)
    .option("--refresh-baseline", "ignore the cached whole-suite baseline", false)
    .action(async (opts: {
      repo?: string;
      all: boolean;
      pr: boolean;
      changedSince?: string;
      limit: string;
      order: string;
      prMaxLines?: string;
      maxTokens?: string;
      maxMinutes?: string;
      report?: string;
      dryRun: boolean;
      refreshBaseline: boolean;
    }) => {
      const { config, log, apiKey } = context(program);
      if (opts.all && opts.repo) throw new Error("--all sweeps every repo; do not also pass --repo.");
      if (!opts.all && !opts.repo) throw new Error("sweep needs --repo <name> or --all.");
      const parsedLimit = Number.parseInt(opts.limit, 10);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_SWEEP_LIMIT;
      const limits = createLimits({
        maxTokens: parseCeiling(opts.maxTokens, "--max-tokens", config.sweep.max_tokens_per_run),
        maxMinutes: parseCeiling(opts.maxMinutes, "--max-minutes", config.sweep.max_minutes),
      });
      const prMaxLines = parseCeiling(opts.prMaxLines, "--pr-max-lines", config.sweep.pr_max_lines);
      const common = { changedSince: opts.changedSince, order: opts.order, limit, refreshBaseline: opts.refreshBaseline };

      // --pr needs the per-repo branch, commit and report bookkeeping the --all
      // loop already does, so one repo is that loop over a config of one.
      if (opts.all || opts.pr) {
        const scoped = opts.all ? config : { ...config, repos: [findRepo(config, opts.repo as string)] };
        const report = await sweepAll({ ...common, config: scoped, log, apiKey, dryRun: opts.dryRun, pr: opts.pr, prMaxLines, limits });
        if (opts.report) await writeReport(opts.report, report);
        process.stdout.write(reportLines(report));
        const opened = report.repos.some((r) => r.prUrl);
        const accepted = report.repos.reduce((sum, r) => sum + r.accepted, 0);
        if (report.abortedBy) {
          // The killed repo is the last one in the report. Its PR may already be
          // open, in which case there is nothing left to resume.
          const killed = report.repos.find((r) => r.aborted && !r.prUrl);
          if (killed) process.stdout.write(resumeNote(killed.accepted, killed.journal, report.abortedBy));
          process.exitCode = EXIT_ABORTED;
          return;
        }
        process.exitCode = opened || accepted > 0 ? EXIT_OK : EXIT_NONE_ACCEPTED;
        return;
      }

      const repo = findRepo(config, opts.repo as string);
      const targets = await sweepTargets({ ...common, config, repo, log });
      if (targets.length === 0) {
        log.warn({ repo: repo.name, changedSince: opts.changedSince }, "no targets matched, nothing to do");
        process.exitCode = EXIT_NONE_ACCEPTED;
        return;
      }

      const summary = await runPipeline({
        config,
        repo,
        targets,
        dryRun: opts.dryRun,
        fast: false,
        log,
        apiKey,
        refreshBaseline: opts.refreshBaseline,
        limits,
      });
      if (opts.report) {
        await writeReport(opts.report, {
          startedAt: new Date(Date.now() - summary.durationMs).toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: summary.durationMs,
          dryRun: opts.dryRun,
          tokens: totalTokens(summary.tokens),
          mutation: mutationScore(summary.accepted),
          ceilingHit: summary.limitHit,
          repos: [
            {
              repo: repo.name,
              status: "ran",
              targetsAttempted: targets.length,
              tokens: totalTokens(summary.tokens),
              durationMs: summary.durationMs,
              ...runFields(summary),
            },
          ],
        });
      }
      process.exitCode = finish(summary);
    });

  program
    .command("preflight")
    .description("Check that the repo's runner and coverage reporter are usable")
    .requiredOption("--repo <name>", "repo name from covergen.yaml")
    .option("--deep", "also run the smoke coverage pass, which builds the tree", false)
    .action(async (opts: { repo: string; deep: boolean }) => {
      const { config } = context(program);
      const repo = findRepo(config, opts.repo);
      try {
        const runner = getRunner(repo.runner);
        await runner.preflight(repo, { deep: opts.deep });
        process.stdout.write(`OK ${repo.name} (${repo.runner}) in ${repo.cwd}${opts.deep ? " (deep)" : ""}\n`);
        if (generatorBackend(config, repo) === "claude-code") {
          const auth = await preflightClaudeCode(
            claudeExec(config.claude_code.binary, tmpdir(), config.claude_code.timeout_ms),
          );
          process.stdout.write(`OK generator claude-code, logged in via ${auth}\n`);
        }
        // A warning is not a failure: the toolchain works, but something about it
        // will cost candidates. Printed after OK so a green preflight still reads green.
        for (const warning of (await runner.warnings?.(repo)) ?? []) process.stdout.write(`WARN ${warning}\n`);
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.stdout.write(`FAIL ${repo.name} (${repo.runner})\n${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = EXIT_ERROR;
      }
    });

  program
    .command("explore")
    .description("Crawl a live web app read-only and print the user flows no end to end spec covers")
    .requiredOption("--repo <name>", "repo name from covergen.yaml, with an explore: block")
    .requiredOption("--dry-run", "report only. The only mode explore has today; generation is not built")
    .option("--max-pages <n>", "override explore.max_pages for this crawl")
    .action(async (opts: { repo: string; maxPages?: string }) => {
      const { config, log } = context(program);
      const repo = findRepo(config, opts.repo);
      if (!repo.explore) throw new Error(`repo "${repo.name}" has no explore: block in covergen.yaml.`);
      const { baseUrl, storageStatePath } = exploreEnv(repo.explore);
      const maxPages = parseCeiling(opts.maxPages, "--max-pages", repo.explore.maxPages);
      if (maxPages < 1) throw new Error("--max-pages must be at least 1. There is no unlimited crawl.");
      // Logged as a boolean, never as a path: the session file is the credential.
      log.info({ repo: repo.name, baseUrl, session: storageStatePath !== undefined, maxPages }, "explore dry run");
      const specs = indexSpecs(await loadSpecs(repo.cwd, repo.explore.specGlob), baseUrl);
      const reader = await openBrowserReader({ storageStatePath });
      try {
        const pages = await crawl(reader, { baseUrl, maxPages, ignore: repo.explore.ignorePatterns });
        const flows = buildFlows(pages, baseUrl, specs, repo.explore.allowMutations);
        process.stdout.write(renderReport(flows, { baseUrl, pages: pages.length, maxPages }));
        process.exitCode = flows.some((f) => !f.covered) ? EXIT_OK : EXIT_NONE_ACCEPTED;
      } finally {
        await reader.close();
      }
    });

  program
    .command("audit")
    .description("Judge the tests this repo already has: which ones run code without checking it, and what they cost")
    .requiredOption("--repo <name>", "repo name from covergen.yaml")
    .option("--limit <n>", "audit at most this many spec files, cheapest-value first", "0")
    .option("--report <path>", "write the JSON report to this path")
    .option("--deep", "plant bugs against every case, not only the ones the static pass flagged", false)
    .option("--pr", "open a draft PR proposing the removal of the cases that catch nothing and cover nothing unique", false)
    .option("--min-savings-ms <n>", "leave a case alone unless cutting it gives back at least this many ms per run", "0")
    .action(async (opts: { repo: string; limit: string; report?: string; deep: boolean; pr: boolean; minSavingsMs: string }) => {
      const { config, log } = context(program);
      const repo = findRepo(config, opts.repo);
      const parsed = Number.parseInt(opts.limit, 10);
      const report = await runAudit({
        config,
        repo,
        log,
        deep: opts.deep,
        limit: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
        limits: createLimits({ maxMinutes: config.sweep.max_minutes }),
      });
      const markdown = auditMarkdown(report);
      const path = await writeAudit(config, repo, markdown);
      if (opts.report) await writeAuditJson(opts.report, report);
      process.stdout.write(markdown);
      process.stdout.write(`\nWritten to ${path}\n`);
      if (opts.pr) {
        const savings = Number.parseInt(opts.minSavingsMs, 10);
        const outcome = await runRemoval({ config, repo, log, report, minSavingsMs: Number.isFinite(savings) && savings > 0 ? savings : 0 });
        const said = outcome.status === "opened" ? outcome.urls.join(", ") : (outcome.reason ?? outcome.status);
        process.stdout.write(`Removal PR: ${said}\n`);
      }
      // Nothing flagged is the good outcome and still not a finding, so it takes
      // the same exit code an empty run does.
      process.exitCode = report.totals.cases > report.totals.keeps ? EXIT_OK : EXIT_NONE_ACCEPTED;
    });

  program
    .command("baseline")
    .description("Run the suite with coverage and print the highest-value targets")
    .requiredOption("--repo <name>", "repo name from covergen.yaml")
    .option("--top <n>", "how many files to print", "30")
    .action(async (opts: { repo: string; top: string }) => {
      const { config } = context(program);
      const repo = findRepo(config, opts.repo);
      const map = await baselineCoverage(repo, config.gate.timeout_ms);
      // The same ranking a sweep uses, with the components printed, so the file
      // at the top can be argued with instead of taken on faith.
      const rows = await rankByValue({ repo, baseline: map, targets: [...map.keys()] });

      const parsedTop = Number.parseInt(opts.top, 10);
      const top = Number.isFinite(parsedTop) && parsedTop > 0 ? parsedTop : 30;
      const overall = summarize(map);
      process.stdout.write(
        `${repo.name}: ${overall.covered}/${overall.total} lines covered (${overall.pct.toFixed(1)}%) across ${rows.length} files\n\n`,
      );
      process.stdout.write(valueTable(rows.slice(0, top)));
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    process.stderr.write(`covergen: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = EXIT_ERROR;
  }
}

/**
 * True when this module is the process entry point. `npm i -g` puts a symlink in
 * the bin directory pointing at dist/cli.js, so `process.argv[1]` is the link
 * while `import.meta.url` is the file it resolves to. Comparing the two without
 * resolving the link made the installed binary exit 0 and print nothing.
 */
export function isEntryPoint(moduleUrl: string, entry: string | undefined): boolean {
  if (entry === undefined) return false;
  const abs = resolve(entry);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    // The entry may not exist as a file, for example under a bundler. Fall back
    // to the unresolved path rather than throwing at import time.
  }
  return moduleUrl === pathToFileURL(real).href || moduleUrl === pathToFileURL(abs).href;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  await main();
}
