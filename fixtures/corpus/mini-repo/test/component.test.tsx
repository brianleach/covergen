import { expect, test } from "vitest";
import { upper } from "../src/strings";
test("a .test.tsx file pairs like a .test.ts file", () => expect(<span>{upper("a")}</span>).toBeTruthy());
