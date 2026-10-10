import { describe, expect, it } from "vitest";
import { upper } from "../src/strings";
import { add, sub } from "../src/math.js";
describe("math", () => {
  it("adds and subtracts", () => expect(upper(String(add(1, sub(3, 2))))).toBe("2"));
});
