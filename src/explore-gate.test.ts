import { describe, expect, it } from "vitest";
import { scrubEnvValues } from "./explore-gate.js";

describe("scrubEnvValues", () => {
  it("replaces each value, longest first, with or without a trailing slash", () => {
    const values = { BASE_URL: "https://app.example.test/", BASE_PATH: "https://app.example.test/sub", STATE: undefined };
    expect(scrubEnvValues("a https://app.example.test/sub/x b https://app.example.test c", values)).toBe("a ${BASE_PATH}/x b ${BASE_URL} c");
    expect(scrubEnvValues("nothing here", { EMPTY: "" })).toBe("nothing here");
  });
});
