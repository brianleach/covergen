import { describe, expect, it } from "vitest";
import { limitNote } from "./limits.js";

describe("limitNote", () => {
  it("describes the time ceiling when the minutes limit stopped the run", () => {
    const note = limitNote("minutes");

    expect(note).toBe(
      "Stopped early: the run-wide time ceiling was reached, so the remaining targets and repos were skipped.",
    );
    expect(note).not.toBe(limitNote("tokens"));
  });
});
