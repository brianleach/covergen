/**
 * Prompt assembly, split the way AutoCover splits it so prompt caching actually pays:
 *
 *   stable      idiom pack + rules + output format. Identical for a whole run.
 *   semiStable  the file under test and the nearest existing spec. Identical per file.
 *   volatile    the one segment, its uncovered lines, and the target spec path.
 *
 * Both stable and semiStable get a cache breakpoint in generate.ts, so a run over
 * one file pays for the prefix once and then only for the volatile tail.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { PromptBlocks, RepoConfig, RunnerName, Segment } from "./types.js";

/** Read an idiom pack verbatim. Returns "" when no pack is configured. */
export function loadIdiomPack(path?: string): string {
  if (!path) return "";
  return readFileSync(path, "utf8");
}

/** Prefix every line with its 1-based line number, right-aligned. */
export function numberLines(text: string, startLine = 1): string {
  const lines = text.split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width, " ")} | ${line}`).join("\n");
}

function toPosix(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Candidate spec paths for a source file: the repo's conventional path first, then
 * the sibling naming conventions each runner also tolerates. `exists` decides.
 *
 * There is no directory listing here on purpose. The caller owns fs access, which
 * keeps this pure and makes it trivial to test.
 */
export function specCandidates(repo: RepoConfig, relSource: string): string[] {
  const rel = toPosix(relSource);
  const dir = dirname(rel);
  const ext = extname(rel);
  const base = basename(rel, ext);
  const here = (name: string) => toPosix(dir === "." ? name : join(dir, name));

  const out = [toPosix(repo.specPath(rel))];
  if (repo.runner === "rspec") {
    out.push(here(`${base}_spec.rb`), toPosix(join("spec", dir, `${base}_spec.rb`)));
  } else if (repo.runner === "pytest") {
    out.push(here(`test_${base}.py`), toPosix(join("tests", `test_${base}.py`)));
  } else if (repo.runner === "cargo") {
    // Rust keeps unit tests in the source file; tests/<name>.rs is the alternative.
    out.push(toPosix(join("tests", `${base}.rs`)));
  } else if (repo.runner === "go") {
    // Go has exactly one convention: an internal test beside the source.
    out.push(here(`${base}_test.go`));
  } else {
    for (const suffix of [".test", ".spec"]) {
      out.push(here(`${base}${suffix}${ext}`), here(join("__tests__", `${base}${suffix}${ext}`)));
    }
  }
  return [...new Set(out)];
}

/**
 * The nearest existing spec for `relSource`, or undefined when the file has none.
 * Tries the configured spec path, then sibling spec files in the same directory.
 */
export function findNearestSpec(
  repo: RepoConfig,
  relSource: string,
  exists: (p: string) => boolean,
): string | undefined {
  // The cargo runner's default spec path is the source file itself. Showing the
  // file under test a second time as "the existing spec" teaches nothing and
  // doubles the semi-stable block, so it is never its own nearest spec.
  const self = toPosix(relSource);
  return specCandidates(repo, relSource).find((p) => p !== self && exists(p));
}

export interface BuildPromptArgs {
  /** Idiom pack markdown, verbatim. */
  idiomPack: string;
  /** Rendered rules registry, from rules.ts. */
  rulesText: string;
  /** Source file path relative to the repo cwd. */
  sourcePath: string;
  sourceText: string;
  /** Nearest existing spec, when there is one. */
  nearestSpecPath?: string;
  nearestSpecText?: string;
  segment: Segment;
  runner: RunnerName;
  /** Spec file this candidate targets, relative to the repo cwd. */
  specPath: string;
  /** True when the model must return a complete new file. */
  wholeFile: boolean;
}

function outputFormat(runner: RunnerName, wholeFile: boolean): string {
  const container =
    runner === "rspec"
      ? "inside the top-level `RSpec.describe ... do` block of that file"
      : runner === "pytest" || runner === "go"
        ? "at the end of that file, at top level"
        : "inside the top-level `describe` block of that file";
  const shape = wholeFile
    ? runner === "pytest"
      ? "the complete contents of a new test file, including every import"
      : runner === "go"
        ? "the complete contents of a new test file, including the package clause (the same package as the file under test) and every import"
        : "the complete contents of a new spec file, including every require/import and the top-level describe"
    : runner === "pytest"
      ? `one or more module-level \`def test_*\` functions that can be appended verbatim ${container}, with no imports of their own`
      : runner === "go"
        ? `one or more \`func TestXxx(t *testing.T)\` functions that can be appended verbatim ${container}, with no package clause and no imports of their own`
        : `a block that can be appended verbatim ${container}, with no requires, no imports, and no describe wrapper of its own`;
  return [
    "Output format:",
    "- Return exactly one fenced code block and nothing else. No preamble, no explanation, no second block.",
    `- The block must contain ${shape}.`,
    "- Do not include the line numbers shown in the source listing; they are a reading aid only.",
    ...(runner === "go" ? ["- The code must be gofmt formatted: tabs for indentation, one statement per line. Unformatted code is rejected before it is run."] : []),
  ].join("\n");
}

/**
 * Assemble the three cache-tiered blocks for one candidate.
 */
export function buildPromptBlocks(args: BuildPromptArgs): PromptBlocks {
  const { segment, runner, specPath, wholeFile } = args;

  const stable = [
    `You write ${runner} tests for an existing codebase. You are given one file, a chunk of it that no test currently executes, and the exact uncovered line numbers. Write a test that executes those lines.`,
    "",
    args.idiomPack.trim().length > 0
      ? ["Repository test conventions (follow them exactly):", "", args.idiomPack.trim()].join("\n")
      : "There is no idiom pack for this repository. Follow the conventions visible in the existing spec below.",
    "",
    args.rulesText,
    "- Do not assert on implementation details that a harmless refactor would break: private method names, call counts on incidental collaborators, exact log strings, or object identity where value equality is meant.",
    "- Exercise the listed uncovered lines. A test that passes without reaching them is worthless here.",
    "- The gate breaks those lines one at a time and re-runs your test. A test that still passes while the code is broken is rejected, so assert on the value the code produced, not that it exists.",
    "- Write the fewest examples that reach the listed lines, usually one to three. Do not add tests for behavior the existing spec already covers.",
    "- No helper scaffolding (builders, factories, wrapper functions) unless the existing spec already uses that pattern. Inline the setup.",
    "- Reuse the existing spec's lets, fixtures, and mocks instead of redefining them.",
    "- Keep it the length a reviewer would write by hand. Bloat gets the whole candidate rejected in review.",
    "",
    outputFormat(runner, wholeFile),
  ].join("\n");

  const spec =
    args.nearestSpecPath && args.nearestSpecText !== undefined
      ? [
          `Existing spec at ${args.nearestSpecPath}. Match its style, helpers, and setup:`,
          "",
          "```",
          args.nearestSpecText,
          "```",
          // A configured spec template can point past the nearest spec.
          ...(args.nearestSpecPath !== specPath ? ["", `That file is a style example only. Your tests go in ${specPath}.`] : []),
        ].join("\n")
      : [
          `There is no existing spec for ${args.sourcePath}.`,
          `You are writing a complete new spec file at ${specPath}, so include every require/import and the top-level describe block.`,
        ].join("\n");

  const semiStable = [
    `File under test: ${args.sourcePath} (line numbers added for reference).`,
    "",
    "```",
    numberLines(args.sourceText),
    "```",
    "",
    spec,
  ].join("\n");

  const symbol = segment.symbol ? ` inside \`${segment.symbol}\`` : "";
  const volatile = [
    `Target: lines ${segment.startLine} to ${segment.endLine} of ${segment.path}${symbol}.`,
    "",
    "```",
    segment.text,
    "```",
    "",
    `Uncovered lines that this test must execute: ${segment.uncoveredLines.join(", ")}`,
    "",
    `Write the test into ${specPath}.`,
    wholeFile
      ? "That file does not exist yet: return the complete file."
      : "That file already exists: return only an appendable block, not the whole file.",
    "",
    "Return one fenced code block and nothing else.",
  ].join("\n");

  return { stable, semiStable, volatile };
}
