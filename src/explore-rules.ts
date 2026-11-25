/**
 * The explore gate's rejections, one registry for the prompt and the checks.
 * Each id is a FlowStatus and a row of the table in docs/explore-mode.md ("The
 * gate stays a gate"). Today the registry only feeds the stable prompt block, so
 * the model is told up front what will reject its spec; the checks that enforce
 * each id read the same entries when they land.
 */

import type { FlowStatus } from "./types.js";

export type ExploreRuleId = Extract<
  FlowStatus,
  "flaky" | "no_assertion" | "action_removable" | "mutation_not_allowed" | "credential_in_spec" | "off_site" | "duplicate_flow"
>;

export interface ExploreRule {
  id: ExploreRuleId;
  /** One line, written to the model. */
  description: string;
}

export const exploreRules: readonly ExploreRule[] = [
  { id: "flaky", description: "The spec must pass three times in a row against the live target, so wait on web-first assertions, never on timers." },
  { id: "no_assertion", description: "Assert something a regression could break: a visible state change, a network response, or a URL change." },
  { id: "action_removable", description: "With its main action commented out the spec must fail, so assert the effect of that action, not that the page loaded." },
  { id: "mutation_not_allowed", description: "Use a mutating element (submit, save, delete) only when the target says the route is writable." },
  { id: "credential_in_spec", description: "No email, password, cookie or token in the spec; the session comes from the storage state the spec loads." },
  { id: "off_site", description: "Navigate only within the base origin, with relative paths." },
  { id: "duplicate_flow", description: "Cover what the existing specs do not; a spec repeating an existing one is rejected." },
];

export const exploreRuleIds: readonly ExploreRuleId[] = exploreRules.map((r) => r.id);

/** The registry rendered for the stable prompt block. */
export function exploreRulesText(): string {
  return ["Rules every generated spec must follow. Each id is the rejection it earns when broken:", ...exploreRules.map((r) => `- ${r.id}: ${r.description}`)].join("\n");
}
