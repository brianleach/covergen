import { describe, expect, it } from "bun:test";
import { slugify } from "../slugs.js";
import { padSlug } from "./pad.js";

describe("padSlug", () => {
  it("pads a slug to the width", () => {
    expect(padSlug(slugify("Hi There"), 10)).toBe("hi-there--");
  });
});
