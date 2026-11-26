/**
 * One flow prompt in, one FlowCandidate out, through any generator backend.
 *
 * A flow has no source segment, so this never calls `Generator.generate`. It
 * opens the chat with `continueChat([], volatile, system)`, which every backend
 * implements, and records the two turns so a repair round continues the same
 * chat (and, on the claude-code backend, resumes the same session).
 */

import { extractCode, hashCode, shortId } from "./generate.js";
import type { Generator } from "./generate.js";
import type { FlowCandidate, PromptBlocks } from "./types.js";

/**
 * A spec that cannot be a Playwright spec at all, or undefined when the shape
 * holds. Pure text checks: the gate proper runs the spec.
 */
export function checkFlowShape(code: string): string | undefined {
  if (!/\bfrom\s+["']@playwright\/test["']/.test(code)) return "spec does not import from @playwright/test";
  if (!/\btest\s*\(/.test(code)) return "spec declares no test()";
  if (!/\bpage\.goto\s*\(/.test(code)) return "spec never calls page.goto()";
  return undefined;
}

/** The literal directory at the head of a glob: `e2e/**\/*.spec.ts` gives `e2e`. */
export function specDirOf(specGlob: string): string {
  const parts = specGlob.replaceAll("\\", "/").split("/");
  const literal: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?[\]{}]/.test(part)) break;
    literal.push(part);
  }
  return literal.length > 0 ? literal.join("/") : ".";
}

/**
 * Where a generated spec for `route` goes: `<specDir>/covergen/<slug>.spec.ts`,
 * `/` as `home`, `:id` as `id`, slashes as dashes, then `-2`, `-3` until `exists`
 * says the path is free.
 */
export function flowSpecPath(route: string, specDir: string, exists: (path: string) => boolean): string {
  const slug =
    route
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => (s === ":id" ? "id" : s.replaceAll(/[^a-z0-9._-]+/gi, "-").replaceAll(/^-+|-+$/g, "")))
      .filter((s) => s.length > 0)
      .join("-") || "home";
  const dir = specDir === "." || specDir === "" ? "covergen" : `${specDir.replace(/\/+$/, "")}/covergen`;
  let path = `${dir}/${slug}.spec.ts`;
  for (let n = 2; exists(path); n++) path = `${dir}/${slug}-${n}.spec.ts`;
  return path;
}

/**
 * Ask any backend for one flow spec. A reply with no fenced block, or several,
 * becomes a build_failed candidate carrying the extract error rather than a
 * throw, and so does a block that fails checkFlowShape.
 */
export async function generateFlowCandidate(
  generator: Pick<Generator, "continueChat">,
  blocks: PromptBlocks,
  flow: { route: string },
  specPath: string,
): Promise<FlowCandidate> {
  const system = { stable: blocks.stable, semiStable: blocks.semiStable };
  const reply = await generator.continueChat([], blocks.volatile, system);
  const base = {
    id: shortId(),
    route: flow.route,
    specPath,
    attempts: 1,
    history: [
      { role: "user" as const, content: blocks.volatile },
      { role: "assistant" as const, content: reply },
    ],
    system,
  };
  let code: string;
  try {
    code = extractCode(reply);
  } catch (err) {
    // Hash the reply, so two different failures are not deduped into one.
    return { ...base, hash: hashCode(reply), code: "", status: "build_failed", lastError: err instanceof Error ? err.message : String(err) };
  }
  const problem = checkFlowShape(code);
  return { ...base, hash: hashCode(code), code, status: problem ? "build_failed" : "generated", ...(problem ? { lastError: problem } : {}) };
}

/** Drop later candidates whose normalized spec matches an earlier one, as dedupeCandidates does for unit tests. */
export function dedupeFlowCandidates(list: readonly FlowCandidate[]): FlowCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    if (seen.has(c.hash)) return false;
    seen.add(c.hash);
    return true;
  });
}
