import { describe, expect, it } from "vitest";
import { createOpenAICompatibleGenerator, endpoint, preflightOpenAICompatible } from "./openai-compatible.js";
import type { PromptBlocks, Segment } from "./types.js";

const blocks: PromptBlocks = { stable: "STABLE rules", semiStable: "SEMI file under test", volatile: "VOLATILE segment" };
const segment: Segment = { path: "src/add.ts", startLine: 1, endLine: 3, uncoveredLines: [2], text: "2 |   return a + b;" };
const fenced = (code: string): string => ["```ts", code, "```"].join("\n");

interface Seen { url: string; init: RequestInit; body: Record<string, unknown> }

/** A fetch that never opens a socket: one canned response per call, requests recorded. */
function stubFetch(responses: Array<() => Response | Promise<Response>>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let n = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {}, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const make = responses[n] ?? responses.at(-1);
    n += 1;
    if (!make) throw new Error("no stub response");
    return make();
  }) as typeof fetch;
  return { fetch: fn, seen };
}

const completion = (content: unknown, extra: Record<string, unknown> = {}): Response =>
  Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
    ...extra,
  });

const opts = { baseUrl: "http://localhost:11434/v1/", model: "local-coder", seed: 7 };

describe("createOpenAICompatibleGenerator", () => {
  it("posts the prompt blocks as one chat request and parses the fenced reply", async () => {
    const { fetch, seen } = stubFetch([() => completion(`Here it is.\n${fenced("it('adds', () => {})")}`)]);
    const gen = createOpenAICompatibleGenerator({ ...opts, maxTokens: 512, fetch });
    const candidate = await gen.generate(blocks, segment, "src/add.test.ts", false);

    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(req.init.method).toBe("POST");
    expect(req.body).toEqual({
      model: "local-coder",
      max_tokens: 512,
      stream: false,
      seed: 7,
      messages: [
        { role: "system", content: "STABLE rules\n\nSEMI file under test" },
        { role: "user", content: "VOLATILE segment" },
      ],
    });
    expect(candidate.code).toBe("it('adds', () => {})");
    expect(candidate.status).toBe("generated");
    expect(candidate.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(gen.usage()).toEqual({ input: 120, output: 30, cacheRead: 0, cacheWrite: 0 });
  });

  it("continues a chat with the history and the system blocks", async () => {
    const { fetch, seen } = stubFetch([() => completion("fixed")]);
    const gen = createOpenAICompatibleGenerator({ ...opts, fetch });
    const text = await gen.continueChat([{ role: "user", content: "u1" }, { role: "assistant", content: "a1" }], "it failed", blocks);
    expect(text).toBe("fixed");
    expect((seen[0]!.body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("names the status and the body head on a non-200 response", async () => {
    const { fetch } = stubFetch([() => new Response("model 'local-coder' not found", { status: 404 })]);
    const gen = createOpenAICompatibleGenerator({ ...opts, fetch });
    await expect(gen.generate(blocks, segment, "x.test.ts", false)).rejects.toThrow(/answered 404.*not found/);
  });

  it("rejects an empty completion and a reply with no code block", async () => {
    const { fetch } = stubFetch([() => completion(""), () => completion(null), () => completion("no code here")]);
    const gen = createOpenAICompatibleGenerator({ ...opts, fetch });
    await expect(gen.generate(blocks, segment, "x.test.ts", false)).rejects.toThrow(/empty completion/);
    await expect(gen.generate(blocks, segment, "x.test.ts", false)).rejects.toThrow(/empty completion/);
    await expect(gen.generate(blocks, segment, "x.test.ts", false)).rejects.toThrow(/no fenced code block/);
  });

  it("treats a truncated reply as an error", async () => {
    const { fetch } = stubFetch([
      () => Response.json({ choices: [{ message: { content: "```ts\nit(" }, finish_reason: "length" }] }),
    ]);
    const gen = createOpenAICompatibleGenerator({ ...opts, fetch });
    await expect(gen.generate(blocks, segment, "x.test.ts", false)).rejects.toThrow(/truncated/);
  });

  it("times out a request that never answers", async () => {
    const hang = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const gen = createOpenAICompatibleGenerator({ ...opts, timeoutMs: 20, fetch: hang });
    await expect(gen.generate(blocks, segment, "x.test.ts", false)).rejects.toThrow(/did not answer within 20 ms/);
  });
});

describe("preflightOpenAICompatible", () => {
  it("passes when the model is listed and fails when it is not", async () => {
    const listed = stubFetch([() => Response.json({ data: [{ id: "local-coder" }] })]);
    await expect(preflightOpenAICompatible({ ...opts, fetch: listed.fetch })).resolves.toBeUndefined();
    expect(listed.seen[0]!.url).toBe("http://localhost:11434/v1/models");
    const other = stubFetch([() => Response.json({ data: [{ id: "something-else" }] })]);
    await expect(preflightOpenAICompatible({ ...opts, fetch: other.fetch })).rejects.toThrow(/does not serve model "local-coder"/);
  });

  it("reports an unreachable endpoint", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(preflightOpenAICompatible({ ...opts, fetch: down })).rejects.toThrow(/could not reach .*fetch failed/);
  });
});

describe("endpoint", () => {
  it("joins without doubling slashes", () => {
    expect(endpoint("http://h:1/v1///", "/models")).toBe("http://h:1/v1/models");
  });
});
