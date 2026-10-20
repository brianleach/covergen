import { expect, test } from "vitest";
import { add } from "fancy/math";
import { upper } from "@two/a/x/strings";
import { name } from "outside/package.json";
test("aliases with several targets or wildcards stay unresolved", () => expect(upper(String(add(1, 1))) + name).toBe("2x"));
