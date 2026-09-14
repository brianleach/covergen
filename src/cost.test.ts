import { describe, expect, it } from "vitest";
import { DEFAULT_PRICE_PER_MTOK, costOf, formatUsd, priceFor, runCost, type Price } from "./cost.js";

const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
const flat: Price = { input: 10, output: 20, cache_read: 1, cache_write: 12.5 };

describe("priceFor", () => {
  it("prefers an exact model id", () => {
    expect(priceFor("claude-opus-5", DEFAULT_PRICE_PER_MTOK)).toEqual(DEFAULT_PRICE_PER_MTOK["claude-opus-5"]);
  });

  it("falls back to the longest key the id starts with, so a dated snapshot inherits its family", () => {
    const table = { "claude-opus": flat, "claude-opus-5": { ...flat, input: 5 } };
    expect(priceFor("claude-opus-5-20260101", table)?.input).toBe(5);
  });

  it("returns undefined rather than guessing at an unknown model", () => {
    expect(priceFor("some-other-model", DEFAULT_PRICE_PER_MTOK)).toBeUndefined();
  });
});

describe("costOf", () => {
  it("prices each token class per million", () => {
    expect(costOf(tokens, flat)).toBeCloseTo(10 + 20 + 1 + 12.5, 6);
  });

  it("is zero for a run that never called a model", () => {
    expect(costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, flat)).toBe(0);
  });
});

describe("runCost", () => {
  it("sums priced models and reports each one", () => {
    const cost = runCost(
      [
        { model: "a", tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
        { model: "b", tokens: { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
      { a: flat, b: flat },
    );
    expect(cost.usd).toBeCloseTo(15, 6);
    expect(cost.partial).toBe(false);
    expect(cost.byModel).toEqual([
      { model: "a", usd: 10 },
      { model: "b", usd: 5 },
    ]);
  });

  it("marks the total a floor when a model has no price", () => {
    const cost = runCost(
      [
        { model: "a", tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
        { model: "unknown", tokens: { input: 9_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
      { a: flat },
    );
    expect(cost.usd).toBeCloseTo(10, 6);
    expect(cost.partial).toBe(true);
    expect(cost.byModel[1]).toEqual({ model: "unknown" });
  });
});

describe("formatUsd", () => {
  it("keeps four decimals for a run too small to show in cents", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("uses cents for anything a reviewer will read", () => {
    expect(formatUsd(1.238)).toBe("$1.24");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
