import { expect, test } from "vitest";
import { fixture } from "#utils";
test("a test helper reached through an alias is not a source", () => expect(fixture(2)).toEqual([0, 1]));
