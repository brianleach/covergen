import { expect, test } from "vitest";
import { lower } from "../src/strings";
import { add } from "../src/math";
test("tie goes to the first relative import", () => expect(lower(String(add(1, 1)))).toBe("2"));
