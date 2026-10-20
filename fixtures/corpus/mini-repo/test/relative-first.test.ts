import { expect, test } from "vitest";
import { addAll, sum } from "@mini/core";
import { add } from "../src/math";
test("a relative import wins even with fewer symbols", () => expect(add(addAll(1), sum([1]))).toBe(2));
