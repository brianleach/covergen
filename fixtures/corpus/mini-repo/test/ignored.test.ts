import { expect, test } from "vitest";
import { ignored } from "@mini/ignored";
test("a package excluded by the workspace globs is not a workspace package", () => expect(ignored).toBe(true));
