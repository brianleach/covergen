import { expect, test } from "vitest";
import {
  // adders, then the rest
  addAll,
  hello,
  sum,
  /* the version */ version,
} from "@mini/core";
test("workspace package import, re-exports followed one level", () => {
  expect(`${addAll(1, 2)}${sum([1])}${hello("a")}${version}`).toBe("31hi a1");
});
