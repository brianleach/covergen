import { expect, test } from "vitest";
import * as core from "@mini/core";
test("namespace members follow re-exports through a nested barrel", () => {
  expect(core.deep + core.deeper + core.sum([1])).toBe(4);
});
