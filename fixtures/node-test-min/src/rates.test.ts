import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyRate } from "./rates.js";

describe("applyRate", () => {
  it("adds the rate and rounds", () => {
    assert.equal(applyRate(100, 0.1), 110);
  });
});
