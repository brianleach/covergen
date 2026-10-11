import { expect, test } from "vitest";
import { add } from "../src/math";
test("generated", () => expect(add(1, 1)).toBe(2));
