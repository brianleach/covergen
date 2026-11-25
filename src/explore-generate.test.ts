import { describe, expect, it, vi } from "vitest";

// Spies over every generator factory: the --show-prompt path must build none.
vi.mock("./generate.js", async (orig) => ({ ...(await orig<typeof import("./generate.js")>()), createGenerator: vi.fn() }));
vi.mock("./claude-code.js", async (orig) => ({ ...(await orig<typeof import("./claude-code.js")>()), createClaudeCodeGenerator: vi.fn() }));
vi.mock("./openai-compatible.js", async (orig) => ({
  ...(await orig<typeof import("./openai-compatible.js")>()),
  createOpenAICompatibleGenerator: vi.fn(),
}));

import { createClaudeCodeGenerator } from "./claude-code.js";
import { bundledIdiomPack, exploreIdiomPackPath } from "./config.js";
import { buildFlows, exploreEnv } from "./explore.js";
import type { PageSnapshot } from "./explore.js";
import { checkFlowShape, dedupeFlowCandidates, flowSpecPath, generateFlowCandidate, specDirOf } from "./explore-generate.js";
import { buildFlowPromptBlocks, loadExploreIdiomPack, pickStyleSpec, showFlowPrompt } from "./explore-prompt.js";
import { exploreRuleIds, exploreRulesText } from "./explore-rules.js";
import { indexSpecs } from "./explore-specs.js";
import type { SpecFile } from "./explore-specs.js";
import { createGenerator } from "./generate.js";
import type { Generator } from "./generate.js";
import { createOpenAICompatibleGenerator } from "./openai-compatible.js";
import type { ExploreOptions } from "./types.js";

const BASE_SENTINEL = "https://sentinel-base-7f3a.invalid";
const STATE_SENTINEL = "/tmp/sentinel-state-9c1e/session.json";

const explore: ExploreOptions = {
  baseUrlEnv: "APP_BASE_URL",
  storageStateEnv: "APP_STORAGE_STATE",
  allowMutations: ["/settings/profile"],
  maxPages: 10,
  ignorePatterns: [],
  specGlob: "e2e/**/*.spec.ts",
  seedRoutes: [],
  sitemap: false,
};

const SPECS: SpecFile[] = [
  { path: "e2e/items.spec.ts", text: 'test("x", async ({ page }) => {\n  await page.goto("/items");\n  await page.getByRole("link", { name: "First item" }).click();\n});' },
  { path: "e2e/a.spec.ts", text: 'await page.goto("/");' },
];

function fixtureFlows(baseUrl: string) {
  const pages: PageSnapshot[] = [
    { url: `${baseUrl}/`, title: "Home", links: [], elements: [{ role: "link", name: "Items", mutating: false }] },
    {
      url: `${baseUrl}/items`,
      title: "Items",
      links: [],
      elements: [
        { role: "link", name: "First item", mutating: false },
        { role: "link", name: "New item", mutating: false },
      ],
    },
    {
      url: `${baseUrl}/settings/profile`,
      title: "Profile",
      links: [],
      elements: [
        { role: "textbox", name: "Display name", mutating: true },
        { role: "button", name: "Save changes", mutating: true },
      ],
    },
  ];
  return buildFlows(pages, baseUrl, indexSpecs(SPECS, baseUrl), explore.allowMutations);
}

const GOOD = [
  'import { expect, test } from "@playwright/test";',
  "test.use({ storageState: process.env.APP_STORAGE_STATE });",
  'test("saves the display name", async ({ page }) => {',
  '  await page.goto("/settings/profile");',
  '  await page.getByRole("button", { name: "Save changes" }).click();',
  '  await expect(page.getByText("Saved")).toBeVisible();',
  "});",
].join("\n");

function stub(reply: string): Pick<Generator, "continueChat"> & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    continueChat: async (...args) => {
      calls.push(args);
      return reply;
    },
  };
}

describe("flow prompt blocks", () => {
  it("carry the env variable names and never their values", () => {
    const env = { APP_BASE_URL: BASE_SENTINEL, APP_STORAGE_STATE: STATE_SENTINEL };
    const { baseUrl } = exploreEnv(explore, env);
    const flows = fixtureFlows(baseUrl);
    const flow = flows.find((f) => f.route === "/settings/profile");
    if (!flow) throw new Error("fixture flow missing");
    const blocks = buildFlowPromptBlocks({ flow, flows, explore, idiomPack: loadExploreIdiomPack(explore), styleSpec: pickStyleSpec(SPECS, flow.route, baseUrl) });
    const all = `${blocks.stable}\n${blocks.semiStable}\n${blocks.volatile}`;
    expect(all).not.toContain("sentinel-base-7f3a");
    expect(all).not.toContain("sentinel-state-9c1e");
    expect(all).toContain("process.env.APP_STORAGE_STATE");
    expect(all).toContain("APP_BASE_URL");
  });

  it("put the pack, rules and format in stable, the style spec and map in semiStable, the target in volatile", () => {
    const flows = fixtureFlows("http://127.0.0.1:1");
    const flow = flows.find((f) => f.route === "/items");
    if (!flow) throw new Error("fixture flow missing");
    const blocks = buildFlowPromptBlocks({ flow, flows, explore, idiomPack: "PACK TEXT", styleSpec: pickStyleSpec(SPECS, flow.route, "http://127.0.0.1:1") });
    expect(blocks.stable).toContain("PACK TEXT");
    for (const id of exploreRuleIds) expect(blocks.stable).toContain(`- ${id}:`);
    expect(blocks.stable).toContain("@playwright/test");
    expect(blocks.semiStable).toContain("Existing spec at e2e/items.spec.ts");
    expect(blocks.semiStable).toContain("- /settings/profile: Profile");
    expect(blocks.semiStable).not.toContain("Save changes");
    expect(blocks.volatile).toContain('- link "New item"');
    expect(blocks.volatile).toContain("read-only");
    expect(blocks.volatile).toMatch(/already address[^\n]*\n- link "First item"/);
  });

  it("say the route is writable and mark mutating targets when allow_mutations covers it", () => {
    const flows = fixtureFlows("http://127.0.0.1:1");
    const flow = flows.find((f) => f.route === "/settings/profile");
    if (!flow) throw new Error("fixture flow missing");
    const blocks = buildFlowPromptBlocks({ flow, flows, explore, idiomPack: "" });
    expect(blocks.volatile).toContain("This route is writable");
    expect(blocks.volatile).toContain('button "Save changes" (mutating)');
    expect(blocks.semiStable).toContain("no end to end spec yet");
  });

  it("pick the smallest spec visiting the route, else the smallest overall", () => {
    expect(pickStyleSpec(SPECS, "/items", "http://x.test")?.path).toBe("e2e/items.spec.ts");
    expect(pickStyleSpec(SPECS, "/billing", "http://x.test")?.path).toBe("e2e/a.spec.ts");
    expect(pickStyleSpec([], "/billing", "http://x.test")).toBeUndefined();
  });
});

describe("the explore idiom pack", () => {
  it("defaults to the bundled playwright pack, for explore only", () => {
    expect(exploreIdiomPackPath(explore)).toBe(bundledIdiomPack("playwright.md"));
    expect(exploreIdiomPackPath({ idiomPackPath: "/repo/my-pack.md" })).toBe("/repo/my-pack.md");
    const pack = loadExploreIdiomPack(explore);
    expect(pack).toContain("getByRole");
    expect(pack).not.toContain("waitForTimeout(");
  });

  it("renders every rule into the prompt text", () => {
    expect(exploreRuleIds).toEqual(["flaky", "no_assertion", "action_removable", "mutation_not_allowed", "credential_in_spec", "off_site", "duplicate_flow"]);
    expect(exploreRulesText().split("\n")).toHaveLength(8);
  });
});

describe("flow candidates", () => {
  const blocks = { stable: "S", semiStable: "M", volatile: "V" };
  const fenced = (code: string) => `\`\`\`typescript\n${code}\n\`\`\``;

  it("come from continueChat with a fresh history and the system blocks, and keep both turns", async () => {
    const gen = stub(fenced(GOOD));
    const c = await generateFlowCandidate(gen, blocks, { route: "/settings/profile" }, "e2e/covergen/settings-profile.spec.ts");
    expect(gen.calls).toEqual([[[], "V", { stable: "S", semiStable: "M" }]]);
    expect(c.status).toBe("generated");
    expect(c.code).toBe(GOOD);
    expect(c.specPath).toBe("e2e/covergen/settings-profile.spec.ts");
    expect(c.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c.system).toEqual({ stable: "S", semiStable: "M" });
  });

  it("are build_failed, not thrown, on two fenced blocks or none", async () => {
    const two = await generateFlowCandidate(stub(`${fenced(GOOD)}\n${fenced(GOOD)}`), blocks, { route: "/" }, "x.spec.ts");
    expect(two.status).toBe("build_failed");
    expect(two.lastError).toContain("exactly one fenced code block");
    const none = await generateFlowCandidate(stub("I cannot do that."), blocks, { route: "/" }, "x.spec.ts");
    expect(none.status).toBe("build_failed");
    expect(none.lastError).toContain("no fenced code block");
    expect(none.hash).not.toBe(two.hash);
  });

  it("are build_failed when the spec misses the Playwright import", async () => {
    const c = await generateFlowCandidate(stub(fenced(GOOD.split("\n").slice(1).join("\n"))), blocks, { route: "/" }, "x.spec.ts");
    expect(c.status).toBe("build_failed");
    expect(c.lastError).toBe("spec does not import from @playwright/test");
  });

  it("dedupe by normalized hash", async () => {
    const a = await generateFlowCandidate(stub(fenced(GOOD)), blocks, { route: "/" }, "x.spec.ts");
    const b = await generateFlowCandidate(stub(fenced(GOOD.replaceAll("  ", "    "))), blocks, { route: "/" }, "x.spec.ts");
    expect(dedupeFlowCandidates([a, b])).toEqual([a]);
  });

  it("checkFlowShape names each missing piece", () => {
    expect(checkFlowShape(GOOD)).toBeUndefined();
    expect(checkFlowShape(GOOD.replace("test(", "it("))).toBe("spec declares no test()");
    expect(checkFlowShape(GOOD.replace("page.goto(", "page.open("))).toBe("spec never calls page.goto()");
  });
});

describe("flow spec paths", () => {
  const none = () => false;
  it("slug the route under <spec_dir>/covergen", () => {
    expect(flowSpecPath("/", "e2e", none)).toBe("e2e/covergen/home.spec.ts");
    expect(flowSpecPath("/items/:id/edit", "e2e", none)).toBe("e2e/covergen/items-id-edit.spec.ts");
    expect(flowSpecPath("/settings/profile", ".", none)).toBe("covergen/settings-profile.spec.ts");
  });

  it("suffix -2, -3 on a collision", () => {
    const taken = new Set(["e2e/covergen/billing.spec.ts", "e2e/covergen/billing-2.spec.ts"]);
    expect(flowSpecPath("/billing", "e2e", (p) => taken.has(p))).toBe("e2e/covergen/billing-3.spec.ts");
  });

  it("take the literal head of the spec glob as the spec dir", () => {
    expect(specDirOf("e2e/**/*.spec.ts")).toBe("e2e");
    expect(specDirOf("tests/e2e/*.spec.ts")).toBe("tests/e2e");
    expect(specDirOf("**/*.spec.ts")).toBe(".");
  });
});

describe("--show-prompt", () => {
  it("previews the top-ranked open flow and constructs no generator", () => {
    const baseUrl = "http://127.0.0.1:1";
    const flows = fixtureFlows(baseUrl);
    const out = showFlowPrompt({ flows, specs: SPECS, explore, baseUrl, exists: () => false });
    expect(out).toContain("=== stable ===");
    expect(out).toContain("=== volatile ===");
    expect(out).toMatch(/Target flow: \/settings\/profile/);
    expect(out).toContain("e2e/covergen/settings-profile.spec.ts");
    expect(createGenerator).not.toHaveBeenCalled();
    expect(createClaudeCodeGenerator).not.toHaveBeenCalled();
    expect(createOpenAICompatibleGenerator).not.toHaveBeenCalled();
  });

  it("says so when no flow is open", () => {
    expect(showFlowPrompt({ flows: [], specs: [], explore, baseUrl: "http://x.test", exists: () => false })).toContain("no open flow");
  });
});
