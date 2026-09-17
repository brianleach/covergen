/**
 * Explore mode: the flow model. Design and rationale in docs/explore-mode.md.
 *
 * There is no lcov here. The unit of coverage is a flow: a route plus the
 * interactive elements on it, covered when an existing end to end spec navigates
 * to the route and names its elements. This file holds the shapes the rest of
 * the mode agrees on and the route normalization both halves depend on, so it is
 * pure and needs no browser.
 */

/** One interactive element, as a Playwright spec would address it. */
export interface FlowElement {
  /** ARIA role: link, button, textbox, checkbox, combobox. */
  role: string;
  /** Accessible name, trimmed and collapsed. Empty when the page gave none. */
  name: string;
  /** True when using it writes: a control inside a form, or a destructive name. */
  mutating: boolean;
}

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

/** How a spec index answers the two coverage questions. Built in explore-specs.ts. */
export interface SpecCoverage {
  specsForRoute(route: string): string[];
  addressesElement(element: FlowElement): boolean;
}
