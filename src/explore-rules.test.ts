import { describe, expect, it } from "vitest";
import { buildFlows } from "./explore.js";
import type { Flow, PageSnapshot } from "./explore.js";
import { credentialViolation, duplicateViolation, mutationViolation, offSiteViolation } from "./explore-rules.js";
import { indexSpecs } from "./explore-specs.js";
import type { SpecFile } from "./explore-specs.js";

// Synthetic values only.
const BASE = "https://sentinel-app-4d2b.example.test";

const EXISTING: SpecFile[] = [
  { path: "e2e/items.spec.ts", text: 'await page.goto("/items");\nawait page.getByRole("link", { name: "First item" }).click();' },
];

const pages: PageSnapshot[] = [
  { url: `${BASE}/items`, title: "Items", links: [], elements: [{ role: "link", name: "First item", mutating: false }] },
  {
    url: `${BASE}/settings/profile`,
    title: "Profile",
    links: [],
    elements: [
      { role: "textbox", name: "Display name", mutating: true },
      { role: "button", name: "Save changes", mutating: true },
    ],
  },
  {
    url: `${BASE}/billing`,
    title: "Billing",
    links: [],
    elements: [
      { role: "button", name: "Update card", mutating: true },
      { role: "link", name: "Invoices", mutating: false },
    ],
  },
];
const flows: Flow[] = buildFlows(pages, BASE, indexSpecs(EXISTING, BASE), ["/settings/profile"]);
const flowAt = (route: string): Flow => flows.find((f) => f.route === route) as Flow;

const spec = (route: string, ...body: string[]): string =>
  [
    'import { expect, test } from "@playwright/test";',
    "test.use({ storageState: process.env.APP_STORAGE_STATE });",
    'test("flow", async ({ page }) => {',
    `  await page.goto("${route}");`,
    ...body.map((b) => `  ${b}`),
    "});",
  ].join("\n");

const GOOD = spec("/settings/profile", 'await page.getByRole("button", { name: "Save changes" }).click();', 'await expect(page.getByText("Saved")).toBeVisible();');

describe("credential_in_spec", () => {
  const env = "APP_STORAGE_STATE";
  const flagged = [
    'const user = "someone@example.test";',
    'await page.getByLabel("Password").fill("synthetic-pass");',
    'const opts = { password: "synthetic-pass" };',
    'const headers = { "Authorization": "Bearer synthetic0000token" };',
    'const t = "eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl";',
    'const k = "0123456789abcdef0123456789abcdef";',
    'const k = "Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0LzXcVbNm";',
    'test.use({ storageState: "state.json" });',
    'await context.addCookies([{ name: "sid", value: "x", url: "/" }]);',
    'await page.setExtraHTTPHeaders({ "x-key": "synthetic" });',
  ];
  for (const line of flagged) {
    it(`flags ${line.slice(0, 40)}, never echoing the text`, () => {
      const v = credentialViolation(`// header\n${line}`, env);
      expect(v?.rule).toBe("credential_in_spec");
      expect(v?.line).toBe(2);
      for (const lit of line.match(/"[^"]{4,}"/g) ?? []) expect(v?.message).not.toContain(lit.slice(1, -1));
    });
  }
  it("passes the configured storage state and ordinary literals", () => {
    expect(credentialViolation(GOOD, env)).toBeUndefined();
    expect(credentialViolation('test.use({ storageState: process.env["APP_STORAGE_STATE"] });\nawait page.goto("/settings/profile/notifications");', env)).toBeUndefined();
    expect(credentialViolation("test.use({ storageState: process.env.OTHER });", env)?.rule).toBe("credential_in_spec");
  });
});

describe("off_site", () => {
  it("refuses an absolute goto even on the base origin, and any off-origin URL", () => {
    expect(offSiteViolation(`await page.goto("${BASE}/items");`, BASE)?.message).toBe("page.goto takes a relative path only");
    expect(offSiteViolation("await page.goto(process.env.APP_BASE_URL + '/items');", BASE)?.rule).toBe("off_site");
    expect(offSiteViolation('await expect(page).toHaveURL("https://other.example.test/x");', BASE)?.rule).toBe("off_site");
    expect(offSiteViolation('await page.request.get("https://other.example.test/api");', BASE)?.rule).toBe("off_site");
    expect(offSiteViolation('await page.route("https://other.example.test/**", (r) => r.abort());', BASE)?.rule).toBe("off_site");
    expect(offSiteViolation('await page.evaluate(() => { window.location.href = "https://other.example.test"; });', BASE)?.rule).toBe("off_site");
  });
  it("passes relative navigation and same-origin assertions", () => {
    expect(offSiteViolation(`await page.goto("/items");\nawait expect(page).toHaveURL("${BASE}/items");\nawait page.goto(\`/items/\${id}\`);`, BASE)).toBeUndefined();
  });
});

describe("mutation_not_allowed", () => {
  it("allows the writable target's own mutating element", () => {
    expect(mutationViolation(GOOD, { baseUrl: BASE, flow: flowAt("/settings/profile"), flows })).toBeUndefined();
  });
  it("catches an action through a const and a regex name", () => {
    const code = spec("/billing", 'const update = page.getByRole("button", { name: /update card/i });', "await update.click();");
    expect(mutationViolation(code, { baseUrl: BASE, flow: flowAt("/billing"), flows })?.line).toBe(5);
  });
  it("refuses a destructive name unless the target flow is writable, and ignores elements only asserted", () => {
    const destroy = spec("/items", 'await page.getByRole("button", { name: "Delete item" }).click();');
    expect(mutationViolation(destroy, { baseUrl: BASE, flow: flowAt("/items"), flows })?.rule).toBe("mutation_not_allowed");
    expect(mutationViolation(destroy, { baseUrl: BASE, flow: flowAt("/settings/profile"), flows })).toBeUndefined();
    const looked = spec("/billing", 'await expect(page.getByRole("button", { name: "Update card" })).toBeVisible();');
    expect(mutationViolation(looked, { baseUrl: BASE, flow: flowAt("/billing"), flows })).toBeUndefined();
  });
});

describe("duplicate_flow", () => {
  const ctx = { baseUrl: BASE, flow: flowAt("/items"), existing: EXISTING, acceptedThisRun: [] as SpecFile[] };
  it("passes a spec that reaches a new route or a new target", () => {
    expect(duplicateViolation(spec("/billing", 'await page.getByRole("link", { name: "Invoices" }).click();'), { ...ctx, flow: flowAt("/billing") })).toBeUndefined();
    expect(duplicateViolation(spec("/items", 'await page.getByRole("link", { name: "Second item" }).click();'), ctx)).toBeUndefined();
  });
  it("counts specs accepted earlier in this run", () => {
    const code = spec("/billing", 'await page.getByRole("link", { name: "Invoices" }).click();');
    const accepted = [{ path: "e2e/covergen/billing.spec.ts", text: code }];
    expect(duplicateViolation(code, { ...ctx, flow: flowAt("/billing"), acceptedThisRun: accepted })?.rule).toBe("duplicate_flow");
  });
});

