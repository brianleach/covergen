/**
 * The local generator backend: a model served on an OpenAI-compatible chat
 * endpoint, Ollama's `/v1/chat/completions` being the one this is built for.
 *
 * Plain `fetch`, no client library. The prompt blocks are the ones src/prompt.ts
 * builds for every backend; the stable and semi-stable blocks go in as one system
 * message because there is no cache breakpoint to place on this path. Replies go
 * through the same `extractCode`, and usage is counted in the same `Usage` shape.
 * A local model has no API bill, so the pipeline prices these runs at zero.
 */

import { extractCode, hashCode, shortId, type Generator, type Usage } from "./generate.js";
import type { Candidate, PromptBlocks, PromptMessage } from "./types.js";

export interface OpenAICompatibleOptions {
  /** Endpoint root including the version prefix, e.g. http://localhost:11434/v1. */
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Sent with every request; servers that honor it make sampling repeatable. */
  seed?: number;
  /** Injected in tests so `npm test` never opens a socket. */
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 16384;

/** `base` with any trailing slash dropped and `path` appended. */
export function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** A failed request, with the status and the head of the body, never the prompt. */
async function failure(res: Response, url: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`${url} answered ${res.status}. Body began: ${body.replace(/\s+/g, " ").slice(0, 240)}`);
}

/** Wrap fetch so a timeout reads as one, not as a bare AbortError. */
async function call(doFetch: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new Error(`${url} did not answer within ${timeoutMs} ms`);
    throw new Error(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Check the endpoint answers and serves the configured model before a run spends
 * time on a baseline. Reads `/models`, which Ollama and the other common local
 * servers expose; a server that lists models without this one is a config error.
 */
export async function preflightOpenAICompatible(opts: OpenAICompatibleOptions): Promise<void> {
  const url = endpoint(opts.baseUrl, "/models");
  const res = await call(opts.fetch ?? fetch, url, { method: "GET" }, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000));
  if (!res.ok) throw await failure(res, url);
  const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  if (ids.length > 0 && !ids.includes(opts.model)) {
    throw new Error(`${url} does not serve model "${opts.model}". It serves: ${ids.slice(0, 10).join(", ")}`);
  }
}

export function createOpenAICompatibleGenerator(opts: OpenAICompatibleOptions): Generator {
  const doFetch = opts.fetch ?? fetch;
  const url = endpoint(opts.baseUrl, "/chat/completions");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  async function ask(messages: ChatMessage[]): Promise<string> {
    const body = {
      model: opts.model,
      messages,
      max_tokens: maxTokens,
      stream: false,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    };
    const res = await call(
      doFetch,
      url,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      timeoutMs,
    );
    if (!res.ok) throw await failure(res, url);
    const reply = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    totals.input += reply.usage?.prompt_tokens ?? 0;
    totals.output += reply.usage?.completion_tokens ?? 0;
    const choice = reply.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new Error(`model reply truncated at max_tokens=${maxTokens}; raise openai_compatible.max_tokens`);
    }
    const text = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
    if (!text) throw new Error(`${url} returned an empty completion`);
    return text;
  }

  function systemMessage(blocks: Pick<PromptBlocks, "stable" | "semiStable">): ChatMessage {
    return { role: "system", content: `${blocks.stable}\n\n${blocks.semiStable}` };
  }

  return {
    async generate(blocks, segment, specPath, wholeFile) {
      const reply = await ask([systemMessage(blocks), { role: "user", content: blocks.volatile }]);
      const code = extractCode(reply);
      const history: PromptMessage[] = [
        { role: "user", content: blocks.volatile },
        { role: "assistant", content: reply },
      ];
      return {
        id: shortId(),
        hash: hashCode(code),
        segment,
        specPath,
        code,
        wholeFile,
        status: "generated",
        attempts: 1,
        history,
        system: { stable: blocks.stable, semiStable: blocks.semiStable },
      } satisfies Candidate;
    },

    async continueChat(history, userMessage, system) {
      return ask([
        ...(system ? [systemMessage(system)] : []),
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userMessage },
      ]);
    },

    usage() {
      return { ...totals };
    },
  };
}
