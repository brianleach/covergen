import { describe, expect, it } from "vitest";
import { indexSpecs, scanSpec, targetKey } from "./explore-specs.js";

const BASE = "https://app.test";

describe("scanSpec", () => {
  it("reads routes out of every goto form and collapses interpolated segments", () => {
    const spec = {
      path: "e2e/items.spec.ts",
      text: [
        'await page.goto("/items");',
        "await page.goto('/settings/profile/');",
        "await page.goto(`/items/${item.id}/edit`);",
        'await page.goto("https://app.test/billing?plan=pro");',
        'await page.goto("https://elsewhere.test/items");',
        "await page.goto(target);",
      ].join("\n"),
    };
    expect(scanSpec(spec, BASE).routes).toEqual(["/items", "/settings/profile", "/items/:id/edit", "/billing"]);
  });

  it("reads role targets with a string name, a regex name, or no name at all", () => {
    const spec = {
      path: "e2e/profile.spec.ts",
      text: [
        'page.getByRole("button", { name: "Save changes" })',
        "page.getByRole('link', { name: /Back to items/i })",
        'page.getByRole("textbox", { name: `Display name` })',
        'page.getByRole("combobox")',
      ].join("\n"),
    };
    expect(scanSpec(spec, BASE).targets).toEqual([
      "button:save changes",
      "link:back to items",
      "textbox:display name",
      "combobox:",
    ]);
  });

  it("credits nothing for a goto it cannot read", () => {
    expect(scanSpec({ path: "e2e/a.spec.ts", text: "await page.goto(url);" }, BASE).routes).toEqual([]);
  });
});

describe("indexSpecs", () => {
  const specs = [
    { path: "e2e/items.spec.ts", text: 'page.goto("/items"); page.getByRole("link", { name: "New item" });' },
    { path: "e2e/dashboard.spec.ts", text: 'page.goto("/items"); page.getByRole("heading");' },
  ];
  const index = indexSpecs(specs, BASE);

  it("names every spec that reaches a route, and nothing for a route none reach", () => {
    expect(index.specsForRoute("/items")).toEqual(["e2e/items.spec.ts", "e2e/dashboard.spec.ts"]);
    expect(index.specsForRoute("/billing")).toEqual([]);
  });

  it("matches an element on role and name, ignoring case and extra whitespace", () => {
    expect(index.addressesElement({ role: "link", name: "New  Item", mutating: false })).toBe(true);
    expect(index.addressesElement({ role: "link", name: "Delete item", mutating: true })).toBe(false);
  });

  it("treats a role named with no name option as covering that role", () => {
    expect(index.addressesElement({ role: "heading", name: "Anything at all", mutating: false })).toBe(true);
  });
});

describe("targetKey", () => {
  it("is the comparison both sides use", () => {
    expect(targetKey("BUTTON", "  Save   changes ")).toBe("button:save changes");
  });
});
