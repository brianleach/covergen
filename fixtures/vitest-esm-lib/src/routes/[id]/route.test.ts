import { describe, expect, it } from "vitest";
import { routeLabel } from "./route.js";

describe("routeLabel", () => {
  it("labels an item by id", () => {
    expect(routeLabel("42")).toBe("item:42");
  });
});
