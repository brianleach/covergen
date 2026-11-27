/**
 * The statements of a generated end to end spec, in order, each classified.
 *
 * A small scanner, not a parser: comments and string contents are blanked
 * first so nothing inside them can open a block or end a statement, then the
 * text is split into statements at `;`, at a newline where the expression
 * cannot continue, and at the brace that closes a block. A statement whose
 * block holds statements of its own (the `test(...)` call, an `if`) is not a
 * step; its inner statements are. `no_assertion` and `action_removable` read
 * the result: which assertions come after the first action, and which action
 * is the main one.
 */

export type StepKind = "action" | "assertion" | "navigation" | "other";

export interface Step {
  kind: StepKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The action method (`click`, `goto`), the assertion matcher (`toHaveURL`), or `waitForResponse`. Empty for other. */
  verb: string;
  /** The statement's source text, comments included. */
  text: string;
}

interface Raw {
  start: number;
  end: number;
  children: Raw[];
}

/** The code with comments and string contents replaced by spaces, newlines kept, so offsets and lines stay the same. */
export function blankOut(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i] ?? "";
    if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      const block = code[i + 1] === "*";
      const close = block ? code.indexOf("*/", i + 2) : code.indexOf("\n", i);
      const end = close === -1 ? code.length : block ? close + 2 : close;
      out += code.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      out += c + code.slice(i + 1, Math.min(j, code.length)).replace(/[^\n]/g, " ") + (j < code.length ? c : "");
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const CONTINUES_AFTER = /[=(,+\-*/&|?:.!<>[{]$/;
const CONTINUES_BEFORE = /^(?:\.|\?\.|[)\]+\-*/&|?:,=])/;
const KEEPS_AFTER_BLOCK = /^(?:[;),.?\]]|else\b|catch\b|finally\b|while\b)/;

function nextCode(c: string, i: number): string {
  return c.slice(i).replace(/^\s+/, "");
}

function parseBlock(c: string, from: number): { stmts: Raw[]; next: number } {
  const stmts: Raw[] = [];
  let i = from;
  for (;;) {
    while (i < c.length && /[\s;]/.test(c[i] ?? "")) i += 1;
    if (i >= c.length) return { stmts, next: i };
    if (c[i] === "}") return { stmts, next: i + 1 };
    const start = i;
    const children: Raw[] = [];
    let depth = 0;
    while (i < c.length) {
      const ch = c[i];
      if (ch === "(" || ch === "[") {
        depth += 1;
        i += 1;
      } else if (ch === ")" || ch === "]") {
        if (depth === 0) {
          i += 1;
          continue;
        }
        depth -= 1;
        i += 1;
      } else if (ch === "{") {
        const inner = parseBlock(c, i + 1);
        // Inside parentheses, a block with no step in it is an object literal or a destructuring, part of this statement.
        if (depth === 0 || inner.stmts.some((r) => significant(c, r))) children.push(...inner.stmts);
        i = inner.next;
        if (depth === 0 && !KEEPS_AFTER_BLOCK.test(nextCode(c, i))) break;
      } else if (ch === "}") {
        break;
      } else if (ch === ";" && depth === 0) {
        i += 1;
        break;
      } else if (ch === "\n" && depth === 0 && !CONTINUES_AFTER.test(c.slice(start, i).trimEnd()) && !CONTINUES_BEFORE.test(nextCode(c, i))) {
        break;
      } else {
        i += 1;
      }
    }
    stmts.push({ start, end: i, children });
  }
}

const SIGNIFICANT = /^(?:await\b|expect\s*[.(]|(?:const|let|var)\s+[\w$]+\s*=\s*await\b)/;
const ACTIONS = /\.\s*(click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles|tap|dragTo)\s*\(/;
const EXPECT = /^(?:(?:const|let|var)\s+[\w$]+\s*=\s*)?(?:await\s+)?expect\s*[.(]/;
const MATCHER = /\.\s*(to[A-Z]\w*)\s*\(/g;

function significant(c: string, r: Raw): boolean {
  return SIGNIFICANT.test(c.slice(r.start, r.end)) || r.children.some((k) => significant(c, k));
}

function leaves(c: string, raws: Raw[]): Raw[] {
  return raws.flatMap((r) => (r.children.some((k) => significant(c, k)) ? leaves(c, r.children) : [r]));
}

/** Every statement of the spec in order, classified. */
export function scanSteps(code: string): Step[] {
  const c = blankOut(code);
  const lineAt = (index: number): number => code.slice(0, index).split("\n").length;
  let seenGoto = false;
  const steps = leaves(c, parseBlock(c, 0).stmts).map((r): Step => {
    const clean = c.slice(r.start, r.end).trim();
    const end = r.start + c.slice(r.start, r.end).trimEnd().length;
    const at = { startLine: lineAt(r.start), endLine: lineAt(end), text: code.slice(r.start, end) };
    if (EXPECT.test(clean)) {
      const matchers = [...clean.matchAll(MATCHER)].map((m) => m[1] ?? "");
      return { kind: "assertion", verb: matchers.at(-1) ?? "expect", ...at };
    }
    if (/\bwaitForResponse\s*\(/.test(clean)) return { kind: "other", verb: "waitForResponse", ...at };
    if (/\.\s*goto\s*\(/.test(clean)) {
      const first = !seenGoto;
      seenGoto = true;
      return first ? { kind: "navigation", verb: "goto", ...at } : { kind: "action", verb: "goto", ...at };
    }
    const action = clean.match(ACTIONS);
    if (action) return { kind: "action", verb: action[1] ?? "", ...at };
    return { kind: "other", verb: "", ...at };
  });
  // A waitForResponse is an assertion when the response it binds is asserted on later.
  return steps.map((s, i) => {
    if (s.verb !== "waitForResponse") return s;
    const bound = blankOut(s.text).match(/^\s*(?:const|let|var)\s+([\w$]+)\s*=/)?.[1];
    const used = bound !== undefined && steps.slice(i + 1).some((t) => t.kind === "assertion" && new RegExp(String.raw`\bexpect\s*\(\s*(?:await\s+)?${bound.replaceAll("$", "\\$")}\b`).test(t.text));
    return used ? { ...s, kind: "assertion" } : s;
  });
}

/** Matchers a regression can break: the page changed, or the element did. */
export const COUNTING_MATCHERS: ReadonlySet<string> = new Set([
  "toHaveURL",
  "toBeVisible",
  "toBeHidden",
  "toHaveText",
  "toContainText",
  "toHaveValue",
  "toHaveCount",
  "toBeChecked",
  "toHaveAttribute",
]);

const RESPONSE_EXPECT = /\bexpect\s*\(\s*(?:await\s+)?[\w$]+(?:\s*\.\s*[\w$]+\s*\(\s*\))*\s*\.\s*(?:status|json)\s*\(\s*\)/;
const WEAK_MATCHERS = new Set(["toBeDefined", "toBeUndefined", "toBeTruthy", "toBeFalsy", "toBeNull"]);

/** An assertion that can catch a regression: a counting matcher, or an expect on a response's status or JSON. */
export function isCountingAssertion(step: Step): boolean {
  if (step.kind !== "assertion" || step.verb === "waitForResponse") return false;
  if (COUNTING_MATCHERS.has(step.verb)) return true;
  return RESPONSE_EXPECT.test(blankOut(step.text)) && !WEAK_MATCHERS.has(step.verb);
}

/** The counting assertions after the first action. Assertions before it prove only that the page loaded. */
export function countingAssertions(steps: readonly Step[]): Step[] {
  const first = steps.findIndex((s) => s.kind === "action");
  return first === -1 ? [] : steps.slice(first + 1).filter(isCountingAssertion);
}

/** The last action before the last counting assertion, or undefined when there is none. */
export function mainAction(steps: readonly Step[]): Step | undefined {
  const last = countingAssertions(steps).at(-1);
  if (!last) return undefined;
  return steps.slice(0, steps.indexOf(last)).filter((s) => s.kind === "action").at(-1);
}
