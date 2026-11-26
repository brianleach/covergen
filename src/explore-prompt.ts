/**
 * Prompt assembly for one crawled flow, split like src/prompt.ts so the cache
 * prefix pays the same way:
 *
 *   stable      Playwright idiom pack + explore rules + output format. Identical for a run.
 *   semiStable  one existing spec as the style example + the flow map. Identical for
 *               every flow that shares a style example, and the map for the whole run.
 *   volatile    the target flow: route, title, targets, writes, what specs already address.
 *
 * Only environment variable NAMES enter a block. The base URL and the storage
 * state path are values, and neither is ever passed in: a flow carries the
 * crawled URL, and this module reads its route, never its url.
 */

import { readFileSync } from "node:fs";
import { exploreIdiomPackPath } from "./config.js";
import { blockedReason } from "./explore.js";
import type { Flow, FlowElement } from "./explore.js";
import { flowSpecPath, specDirOf } from "./explore-generate.js";
import { exploreRulesText } from "./explore-rules.js";
import { scanSpec } from "./explore-specs.js";
import type { SpecFile } from "./explore-specs.js";
import { numberLines } from "./prompt.js";
import type { ExploreOptions, PromptBlocks } from "./types.js";

export interface FlowPromptArgs {
  flow: Flow;
  /** Every crawled flow, for the map. */
  flows: readonly Flow[];
  explore: Pick<ExploreOptions, "storageStateEnv" | "baseUrlEnv">;
  idiomPack: string;
  /** The style example, from pickStyleSpec. Absent when the repo has no spec yet. */
  styleSpec?: SpecFile;
  /** Where the spec will be written, when the caller knows. */
  specPath?: string;
}

const describe = (e: FlowElement): string => `${e.role} "${e.name}"${e.mutating ? " (mutating)" : ""}`;

/** Read the explore idiom pack: the configured one, else the bundled playwright pack. */
export function loadExploreIdiomPack(explore: Pick<ExploreOptions, "idiomPackPath">): string {
  return readFileSync(exploreIdiomPackPath(explore), "utf8");
}

/**
 * The style example: the smallest spec that visits the route, else the smallest
 * spec overall. Size is a proxy for "easiest to imitate". Ties go to path order.
 */
export function pickStyleSpec(specs: readonly SpecFile[], route: string, baseUrl: string): SpecFile | undefined {
  const bySize = [...specs].sort((a, b) => a.text.length - b.text.length || a.path.localeCompare(b.path));
  return bySize.find((s) => scanSpec(s, baseUrl).routes.includes(route)) ?? bySize[0];
}

function outputFormat(explore: FlowPromptArgs["explore"]): string {
  return [
    "Output format:",
    "- Return exactly one fenced code block and nothing else. No preamble, no explanation, no second block.",
    "- The block holds one complete Playwright spec file that imports `test` and `expect` from `@playwright/test`.",
    `- Set the session with \`test.use({ storageState: process.env.${explore.storageStateEnv} })\`. Write the variable name exactly; never a path.`,
    `- Navigate only with relative paths, \`page.goto("/...")\`. The base URL comes from ${explore.baseUrlEnv} through the Playwright config, never from the spec.`,
    "- Address elements with `getByRole` and the role and name listed for the target.",
    "- Hold exactly one `test()`, for the target flow.",
  ].join("\n");
}

export function buildFlowPromptBlocks(args: FlowPromptArgs): PromptBlocks {
  const { flow, explore } = args;
  const pack = args.idiomPack.trim();

  const stable = [
    "You write Playwright end to end specs for an existing web app. You are given one user flow that no existing spec covers: a route and the interactive elements on it. Write one spec that exercises the flow and asserts its effect.",
    "",
    pack.length > 0 ? ["End to end conventions (follow them exactly):", "", pack].join("\n") : "There is no idiom pack. Follow the conventions visible in the existing spec below.",
    "",
    exploreRulesText(),
    "",
    outputFormat(explore),
  ].join("\n");

  const style = args.styleSpec
    ? [`Existing spec at ${args.styleSpec.path}. Match its style (line numbers are a reading aid only):`, "", "```", numberLines(args.styleSpec.text), "```"].join("\n")
    : "The repository has no end to end spec yet, so there is no style example. Follow the conventions above.";
  const map = args.flows.map((f) => `- ${f.route}${f.title ? `: ${f.title}` : ""}`);
  const semiStable = [style, "", "Flow map of the crawled app (route and title):", ...map].join("\n");

  const addressed = flow.elements.filter((e) => !flow.uncovered.includes(e));
  const volatile = [
    `Target flow: ${flow.route}${flow.title ? ` (title "${flow.title}")` : ""}.`,
    flow.writable
      ? "This route is writable: its mutating elements may be pressed, with unique run-scoped test data."
      : "This route is read-only: do not press any mutating element.",
    "",
    "Elements to exercise (role and accessible name):",
    ...flow.targets.map((e) => `- ${describe(e)}`),
    "",
    addressed.length > 0
      ? ["Elements existing specs already address (do not repeat them as the main action):", ...addressed.map((e) => `- ${describe(e)}`)].join("\n")
      : "No existing spec addresses an element on this route.",
    ...(flow.coveredBy.length > 0 ? ["", `Specs that already visit this route: ${flow.coveredBy.join(", ")}.`] : []),
    ...(args.specPath ? ["", `The spec will be written to ${args.specPath}.`] : []),
    "",
    "Return one fenced code block and nothing else.",
  ].join("\n");

  return { stable, semiStable, volatile };
}

/** The --show-prompt preview: the three blocks, labelled, for a reader to check before anything is spent. */
export function renderFlowPrompt(blocks: PromptBlocks, flow: Flow): string {
  return [
    `--- prompt preview for ${flow.route}: no generator was constructed, nothing was sent ---`,
    "=== stable ===",
    blocks.stable,
    "=== semiStable ===",
    blocks.semiStable,
    "=== volatile ===",
    blocks.volatile,
    "",
  ].join("\n");
}

/**
 * What `explore --dry-run --show-prompt` prints after the report: the blocks for
 * the top-ranked flow a generation pass would target, or a sentence when none is
 * open. Builds text only; no generator is constructed and no key is read.
 */
export function showFlowPrompt(args: {
  flows: readonly Flow[];
  specs: readonly SpecFile[];
  explore: Pick<ExploreOptions, "storageStateEnv" | "baseUrlEnv" | "specGlob" | "idiomPackPath">;
  baseUrl: string;
  exists: (path: string) => boolean;
  idiomPack?: string;
}): string {
  const flow = args.flows.find((f) => blockedReason(f) === "");
  if (!flow) return "--- no open flow, so there is no prompt to preview ---\n";
  const specPath = flowSpecPath(flow.route, specDirOf(args.explore.specGlob), args.exists);
  const blocks = buildFlowPromptBlocks({
    flow,
    flows: args.flows,
    explore: args.explore,
    idiomPack: args.idiomPack ?? loadExploreIdiomPack(args.explore),
    styleSpec: pickStyleSpec(args.specs, flow.route, args.baseUrl),
    specPath,
  });
  return renderFlowPrompt(blocks, flow);
}
