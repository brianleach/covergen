import { expect, test } from "vitest";
import { broken } from "@mini/broken";
test("workspace package with no readable entry", () => expect(broken).toBe(true));
