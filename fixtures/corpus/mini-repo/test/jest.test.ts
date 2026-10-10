import { expect, test } from "@jest/globals";
import { add } from "../src/math";
test("another runner", () => expect(add(1, 1)).toBe(2));
