import { expect, test } from "vitest";
import { upper } from "~/strings";
import { lower } from "#strings";
import { add } from "~/math";
test("plain prefix and exact aliases", () => expect(upper(lower("A")) + add(1, 1)).toBe("A2"));
