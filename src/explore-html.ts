/**
 * Reading the shape of a page out of its HTML: the title, the same-origin links,
 * and the interactive elements a spec could address by role and name.
 *
 * Hand-rolled rather than a parser dependency, and shared by both readers: the
 * browser reader hands `page.content()` to the same function, so a client-side
 * app's rendered DOM and a static fixture page go through one implementation that
 * unit tests drive with no browser at all. Names follow the accessible-name
 * order (aria-labelledby, aria-label, an associated label, own text, then title,
 * placeholder and value), which covers what a static page can say; the browser
 * reader then corrects them against the accessibility tree.
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

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const LABELABLE = new Set(["button", "input", "select", "textarea"]);

/** Index of the tag closing the `tag` opened just before `from`, counting nesting. */
function closeOf(html: string, tag: string, from: number): number {
  const re = new RegExp(`<(/?)${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return html.length;
}

/** Text content of a fragment: an image speaks through its alt, a nested control's own text is not label text. */
function textOf(fragment: string): string {
  const stripped = fragment
    .replaceAll(/<(select|textarea)\b[\s\S]*?<\/\1>/gi, " ")
    .replaceAll(/<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (_, raw: string) => ` ${parseAttrs(raw)["alt"] ?? ""} `)
    .replaceAll(/<[^>]*>/g, " ");
  return collapse(decodeText(stripped));
}

/** What the first pass learns: text by id, label text by `for`, and the ranges wrapping labels cover. */
interface NameSources {
  ids: Map<string, string>;
  labelFor: Map<string, string>;
  wrapping: { from: number; to: number; text: string }[];
}

function collectNameSources(html: string): NameSources {
  const sources: NameSources = { ids: new Map(), labelFor: new Map(), wrapping: [] };
  for (const match of html.matchAll(TAG)) {
    if (match[1] === "/") continue;
    const tag = (match[2] ?? "").toLowerCase();
    const attrs = parseAttrs(match[3] ?? "");
    const from = match.index + match[0].length;
    if (VOID.has(tag) || match[0].endsWith("/>")) continue;
    if (attrs["id"] === undefined && tag !== "label") continue;
    const text = textOf(html.slice(from, closeOf(html, tag, from)));
    if (attrs["id"] !== undefined && !sources.ids.has(attrs["id"])) sources.ids.set(attrs["id"], text);
    if (tag !== "label") continue;
    if (attrs["for"] !== undefined) {
      if (!sources.labelFor.has(attrs["for"])) sources.labelFor.set(attrs["for"], text);
    } else sources.wrapping.push({ from, to: closeOf(html, tag, from), text });
  }
  return sources;
}

/** The accessible-name order, first non-empty source wins. */
function nameOf(attrs: Record<string, string>, text: string, label: string | undefined, ids: Map<string, string>): string {
  const labelledBy = (attrs["aria-labelledby"] ?? "")
    .split(/\s+/)
    .filter((id) => id.length > 0)
    .map((id) => ids.get(id) ?? "")
    .join(" ");
  const candidates = [labelledBy, attrs["aria-label"], label, text, attrs["title"], attrs["placeholder"], attrs["value"]];
  for (const candidate of candidates) {
    const name = collapse(candidate ?? "");
    if (name.length > 0) return name;
  }
  return "";
}

/**
 * Parse one page. `url` is the absolute URL it was read from, used to resolve
 * relative hrefs. Links are returned absolute and unfiltered; the crawl decides
 * which are in scope. Two passes: the first collects what other elements say
 * about a control (ids, labels), the second names each control from them.
 */
export function parseSnapshot(page: string, url: string): PageSnapshot {
  // Script and style bodies are not markup: a tag inside a string literal is not an element.
  const html = page.replaceAll(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  const title = collapse(decodeText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
  const sources = collectNameSources(html);
  const links: string[] = [];
  const elements: FlowElement[] = [];
  let formDepth = 0;
  // The one open element still collecting its text, if any. Nesting an anchor in
  // a button is invalid HTML, so one slot is enough.
  let open: { tag: string; role: string; attrs: Record<string, string>; from: number; label?: string } | undefined;

  const labelAt = (tag: string, attrs: Record<string, string>, at: number): string | undefined => {
    if (!LABELABLE.has(tag)) return undefined;
    const byFor = attrs["id"] === undefined ? undefined : sources.labelFor.get(attrs["id"]);
    return byFor ?? sources.wrapping.find((range) => at >= range.from && at < range.to)?.text;
  };

  const push = (role: string, attrs: Record<string, string>, text: string, label: string | undefined, inForm: boolean) => {
    const name = nameOf(attrs, text, label, sources.ids);
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
      push(open.role, open.attrs, textOf(html.slice(open.from, match.index)), open.label, formDepth > 0);
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
    const label = labelAt(tag, attrs, match.index);
    if (tag === "a" || tag === "button") open = { tag, role, attrs, from: end, label };
    else push(role, attrs, "", label, formDepth > 0);
  }
  return { url, title, links, elements };
}

/** The roles worth a target. Structure (headings, lists, landmarks) and plain text are not. */
const INTERACTIVE = new Set([
  "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "switch",
  "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
]);

/**
 * The interactive entries of a Playwright aria snapshot, in document order. The
 * snapshot is YAML shaped: `- role "name" [attrs]:` per node, with text and
 * property lines (`- text: ...`, `- /url: ...`) that are not elements.
 */
export function parseAriaSnapshot(text: string): { role: string; name: string }[] {
  const out: { role: string; name: string }[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
    if (!match || !INTERACTIVE.has(match[1] ?? "")) continue;
    let name = match[2] ?? "";
    try {
      name = JSON.parse(`"${name}"`) as string;
    } catch {
      // An escape JSON does not know; the raw text is the better guess.
    }
    out.push({ role: match[1] as string, name: collapse(name) });
  }
  return out;
}

/**
 * Correct the HTML parse with the accessibility tree. Per role, in document
 * order, the nth parsed element pairs with the nth snapshot entry: a different
 * name takes the snapshot's, the `mutating` flag stays the parser's. Entries only
 * the snapshot has (script-rendered, shadow DOM) are appended, and since nothing
 * says whether they write, everything but a plainly named link counts as mutating.
 */
export function mergeAriaNames(
  parsed: readonly FlowElement[],
  aria: readonly { role: string; name: string }[],
): { elements: FlowElement[]; corrected: number; appended: number } {
  const byRole = new Map<string, { role: string; name: string }[]>();
  for (const entry of aria) byRole.set(entry.role, [...(byRole.get(entry.role) ?? []), entry]);
  const used = new Map<string, number>();
  let corrected = 0;
  const elements = parsed.map((element) => {
    const index = used.get(element.role) ?? 0;
    used.set(element.role, index + 1);
    const match = byRole.get(element.role)?.[index];
    if (!match || match.name === element.name) return element;
    corrected += 1;
    return { ...element, name: match.name };
  });
  let appended = 0;
  for (const [role, entries] of byRole) {
    for (const entry of entries.slice(used.get(role) ?? 0)) {
      appended += 1;
      elements.push({ role, name: entry.name, mutating: role !== "link" || DESTRUCTIVE.test(entry.name) });
    }
  }
  return { elements, corrected, appended };
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
