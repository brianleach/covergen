/**
 * Explore mode: the flow model, the read-only crawl, the ranking, and the
 * uncovered-flow report. Design and rationale in docs/explore-mode.md.
 *
 * There is no lcov here. The unit of coverage is a flow: a route plus the
 * interactive elements on it, covered when an existing end to end spec navigates
 * to the route and names its elements. Everything here is pure apart from the
 * crawl, which drives a PageReader it never constructs, so the whole model is
 * testable against a fixture site with no browser.
 */

import type { ExploreOptions } from "./types.js";

/** One interactive element, as a Playwright spec would address it. */
export interface FlowElement {
  /** ARIA role: link, button, textbox, checkbox, combobox. */
  role: string;
  /** Accessible name, trimmed and collapsed. Empty when the page gave none. */
  name: string;
  /** True when using it writes: a control inside a form, or a destructive name. */
  mutating: boolean;
}

/** What a reader returns for one page: its shape, never its body. */
export interface PageSnapshot {
  /** Absolute URL after redirects. */
  url: string;
  title: string;
  /** Absolute hrefs found on the page, in document order and unfiltered. */
  links: string[];
  elements: FlowElement[];
}

/** Reads pages read-only. One implementation per backend, browser or static. */
export interface PageReader {
  read(url: string): Promise<PageSnapshot>;
  close(): Promise<void>;
}

/** A route plus its elements, ranked, with the specs that already exercise it. */
export interface Flow {
  /** Normalized pathname, record segments collapsed to :id. */
  route: string;
  url: string;
  title: string;
  elements: FlowElement[];
  value: number;
  /** Which ranking weights fired, so the order can be argued with. */
  reasons: string[];
  /** Spec files whose page.goto reaches this route. */
  coveredBy: string[];
  /** Elements no spec addresses by role and name. */
  uncovered: FlowElement[];
  /** The uncovered elements generation may use: no writes unless `writable`. */
  targets: FlowElement[];
  covered: boolean;
  /** True when explore.allow_mutations covers this route. */
  writable: boolean;
}

const MONEY = /\b(checkout|billing|payment|pay|invoice|subscription|subscribe|order|cart|refund)\b/;
const AUTH = /\b(login|signin|sign-in|signup|sign-up|register|password|session|auth|verify|mfa|2fa|token|api-key)\b/;

/**
 * Collapse a URL to a route. Query, hash and the trailing slash go, and a segment
 * that identifies one record (digits, a uuid, a long id) becomes :id, so
 * /items/1 and /items/2 are one flow rather than two entries of the same form.
 */
export function normalizeRoute(url: string, base: string): string {
  const segments = new URL(url, base).pathname.split("/").filter((s) => s.length > 0);
  const collapsed = segments.map((s) => {
    const decoded = decodeURIComponent(s);
    if (/^\d+$/.test(decoded)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) return ":id";
    if (/^[0-9a-z]{16,}$/i.test(decoded) && /\d/.test(decoded)) return ":id";
    return decoded.toLowerCase();
  });
  return collapsed.length === 0 ? "/" : `/${collapsed.join("/")}`;
}

/**
 * Match a route against one pattern. `*` stops at a separator, `**` crosses them,
 * everything else is literal. Deliberately small: these patterns are written by
 * the owner about their own routes, not discovered.
 */
export function matchRoute(route: string, pattern: string): boolean {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.split("**").map((part) => part.replaceAll("*", "[^/]*")).join(".*");
  return new RegExp(`^${body}$`).test(route);
}

/** True when the URL is on the base origin, over http, and not ignored. */
export function inScope(url: string, base: string, ignore: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.origin !== new URL(base).origin) return false;
  return !ignore.some((pattern) => matchRoute(normalizeRoute(parsed.href, base), pattern));
}

/**
 * Breadth first from the base URL, one page per route, read-only throughout: the
 * reader navigates and reads, it never clicks, fills or submits. A route already
 * seen is not read again, so a list of a thousand items costs one page. Stops at
 * `maxPages`, which is the only thing between a crawl and a whole site.
 */
export async function crawl(
  reader: PageReader,
  opts: { baseUrl: string; maxPages: number; ignore: readonly string[] },
): Promise<PageSnapshot[]> {
  const seen = new Set<string>();
  const queue: string[] = [opts.baseUrl];
  const pages: PageSnapshot[] = [];
  while (queue.length > 0 && pages.length < opts.maxPages) {
    const next = queue.shift() as string;
    if (!inScope(next, opts.baseUrl, opts.ignore)) continue;
    const route = normalizeRoute(next, opts.baseUrl);
    if (seen.has(route)) continue;
    seen.add(route);
    const snapshot = await reader.read(next);
    pages.push(snapshot);
    for (const link of snapshot.links) {
      if (!inScope(link, opts.baseUrl, opts.ignore)) continue;
      if (seen.has(normalizeRoute(link, opts.baseUrl))) continue;
      queue.push(new URL(link, opts.baseUrl).href);
    }
  }
  return pages;
}

/**
 * Rank a flow by what a regression would cost: entry points, writes, money and
 * auth carry the weight, and the element count only breaks ties, under a square
 * root, so a busy settings page does not outrank checkout on volume alone.
 */
export function rankFlow(route: string, elements: readonly FlowElement[], isEntry: boolean): { value: number; reasons: string[] } {
  const reasons: string[] = [];
  let weight = 1;
  const add = (points: number, reason: string) => {
    weight += points;
    reasons.push(reason);
  };
  if (isEntry) add(2, "entry point");
  if (elements.some((e) => e.mutating)) add(2, "writes");
  if (MONEY.test(route)) add(3, "money");
  if (AUTH.test(route)) add(2, "auth");
  return { value: Math.round(weight * Math.sqrt(1 + elements.length) * 100) / 100, reasons };
}

/** How a spec index answers the two coverage questions. Built in explore-specs.ts. */
export interface SpecCoverage {
  specsForRoute(route: string): string[];
  addressesElement(element: FlowElement): boolean;
}

/** Crawled pages into ranked flows, with coverage from the specs that exist. */
export function buildFlows(pages: readonly PageSnapshot[], baseUrl: string, specs: SpecCoverage, allowMutations: readonly string[]): Flow[] {
  const entry = normalizeRoute(baseUrl, baseUrl);
  const flows = pages.map((page) => {
    const route = normalizeRoute(page.url, baseUrl);
    const coveredBy = specs.specsForRoute(route);
    const uncovered = page.elements.filter((e) => !specs.addressesElement(e));
    const writable = allowMutations.some((pattern) => matchRoute(route, pattern));
    return {
      route,
      url: page.url,
      title: page.title,
      elements: page.elements,
      ...rankFlow(route, page.elements, route === entry),
      coveredBy,
      uncovered,
      targets: uncovered.filter((e) => writable || !e.mutating),
      covered: coveredBy.length > 0 && uncovered.length === 0,
      writable,
    };
  });
  return flows.sort((a, b) => b.value - a.value || a.route.localeCompare(b.route));
}

/** Why a flow cannot be generated against yet, or the empty string when it can. */
export function blockedReason(flow: Flow): string {
  if (flow.covered) return "already covered";
  if (flow.uncovered.length === 0) return "no addressable elements";
  if (flow.targets.length === 0) return "not in explore.allow_mutations";
  return "";
}

/** The dry-run report: the flow map, covered against uncovered, and what blocks each. */
export function renderReport(flows: readonly Flow[], opts: { baseUrl: string; pages: number; maxPages: number }): string {
  const covered = flows.filter((f) => f.covered).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines = [
    `explore ${opts.baseUrl}: ${plural(opts.pages, "route")} crawled (max ${opts.maxPages}), ${covered} covered, ${flows.length - covered} uncovered`,
    "",
    ["value".padStart(7), "cov", "route".padEnd(34), "els", "why"].join("  "),
  ];
  for (const flow of flows) {
    const why = [...flow.reasons, blockedReason(flow)].filter((s) => s.length > 0).join(", ");
    const cells = [
      flow.value.toFixed(2).padStart(7),
      (flow.covered ? "yes" : "no").padEnd(3),
      flow.route.slice(0, 34).padEnd(34),
      String(flow.elements.length).padStart(3),
      why,
    ];
    lines.push(cells.join("  "));
  }
  const open = flows.filter((f) => blockedReason(f) === "");
  lines.push("", `${plural(open.length, "flow")} a generation pass would target:`);
  for (const flow of open.slice(0, 10)) {
    const missing = flow.targets.slice(0, 4).map((e) => `${e.role} "${e.name}"`).join(", ");
    const seen = flow.coveredBy.length > 0 ? ` (route seen in ${flow.coveredBy.join(", ")})` : "";
    lines.push(`  ${flow.route}${seen}: ${missing}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The base URL and the storage state path, from the environment variables the
 * config names. A missing session is legal: a site with no login, or a first
 * crawl of the public half. The session value is a path, never a credential, and
 * nothing here reads the file it points at.
 */
export function exploreEnv(options: ExploreOptions, env: NodeJS.ProcessEnv = process.env): { baseUrl: string; storageStatePath?: string } {
  const baseUrl = env[options.baseUrlEnv]?.trim();
  if (!baseUrl) throw new Error(`explore needs a base URL. Set ${options.baseUrlEnv} to the target the owner marked as explorable.`);
  return { baseUrl, storageStatePath: env[options.storageStateEnv]?.trim() || undefined };
}
