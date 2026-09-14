import { describe, expect, it } from "vitest";
import { applyRate } from "./rates.js";

describe("applyRate", () => {
  it("adds the rate and rounds", () => {
    expect(applyRate(100, 0.1)).toBe(110);
  });
});
