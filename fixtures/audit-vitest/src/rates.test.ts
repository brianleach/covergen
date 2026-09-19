/**
 * One spec file with one case of each shape the audit has a verdict for. The
 * comments say what the audit is expected to report, and src/audit.test.ts and
 * the command itself are what prove it.
 */

import { describe, expect, it } from "vitest";
import * as rates from "./rates.js";
import { applyRate, tierFor } from "./rates.js";

describe("rates", () => {
  // keeps: calls the code and checks what came back.
  it("adds the rate and rounds", () => {
    expect(applyRate(100, 0.1)).toBe(110);
  });

  // redundant: same lines as the case above, and it asserts on an input, so no
  // planted bug in applyRate can make it fail.
  it("leaves its arguments alone", () => {
    const amount = 100;
    applyRate(amount, 0.1);
    expect(amount).toBe(100);
  });

  // weak_static and weak_dynamic: runs tierFor, then asserts a literal.
  it("handles a high amount", () => {
    tierFor(5000);
    expect(true).toBe(true);
  });

  // weak_static: pins what the module declares without ever calling it.
  it("exports the rate helpers", () => {
    expect(Object.keys(rates).sort()).toEqual(["applyRate", "tierFor"]);
  });
});
