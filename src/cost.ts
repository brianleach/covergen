/**
 * Dollar cost of a run. covergen reported tokens but never money, so no run
 * could be judged against a spend guard. Prices are dollars per million tokens
 * and every one of them is overridable from covergen.yaml, because a shipped
 * table goes stale the moment a price changes.
 *
 * Cache prices follow the published multipliers on the input price: a 5 minute
 * cache write costs 1.25x input, a cache read 0.1x input.
 */

import type { ModelCost, RunCost, RunSummary } from "./types.js";

export interface Price {
  /** Dollars per million input tokens. */
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

const derived = (input: number, output: number): Price => ({
  input,
  output,
  cache_read: input * 0.1,
  cache_write: input * 1.25,
});

/**
 * Defaults for the models covergen ships with. A model that is not listed is
 * reported as unpriced rather than guessed at; add it under `price_per_mtok`.
 */
export const DEFAULT_PRICE_PER_MTOK: Record<string, Price> = {
  "claude-opus-5": derived(5, 25),
  "claude-sonnet-5": derived(2, 10),
  "claude-haiku-4-5": derived(1, 5),
};

/**
 * Price for a model id. Exact match first, then the longest configured key that
 * the id starts with, so a dated snapshot inherits its family's price.
 */
export function priceFor(model: string, table: Record<string, Price>): Price | undefined {
  const exact = table[model];
  if (exact) return exact;
  let best: { key: string; price: Price } | undefined;
  for (const [key, price] of Object.entries(table)) {
    if (!model.startsWith(key)) continue;
    if (!best || key.length > best.key.length) best = { key, price };
  }
  return best?.price;
}

/** Dollars for one model's token counts. */
export function costOf(tokens: RunSummary["tokens"], price: Price): number {
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cache_read +
      tokens.cacheWrite * price.cache_write) /
    1_000_000
  );
}

/**
 * Fold per-model token counts into a run cost. Models with no price entry are
 * listed with no dollars and flip `partial`, so a reader knows the total is a
 * floor rather than the answer.
 */
export function runCost(usage: Array<{ model: string; tokens: RunSummary["tokens"] }>, table: Record<string, Price>): RunCost {
  const byModel: ModelCost[] = [];
  let usd = 0;
  let partial = false;
  for (const entry of usage) {
    const price = priceFor(entry.model, table);
    if (!price) {
      partial = true;
      byModel.push({ model: entry.model });
      continue;
    }
    const amount = costOf(entry.tokens, price);
    usd += amount;
    byModel.push({ model: entry.model, usd: amount });
  }
  return { usd, byModel, partial };
}

/** "$1.23" for anything a reviewer will read, "$0.0042" for the small runs. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
