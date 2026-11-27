import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFlows } from "./explore.js";
import type { Flow, PageSnapshot } from "./explore.js";
import { evaluateFlow, scrubEnvValues } from "./explore-gate.js";
import type { FlowGateArgs } from "./explore-gate.js";
import { indexSpecs } from "./explore-specs.js";
import type { SpecFile } from "./explore-specs.js";
import type { ExecFn, ExecOptions, ExecResult } from "./runners/exec.js";
import type { ExploreOptions, FlowCandidate } from "./types.js";

// Synthetic values only: the gate must never let either one into an error tail.
const BASE = "https://sentinel-app-4d2b.example.test";
const STATE = "/tmp/sentinel-session-81fe/state.json";

const explore: ExploreOptions = {
  baseUrlEnv: "APP_BASE_URL",
  storageStateEnv: "APP_STORAGE_STATE",
  allowMutations: ["/settings/profile"],
  maxPages: 10,
  ignorePatterns: [],
  specGlob: "e2e/**/*.spec.ts",
  seedRoutes: [],
  sitemap: false,
  testCommand: ["npx", "playwright", "test"],
  specDir: "e2e",
  k: 3,
  timeoutMs: 5_000,
};

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
const flows: Flow[] = buildFlows(pages, BASE, indexSpecs(EXISTING, BASE), explore.allowMutations);
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

function candidate(code: string, specPath = "e2e/covergen/settings-profile.spec.ts"): FlowCandidate {
  return { id: "c1", hash: "h", route: "/settings/profile", specPath, code, status: "generated", attempts: 1, history: [], system: { stable: "", semiStable: "" } };
}

const ok: ExecResult = { exitCode: 0, stdout: "1 passed", stderr: "", durationMs: 1 };
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: "", stderr, durationMs: 1 });

/** A fake exec that answers from a script and records each call, plus whether the spec existed at that moment. */
function fakeExec(cwd: string, script: (n: number) => ExecResult): ExecFn & { calls: { cmd: string[]; opts: ExecOptions; existed: boolean }[] } {
  const calls: { cmd: string[]; opts: ExecOptions; existed: boolean }[] = [];
  const fn = async (cmd: string[], opts: ExecOptions) => {
    calls.push({ cmd, opts, existed: existsSync(join(cwd, cmd.at(-1) ?? "")) });
    return script(calls.length);
  };
  return Object.assign(fn, { calls });
}

function args(cwd: string, code: string, exec: ExecFn, extra: Partial<FlowGateArgs> = {}): FlowGateArgs {
  return {
    explore,
    cwd,
    candidate: candidate(code),
    flow: flowAt("/settings/profile"),
    flows,
    existing: EXISTING,
    acceptedThisRun: [],
    baseUrl: BASE,
    storageStatePath: STATE,
    exec,
    ...extra,
  };
}

const repo = () => mkdtempSync(join(tmpdir(), "covergen-explore-gate-"));

describe("evaluateFlow verdicts", () => {
  it("accepts a spec that passes k times, runs the target's command on the spec path, and leaves no file behind", async () => {
    const cwd = repo();
    const exec = fakeExec(cwd, () => ok);
    const lines: string[] = [];
    const result = await evaluateFlow({ ...args(cwd, GOOD, exec), log: (l) => lines.push(l) });
    expect(result.status).toBe("accepted");
    expect(exec.calls).toHaveLength(3);
    expect(exec.calls.every((c) => c.existed)).toBe(true);
    expect(exec.calls[0]?.cmd).toEqual(["npx", "playwright", "test", "e2e/covergen/settings-profile.spec.ts"]);
    expect(exec.calls[0]?.opts).toMatchObject({ cwd, timeoutMs: 5_000 });
    expect(existsSync(join(cwd, "e2e/covergen/settings-profile.spec.ts"))).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
    expect(lines).toEqual(["explore gate: accepted"]);
  });

  it("gives the child the two values under their configured names and nothing else new", async () => {
    const cwd = repo();
    const exec = fakeExec(cwd, () => ok);
    await evaluateFlow(args(cwd, GOOD, exec));
    expect(exec.calls[0]?.opts.env).toEqual({ APP_BASE_URL: BASE, APP_STORAGE_STATE: STATE });
    const noSession = fakeExec(cwd, () => ok);
    await evaluateFlow(args(cwd, GOOD, noSession, { storageStatePath: undefined }));
    expect(noSession.calls[0]?.opts.env).toEqual({ APP_BASE_URL: BASE });
  });

  it("honors k", async () => {
    const cwd = repo();
    const exec = fakeExec(cwd, () => ok);
    await evaluateFlow(args(cwd, GOOD, exec, { explore: { ...explore, k: 5 } }));
    expect(exec.calls).toHaveLength(5);
  });

  it("calls a first-run failure test_failed and a build error build_failed", async () => {
    const cwd = repo();
    const always = await evaluateFlow(args(cwd, GOOD, fakeExec(cwd, () => fail("Error: expect(locator).toBeVisible() failed"))));
    expect(always.status).toBe("test_failed");
    expect(always.runs).toHaveLength(1);
    const build = await evaluateFlow(args(cwd, GOOD, fakeExec(cwd, () => fail("SyntaxError: Unexpected token '}'"))));
    expect(build.status).toBe("build_failed");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("calls pass then fail flaky, with the run number", async () => {
    const cwd = repo();
    const result = await evaluateFlow(args(cwd, GOOD, fakeExec(cwd, (n) => (n < 3 ? ok : fail("Timed out waiting")))));
    expect(result.status).toBe("flaky");
    expect(result.error).toMatch(/^passed 2 times then failed on run 3 of 3\nTimed out waiting/);
    expect(existsSync(join(cwd, "e2e/covergen/settings-profile.spec.ts"))).toBe(false);
  });

  it("removes the file when exec throws", async () => {
    const cwd = repo();
    const exec: ExecFn = async () => {
      throw new Error("spawn exploded");
    };
    await expect(evaluateFlow(args(cwd, GOOD, exec))).rejects.toThrow("spawn exploded");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("scrubs the base URL and the session path out of kept tails", async () => {
    const cwd = repo();
    const out = `navigating to ${BASE}/settings/profile\nloading ${STATE}\nat ${BASE}`;
    const result = await evaluateFlow(args(cwd, GOOD, fakeExec(cwd, () => fail(out))));
    expect(result.error).toBe("navigating to ${APP_BASE_URL}/settings/profile\nloading ${APP_STORAGE_STATE}\nat ${APP_BASE_URL}");
    expect(result.error).not.toContain("sentinel");
  });

  it("refuses an existing path and a path outside spec_dir without touching either", async () => {
    const cwd = repo();
    const exec = fakeExec(cwd, () => ok);
    await evaluateFlow(args(cwd, GOOD, exec));
    mkdirSync(join(cwd, "e2e/covergen"), { recursive: true });
    writeFileSync(join(cwd, "e2e/covergen/settings-profile.spec.ts"), "hand written");
    await expect(evaluateFlow(args(cwd, GOOD, exec))).rejects.toThrow(/already exists/);
    expect(readFileSync(join(cwd, "e2e/covergen/settings-profile.spec.ts"), "utf8")).toBe("hand written");
    await expect(evaluateFlow({ ...args(cwd, GOOD, exec), candidate: candidate(GOOD, "../outside.spec.ts") })).rejects.toThrow(/spec_dir/);
  });

  it("calls a spec that fails the shape check build_failed without running it", async () => {
    const cwd = repo();
    const exec = fakeExec(cwd, () => ok);
    const result = await evaluateFlow(args(cwd, 'test("x", () => {});', exec));
    expect(result.status).toBe("build_failed");
    expect(exec.calls).toHaveLength(0);
  });
});

describe("static rules refuse before any file is written", () => {
  // The line is the offending action, or for duplicate_flow the goto that reached the covered route.
  const cases: [string, string, string, number][] = [
    ["credential_in_spec", spec("/settings/profile", 'await page.getByLabel("Email").fill("someone@example.test");'), "/settings/profile", 5],
    ["off_site", spec("/settings/profile", 'await page.waitForURL("https://elsewhere.example.test/done");'), "/settings/profile", 5],
    ["mutation_not_allowed", spec("/billing", 'await page.getByRole("button", { name: "Update card" }).click();'), "/billing", 5],
    ["duplicate_flow", spec("/items", 'await page.getByRole("link", { name: "First item" }).click();'), "/items", 4],
  ];
  for (const [rule, code, route, line] of cases) {
    it(rule, async () => {
      const cwd = repo();
      const exec = fakeExec(cwd, () => ok);
      const lines: string[] = [];
      const result = await evaluateFlow({ ...args(cwd, code, exec, { flow: flowAt(route) }), log: (l) => lines.push(l) });
      expect(result).toMatchObject({ status: rule, rule, line, runs: [] });
      expect(exec.calls).toHaveLength(0);
      expect(readdirSync(cwd)).toEqual([]);
      expect(lines).toEqual([`explore gate: ${rule} rule=${rule} line=${line}`]);
    });
  }
});

describe("scrubEnvValues", () => {
  it("replaces each value, longest first, with or without a trailing slash", () => {
    const values = { BASE_URL: "https://app.example.test/", BASE_PATH: "https://app.example.test/sub", STATE: undefined };
    expect(scrubEnvValues("a https://app.example.test/sub/x b https://app.example.test c", values)).toBe("a ${BASE_PATH}/x b ${BASE_URL} c");
    expect(scrubEnvValues("nothing here", { EMPTY: "" })).toBe("nothing here");
  });
});
