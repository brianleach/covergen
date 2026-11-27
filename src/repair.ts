/**
 * Chat-continuation repair.
 *
 * The model already has the file, the spec and the segment in its context from the
 * generate call, so a repair round is the error appended to the same chat, with the
 * same system blocks re-sent so the prompt cache prefix still matches.
 *
 * Freezing matters more than repairing. A candidate that fails the same way twice
 * burns tokens for nothing, so flaky gets exactly one round, the three assertion
 * verdicts share one round between them, and every status gives up after maxRounds.
 *
 * The loop is generic so the explore gate's flow candidates repair the same way,
 * with their own messages (exploreRepairMessage) and their own shared rounds
 * (EXPLORE_SHARED_ROUNDS). The defaults are the unit pipeline's.
 */

import type { FlowGateResult } from "./explore-gate.js";
import type { RuleContext } from "./explore-rules.js";
import { indexSpecs, scanSpec } from "./explore-specs.js";
import { COUNTING_MATCHERS } from "./explore-steps.js";
import { extractCode, hashCode, type Generator } from "./generate.js";
import type { Candidate, FlowCandidate, GateResult, PromptBlocks, PromptMessage } from "./types.js";

/** What the loop needs of a candidate: its code and the chat it came from. */
export interface RepairableCandidate {
  code: string;
  hash: string;
  attempts: number;
  lastError?: string;
  status: string;
  history: PromptMessage[];
  system?: Pick<PromptBlocks, "stable" | "semiStable">;
}

/** What the loop needs of a verdict. */
export interface RepairableResult {
  status: string;
  error?: string;
}

export interface RepairArgs<C extends RepairableCandidate = Candidate, R extends RepairableResult = GateResult> {
  candidate: C;
  /** The verdict that sent this candidate here. */
  gateResult: R;
  generator: Pick<Generator, "continueChat">;
  evaluate: (candidate: C) => Promise<R>;
  maxRounds: number;
  /** The user turn for one round. Default: repairMessage. */
  message?: (candidate: C, result: R) => string;
  /** Verdict groups that share one repair round each. Default: UNIT_SHARED_ROUNDS. */
  sharedRounds?: readonly (readonly string[])[];
  /** The candidate as it is returned once accepted. Default: status accepted, plus the unit delta. */
  accepted?: (candidate: C, result: R) => C;
}

export interface RepairOutcome<C extends RepairableCandidate = Candidate, R extends RepairableResult = GateResult> {
  candidate: C;
  result: R;
}

/** flaky gets one round; the three "it does not check anything" verdicts share one. */
export const UNIT_SHARED_ROUNDS: readonly (readonly string[])[] = [["flaky"], ["weak_assertions", "tautological", "declaration_snapshot"]];

/** flaky gets one round; the two "it protects nothing" verdicts share one. */
export const EXPLORE_SHARED_ROUNDS: readonly (readonly string[])[] = [["flaky"], ["no_assertion", "action_removable"]];

const ONE_BLOCK = "Return the full corrected test in exactly one fenced code block, and nothing else.";

/** The user turn for one repair round, chosen by what the gate said went wrong. */
export function repairMessage(candidate: Candidate, result: GateResult): string {
  const error = result.error?.trim();
  const errorBlock = error ? ["", "```", error, "```"].join("\n") : "";

  switch (result.status) {
    case "build_failed":
      return [`That test did not build. The runner said:${errorBlock}`, "", `Fix the cause, not the symptom. ${ONE_BLOCK}`].join("\n");
    case "test_failed":
      return [
        `That test built but failed. The runner said:${errorBlock}`,
        "",
        "The code under test is correct; the test's expectations or setup are wrong. Fix them.",
        ONE_BLOCK,
      ].join("\n");
    case "no_coverage_gain": {
      const covered = new Set(result.delta?.newlyCovered ?? []);
      const missing = candidate.segment.uncoveredLines.filter((line) => !covered.has(line));
      const list = (missing.length > 0 ? missing : candidate.segment.uncoveredLines).join(", ");
      return [
        `That test passed but did not execute the lines it was written for. Still uncovered: ${list}.`,
        "",
        "Work out what input or setup actually reaches those lines (an error path, a guard clause, a branch) and drive the code down that path.",
        ONE_BLOCK,
      ].join("\n");
    }
    case "flaky":
      return [
        `That test passed once and then failed on a repeat run, so it is not deterministic. The failing run said:${errorBlock}`,
        "",
        "Remove the source of nondeterminism: ordering assumptions, shared mutable state left behind between runs, real time, randomness without a fixed seed.",
        ONE_BLOCK,
      ].join("\n");
    case "weak_assertions": {
      const survivors = result.mutation?.survivors ?? [];
      const list = survivors.map((s) => `- line ${s.line}: ${s.description}`).join("\n");
      return [
        "That test runs the lines it was written for, but it still passed after each of these changes was made to the code under test:",
        "",
        list.length > 0 ? list : "- (no detail recorded)",
        "",
        "So it executes those lines without checking what they do. Add assertions on the observable result of those lines: the returned value, the raised error, the record that was written, the collaborator that was called. Do not assert on internals the code does not expose.",
        ONE_BLOCK,
      ].join("\n");
    }
    case "declaration_snapshot":
      return [
        "That test never calls the code under test with an input. It describes what the module declares: a name, a type, the shape of a constant. None of that can regress.",
        "",
        "Pick one exported function or method from the segment, call it with a real argument, and assert on what comes back or on what it changed.",
        ONE_BLOCK,
      ].join("\n");
    case "os_specific":
      return [
        `That test only runs on one operating system. The rules said:${errorBlock}`,
        "",
        'The suite runs on a Linux runner and on a macOS runner, so anything that exists on one of them has to be guarded: wrap it in a platform check that skips, `if runtime.GOOS != "linux" { t.Skip("reason") }`, and put the skip before the setup it protects.',
        "Better still, drop the host dependency: files belong in t.TempDir(), environment variables in t.Setenv, and a path length belongs in a constant the code under test owns.",
        ONE_BLOCK,
      ].join("\n");
    case "tautological":
      return [
        `That test calls the code but every assertion passes no matter what the code does. The rules said:${errorBlock}`,
        "",
        "Matchers like toBeDefined, toBeTruthy, not.toThrow and a bare snapshot only prove the line ran. Assert the value itself: the number returned, the string built, the error raised, the record written.",
        ONE_BLOCK,
      ].join("\n");
    default:
      return ONE_BLOCK;
  }
}

function withReply<C extends RepairableCandidate>(candidate: C, userMessage: string, reply: string, code: string, previous: RepairableResult): C {
  const history: PromptMessage[] = [
    ...candidate.history,
    { role: "user", content: userMessage },
    { role: "assistant", content: reply },
  ];
  return {
    ...candidate,
    code,
    hash: hashCode(code),
    attempts: candidate.attempts + 1,
    lastError: previous.error,
    status: "generated",
    history,
  };
}

const unitAccepted = (candidate: Candidate, result: GateResult): Candidate => ({ ...candidate, status: "accepted", delta: result.delta });

/**
 * Repair until accepted or out of rounds. Returns the last candidate and verdict;
 * a candidate that never got accepted comes back with status "frozen".
 */
export async function repairLoop<C extends RepairableCandidate = Candidate, R extends RepairableResult = GateResult>(
  args: RepairArgs<C, R>,
): Promise<RepairOutcome<C, R>> {
  // The defaults are typed for the unit pipeline; a flow caller passes its own.
  const message = args.message ?? (repairMessage as unknown as (candidate: C, result: R) => string);
  const accept = args.accepted ?? (unitAccepted as unknown as (candidate: C, result: R) => C);
  const as = (status: string): C["status"] => status;
  let candidate = args.candidate;
  let result = args.gateResult;

  if (result.status === "accepted") {
    return { candidate: accept(candidate, result), result };
  }

  /** Each group of verdicts shares one repair round. */
  const groups = (args.sharedRounds ?? UNIT_SHARED_ROUNDS).map((g) => new Set(g));
  const used = groups.map(() => false);

  for (let round = 0; round < args.maxRounds; round += 1) {
    const group = groups.findIndex((g) => g.has(result.status));
    if (group !== -1) {
      if (used[group]) break;
      used[group] = true;
    }

    const userMessage = message(candidate, result);
    let reply: string;
    try {
      reply = await args.generator.continueChat(candidate.history, userMessage, candidate.system);
    } catch (err) {
      candidate = { ...candidate, status: as("frozen"), lastError: String(err instanceof Error ? err.message : err) };
      return { candidate, result };
    }

    let code: string;
    try {
      code = extractCode(reply);
    } catch (err) {
      candidate = {
        ...candidate,
        attempts: candidate.attempts + 1,
        status: as("frozen"),
        lastError: String(err instanceof Error ? err.message : err),
        history: [
          ...candidate.history,
          { role: "user", content: userMessage },
          { role: "assistant", content: reply },
        ],
      };
      return { candidate, result };
    }

    candidate = withReply(candidate, userMessage, reply, code, result);
    result = await args.evaluate(candidate);

    if (result.status === "accepted") {
      return { candidate: accept(candidate, result), result };
    }
    if (result.status === "rule_violation") {
      return { candidate: { ...candidate, status: as("rule_violation"), lastError: result.error }, result };
    }
    candidate = { ...candidate, status: as(result.status), lastError: result.error };
  }

  return { candidate: { ...candidate, status: as("frozen"), lastError: result.error }, result };
}

const SPEC_BLOCK = "Return the full corrected spec file in exactly one fenced code block, and nothing else.";

/** What exploreRepairMessage needs besides the verdict: the rule context the gate ran with, minus the base URL. */
export type ExploreRepairContext = Pick<RuleContext, "storageStateEnv" | "flow" | "flows" | "existing" | "acceptedThisRun"> & { baseUrl: string };

const listElements = (elements: readonly { role: string; name: string; route?: string }[]): string =>
  elements.length > 0 ? elements.map((e) => `- ${e.role} "${e.name}"${e.route ? ` on ${e.route}` : ""}`).join("\n") : "- (none)";

/**
 * The user turn for one repair round of an end to end spec. Every error it
 * quotes is already scrubbed of the base URL and the session path, and a rule
 * message names the shape found, never the matched text.
 */
export function exploreRepairMessage(candidate: FlowCandidate, result: FlowGateResult, ctx: ExploreRepairContext): string {
  const error = result.error?.trim();
  const errorBlock = error ? ["", "```", error, "```"].join("\n") : "";
  const at = result.line ? ` at line ${result.line}` : "";
  const counting = [...COUNTING_MATCHERS].join(", ");

  switch (result.status) {
    case "credential_in_spec":
      return [
        `That spec was refused before it was written: credential_in_spec${at}, ${error ?? "a credential-shaped value"}.`,
        "",
        `Remove it. Never put an email, password, cookie or token in the spec: the session comes from the storage state, read with test.use({ storageState: process.env.${ctx.storageStateEnv} }).`,
        SPEC_BLOCK,
      ].join("\n");
    case "off_site":
      return [
        `That spec was refused: off_site${at}. Navigate with relative paths only, page.goto("/path"), never an absolute URL or an environment variable, and assert URLs as relative paths or patterns.`,
        SPEC_BLOCK,
      ].join("\n");
    case "mutation_not_allowed": {
      const visited = new Set([ctx.flow.route, ...scanSpec({ path: "", text: candidate.code }, ctx.baseUrl).routes]);
      const offLimits = ctx.flows.filter((f) => visited.has(f.route) && !f.writable).flatMap((f) => f.elements.filter((e) => e.mutating).map((e) => ({ ...e, route: f.route })));
      return [
        `That spec was refused: mutation_not_allowed${at}. ${ctx.flow.route} is ${ctx.flow.writable ? "writable" : "read-only"}, and these elements write and are off limits:`,
        "",
        listElements(offLimits),
        "",
        "Use only elements that read: links, tabs, filters, menus that open.",
        SPEC_BLOCK,
      ].join("\n");
    }
    case "duplicate_flow": {
      const index = indexSpecs([...ctx.existing, ...ctx.acceptedThisRun], ctx.baseUrl);
      const addressed = ctx.flow.elements.filter((e) => index.addressesElement(e));
      const open = ctx.flow.targets.filter((e) => !index.addressesElement(e));
      return [
        `That spec was refused: duplicate_flow. Existing specs already address everything it does on ${ctx.flow.route}:`,
        "",
        listElements(addressed),
        "",
        "Cover one of the targets still open instead:",
        "",
        listElements(open),
        SPEC_BLOCK,
      ].join("\n");
    }
    case "no_assertion":
    case "action_removable": {
      const what =
        result.status === "action_removable" && result.verb
          ? `With its main action, the ${result.verb} on line ${result.line}, commented out, ${error?.includes("did not build") ? "the spec did not build, so the check could not tell whether it protects anything" : "the spec still passed, so it checks nothing that action does"}.`
          : `That spec asserts nothing a regression could break${at}: ${error ?? "no counting assertion after the first action"}.`;
      return [
        what,
        "",
        `After the action, assert its visible effect with one of ${counting}, or expect on the response's status or JSON. A title, expect(true), toBeDefined, or anything asserted before the action only proves the page loaded.`,
        SPEC_BLOCK,
      ].join("\n");
    }
    case "flaky":
      return [
        `That spec passed and then failed on a repeat run against the live target. The failing run said:${errorBlock}`,
        "",
        "Wait with web-first assertions (await expect(locator).toBeVisible(), toHaveURL, toHaveText) instead of timers, waitForTimeout or fixed sleeps, and do not depend on data a previous run left behind.",
        SPEC_BLOCK,
      ].join("\n");
    case "build_failed":
      return [`That spec did not build. The runner said:${errorBlock}`, "", `Fix the cause, not the symptom. ${SPEC_BLOCK}`].join("\n");
    case "test_failed":
      return [`That spec failed against the live target. The runner said:${errorBlock}`, "", "The site is correct; the spec's locators, waits or expectations are wrong. Fix them.", SPEC_BLOCK].join("\n");
    default:
      return SPEC_BLOCK;
  }
}
