/**
 * Reading the shape of a page out of its HTML: the title, the same-origin links,
 * and the interactive elements a spec could address by role and name.
 *
 * Hand-rolled rather than a parser dependency, and shared by both readers: the
 * browser reader hands `page.content()` to the same function, so a client-side
 * app's rendered DOM and a static fixture page go through one implementation that
 * unit tests drive with no browser at all. The naming is an approximation of an
 * accessible name, not the accessibility tree's answer; docs/explore-mode.md says
 * where that costs us.
 */

import type { FlowElement, PageReader, PageSnapshot } from "./explore.js";

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
/** Controls whose name says the click destroys something. Never followed, never generated. */
export const DESTRUCTIVE = /\b(delete|destroy|remove|revoke|deactivate|cancel subscription|log ?out|sign ?out|reset)\b/i;

const collapse = (value: string): string => value.trim().replaceAll(/\s+/g, " ");

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** Drop comments and decode the entities a name is likely to carry. */
function decodeText(value: string): string {
  return value.replaceAll(/<!--[\s\S]*?-->/g, "").replaceAll(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e);
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR)) {
    const key = (match[1] ?? "").toLowerCase();
    if (key.length === 0) continue;
    out[key] = decodeText(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

/** The ARIA role a spec would use for this tag, or undefined when it is not interactive. */
export function roleOf(tag: string, attrs: Record<string, string>): string | undefined {
  const explicit = attrs["role"];
  if (explicit) return explicit.toLowerCase();
  if (tag === "a") return attrs["href"] === undefined ? undefined : "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag !== "input") return undefined;
  const type = (attrs["type"] ?? "text").toLowerCase();
  if (type === "submit" || type === "button" || type === "reset") return "button";
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "hidden") return undefined;
  return "textbox";
}

/** aria-label, then the attributes a control offers, then its own text. */
function nameOf(attrs: Record<string, string>, text: string): string {
  return collapse(attrs["aria-label"] ?? text ?? "") || collapse(attrs["placeholder"] ?? attrs["value"] ?? attrs["title"] ?? attrs["name"] ?? "");
}

/**
 * Parse one page. `url` is the absolute URL it was read from, used to resolve
 * relative hrefs. Links are returned absolute and unfiltered; the crawl decides
 * which are in scope.
 */
export function parseSnapshot(html: string, url: string): PageSnapshot {
  const title = collapse(decodeText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
  const links: string[] = [];
  const elements: FlowElement[] = [];
  let formDepth = 0;
  // The one open element still collecting its text, if any. Nesting an anchor in
  // a button is invalid HTML, so one slot is enough.
  let open: { tag: string; role: string; attrs: Record<string, string>; from: number } | undefined;

  const push = (role: string, attrs: Record<string, string>, text: string, inForm: boolean) => {
    const name = nameOf(attrs, text);
    const submits = role === "button" && (attrs["type"] ?? "").toLowerCase() !== "button" && (attrs["type"] ?? "").toLowerCase() !== "reset";
    const mutating = (inForm && (role !== "link" || submits)) || DESTRUCTIVE.test(name);
    elements.push({ role, name, mutating });
  };

  for (const match of html.matchAll(TAG)) {
    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const attrs = parseAttrs(match[3] ?? "");
    const end = match.index + match[0].length;
    if (tag === "form") {
      formDepth = closing ? Math.max(0, formDepth - 1) : formDepth + 1;
      continue;
    }
    if (open && closing && tag === open.tag) {
      push(open.role, open.attrs, decodeText(html.slice(open.from, match.index).replaceAll(/<[^>]*>/g, " ")), formDepth > 0);
      open = undefined;
      continue;
    }
    if (closing) continue;
    if (tag === "a" && attrs["href"] !== undefined) {
      try {
        links.push(new URL(attrs["href"], url).href);
      } catch {
        // A javascript: or mailto: href, or something malformed. Not a route.
      }
    }
    const role = roleOf(tag, attrs);
    if (role === undefined) continue;
    if (tag === "a" || tag === "button") open = { tag, role, attrs, from: end };
    else push(role, attrs, "", formDepth > 0);
  }
  return { url, title, links, elements };
}

/**
 * A reader over plain HTTP, with no browser and no credentials: it is what the
 * fixture tests drive, and it is enough for a server-rendered site. Anything that
 * needs a login or client-side rendering wants the browser reader instead.
 */
export function staticReader(fetchImpl: typeof fetch = fetch): PageReader {
  return {
    async read(url) {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`explore: ${url} answered ${response.status}`);
      return parseSnapshot(await response.text(), response.url || url);
    },
    async close() {
      // Nothing to release.
    },
  };
}
