/**
 * Anthropic calls for one candidate test.
 *
 * Caching is the whole point of the block split: the stable and semi-stable blocks
 * go into `system` with a cache breakpoint each, and only the volatile block rides
 * in the user message. Over one file that means the idiom pack and the source
 * listing are paid for once and read from cache for every later segment.
 *
 * Adaptive thinking is on. Every current model runs it, and `budget_tokens` is
 * rejected by the Opus 5 / Sonnet 5 family, so there is nothing to tune here.
 */

import { createHash, randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Candidate, PromptBlocks, PromptMessage, Segment } from "./types.js";

/**
 * Opus 5 for generation. Test writing is the reasoning-heavy half of this tool and
 * a rejected candidate costs a full runner invocation, so the cheaper model is a
 * false economy. config.ts defaults match (generator opus, repair sonnet).
 */
export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_MAX_TOKENS = 16384;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface GeneratorOptions {
  /** Injected in tests. Defaults to a client built from the ambient credentials. */
  client?: Anthropic;
  /** Explicit key. Falls back to the SDK default (ANTHROPIC_API_KEY in the environment). */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export interface Generator {
  generate(blocks: PromptBlocks, segment: Segment, specPath: string, wholeFile: boolean): Promise<Candidate>;
  /** Continue an existing candidate's chat, used by the repair loop. Returns raw reply text. */
  continueChat(
    history: PromptMessage[],
    userMessage: string,
    system?: Pick<PromptBlocks, "stable" | "semiStable">,
  ): Promise<string>;
  usage(): Usage;
}

/** Short, collision-tolerant id. Candidates are deduped by hash, not by id. */
export function shortId(): string {
  return randomBytes(4).toString("hex");
}

/** sha256 over the code with all whitespace collapsed, so reindenting is not a new candidate. */
export function hashCode(code: string): string {
  const normalized = code.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

const FENCE = /^[ \t]*```[^\n]*\n([\s\S]*?)\n?^[ \t]*```[ \t]*$/gm;

/**
 * Pull the single fenced block out of a reply. Throws when the model returned none
 * or more than one, which the repair loop treats as a failed round rather than
 * guessing which block was meant.
 */
export function extractCode(text: string): string {
  FENCE.lastIndex = 0;
  const blocks = [...text.matchAll(FENCE)].map((m) => m[1] ?? "");
  if (blocks.length === 0) {
    const head = text.replace(/\s+/g, " ").slice(0, 240);
    throw new Error(`no fenced code block in model reply. Reply began: ${head}`);
  }
  if (blocks.length > 1) throw new Error(`expected exactly one fenced code block, got ${blocks.length}`);
  return (blocks[0] ?? "").replace(/\s+$/, "");
}

/** Drop later candidates whose normalized code matches an earlier one. */
export function dedupeCandidates(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of list) {
    if (seen.has(candidate.hash)) continue;
    seen.add(candidate.hash);
    out.push(candidate);
  }
  return out;
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function createGenerator(opts: GeneratorOptions = {}): Generator {
  const client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : undefined);
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  function record(message: Anthropic.Message): void {
    totals.input += message.usage.input_tokens ?? 0;
    totals.output += message.usage.output_tokens ?? 0;
    totals.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    totals.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
  }

  async function ask(
    system: Anthropic.TextBlockParam[] | undefined,
    messages: Anthropic.MessageParam[],
  ): Promise<string> {
    const message = await client.messages.create({
      model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      ...(system ? { system } : {}),
      messages,
    });
    record(message);
    if (message.stop_reason === "max_tokens") {
      throw new Error(
        `model reply truncated at max_tokens=${maxTokens} (${message.usage.output_tokens} output tokens); raise anthropic.max_tokens`,
      );
    }
    return textOf(message);
  }

  function systemBlocks(blocks: Pick<PromptBlocks, "stable" | "semiStable">): Anthropic.TextBlockParam[] {
    return [
      { type: "text", text: blocks.stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: blocks.semiStable, cache_control: { type: "ephemeral" } },
    ];
  }

  return {
    async generate(blocks, segment, specPath, wholeFile) {
      const reply = await ask(systemBlocks(blocks), [{ role: "user", content: blocks.volatile }]);
      const code = extractCode(reply);
      return {
        id: shortId(),
        hash: hashCode(code),
        segment,
        specPath,
        code,
        wholeFile,
        status: "generated",
        attempts: 1,
        history: [
          { role: "user", content: blocks.volatile },
          { role: "assistant", content: reply },
        ],
        system: { stable: blocks.stable, semiStable: blocks.semiStable },
      };
    },

    async continueChat(history, userMessage, system) {
      const messages: Anthropic.MessageParam[] = [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: userMessage },
      ];
      return ask(system ? systemBlocks(system) : undefined, messages);
    },

    usage() {
      return { ...totals };
    },
  };
}
