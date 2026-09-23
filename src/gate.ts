/**
 * The gate: splice one candidate into the real spec file, run it, and decide.
 *
 * A candidate is accepted only when it builds, passes k times in a row, covers at
 * least one previously uncovered line of the target source, loses none, and, when
 * the mutation spot-check is on, fails for at least one small break of the lines it
 * covers. Every other outcome is a named failure the repair loop can act on.
 *
 * The spec file is always restored. The original bytes are captured before the
 * write and put back in a finally block; a file we created is deleted outright.
 * The source file is restored the same way, in its own inner finally, so it goes
 * back before the spec does.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { diffCoverage, discardCoverageDir, readLcov } from "./lcov.js";
import { generateMutants } from "./mutate.js";
import { runCommand } from "./runners/exec.js";
import type {
  Candidate,
  CoverageMap,
  GateOptions,
  GateResult,
  MutationSummary,
  RepoConfig,
  RunResult,
  Runner,
  RunnerName,
} from "./types.js";

/** Patterns that mean the file never got as far as running a test. */
const BUILD_FAILURE = [
  /\bSyntaxError\b/,
  /\bNameError\b/,
  /\bLoadError\b/,
  /uninitialized constant/i,
  /cannot find module/i,
  /failed to load/i,
  /\bTS\d{4,}\b/,
  // `go test` prints this once per package it could not build.
  /\[(?:build|setup) failed\]/,
  // cargo prints this only when rustc rejected the crate, never on a test failure.
  /could not compile/i,
  /Transform failed/i,
  /Parse failure/i,
  /unexpected token/i,
  /module not found/i,
  /cannot resolve/i,
];

export function classifyFailure(output: string): "build_failed" | "test_failed" {
  return BUILD_FAILURE.some((p) => p.test(output)) ? "build_failed" : "test_failed";
}

/**
 * A mutant that never compiled says nothing about the test. Narrower than
 * BUILD_FAILURE on purpose: only what the parser raises before any code runs,
 * because a mutant that makes the code raise at runtime is one the test killed.
 */
const UNCOMPILABLE = [
  /\bSyntaxError\b/,
  /\bIndentationError\b/,
  /\bTabError\b/,
  /Transform failed/i,
  /Parse failure/i,
  /\bsyntax error\b/i,
  // Go: a mutant the compiler rejected, e.g. `undefined: err` after a return swap.
  /\[(?:build|setup) failed\]/,
  // Rust: a mutant rustc rejected, e.g. a relational flip inside a generic.
  /could not compile/i,
];

/** True when a mutant run is a real result; false when the parser rejected the mutant. */
export function mutantCompiled(run: RunResult): boolean {
  return run.ok || !UNCOMPILABLE.some((p) => p.test(`${run.stderr}\n${run.stdout}`));
}

/** Last `lines` lines of stderr then stdout, which is where runners put the reason. */
export function tailOf(run: RunResult | undefined, lines = 60): string | undefined {
  if (!run) return undefined;
  const text = [run.stderr, run.stdout].filter((s) => s && s.trim().length > 0).join("\n").trimEnd();
  if (text.length === 0) return undefined;
  return text.split("\n").slice(-lines).join("\n");
}

/**
 * Insert an appendable block into an existing spec file.
 *
 * RSpec: before the final top-level `end`, which closes the outer describe.
 * JS runners: at the end of the file. Vitest, Jest and bun all accept a second
 * top-level describe, so there is nothing to splice into.
 */
export function spliceBlock(original: string, block: string, runner: RunnerName): string {
  const body = block.replace(/\s+$/, "");
  if (runner !== "rspec") {
    const base = original.replace(/\s+$/, "");
    return `${base}\n\n${body}\n`;
  }
  const lines = original.split("\n");
  let target = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] ?? "").trim() === "end") {
      target = i;
      break;
    }
  }
  if (target === -1) {
    const base = original.replace(/\s+$/, "");
    return `${base}\n\n${body}\n`;
  }
  const indented = body
    .split("\n")
    .map((line) => (line.trim().length === 0 ? line : `  ${line}`))
    .join("\n");
  return [...lines.slice(0, target), indented, "", ...lines.slice(target)].join("\n");
}

/**
 * Why a mutation result is not good enough, or undefined when it is.
 *
 * Two thresholds, both applied: an absolute floor, so a candidate that kills one
 * of five mutants cannot pass on a lucky ratio, and a ratio, so the floor does
 * not become the whole bar when there are many mutants.
 *
 * `tried: 0` means nothing the operators know how to break sits on the lines the
 * candidate covered, so the spot-check has no opinion. That is a shortfall, not
 * a pass: accepting there is accepting on coverage alone, which is the thing the
 * spot-check exists to prevent. `allowNoMutants` is the per-repo escape hatch
 * for a tree where declaration-shaped files are the normal case.
 */
export function mutationShortfall(
  summary: MutationSummary,
  minKilled: number,
  minRatio: number,
  allowNoMutants = false,
): string | undefined {
  if (summary.tried === 0) return allowNoMutants ? undefined : "no bug could be planted";
  if (summary.killed < Math.min(minKilled, summary.tried)) {
    return `caught ${summary.killed} of ${summary.tried} planted bugs, need at least ${Math.min(minKilled, summary.tried)}`;
  }
  const ratio = summary.killed / summary.tried;
  if (minRatio > 0 && ratio < minRatio) {
    return `caught ${summary.killed} of ${summary.tried} planted bugs (${(ratio * 100).toFixed(0)}%), need ${(minRatio * 100).toFixed(0)}%`;
  }
  return undefined;
}

export interface EvaluateArgs {
  repo: RepoConfig;
  runner: Runner;
  candidate: Candidate;
  /**
   * Whole-suite coverage before this candidate existed. A line counts as a gain
   * only if nothing in the suite covered it.
   */
  baseline: CoverageMap;
  /**
   * Coverage from running just this spec file, before the splice. Loss is judged
   * against this, because the gate runs the spec alone and lines other spec files
   * cover would otherwise look lost. Defaults to `baseline` (correct in fast mode).
   */
  specBaseline?: CoverageMap;
  /** Source file under test, relative to repo.cwd. */
  sourceRel: string;
  opts: GateOptions;
  /** Injected in tests. Runs repo.validate commands. */
  exec?: typeof runCommand;
  /**
   * Bounded mutation spot-check, run only after everything else has passed.
   * Omitted or disabled means the candidate is accepted on coverage alone.
   */
  mutation?: {
    enabled: boolean;
    maxMutants: number;
    /** Absolute floor: catching fewer planted bugs than this rejects the candidate. */
    minKilled: number;
    /** Share of the mutants tried that must be killed, 0 to 1. Defaults to 0 (floor only). */
    minKilledRatio?: number;
    /** Accept a candidate no operator could produce an applicable mutant for. */
    allowNoMutants?: boolean;
    timeoutMs: number;
  };
}

/**
 * How many mutants may be written and run to fill `maxMutants` applicable slots.
 * A mutant the compiler rejects is not a result, so it must not consume a slot,
 * but refilling has to stop somewhere: a file where most operators produce
 * uncompilable edits would otherwise run the whole operator set at gate speed.
 */
export const MUTANT_ATTEMPT_FACTOR = 3;

export async function evaluate(args: EvaluateArgs): Promise<GateResult> {
  const { repo, runner, candidate, baseline, sourceRel, opts } = args;
  const specBaseline = args.specBaseline ?? baseline;
  const exec = args.exec ?? runCommand;
  const absSpec = join(repo.cwd, candidate.specPath);
  const existed = existsSync(absSpec);

  if (candidate.wholeFile && existed) {
    return {
      status: "build_failed",
      runs: [],
      error: `candidate is a whole file but ${candidate.specPath} already exists; regenerate it as an appendable block`,
    };
  }
  if (!candidate.wholeFile && !existed) {
    return {
      status: "build_failed",
      runs: [],
      error: `candidate is an appendable block but ${candidate.specPath} does not exist; regenerate it as a complete file`,
    };
  }

  const original = existed ? await readFile(absSpec, "utf8") : undefined;
  const runs: RunResult[] = [];

  try {
    const next = candidate.wholeFile
      ? candidate.code.replace(/\s+$/, "") + "\n"
      : spliceBlock(original ?? "", candidate.code, repo.runner);
    // A brand new spec may land in a directory the repo does not have yet.
    if (!existed) await mkdir(dirname(absSpec), { recursive: true });
    await writeFile(absSpec, next, "utf8");

    // A per-runner check on the written file, before anything is run. gofmt is
    // the case: a Go project treats unformatted code as a failure, and finding
    // that out after three passing runs would be three runs wasted.
    const specIssue = await runner.checkSpec?.(repo, candidate.specPath);
    if (specIssue) return { status: "build_failed", runs, error: specIssue };

    const env = { COVERGEN_SOURCE: sourceRel };
    const first = await runner.run(repo, {
      files: [candidate.specPath],
      coverage: true,
      timeoutMs: opts.timeoutMs,
      env,
      gate: true,
    });
    runs.push(first);

    if (!first.ok) {
      const error = tailOf(first);
      return { status: classifyFailure(`${first.stderr}\n${first.stdout}`), runs, error };
    }

    for (let i = 1; i < opts.k; i += 1) {
      const repeat = await runner.run(repo, {
        files: [candidate.specPath],
        coverage: false,
        timeoutMs: opts.timeoutMs,
        env,
        gate: true,
      });
      runs.push(repeat);
      if (!repeat.ok) {
        return {
          status: "flaky",
          runs,
          error: tailOf(repeat) ?? `passed once then failed on run ${i + 1} of ${opts.k}`,
        };
      }
    }

    if (!first.lcovPath) {
      return { status: "no_coverage_gain", runs, error: "runner produced no lcov file, cannot prove a coverage gain" };
    }

    const after = await readLcov(first.lcovPath, { cwd: repo.cwd });
    await discardCoverageDir(first.lcovPath);
    const gain = diffCoverage(baseline, after, sourceRel);
    const loss = diffCoverage(specBaseline, after, sourceRel);
    // `after` is the candidate's spec run alone, so its raw percentage is not
    // comparable to the suite baseline. Report the suite figure plus the gain.
    const delta = {
      ...gain,
      lost: loss.lost,
      after: { covered: gain.before.covered + gain.newlyCovered.length, total: gain.before.total },
    };

    if (delta.lost.length > 0) {
      return { status: "no_coverage_gain", runs, delta, error: `lost coverage on lines ${delta.lost.join(", ")}` };
    }
    if (delta.newlyCovered.length === 0) {
      return { status: "no_coverage_gain", runs, delta, error: "passed but covered no new lines" };
    }

    // Repo-level validation (typecheck, lint) with the candidate still in place.
    for (const cmd of repo.validate ?? []) {
      const full = [...(repo.commandPrefix ?? []), ...cmd];
      const res = await exec(full, { cwd: repo.cwd, timeoutMs: opts.timeoutMs });
      const asRun: RunResult = { ok: res.exitCode === 0, ...res };
      runs.push(asRun);
      if (res.exitCode !== 0) {
        return {
          status: "build_failed",
          runs,
          delta,
          error: `validation command failed (${cmd.join(" ")}):\n${tailOf(asRun) ?? "no output"}`,
        };
      }
    }
    const mutation = args.mutation;
    if (!mutation?.enabled) return { status: "accepted", runs, delta };

    const absSource = join(repo.cwd, sourceRel);
    let originalSource: string;
    try {
      originalSource = await readFile(absSource, "utf8");
    } catch {
      // No readable source means nothing to mutate. Do not fail an otherwise
      // good candidate over it.
      return { status: "accepted", runs, delta, mutation: { tried: 0, killed: 0, survivors: [] } };
    }

    // Ask for more mutants than there are slots: the ones the compiler rejects
    // are dropped rather than scored, and the slots they would have burned are
    // refilled from the rest until `maxMutants` real results exist or the
    // operators run out of applicable edits.
    const mutants = generateMutants({
      path: sourceRel,
      language: repo.language,
      source: originalSource,
      lines: delta.newlyCovered,
      max: mutation.maxMutants * MUTANT_ATTEMPT_FACTOR,
    });

    let killed = 0;
    let tried = 0;
    const survivors: MutationSummary["survivors"] = [];
    try {
      for (const mutant of mutants) {
        if (tried >= mutation.maxMutants) break;
        await writeFile(absSource, mutant.source, "utf8");
        const run = await runner.run(repo, {
          files: [candidate.specPath],
          coverage: false,
          timeoutMs: mutation.timeoutMs,
          env,
          gate: true,
        });
        runs.push(run);
        // Not applicable, not killed: a mutant the parser rejected is dropped from
        // the count rather than scored, the way a build failure is not a test result.
        if (!mutantCompiled(run)) continue;
        tried += 1;
        // A failing run is the good outcome: the test noticed the broken code.
        if (run.ok) survivors.push({ id: mutant.id, line: mutant.line, description: mutant.description });
        else killed += 1;
      }
    } finally {
      // Restore the source before the outer finally restores the spec, so the
      // tree is never left with a mutant in it.
      await writeFile(absSource, originalSource, "utf8");
    }

    const summary: MutationSummary = { tried, killed, survivors };
    const shortfall = mutationShortfall(summary, mutation.minKilled, mutation.minKilledRatio ?? 0, mutation.allowNoMutants);
    if (shortfall) {
      if (tried === 0) {
        return {
          status: "weak_assertions",
          runs,
          delta,
          mutation: summary,
          error:
            `${shortfall}: nothing on lines ${delta.newlyCovered.join(", ")} of ${sourceRel} can be broken in a way this test could notice. ` +
            "Target a line with a branch, a comparison or a returned value, and assert on what it produces.",
        };
      }
      const list = survivors.map((s) => `line ${s.line}: ${s.description}`).join("\n");
      return {
        status: "weak_assertions",
        runs,
        delta,
        mutation: summary,
        error: `${shortfall}. The test still passed with these bugs planted:\n${list}`,
      };
    }
    return { status: "accepted", runs, delta, mutation: summary };
  } finally {
    if (original === undefined) {
      await unlink(absSpec).catch(() => {});
    } else {
      await writeFile(absSpec, original, "utf8");
    }
  }
}
