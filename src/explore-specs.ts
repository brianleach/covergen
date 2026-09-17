/**
 * What the existing end to end specs already reach. This is the "coverage" half
 * of explore mode and it never needs a browser: it is text over the repo's own
 * spec files, looking for the two things a Playwright spec says about a flow.
 *
 *   page.goto("/settings/profile")        -> this spec visits that route
 *   getByRole("button", { name: "Save" }) -> this spec addresses that element
 *
 * A template literal segment collapses to :id, as normalizeRoute collapses a
 * crawled URL, so `goto(\`/items/${id}\`)` and a crawl of /items/7 agree they are
 * one route. Over-reading is the safe direction: a spec falsely credited with a
 * route costs one flow that never gets generated, while a missed one costs a
 * duplicate spec the gate still has to pass.
 */

import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeRoute } from "./explore.js";
import type { FlowElement, SpecCoverage } from "./explore.js";

/** One spec file as the scanner sees it. */
export interface SpecFile {
  /** Path as the report should print it, usually relative to the repo cwd. */
  path: string;
  text: string;
}

/** goto with a plain quoted argument, or a template literal. */
const GOTO = /\bgoto\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
/** getByRole("button", { name: "Save" }), with the name optional and possibly a regex. */
const BY_ROLE = /\bgetByRole\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*(?:,\s*\{([^}]*)\})?/g;
const NAME_OPTION = /\bname\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|\/(.*?)\/[a-z]*)/;

const collapse = (value: string): string => value.trim().replaceAll(/\s+/g, " ");

/** `/items/${id}/edit` -> `/items/:id/edit`, before normalizeRoute sees it. */
function stripInterpolation(raw: string): string {
  return raw.replaceAll(/\$\{[^}]*\}/g, ":id");
}

/**
 * Routes and element targets named anywhere in one spec. A `goto` whose argument
 * is a bare variable yields nothing: the scanner cannot know where it went.
 */
export function scanSpec(spec: SpecFile, baseUrl: string): { routes: string[]; targets: string[] } {
  const routes = new Set<string>();
  const targets = new Set<string>();
  for (const match of spec.text.matchAll(GOTO)) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (raw === undefined || raw.length === 0) continue;
    const value = stripInterpolation(raw);
    // An absolute URL on another origin is not this app's route.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith(new URL(baseUrl).origin)) continue;
    try {
      routes.add(normalizeRoute(value, baseUrl));
    } catch {
      // Not a URL and not a path. Nothing to credit.
    }
  }
  for (const match of spec.text.matchAll(BY_ROLE)) {
    const role = (match[1] ?? match[2] ?? "").trim();
    if (role.length === 0) continue;
    const options = match[3] ?? "";
    const name = options.match(NAME_OPTION);
    const raw = name ? (name[1] ?? name[2] ?? name[3] ?? name[4] ?? "") : "";
    targets.add(targetKey(role, raw));
  }
  return { routes: [...routes], targets: [...targets] };
}

/** The key both sides compare on: role plus lowercased name, name optional. */
export function targetKey(role: string, name: string): string {
  return `${role.toLowerCase()}:${collapse(name).toLowerCase()}`;
}

/**
 * An index over every spec, answering the two questions buildFlows asks. A
 * role named with no `name` option matches any element of that role, because
 * `getByRole("button")` on a page with one button is exactly that assertion.
 */
export function indexSpecs(specs: readonly SpecFile[], baseUrl: string): SpecCoverage {
  const byRoute = new Map<string, string[]>();
  const targets = new Set<string>();
  const bareRoles = new Set<string>();
  for (const spec of specs) {
    const scanned = scanSpec(spec, baseUrl);
    for (const route of scanned.routes) byRoute.set(route, [...(byRoute.get(route) ?? []), spec.path]);
    for (const target of scanned.targets) {
      targets.add(target);
      if (target.endsWith(":")) bareRoles.add(target.slice(0, -1));
    }
  }
  return {
    specsForRoute: (route) => byRoute.get(route) ?? [],
    addressesElement: (element: FlowElement) =>
      bareRoles.has(element.role.toLowerCase()) || targets.has(targetKey(element.role, element.name)),
  };
}

/** Read the spec files one repo's `explore.spec_glob` matches, in path order. */
export async function loadSpecs(cwd: string, specGlob: string): Promise<SpecFile[]> {
  const paths: string[] = [];
  for await (const entry of glob(specGlob, { cwd })) {
    const rel = (typeof entry === "string" ? entry : String(entry)).replaceAll("\\", "/");
    if (rel.length > 0) paths.push(rel);
  }
  paths.sort();
  return Promise.all(paths.map(async (path) => ({ path, text: await readFile(join(cwd, path), "utf8") })));
}
