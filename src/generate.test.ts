import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createGenerator,
  DEFAULT_MODEL,
  dedupeCandidates,
  extractCode,
  hashCode,
  shortId,
} from "./generate.js";
import type { Candidate, PromptBlocks, Segment } from "./types.js";

const blocks: PromptBlocks = {
  stable: "STABLE idiom pack and rules",
  semiStable: "SEMI file under test",
  volatile: "VOLATILE segment and missing lines",
};

const segment: Segment = {
  path: "app/services/charger.rb",
  startLine: 1,
  endLine: 3,
  uncoveredLines: [2],
  text: "1 | def charge\n2 |   pay\n3 | end",
};

interface FakeCall {
  params: Anthropic.MessageCreateParams;
}

/**
 * Minimal stand-in for the SDK client. Only messages.create is used, and the tests
 * assert on the params it was handed, which is where the caching contract lives.
 */
function fakeClient(replies: string[], usages: Partial<Anthropic.Usage>[] = []) {
  const calls: FakeCall[] = [];
  let n = 0;
  const create = vi.fn(async (params: Anthropic.MessageCreateParams) => {
    calls.push({ params });
    const text = replies[n] ?? replies.at(-1) ?? "";
    const usage = usages[n] ?? {};
    n += 1;
    return {
      id: `msg_${n}`,
      type: "message",
      role: "assistant",
      model: DEFAULT_MODEL,
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text, citations: null },
      ],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    } as unknown as Anthropic.Message;
  });
  return { client: { messages: { create } } as unknown as Anthropic, calls, create };
}

const fenced = (code: string, lang = "ruby") => `Here you go:\n\n\`\`\`${lang}\n${code}\n\`\`\`\n`;

describe("extractCode", () => {
  it("pulls the single block and strips the fence and language tag", () => {
    expect(extractCode(fenced("it 'works' do\n  expect(1).to eq(1)\nend"))).toBe("it 'works' do\n  expect(1).to eq(1)\nend");
  });

  it("works with no language tag", () => {
    expect(extractCode("```\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("keeps nested indentation and blank lines inside the block", () => {
    expect(extractCode("```ts\nif (a) {\n\n  b();\n}\n```")).toBe("if (a) {\n\n  b();\n}");
  });

  it("throws when there is no block", () => {
    expect(() => extractCode("I could not write a test.")).toThrow(/no fenced code block/);
  });

  it("throws when there is more than one block", () => {
    expect(() => extractCode("```a\nx\n```\ntext\n```b\ny\n```")).toThrow(/exactly one fenced code block, got 2/);
  });
});

describe("hashCode", () => {
  it("is stable across whitespace changes", () => {
    expect(hashCode("a   b\n\tc")).toBe(hashCode("a b c"));
  });

  it("differs for different code", () => {
    expect(hashCode("expect(a).to eq(1)")).not.toBe(hashCode("expect(a).to eq(2)"));
  });

  it("returns a sha256 hex digest", () => {
    expect(hashCode("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("shortId", () => {
  it("is short and does not repeat in a small sample", () => {
    const ids = new Set(Array.from({ length: 200 }, () => shortId()));
    expect(ids.size).toBe(200);
    expect([...ids][0]).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("dedupeCandidates", () => {
  const make = (id: string, code: string): Candidate => ({
    id,
    hash: hashCode(code),
    segment,
    specPath: "spec/x_spec.rb",
    code,
    wholeFile: false,
    status: "generated",
    attempts: 1,
    history: [],
  });

  it("drops later duplicates and keeps the first", () => {
    const list = [make("a", "expect(1).to eq(1)"), make("b", "expect(1).to  eq(1)"), make("c", "expect(2).to eq(2)")];
    const out = dedupeCandidates(list);
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("is a no-op on an already unique list", () => {
    const list = [make("a", "x"), make("b", "y")];
    expect(dedupeCandidates(list)).toHaveLength(2);
  });

  it("handles an empty list", () => {
    expect(dedupeCandidates([])).toEqual([]);
  });
});

describe("createGenerator.generate", () => {
  it("sends stable and semi-stable as cached system blocks and volatile as the user message", async () => {
    const { client, calls } = fakeClient([fenced("it 'x' do\n  expect(1).to eq(1)\nend")]);
    const gen = createGenerator({ client, model: "claude-opus-5", maxTokens: 2048 });
    await gen.generate(blocks, segment, "spec/services/charger_spec.rb", false);

    const params = calls[0]!.params;
    expect(params.model).toBe("claude-opus-5");
    expect(params.max_tokens).toBe(2048);
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[0]).toMatchObject({ type: "text", text: blocks.stable, cache_control: { type: "ephemeral" } });
    expect(system[1]).toMatchObject({ type: "text", text: blocks.semiStable, cache_control: { type: "ephemeral" } });
    expect(params.messages).toEqual([{ role: "user", content: blocks.volatile }]);
  });

  it("uses adaptive thinking", async () => {
    const { client, calls } = fakeClient([fenced("it 'x' do\n  expect(1).to eq(1)\nend")]);
    await createGenerator({ client }).generate(blocks, segment, "spec/x_spec.rb", false);
    expect(calls[0]!.params.thinking).toEqual({ type: "adaptive" });
  });

  it("defaults to the opus generator model", async () => {
    const { client, calls } = fakeClient([fenced("it 'x' do\n  expect(1).to eq(1)\nend")]);
    await createGenerator({ client }).generate(blocks, segment, "spec/x_spec.rb", false);
    expect(calls[0]!.params.model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("claude-opus-5");
  });

  it("returns a candidate carrying the parsed code, hash and history", async () => {
    const code = "it 'x' do\n  expect(1).to eq(1)\nend";
    const reply = fenced(code);
    const { client } = fakeClient([reply]);
    const candidate = await createGenerator({ client }).generate(blocks, segment, "spec/x_spec.rb", true);

    expect(candidate.code).toBe(code);
    expect(candidate.hash).toBe(hashCode(code));
    expect(candidate.specPath).toBe("spec/x_spec.rb");
    expect(candidate.wholeFile).toBe(true);
    expect(candidate.status).toBe("generated");
    expect(candidate.attempts).toBe(1);
    expect(candidate.segment).toBe(segment);
    expect(candidate.history).toEqual([
      { role: "user", content: blocks.volatile },
      { role: "assistant", content: reply.trim() },
    ]);
  });

  it("propagates an unparseable reply as an error", async () => {
    const { client } = fakeClient(["no block here"]);
    await expect(createGenerator({ client }).generate(blocks, segment, "spec/x_spec.rb", false)).rejects.toThrow(
      /no fenced code block/,
    );
  });

  it("ignores non-text content blocks", async () => {
    const { client } = fakeClient([fenced("it 'x' do\n  expect(1).to eq(1)\nend")]);
    const candidate = await createGenerator({ client }).generate(blocks, segment, "spec/x_spec.rb", false);
    expect(candidate.code).not.toContain("thinking");
  });
});

describe("createGenerator.continueChat", () => {
  it("replays the history and appends the new user turn", async () => {
    const { client, calls } = fakeClient(["fixed"]);
    const gen = createGenerator({ client });
    const out = await gen.continueChat(
      [
        { role: "user", content: "first ask" },
        { role: "assistant", content: "first reply" },
      ],
      "it failed, fix it",
    );

    expect(out).toBe("fixed");
    expect(calls[0]!.params.messages).toEqual([
      { role: "user", content: "first ask" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "it failed, fix it" },
    ]);
    expect(calls[0]!.params.system).toBeUndefined();
  });
});

describe("createGenerator.usage", () => {
  it("starts at zero", () => {
    const { client } = fakeClient([]);
    expect(createGenerator({ client }).usage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("accumulates input, output and cache reads across calls", async () => {
    const reply = fenced("it 'x' do\n  expect(1).to eq(1)\nend");
    const { client } = fakeClient(
      [reply, reply],
      [
        { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
        { input_tokens: 5, output_tokens: 30, cache_read_input_tokens: 900 },
      ],
    );
    const gen = createGenerator({ client });
    await gen.generate(blocks, segment, "spec/x_spec.rb", false);
    await gen.generate(blocks, segment, "spec/x_spec.rb", false);
    expect(gen.usage()).toEqual({ input: 105, output: 50, cacheRead: 900, cacheWrite: 0 });
  });

  it("returns a copy, so a caller cannot mutate the running totals", async () => {
    const { client } = fakeClient([fenced("it 'x' do\n  expect(1).to eq(1)\nend")], [{ input_tokens: 7 }]);
    const gen = createGenerator({ client });
    await gen.generate(blocks, segment, "spec/x_spec.rb", false);
    const first = gen.usage();
    first.input = 999;
    expect(gen.usage().input).toBe(7);
  });
});

it("throws when the reply is truncated at max_tokens, naming the limit and output tokens", async () => {
  const { client, create } = fakeClient([]);
  create.mockResolvedValueOnce({
    id: "msg_trunc",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    stop_reason: "max_tokens",
    content: [{ type: "text", text: "```ts\nit('x', () => {", citations: null }],
    usage: { input_tokens: 10, output_tokens: 2048, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Message);
  const gen = createGenerator({ client, maxTokens: 2048 });

  await expect(gen.generate(blocks, segment, "spec/x_spec.rb", false)).rejects.toThrow(
    /truncated at max_tokens=2048 \(2048 output tokens\)/,
  );
  expect(gen.usage()).toEqual({ input: 10, output: 2048, cacheRead: 0, cacheWrite: 0 });
});
