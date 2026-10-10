import { expect, test } from "vitest";
import { thrice, twice } from "./helpers";
test("only a test helper is imported", () => expect(twice(1).length + thrice(1).length).toBe(5));
