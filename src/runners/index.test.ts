import { describe, expect, it } from "vitest";
import type { RunnerName } from "../types.js";
import { getRunner } from "./index.js";

const names: RunnerName[] = ["rspec", "vitest", "bun", "jest"];

describe("getRunner", () => {
  it.each(names)("returns the %s runner with a matching name", (name) => {
    expect(getRunner(name).name).toBe(name);
  });

  it("returns the same instance on repeat lookups", () => {
    expect(getRunner("vitest")).toBe(getRunner("vitest"));
  });

  it("exposes the full Runner surface for every runner", () => {
    for (const name of names) {
      const runner = getRunner(name);
      expect(typeof runner.preflight).toBe("function");
      expect(typeof runner.run).toBe("function");
      expect(typeof runner.specPathFor).toBe("function");
    }
  });

  it("throws with the known names for an unknown runner", () => {
    expect(() => getRunner("mocha" as RunnerName)).toThrow(/Unknown runner "mocha"[\s\S]*rspec/);
  });
});
