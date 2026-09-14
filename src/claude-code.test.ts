import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { childEnv, createClaudeCodeGenerator, parseReply, preflightClaudeCode, type ClaudeExec } from "./claude-code.js";
import type { PromptBlocks, Segment } from "./types.js";

const blocks: PromptBlocks = {
  stable: "STABLE idioms and rules",
  semiStable: "SEMI file under test",
  volatile: "VOLATILE segment and missing lines",
};

const segment: Segment = {
  path: "src/add.ts",
  startLine: 1,
  endLine: 3,
  uncoveredLines: [2],
  text: "1 | export function add(a, b) {\n2 |   return a + b;\n3 | }",
};

/** `system` is the contents of the file the child was pointed at. */
interface Call { args: string[]; stdin?: string; system?: string }

type Reply = { text: string; session?: string; usage?: Record<string, number>; code?: number; raw?: string };

/** A `claude` that never runs: replies handed back in order, calls recorded. */
function fakeClaude(replies: Reply[]): { exec: ClaudeExec; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const exec: ClaudeExec = async (args, stdin) => {
    const file = args[args.indexOf("--system-prompt-file") + 1];
    calls.push({ args, stdin, system: args.includes("--system-prompt-file") ? readFileSync(file as string, "utf8") : undefined });
    const reply = replies[n] ?? replies.at(-1) ?? { text: "" };
    n += 1;
    if (reply.raw !== undefined) return { code: reply.code ?? 0, stdout: reply.raw, stderr: "" };
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...reply.usage };
    const body = { type: "result", is_error: false, session_id: reply.session ?? "sess-1", result: reply.text, usage };
    return { code: reply.code ?? 0, stdout: JSON.stringify(body), stderr: "" };
  };
  return { exec, calls };
}

const fenced = (code: string): string => ["```ts", code, "```"].join("\n");

describe("parseReply", () => {
  it("reads text, session and usage from a recorded real response", () => {
    const raw = readFileSync(new URL("../fixtures/claude-code/single-turn-result.json", import.meta.url), "utf8");
    const reply = parseReply(raw);
    expect(reply.sessionId).toBe("a9e33cf0-876c-4863-bed1-144711701b95");
    expect(reply.text).toContain("describe('add'");
    expect(reply.usage).toEqual({ input: 2, output: 89, cacheRead: 0, cacheWrite: 538 });
  });

  it("throws on output that is not JSON, and on a run that reported an error", () => {
    expect(() => parseReply("Invalid API key\n")).toThrow(/did not return JSON.*Invalid API key/s);
    expect(() => parseReply(JSON.stringify({ is_error: true, result: "usage limit reached" }))).toThrow(/usage limit reached/);
  });
});

describe("childEnv", () => {
  it("strips the nesting guards and any ambient API key", () => {
    const env = childEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "sk-live" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("createClaudeCodeGenerator", () => {
  it("runs one headless turn with no tools, the blocks in a system file and the segment on stdin", async () => {
    const { exec, calls } = fakeClaude([{ text: fenced("expect(add(1, 2)).toBe(3);"), usage: { input_tokens: 7, output_tokens: 11 } }]);
    const generator = createClaudeCodeGenerator({ exec, model: "claude-opus-5" });

    const candidate = await generator.generate(blocks, segment, "src/add.test.ts", true);

    expect(candidate.code).toBe("expect(add(1, 2)).toBe(3);");
    expect(candidate.history).toHaveLength(2);
    expect(candidate.system).toEqual({ stable: blocks.stable, semiStable: blocks.semiStable });
    const call = calls[0]!;
    expect(call.stdin).toBe(blocks.volatile);
    expect(call.system).toBe(`${blocks.stable}\n\n${blocks.semiStable}`);
    expect(call.args.join(" ")).toContain("-p --output-format json --model claude-opus-5");
    expect(call.args.join(" ")).toContain("--strict-mcp-config --disable-slash-commands --setting-sources  --tools");
    expect(call.args).not.toContain("--resume");
    expect(generator.usage()).toEqual({ input: 7, output: 11, cacheRead: 0, cacheWrite: 0 });
  });

  it("repairs by resuming the session the candidate was generated in", async () => {
    const { exec, calls } = fakeClaude([
      { text: fenced("first"), session: "sess-abc" },
      { text: fenced("second"), session: "sess-abc" },
    ]);
    const generator = createClaudeCodeGenerator({ exec });

    const candidate = await generator.generate(blocks, segment, "src/add.test.ts", true);
    const reply = await generator.continueChat(candidate.history, "That test failed.", candidate.system);

    expect(reply).toContain("second");
    const repair = calls[1]!;
    expect(repair.args[repair.args.indexOf("--resume") + 1]).toBe("sess-abc");
    expect(repair.stdin).toBe("That test failed.");
  });

  it("replays the whole conversation when no session id is known for it", async () => {
    const { exec, calls } = fakeClaude([{ text: fenced("recovered") }]);
    const history = [
      { role: "user" as const, content: "first ask" },
      { role: "assistant" as const, content: "first answer" },
    ];

    await createClaudeCodeGenerator({ exec }).continueChat(history, "now fix it");

    expect(calls[0]!.args).not.toContain("--resume");
    expect(calls[0]!.stdin).toContain("first ask");
    expect(calls[0]!.stdin).toContain("first answer");
    expect(calls[0]!.stdin).toContain("now fix it");
  });

  it("refuses to call again once the token ceiling is spent", async () => {
    const { exec, calls } = fakeClaude([{ text: fenced("one"), usage: { input_tokens: 40, output_tokens: 60 } }]);
    const generator = createClaudeCodeGenerator({ exec, maxTokensPerSweep: 100 });

    await generator.generate(blocks, segment, "src/add.test.ts", true);
    await expect(generator.generate(blocks, segment, "src/add.test.ts", true)).rejects.toThrow(/token ceiling reached: 100 of 100/);
    expect(calls).toHaveLength(1);
  });

  it("reports the output tail when the binary exits nonzero without JSON", async () => {
    const { exec } = fakeClaude([{ text: "", raw: "boom\n", code: 1 }]);
    await expect(createClaudeCodeGenerator({ exec }).generate(blocks, segment, "s.test.ts", true)).rejects.toThrow(/claude exited 1/);
  });
});

describe("preflightClaudeCode", () => {
  it("passes and names the login kind", async () => {
    const status = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "someone@example.com" };
    const exec = vi.fn<ClaudeExec>(async () => ({ code: 0, stdout: JSON.stringify(status), stderr: "" }));
    await expect(preflightClaudeCode(exec)).resolves.toBe("claude.ai (max)");
    expect(exec).toHaveBeenCalledWith(["auth", "status", "--json"]);
  });

  it("fails with a fix when the binary is missing", async () => {
    const exec: ClaudeExec = async () => ({ code: 127, stdout: "", stderr: "spawn claude ENOENT" });
    await expect(preflightClaudeCode(exec)).rejects.toThrow(/needs the claude binary on PATH.*COVERGEN_GENERATOR=api/s);
  });

  it("fails with a fix when nobody is logged in", async () => {
    const exec: ClaudeExec = async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: "" });
    await expect(preflightClaudeCode(exec)).rejects.toThrow(/claude auth login.*COVERGEN_GENERATOR=api/s);
  });

  it("fails when the status output cannot be read", async () => {
    const exec: ClaudeExec = async () => ({ code: 1, stdout: "", stderr: "" });
    await expect(preflightClaudeCode(exec)).rejects.toThrow(/could not read/);
  });
});

  it("pipes stdin to the spawned child and collects its stdout, stderr and exit code", async () => {
    const { claudeExec } = await import("./claude-code.js");
    const script =
      'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{process.stdout.write(s.toUpperCase());process.stderr.write("warned");process.exitCode=3;});';

    const res = await claudeExec(process.execPath, process.cwd(), 60_000)(["-e", script], "hello");

    expect(res).toEqual({ code: 3, stdout: "HELLO", stderr: "warned" });
  });

  it("reports exit code 1 when the child dies from a signal and has no exit code", async () => {
    const { claudeExec } = await import("./claude-code.js");
    const script = 'process.stdout.write("partial");process.stdout.once("drain",()=>{});setImmediate(()=>process.kill(process.pid,"SIGKILL"));';

    const res = await claudeExec(process.execPath, process.cwd(), 60_000)(["-e", script]);

    expect(res.code).toBe(1);
    expect(res.stderr).toBe("");
  });

  it("resolves with code 127 and the spawn error when the binary is missing", async () => {
    const { claudeExec } = await import("./claude-code.js");

    const res = await claudeExec("covergen-no-such-binary-xyz", process.cwd(), 60_000)(["auth", "status", "--json"]);

    expect(res.code).toBe(127);
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(/ENOENT/);
  });
