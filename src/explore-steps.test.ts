import { describe, expect, it } from "vitest";
import { countingAssertions, isCountingAssertion, mainAction, scanSteps } from "./explore-steps.js";

const SPEC = [
  'import { expect, test } from "@playwright/test";', // 1
  "test.use({ storageState: process.env.APP_STORAGE_STATE });", // 2
  'test("saves the profile", async ({ page }) => {', // 3
  '  await page.goto("/settings/profile");', // 4
  "  // a comment with page.click(); in it", // 5
  '  await expect(page).toHaveTitle("Profile; settings");', // 6
  "  await page", // 7
  '    .getByRole("textbox", { name: "Display name" })', // 8
  '    .fill("Pat")', // 9
  '  const save = page.getByRole("button", { name: "Save changes" });', // 10
  "  /* block comment", // 11
  "     await page.check(); */", // 12
  "  await save.click();", // 13
  '  await expect(page.getByText("Saved")).toBeVisible();', // 14
  '  await page.goto("/settings/profile/history");', // 15
  "  await expect(page.getByRole(\"row\")).not.toHaveCount(0);", // 16
  "});", // 17
].join("\n");

describe("scanSteps", () => {
  it("returns each statement in order with its kind, lines and verb, ignoring comments and strings", () => {
    const steps = scanSteps(SPEC).map(({ kind, startLine, endLine, verb }) => ({ kind, startLine, endLine, verb }));
    expect(steps).toEqual([
      { kind: "other", startLine: 1, endLine: 1, verb: "" },
      { kind: "other", startLine: 1, endLine: 1, verb: "" },
      { kind: "other", startLine: 2, endLine: 2, verb: "" },
      { kind: "navigation", startLine: 4, endLine: 4, verb: "goto" },
      { kind: "assertion", startLine: 6, endLine: 6, verb: "toHaveTitle" },
      { kind: "action", startLine: 7, endLine: 9, verb: "fill" },
      { kind: "other", startLine: 10, endLine: 10, verb: "" },
      { kind: "action", startLine: 13, endLine: 13, verb: "click" },
      { kind: "assertion", startLine: 14, endLine: 14, verb: "toBeVisible" },
      { kind: "action", startLine: 15, endLine: 15, verb: "goto" },
      { kind: "assertion", startLine: 16, endLine: 16, verb: "toHaveCount" },
    ]);
  });

  it("keeps the source text of a multi-line statement", () => {
    const fill = scanSteps(SPEC).find((s) => s.verb === "fill");
    expect(fill?.text).toBe('await page\n    .getByRole("textbox", { name: "Display name" })\n    .fill("Pat")');
  });

  it("descends into test.step and if blocks", () => {
    const code = [
      'test("x", async ({ page }) => {',
      '  await page.goto("/a");',
      '  await test.step("open", async () => {',
      '    await page.getByRole("link", { name: "Open" }).click();',
      "  });",
      "  if (process.env.SLOW) {",
      '    await page.getByRole("button", { name: "Go" }).dblclick();',
      "  } else {",
      '    await page.keyboard.press("Enter");',
      "  }",
      "  await expect(page).toHaveURL(/open/);",
      "});",
    ].join("\n");
    expect(scanSteps(code).map((s) => `${s.startLine}:${s.kind}:${s.verb}`)).toEqual([
      "2:navigation:goto",
      "4:action:click",
      "7:action:dblclick",
      "9:action:press",
      "11:assertion:toHaveURL",
    ]);
  });

  it("counts a waitForResponse as an assertion only when its response is asserted on", () => {
    const asserted = [
      'await page.goto("/a");',
      'const res = await page.waitForResponse((r) => r.url().includes("/api/save"));',
      "expect(res.status()).toBe(200);",
    ].join("\n");
    const steps = scanSteps(asserted);
    expect(steps[1]).toMatchObject({ kind: "assertion", verb: "waitForResponse" });
    expect(isCountingAssertion(steps[1] as never)).toBe(false);
    expect(isCountingAssertion(steps[2] as never)).toBe(true);
    const ignored = ['await page.goto("/a");', 'await page.waitForResponse("**/api/save");'].join("\n");
    expect(scanSteps(ignored)[1]).toMatchObject({ kind: "other", verb: "waitForResponse" });
  });
});

describe("counting assertions and the main action", () => {
  it("counts only assertions after the first action, and picks the last action before the last counting one", () => {
    const steps = scanSteps(SPEC);
    expect(countingAssertions(steps).map((s) => s.verb)).toEqual(["toBeVisible", "toHaveCount"]);
    expect(mainAction(steps)).toMatchObject({ verb: "goto", startLine: 15 });
  });

  it("does not count a title, a bare true, toBeDefined, or a JSON truthiness check", () => {
    const code = [
      'await page.goto("/a");',
      'await page.getByRole("button", { name: "Go" }).click();',
      "await expect(page).toHaveTitle(/A/);",
      "expect(true).toBe(true);",
      'expect(page.getByText("x")).toBeDefined();',
      "expect(await res.json()).toBeTruthy();",
    ].join("\n");
    expect(countingAssertions(scanSteps(code))).toEqual([]);
    expect(mainAction(scanSteps(code))).toBeUndefined();
  });

  it("counts an expect on a response's JSON", () => {
    const code = ['await page.goto("/a");', "await page.getByRole(\"button\").click();", "expect(await res.json()).toMatchObject({ ok: true });"].join("\n");
    expect(countingAssertions(scanSteps(code))).toHaveLength(1);
  });
});
