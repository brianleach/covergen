import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserAvailable, openBrowserReader } from "./explore-browser.js";
import { parseSnapshot, staticReader } from "./explore-html.js";
import { indexSpecs } from "./explore-specs.js";
import {
  buildFlows,
  blockedReason,
  crawl,
  exploreEnv,
  fetchSitemap,
  inScope,
  matchRoute,
  normalizeRoute,
  parseSitemap,
  rankFlow,
  renderReport,
  sessionFailure,
} from "./explore.js";
import type { PageReader, PageSnapshot } from "./explore.js";

/**
 * A tiny site, served over loopback from a temp server, standing in for a web app
 * behind a login: a nav, a list with per-item routes, a settings form that writes,
 * a billing page, and a logout route the crawl must never visit. Inline rather
 * than on disk so the whole target is readable beside the assertions.
 */
const PAGES: Record<string, string> = {
  "/": `<html><head><title>Home</title></head><body><nav>
    <a href="/items">Items</a> <a href="/settings/profile">Profile</a>
    <a href="/billing">Billing</a> <a href="/logout">Log out</a>
    <a href="https://elsewhere.test/docs">Docs</a></nav></body></html>`,
  "/items": `<html><head><title>Items</title></head><body>
    <a href="/items/1">First item</a> <a href="/items/2">Second item</a>
    <a href="/items/new">New item</a></body></html>`,
  "/items/1": `<html><head><title>Item</title></head><body>
    <form action="/items/1/delete" method="post"><button type="submit">Delete item</button></form>
    </body></html>`,
  "/items/2": `<html><head><title>Item</title></head><body>
    <form action="/items/2/delete" method="post"><button type="submit">Delete item</button></form>
    </body></html>`,
  "/items/new": `<html><head><title>New item</title></head><body>
    <form method="post"><input aria-label="Item name"><button type="submit">Create</button></form>
    </body></html>`,
  "/settings/profile": `<html><head><title>Profile</title></head><body>
    <form method="post"><input aria-label="Display name"><button type="submit">Save changes</button></form>
    </body></html>`,
  "/billing": `<html><head><title>Billing</title></head><body>
    <form method="post"><input aria-label="Card number"><button type="submit">Update card</button></form>
    </body></html>`,
  "/logout": `<html><head><title>Logged out</title></head><body>Goodbye</body></html>`,
  // Linked from nowhere: what a client-side router reaches, only a seed finds it.
  "/hidden": `<html><head><title>Reports</title></head><body><a href="/items">Back to items</a></body></html>`,
  // A label the parser resolves, and a button in shadow DOM that page.content() never shows.
  "/client": `<html><head><title>Client</title></head><body>
    <label for="q">Search items</label><input id="q" placeholder="Type here"><x-menu></x-menu>
    <script>customElements.define("x-menu", class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<button>Made in shadow</button>"; }
    });</script></body></html>`,
  "/login": `<html><head><title>Log in</title></head><body>
    <form method="post"><input aria-label="Email"><button type="submit">Log in</button></form></body></html>`,
  "/app": `<html><head><title>Dashboard</title></head><body><button aria-label="Account menu">AM</button></body></html>`,
};

/** Two specs that already exist in the imaginary repo, in the shape a real one has. */
const SPECS = [
  {
    path: "e2e/items.spec.ts",
    text: `test("lists items", async ({ page }) => {
      await page.goto("/items");
      await page.getByRole("link", { name: "New item" }).click();
    });`,
  },
  {
    path: "e2e/profile.spec.ts",
    text: `test("saves the profile", async ({ page }) => {
      await page.goto("/settings/profile");
      await page.getByRole("textbox", { name: "Display name" }).fill("Ada");
      await page.getByRole("button", { name: "Save changes" }).click();
    });`,
  },
];

const IGNORE = ["/logout"];

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/(.)\/$/, "$1");
    if (path === "/app" && !(req.headers.cookie ?? "").includes("session=ok")) {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    if (path === "/sitemap.xml") {
      const origin = `http://${req.headers.host}`;
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<urlset><url><loc>${origin}/hidden</loc></url><url><loc> ${origin}/hidden/ </loc></url>
        <url><loc>https://elsewhere.test/hidden</loc></url><url><loc>${origin}/logout</loc></url></urlset>`);
      return;
    }
    const body = PAGES[path];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    res.end(body ?? "<html><title>Not found</title></html>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

describe("normalizeRoute", () => {
  it("drops the query, the hash and the trailing slash", () => {
    expect(normalizeRoute("https://app.test/items/?page=2#top", "https://app.test")).toBe("/items");
    expect(normalizeRoute("https://app.test", "https://app.test")).toBe("/");
  });

  it("collapses the segments that identify one record", () => {
    const b = "https://app.test";
    expect(normalizeRoute("/items/42/edit", b)).toBe("/items/:id/edit");
    expect(normalizeRoute("/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301", b)).toBe("/u/:id");
    expect(normalizeRoute("/orders/a1b2c3d4e5f60718", b)).toBe("/orders/:id");
    expect(normalizeRoute("/Settings/Profile", b)).toBe("/settings/profile");
  });
});

describe("matchRoute and inScope", () => {
  it("matches a literal, a segment wildcard and a crossing wildcard", () => {
    expect(matchRoute("/logout", "/logout")).toBe(true);
    expect(matchRoute("/admin/users/:id", "/admin/**")).toBe(true);
    expect(matchRoute("/admin/users/:id", "/admin/*")).toBe(false);
    expect(matchRoute("/items", "/admin/**")).toBe(false);
  });

  it("keeps the crawl on one origin and off the ignored routes", () => {
    const b = "https://app.test/";
    expect(inScope("https://app.test/items", b, IGNORE)).toBe(true);
    expect(inScope("https://elsewhere.test/items", b, IGNORE)).toBe(false);
    expect(inScope("mailto:someone@example.test", b, IGNORE)).toBe(false);
    expect(inScope("https://app.test/logout", b, IGNORE)).toBe(false);
  });
});

/** A reader over PAGES that records what it was asked for, and never writes. */
function fakeReader(read: string[]): PageReader {
  return {
    async read(url) {
      read.push(url);
      return parseSnapshot(PAGES[new URL(url).pathname] ?? "", url);
    },
    async close() {},
  };
}

describe("crawl", () => {
  it("stops at max_pages", async () => {
    const read: string[] = [];
    const pages = await crawl(fakeReader(read), { baseUrl: "https://app.test/", maxPages: 3, ignore: IGNORE });
    expect(pages.length).toBe(3);
    expect(read.map((u) => new URL(u).pathname)).toEqual(["/", "/items", "/settings/profile"]);
  });

  it("reads one page per record route and never visits an ignored one", async () => {
    const read: string[] = [];
    await crawl(fakeReader(read), { baseUrl: "https://app.test/", maxPages: 20, ignore: IGNORE });
    expect(read.filter((u) => u.includes("/items/"))).toEqual(["https://app.test/items/1", "https://app.test/items/new"]);
    expect(read.some((u) => u.endsWith("/logout"))).toBe(false);
  });
});

describe("rankFlow", () => {
  it("puts a money write above a read-only page of the same size, and says why", () => {
    const money = rankFlow("/billing/checkout", [{ role: "textbox", name: "Card", mutating: true }], false);
    expect(money.value).toBeGreaterThan(rankFlow("/about", [{ role: "link", name: "Home", mutating: false }], false).value);
    expect(money.reasons).toEqual(["writes", "money"]);
    expect(rankFlow("/", [], true).reasons).toEqual(["entry point"]);
    expect(rankFlow("/login", [], false).reasons).toEqual(["auth"]);
  });
});

describe("the dry run over the fixture site", () => {
  it("crawls read-only, matches the existing specs, and reports the uncovered flows", async () => {
    const reader = staticReader();
    const pages = await crawl(reader, { baseUrl: base, maxPages: 25, ignore: IGNORE });
    const routes = pages.map((p) => normalizeRoute(p.url, base));
    expect(routes).toEqual(["/", "/items", "/settings/profile", "/billing", "/items/:id", "/items/new"]);

    const flows = buildFlows(pages, base, indexSpecs(SPECS, base), ["/settings/**"]);
    const byRoute = new Map(flows.map((f) => [f.route, f]));

    // The profile spec names the route and both of its controls, so nothing is left.
    expect(byRoute.get("/settings/profile")?.covered).toBe(true);
    // The items spec reaches the route but only addresses one of its three links.
    const items = byRoute.get("/items");
    expect(items?.coveredBy).toEqual(["e2e/items.spec.ts"]);
    expect(items?.covered).toBe(false);
    expect(items?.targets.map((e) => e.name)).toEqual(["First item", "Second item"]);
    // Billing is untouched, ranks on money, and its writes are not allowlisted.
    const billing = byRoute.get("/billing");
    expect(billing?.coveredBy).toEqual([]);
    expect(billing?.reasons).toEqual(["writes", "money"]);
    expect(blockedReason(billing as never)).toBe("not in explore.allow_mutations");
    // The record route's only control deletes, so a dry run offers nothing there.
    expect(byRoute.get("/items/:id")?.targets).toEqual([]);

    const report = renderReport(flows, { baseUrl: base, pages: pages.length, maxPages: 25 });
    expect(report).toContain("6 routes crawled (max 25), 1 covered, 5 uncovered");
    expect(report).toContain("/items/new");
    expect(report).toContain("2 flows a generation pass would target:");
  });
});

describe("seeded routes", () => {
  it("crawls a route only a seed reaches, marks it seeded, and keeps max_pages the ceiling", async () => {
    const read: string[] = [];
    const pages = await crawl(fakeReader(read), { baseUrl: "https://app.test/", maxPages: 20, ignore: IGNORE, seeds: ["/hidden", "/logout"] });
    expect(read.map((u) => new URL(u).pathname).slice(0, 2)).toEqual(["/", "/hidden"]);
    expect(read.some((u) => u.endsWith("/logout"))).toBe(false);
    const flows = buildFlows(pages, "https://app.test/", indexSpecs([], "https://app.test/"), []);
    expect(flows.find((f) => f.route === "/hidden")?.reasons).toContain("seeded");
    expect(flows.find((f) => f.route === "/items")?.reasons).not.toContain("seeded");

    const capped: string[] = [];
    await crawl(fakeReader(capped), { baseUrl: "https://app.test/", maxPages: 2, ignore: IGNORE, seeds: ["/hidden", "/billing", "/items/new"] });
    expect(capped.map((u) => new URL(u).pathname)).toEqual(["/", "/hidden"]);
  });

  it("reads a sitemap down to the in-scope routes, once each", async () => {
    const xml = `<urlset><url><loc>https://app.test/a</loc></url><url><loc>https://app.test/a/</loc></url>
      <url><loc>https://other.test/a</loc></url><url><loc>https://app.test/logout</loc></url><url><loc>https://app.test/b?x=1&amp;y=2</loc></url></urlset>`;
    expect(parseSitemap(xml, "https://app.test/", IGNORE)).toEqual(["https://app.test/a", "https://app.test/b?x=1&y=2"]);
  });

  it("fetches the fixture sitemap and seeds only the in-scope route", async () => {
    const seeds = await fetchSitemap(base, IGNORE);
    expect(seeds).toEqual([`${base}hidden`]);
    expect(await fetchSitemap("http://127.0.0.1:1/", IGNORE)).toEqual([]);
    const pages = await crawl(staticReader(), { baseUrl: base, maxPages: 25, ignore: IGNORE, seeds });
    expect(pages.filter((p) => p.seeded).map((p) => normalizeRoute(p.url, base))).toEqual(["/hidden"]);
  });
});

describe("the session check", () => {
  const SENTINEL = "/outside/SENTINEL-state-path.json";
  const withCookie: typeof fetch = (input, init) => fetch(input, { ...init, headers: { cookie: "session=ok" } });

  it("catches the bounce to a login page when no marker is configured", async () => {
    const { storageStatePath } = exploreEnv(
      { baseUrlEnv: "X_BASE", storageStateEnv: "X_STATE", allowMutations: [], maxPages: 5, ignorePatterns: [], specGlob: "", seedRoutes: [], sitemap: false, testCommand: [], specDir: "e2e", k: 3, timeoutMs: 1 },
      { X_BASE: `${base}app`, X_STATE: SENTINEL },
    );
    const read: string[] = [];
    const reader: PageReader = { read: (url) => (read.push(url), staticReader().read(url)), close: async () => {} };
    let message = "";
    await expect(
      crawl(reader, {
        baseUrl: `${base}app`,
        maxPages: 25,
        ignore: IGNORE,
        verify: (first) => {
          message = sessionFailure(first, { baseUrl: `${base}app`, hasSession: storageStatePath !== undefined }) ?? "";
          if (message) throw new Error(message);
        },
      }),
    ).rejects.toThrow(/session check failed/);
    expect(read.length).toBe(1);
    expect(message).toContain("redirected to /login");
    expect(message).not.toContain("SENTINEL");
  });

  it("passes with the marker on the first page and fails without it, with the documented message", async () => {
    const loggedIn = { role: "button", name: "account MENU" };
    const good = await staticReader(withCookie).read(`${base}app`);
    expect(sessionFailure(good, { baseUrl: `${base}app`, loggedIn, hasSession: true })).toBeUndefined();
    const bounced = await staticReader().read(`${base}app`);
    const message = sessionFailure(bounced, { baseUrl: `${base}app`, loggedIn: { role: "button", name: "Account menu" }, hasSession: true });
    expect(message).toBe(
      'explore: session check failed: the first page does not show button "Account menu". The saved session is missing or expired; log in again and re-save it.',
    );
    expect(message).not.toContain("SENTINEL");
    // No session and no marker: nothing to check, and the public home page passes.
    expect(sessionFailure(await staticReader().read(base), { baseUrl: base, hasSession: false })).toBeUndefined();
  });

  it("names the mode in the report header and never the session file", () => {
    const report = renderReport([], { baseUrl: base, pages: 1, maxPages: 5, session: "heuristic" });
    expect(report).toContain("session: heuristic");
    expect(report).not.toContain("SENTINEL");
  });
});

describe("exploreEnv", () => {
  const options = {
    baseUrlEnv: "X_BASE",
    storageStateEnv: "X_STATE",
    allowMutations: [],
    maxPages: 5,
    ignorePatterns: [],
    specGlob: "e2e/**/*.spec.ts",
    seedRoutes: [],
    sitemap: false,
    testCommand: ["npx", "playwright", "test"],
    specDir: "e2e",
    k: 3,
    timeoutMs: 120_000,
  };

  it("reads both from the environment and treats a missing session as legal", () => {
    expect(exploreEnv(options, { X_BASE: "https://app.test" })).toEqual({ baseUrl: "https://app.test", storageStatePath: undefined });
    expect(exploreEnv(options, { X_BASE: "https://app.test", X_STATE: "/outside/state.json" }).storageStatePath).toBe("/outside/state.json");
  });

  it("refuses to guess the target", () => {
    expect(() => exploreEnv(options, {})).toThrow(/X_BASE/);
  });
});

// CI has no browser. The crawl, the matching and the report are proven above
// without one; this is the seam that says the browser reader returns the same
// snapshot shape from the same site when a browser does exist.
const hasBrowser = await browserAvailable();

describe.skipIf(!hasBrowser)("the browser reader", () => {
  it("reads the fixture site through Chromium and agrees with the static reader", async () => {
    const reader = await openBrowserReader();
    try {
      const fromBrowser = await reader.read(base);
      const fromStatic: PageSnapshot = await staticReader().read(base);
      expect(fromBrowser.title).toBe(fromStatic.title);
      expect(fromBrowser.elements).toEqual(fromStatic.elements);
    } finally {
      await reader.close();
    }
  }, 60_000);
});

describe.skipIf(!hasBrowser)("the browser reader's aria correction", () => {
  it("names the labelled input and adds the shadow DOM button, counting both", async () => {
    const counts: { corrected: number; appended: number }[] = [];
    const reader = await openBrowserReader({ onNames: (c) => counts.push(c) });
    try {
      const page = await reader.read(`${base}client`);
      expect(page.elements).toEqual([
        { role: "textbox", name: "Search items", mutating: false },
        { role: "button", name: "Made in shadow", mutating: true },
      ]);
      expect(counts).toEqual([{ corrected: 0, appended: 1 }]);
    } finally {
      await reader.close();
    }
  }, 60_000);
});
