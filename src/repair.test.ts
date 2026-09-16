import { describe, expect, it, vi } from "vitest";
import { hashCode } from "./generate.js";
import { repairLoop, repairMessage } from "./repair.js";
import type { Candidate, CoverageDelta, GateResult, RunResult } from "./types.js";

const segment = {
  path: "app/services/charger.rb",
  startLine: 10,
  endLine: 14,
  uncoveredLines: [11, 12, 13],
  text: "10 | def charge\n11 |   pay\n12 |   log\n13 | end",
};

function candidateFor(over: Partial<Candidate> = {}): Candidate {
  const code = "it 'charges' do\n  expect(subject.charge).to eq(:ok)\nend";
  return {
    id: "abcd1234",
    hash: hashCode(code),
    segment,
    specPath: "spec/services/charger_spec.rb",
    code,
    wholeFile: false,
    status: "generated",
    attempts: 1,
    history: [
      { role: "user", content: "original volatile block" },
      { role: "assistant", content: "```ruby\noriginal\n```" },
    ],
    ...over,
  };
}

const runs: RunResult[] = [{ ok: false, exitCode: 1, stdout: "", stderr: "", durationMs: 1 }];

const gate = (
  status: GateResult["status"],
  error?: string,
  delta?: CoverageDelta,
  mutation?: GateResult["mutation"],
): GateResult => ({
  status,
  runs,
  ...(error ? { error } : {}),
  ...(delta ? { delta } : {}),
  ...(mutation ? { mutation } : {}),
});

const weak = () =>
  gate("weak_assertions", "killed 0 of 2 mutants", undefined, {
    tried: 2,
    killed: 0,
    survivors: [
      { id: "m11-relational", line: 11, description: "relational: == to !=" },
      { id: "m12-boolean", line: 12, description: "boolean: true to false" },
    ],
  });

const fenced = (code: string) => `\`\`\`ruby\n${code}\n\`\`\``;

/** Scripted generator: one reply per repair round. */
function fakeGenerator(replies: string[]) {
  const asks: { history: Candidate["history"]; message: string }[] = [];
  let n = 0;
  const continueChat = vi.fn(async (history: Candidate["history"], message: string) => {
    asks.push({ history, message });
    const reply = replies[n] ?? replies.at(-1) ?? fenced("fallback");
    n += 1;
    return reply;
  });
  return { generator: { continueChat }, asks, continueChat };
}

/** Scripted gate: one verdict per evaluate call. */
function fakeEvaluate(verdicts: GateResult[]) {
  const seen: Candidate[] = [];
  let n = 0;
  const evaluate = vi.fn(async (candidate: Candidate) => {
    seen.push(candidate);
    const verdict = verdicts[n] ?? verdicts.at(-1) ?? gate("test_failed");
    n += 1;
    return verdict;
  });
  return { evaluate, seen };
}

const delta: CoverageDelta = {
  path: "app/services/charger.rb",
  newlyCovered: [11],
  lost: [],
  before: { covered: 0, total: 3 },
  after: { covered: 1, total: 3 },
};

describe("repairMessage", () => {
  it("sends the error tail and asks for one full block on build_failed", () => {
    const msg = repairMessage(candidateFor(), gate("build_failed", "SyntaxError: unexpected end"));
    expect(msg).toContain("did not build");
    expect(msg).toContain("SyntaxError: unexpected end");
    expect(msg).toContain("exactly one fenced code block");
  });

  it("says the test is wrong, not the code, on test_failed", () => {
    const msg = repairMessage(candidateFor(), gate("test_failed", "expected :ok, got :denied"));
    expect(msg).toContain("expected :ok, got :denied");
    expect(msg).toContain("The code under test is correct");
  });

  it("lists the still-uncovered lines on no_coverage_gain", () => {
    const msg = repairMessage(candidateFor(), gate("no_coverage_gain", "covered no new lines", delta));
    expect(msg).toContain("Still uncovered: 12, 13");
    expect(msg).not.toContain("Still uncovered: 11");
  });

  it("falls back to every uncovered line when the delta covered nothing", () => {
    const msg = repairMessage(candidateFor(), gate("no_coverage_gain", "covered no new lines"));
    expect(msg).toContain("Still uncovered: 11, 12, 13");
  });

  it("lists the surviving mutations and asks for real assertions on weak_assertions", () => {
    const msg = repairMessage(candidateFor(), weak());
    expect(msg).toContain("it still passed after each of these changes");
    expect(msg).toContain("- line 11: relational: == to !=");
    expect(msg).toContain("- line 12: boolean: true to false");
    expect(msg.toLowerCase()).toContain("add assertions on the observable result");
    expect(msg).not.toContain("\u2014");
  });

  it("asks for determinism on flaky", () => {
    const msg = repairMessage(candidateFor(), gate("flaky", "random order failure"));
    expect(msg).toContain("not deterministic");
    expect(msg).toContain("random order failure");
  });

  it("asks for a real call on declaration_snapshot and for a real assertion on tautological", () => {
    const declaration = repairMessage(candidateFor(), gate("declaration_snapshot", "behavioral-evidence: never calls the code"));
    expect(declaration).toContain("never calls the code under test with an input");
    expect(declaration).toContain("call it with a real argument");

    const tautological = repairMessage(candidateFor(), gate("tautological", "every assertion is a weak matcher (toBeDefined)"));
    expect(tautological).toContain("every assertion is a weak matcher (toBeDefined)");
    expect(tautological).toContain("toBeDefined");
    expect(tautological).toContain("Assert the value itself");
  });

  it("names the guard on os_specific", () => {
    const msg = repairMessage(candidateFor(), gate("os_specific", "no-os-specific: reads a /proc or /sys path"));
    expect(msg).toContain("reads a /proc or /sys path");
    expect(msg).toContain('if runtime.GOOS != "linux" { t.Skip("reason") }');
    expect(msg).toContain("t.TempDir()");
    expect(msg).not.toContain("\u2014");
  });
});

describe("repairLoop", () => {
  it("returns immediately when the candidate was already accepted", async () => {
    const { generator, continueChat } = fakeGenerator([]);
    const { evaluate } = fakeEvaluate([]);
    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("accepted", undefined, delta),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(out.candidate.status).toBe("accepted");
    expect(out.candidate.delta).toBe(delta);
    expect(continueChat).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("repairs a build failure in one round and accepts", async () => {
    const fixed = "it 'charges' do\n  expect(subject.charge).to eq(:paid)\nend";
    const { generator, asks } = fakeGenerator([fenced(fixed)]);
    const { evaluate, seen } = fakeEvaluate([gate("accepted", undefined, delta)]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("build_failed", "SyntaxError"),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(out.result.status).toBe("accepted");
    expect(out.candidate.status).toBe("accepted");
    expect(out.candidate.code).toBe(fixed);
    expect(out.candidate.hash).toBe(hashCode(fixed));
    expect(out.candidate.attempts).toBe(2);
    expect(out.candidate.lastError).toBe("SyntaxError");
    expect(seen).toHaveLength(1);
    expect(asks[0]!.message).toContain("SyntaxError");
  });

  it("extends the history with the repair turn and replays it on the next round", async () => {
    const { generator, asks } = fakeGenerator([fenced("one"), fenced("two")]);
    const { evaluate } = fakeEvaluate([gate("test_failed", "still red"), gate("accepted", undefined, delta)]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("test_failed", "first failure"),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(asks[0]!.history).toHaveLength(2);
    expect(asks[1]!.history).toHaveLength(4);
    expect(asks[1]!.history[3]).toEqual({ role: "assistant", content: fenced("one") });
    expect(asks[1]!.message).toContain("still red");
    expect(out.candidate.history).toHaveLength(6);
    expect(out.candidate.attempts).toBe(3);
  });

  it("freezes after maxRounds without an acceptance", async () => {
    const { generator, continueChat } = fakeGenerator([fenced("a"), fenced("b"), fenced("c"), fenced("d")]);
    const { evaluate } = fakeEvaluate([gate("test_failed", "1"), gate("test_failed", "2")]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("test_failed", "0"),
      generator,
      evaluate,
      maxRounds: 2,
    });

    expect(out.candidate.status).toBe("frozen");
    expect(continueChat).toHaveBeenCalledTimes(2);
    expect(out.candidate.attempts).toBe(3);
  });

  it("does not repair at all when maxRounds is zero", async () => {
    const { generator, continueChat } = fakeGenerator([fenced("a")]);
    const { evaluate } = fakeEvaluate([]);
    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("test_failed", "boom"),
      generator,
      evaluate,
      maxRounds: 0,
    });

    expect(continueChat).not.toHaveBeenCalled();
    expect(out.candidate.status).toBe("frozen");
    expect(out.candidate.lastError).toBe("boom");
  });

  it("gives flaky exactly one round, then freezes", async () => {
    const { generator, continueChat } = fakeGenerator([fenced("a"), fenced("b"), fenced("c")]);
    const { evaluate } = fakeEvaluate([gate("flaky", "failed on run 2")]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("flaky", "failed on run 1"),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(continueChat).toHaveBeenCalledTimes(1);
    expect(out.candidate.status).toBe("frozen");
    expect(out.result.status).toBe("flaky");
  });

  it("gives weak_assertions exactly one round, then freezes", async () => {
    const { generator, continueChat } = fakeGenerator([fenced("a"), fenced("b"), fenced("c")]);
    const { evaluate } = fakeEvaluate([weak()]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: weak(),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(continueChat).toHaveBeenCalledTimes(1);
    expect(out.candidate.status).toBe("frozen");
    expect(out.result.status).toBe("weak_assertions");
  });

  it("repairs a weak_assertions candidate that comes back accepted", async () => {
    const { generator, continueChat } = fakeGenerator([fenced("stronger")]);
    const { evaluate } = fakeEvaluate([gate("accepted", undefined, delta)]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: weak(),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(continueChat).toHaveBeenCalledTimes(1);
    expect(out.candidate.status).toBe("accepted");
    expect(out.candidate.code).toBe("stronger");
  });

  it("stops immediately when repaired code violates a rule", async () => {
    const { generator, continueChat } = fakeGenerator([fenced("sleep(1)")]);
    const violation: GateResult = { status: "rule_violation", runs: [], error: "no-sleep: uses sleep" };
    const { evaluate } = fakeEvaluate([violation, gate("accepted", undefined, delta)]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("test_failed", "red"),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(out.candidate.status).toBe("rule_violation");
    expect(out.candidate.lastError).toContain("uses sleep");
    expect(continueChat).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("still repairs a non-flaky failure that follows a flaky round", async () => {
    const { generator, continueChat } = fakeGenerator([fenced("a"), fenced("b")]);
    const { evaluate } = fakeEvaluate([gate("test_failed", "red"), gate("accepted", undefined, delta)]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("flaky", "nondeterministic"),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(continueChat).toHaveBeenCalledTimes(2);
    expect(out.candidate.status).toBe("accepted");
  });

  it("freezes when the model reply has no single fenced block", async () => {
    const { generator } = fakeGenerator(["I am not sure how to fix this."]);
    const { evaluate } = fakeEvaluate([]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("build_failed", "SyntaxError"),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(out.candidate.status).toBe("frozen");
    expect(out.candidate.lastError).toMatch(/no fenced code block/);
    expect(evaluate).not.toHaveBeenCalled();
    expect(out.candidate.history).toHaveLength(4);
  });

  it("freezes when the generator itself throws", async () => {
    const generator = {
      continueChat: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    };
    const { evaluate } = fakeEvaluate([]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("test_failed", "red"),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(out.candidate.status).toBe("frozen");
    expect(out.candidate.lastError).toBe("rate limited");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("carries the coverage delta through on an acceptance after repair", async () => {
    const { generator } = fakeGenerator([fenced("a")]);
    const { evaluate } = fakeEvaluate([gate("accepted", undefined, delta)]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("no_coverage_gain", "covered no new lines"),
      generator,
      evaluate,
      maxRounds: 3,
    });

    expect(out.candidate.delta).toBe(delta);
    expect(out.result.delta).toBe(delta);
  });

  it("shares one repair round across the three assertion verdicts", async () => {
    const { generator, continueChat } = fakeGenerator([fenced("a"), fenced("b"), fenced("c")]);
    const { evaluate } = fakeEvaluate([gate("tautological", "weak matchers"), weak()]);

    const out = await repairLoop({
      candidate: candidateFor(),
      gateResult: gate("declaration_snapshot", "no call into the code"),
      generator,
      evaluate,
      maxRounds: 3,
    });

    // One round for the whole family: a candidate that comes back still not
    // checking anything is frozen rather than paid for twice.
    expect(continueChat).toHaveBeenCalledTimes(1);
    expect(out.candidate.status).toBe("frozen");
    expect(out.result.status).toBe("tautological");
  });
});

  it("falls back to the one-block instruction for a status with no tailored message", () => {
    const msg = repairMessage(candidateFor(), gate("rule_violation", "no-sleep: uses sleep"));
    expect(msg).toBe("Return the full corrected test in exactly one fenced code block, and nothing else.");
    expect(msg).not.toContain("no-sleep: uses sleep");
  });
