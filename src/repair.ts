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
 */

import { extractCode, hashCode, type Generator } from "./generate.js";
import type { Candidate, GateResult, PromptMessage } from "./types.js";

export interface RepairArgs {
  candidate: Candidate;
  /** The verdict that sent this candidate here. */
  gateResult: GateResult;
  generator: Pick<Generator, "continueChat">;
  evaluate: (candidate: Candidate) => Promise<GateResult>;
  maxRounds: number;
}

export interface RepairOutcome {
  candidate: Candidate;
  result: GateResult;
}

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

function withReply(candidate: Candidate, userMessage: string, reply: string, code: string, previous: GateResult): Candidate {
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

/**
 * Repair until accepted or out of rounds. Returns the last candidate and verdict;
 * a candidate that never got accepted comes back with status "frozen".
 */
export async function repairLoop(args: RepairArgs): Promise<RepairOutcome> {
  let candidate = args.candidate;
  let result = args.gateResult;

  if (result.status === "accepted") {
    return { candidate: { ...candidate, status: "accepted", delta: result.delta }, result };
  }

  let flakyRoundsUsed = 0;
  let weakRoundsUsed = 0;
  /** The three "it does not check anything" verdicts, sharing one repair round. */
  const weakVerdicts = new Set(["weak_assertions", "tautological", "declaration_snapshot"]);

  for (let round = 0; round < args.maxRounds; round += 1) {
    if (result.status === "flaky") {
      if (flakyRoundsUsed >= 1) break;
      flakyRoundsUsed += 1;
    }
    if (weakVerdicts.has(result.status)) {
      if (weakRoundsUsed >= 1) break;
      weakRoundsUsed += 1;
    }

    const userMessage = repairMessage(candidate, result);
    let reply: string;
    try {
      reply = await args.generator.continueChat(candidate.history, userMessage, candidate.system);
    } catch (err) {
      candidate = { ...candidate, status: "frozen", lastError: String(err instanceof Error ? err.message : err) };
      return { candidate, result };
    }

    let code: string;
    try {
      code = extractCode(reply);
    } catch (err) {
      candidate = {
        ...candidate,
        attempts: candidate.attempts + 1,
        status: "frozen",
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
      return { candidate: { ...candidate, status: "accepted", delta: result.delta }, result };
    }
    if (result.status === "rule_violation") {
      return { candidate: { ...candidate, status: "rule_violation", lastError: result.error }, result };
    }
    candidate = { ...candidate, status: result.status, lastError: result.error };
  }

  return { candidate: { ...candidate, status: "frozen", lastError: result.error }, result };
}
