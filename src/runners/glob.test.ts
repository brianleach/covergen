import { describe, expect, it } from "vitest";
import { escapeGlob } from "./glob.js";

describe("escapeGlob", () => {
  it("leaves a plain path alone", () => {
    expect(escapeGlob("src/lib/rates.ts")).toBe("src/lib/rates.ts");
  });

  it("escapes a dynamic route segment", () => {
    expect(escapeGlob("app/api/items/[id]/route.ts")).toBe("app/api/items/\\[id\\]/route.ts");
  });

  it("escapes a route group and a catch-all segment", () => {
    expect(escapeGlob("app/(admin)/[...slug]/page.tsx")).toBe("app/\\(admin\\)/\\[...slug\\]/page.tsx");
  });

  it("escapes every metacharacter that can appear in a path", () => {
    expect(escapeGlob("a[b]c{d}e(f)g*h?i!j\\k")).toBe("a\\[b\\]c\\{d\\}e\\(f\\)g\\*h\\?i\\!j\\\\k");
  });
});
