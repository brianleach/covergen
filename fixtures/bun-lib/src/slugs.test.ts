import { describe, expect, it } from "bun:test";
import { slugify } from "./slugs.js";

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("  Hello World  ")).toBe("hello-world");
  });
});
