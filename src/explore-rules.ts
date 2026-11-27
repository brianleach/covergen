/**
 * The explore gate's rejections, one registry for the prompt and the checks.
 * Each id is a FlowStatus and a row of the table in docs/explore-mode.md ("The
 * gate stays a gate"). The registry feeds the stable prompt block, so the model
 * is told up front what will reject its spec, and the four static rules carry
 * their own `test`, which src/explore-gate.ts runs before any file is written.
 * A violation message names the shape that was found and never the text that
 * matched it, so a credential the model wrote is not repeated into a log.
 */

import type { Flow, FlowElement } from "./explore.js";
import { DESTRUCTIVE } from "./explore-html.js";
import { indexSpecs, scanSpec, targetKey } from "./explore-specs.js";
import type { SpecFile } from "./explore-specs.js";
import { countingAssertions, scanSteps } from "./explore-steps.js";
import type { FlowStatus } from "./types.js";

export type ExploreRuleId = Extract<
  FlowStatus,
  "flaky" | "no_assertion" | "action_removable" | "mutation_not_allowed" | "credential_in_spec" | "off_site" | "duplicate_flow"
>;

/** What a static rule sees besides the spec text. */
export interface RuleContext {
  baseUrl: string;
  storageStateEnv: string;
  /** The flow the candidate was generated for. */
  flow: Flow;
  /** Every crawled flow. */
  flows: readonly Flow[];
  existing: readonly SpecFile[];
  /** Specs this run already accepted, which count as existing for duplicate_flow. */
  acceptedThisRun: readonly SpecFile[];
}

export interface RuleViolation {
  rule: ExploreRuleId;
  message: string;
  /** 1-based line in the candidate spec. */
  line: number;
}

export interface ExploreRule {
  id: ExploreRuleId;
  /** One line, written to the model. */
  description: string;
  /** The static check, for the rules that need no run. */
  test?: (code: string, ctx: RuleContext) => RuleViolation | undefined;
}

export const exploreRules: readonly ExploreRule[] = [
  { id: "flaky", description: "The spec must pass three times in a row against the live target, so wait on web-first assertions, never on timers." },
  {
    id: "no_assertion",
    description: "Assert something a regression could break: a visible state change, a network response, or a URL change.",
    test: (code) => noAssertionViolation(code),
  },
  { id: "action_removable", description: "With its main action commented out the spec must fail, so assert the effect of that action, not that the page loaded." },
  {
    id: "mutation_not_allowed",
    description: "Use a mutating element (submit, save, delete) only when the target says the route is writable.",
    test: (code, ctx) => mutationViolation(code, ctx),
  },
  {
    id: "credential_in_spec",
    description: "No email, password, cookie or token in the spec; the session comes from the storage state the spec loads.",
    test: (code, ctx) => credentialViolation(code, ctx.storageStateEnv),
  },
  { id: "off_site", description: "Navigate only within the base origin, with relative paths.", test: (code, ctx) => offSiteViolation(code, ctx.baseUrl) },
  {
    id: "duplicate_flow",
    description: "Cover what the existing specs do not; a spec repeating an existing one is rejected.",
    test: (code, ctx) => duplicateViolation(code, ctx),
  },
];

export const exploreRuleIds: readonly ExploreRuleId[] = exploreRules.map((r) => r.id);

/** The registry rendered for the stable prompt block. */
export function exploreRulesText(): string {
  return ["Rules every generated spec must follow. Each id is the rejection it earns when broken:", ...exploreRules.map((r) => `- ${r.id}: ${r.description}`)].join("\n");
}

/** The order the gate runs the static rules in: the credential check first, since it guards what may be written at all. */
export const staticRuleOrder: readonly ExploreRuleId[] = ["credential_in_spec", "off_site", "mutation_not_allowed", "duplicate_flow", "no_assertion"];

/** One string literal of a spec: its value (template interpolations kept raw) and where it starts. */
interface Literal {
  value: string;
  index: number;
}

/** Every string and template literal outside comments, in order. A small lexer, not a parser. */
export function stringLiterals(code: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? code.length : end;
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let value = "";
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") {
          value += code[j + 1] ?? "";
          j += 2;
        } else {
          value += code[j];
          j += 1;
        }
      }
      out.push({ value, index: i });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out;
}

const lineAt = (code: string, index: number): number => code.slice(0, index).split("\n").length;

/** The text between the parenthesis at `open` and its match, or to the end when unbalanced. */
function argsAt(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")" && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

/** Each call of a matching callee: where it starts, and its literals with absolute indices. */
function calls(code: string, callee: RegExp): { index: number; args: string; literals: Literal[]; firstLiteral?: Literal }[] {
  const out: { index: number; args: string; literals: Literal[]; firstLiteral?: Literal }[] = [];
  for (const m of code.matchAll(new RegExp(callee.source, "g"))) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const args = argsAt(code, open);
    const literals = stringLiterals(args).map((l) => ({ ...l, index: open + 1 + l.index }));
    const firstLiteral = literals.find((l) => l.index === open + 1 + args.search(/\S/));
    out.push({ index: m.index ?? 0, args, literals, ...(firstLiteral ? { firstLiteral } : {}) });
  }
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const BEARER = /\bBearer\s+\S{8,}/i;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;
const HEX = /\b[0-9a-f]{32,}\b/i;
const BASE64 = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const SECRET_KEY = String.raw`["']?[A-Za-z_$]*(?:password|passwd|secret|token|api_?key|authorization|cookie|session)[A-Za-z0-9_$]*["']?`;
const SECRET_ASSIGN = new RegExp(String.raw`${SECRET_KEY}\s*[:=]\s*(?=["'\x60])`, "gi");
const SECRET_FILL = /\bgetBy(?:Label|Placeholder|Role)\s*\([^)]*(?:password|passwd|secret|token|api.?key)[^)]*\)\s*\.fill\s*\(\s*(?=["'`])/gi;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

function looksLikeKey(value: string): boolean {
  if (HEX.test(value)) return true;
  for (const m of value.matchAll(BASE64)) {
    const t = m[0];
    if (/[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && entropy(t) >= 4) return true;
  }
  return false;
}

/** credential_in_spec: anything shaped like an email, a secret, a token, or a session that is not the configured storage state. */
export function credentialViolation(code: string, storageStateEnv: string): RuleViolation | undefined {
  const hit = (index: number, what: string): RuleViolation => ({ rule: "credential_in_spec", message: `the spec holds ${what}`, line: lineAt(code, index) });
  const literals = stringLiterals(code);
  for (const l of literals) {
    if (EMAIL.test(l.value)) return hit(l.index, "an email-shaped string literal");
    if (BEARER.test(l.value) || JWT.test(l.value)) return hit(l.index, "a bearer or JWT-shaped token literal");
    if (looksLikeKey(l.value)) return hit(l.index, "a long high-entropy literal shaped like a key");
  }
  for (const re of [SECRET_ASSIGN, SECRET_FILL]) {
    for (const m of code.matchAll(re)) {
      const at = (m.index ?? 0) + m[0].length;
      if (literals.some((l) => l.index === at && l.value.length > 0)) return hit(at, "a string literal given to a credential-named key");
    }
  }
  const allowed = new RegExp(String.raw`^process\.env(?:\.${storageStateEnv}|\[["']${storageStateEnv}["']\])!?$`);
  for (const m of code.matchAll(/\bstorageState\s*:\s*([^,}\n]+)/g)) {
    if (!allowed.test((m[1] ?? "").trim())) return hit(m.index ?? 0, `a storageState other than process.env.${storageStateEnv}`);
  }
  for (const c of calls(code, /\.(?:addCookies|setExtraHTTPHeaders)\s*\(/)) {
    if (c.literals.some((l) => l.value.length > 0)) return hit(c.index, "a cookie or header set from literals");
  }
  return undefined;
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

/** off_site: an absolute URL off the base origin in any navigation or request, or a goto that is absolute at all. */
export function offSiteViolation(code: string, baseUrl: string): RuleViolation | undefined {
  const origin = new URL(baseUrl).origin;
  const hit = (index: number, what: string): RuleViolation => ({ rule: "off_site", message: what, line: lineAt(code, index) });
  for (const c of calls(code, /\bgoto\s*\(/)) {
    if ((c.firstLiteral && ABSOLUTE.test(c.firstLiteral.value)) || /^[^,]*process\.env/.test(c.args)) {
      return hit(c.index, "page.goto takes a relative path only");
    }
  }
  const navigations = [/\b(?:goto|waitForURL|toHaveURL|route)\s*\(/, /\brequest\s*\.\s*\w+\s*\(/, /\blocation\s*\.\s*(?:assign|replace)\s*\(/];
  const literals = navigations.flatMap((re) => calls(code, re).flatMap((c) => c.literals));
  for (const m of code.matchAll(/\blocation(?:\s*\.\s*href)?\s*=(?!=)\s*/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const l = stringLiterals(code).find((x) => x.index === at);
    if (l) literals.push(l);
  }
  for (const l of literals) {
    if (!/^https?:\/\//i.test(l.value)) continue;
    let target = "";
    try {
      target = new URL(l.value).origin;
    } catch {
      // An origin built from an interpolation is not provably the base.
    }
    if (target !== origin) return hit(l.index, "an absolute URL off the base origin");
  }
  return undefined;
}

/** One getByRole target the spec acts on. `pattern` is set when the name was a regex. */
interface ActedTarget {
  role: string;
  name: string;
  pattern?: RegExp;
  index: number;
}

const BY_ROLE = /\bgetByRole\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*(?:,\s*\{([^}]*)\})?\s*\)/g;
const NAME_OPTION = /\bname\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|\/(.*?)\/([a-z]*))/;
const ACTION = String.raw`(?:\s*\.\s*(?:first|last|nth)\s*\([^)]*\))*\s*\.\s*(?:click|dblclick|tap|fill|check|uncheck|setChecked|selectOption|press)\s*\(`;

/** getByRole targets that are clicked, filled, checked, selected or pressed, directly or through a const. */
export function actedTargets(code: string): ActedTarget[] {
  const out: ActedTarget[] = [];
  for (const m of code.matchAll(BY_ROLE)) {
    const role = (m[1] ?? m[2] ?? "").trim().toLowerCase();
    const name = (m[3] ?? "").match(NAME_OPTION);
    const end = (m.index ?? 0) + m[0].length;
    const direct = new RegExp(`^${ACTION}`).test(code.slice(end));
    const bound = code.slice(0, m.index).match(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w$.]*$/);
    const viaVar = bound ? new RegExp(String.raw`\b${bound[1]?.replaceAll("$", "\\$")}${ACTION}`).test(code.slice(end)) : false;
    if (!direct && !viaVar) continue;
    let pattern: RegExp | undefined;
    if (name?.[4] !== undefined) {
      try {
        pattern = new RegExp(name[4], name[5]);
      } catch {
        pattern = undefined;
      }
    }
    out.push({ role, name: name ? (name[1] ?? name[2] ?? name[3] ?? name[4] ?? "") : "", ...(pattern ? { pattern } : {}), index: m.index ?? 0 });
  }
  return out;
}

function targetMatches(t: ActedTarget, e: FlowElement): boolean {
  if (t.role !== e.role.toLowerCase()) return false;
  if (t.pattern) return t.pattern.test(e.name);
  return targetKey(t.role, t.name) === targetKey(e.role, e.name);
}

/** mutation_not_allowed: acting on a mutating element of a visited route that is not writable, or on a destructive name off a writable flow. */
export function mutationViolation(code: string, ctx: Pick<RuleContext, "baseUrl" | "flow" | "flows">): RuleViolation | undefined {
  const visited = new Set([ctx.flow.route, ...scanSpec({ path: "", text: code }, ctx.baseUrl).routes]);
  const guarded = ctx.flows.filter((f) => visited.has(f.route) && !f.writable);
  for (const t of actedTargets(code)) {
    const line = lineAt(code, t.index);
    if (guarded.some((f) => f.elements.some((e) => e.mutating && targetMatches(t, e)))) {
      return { rule: "mutation_not_allowed", message: "the spec acts on a mutating element of a route outside allow_mutations", line };
    }
    if (!ctx.flow.writable && DESTRUCTIVE.test(t.name)) {
      return { rule: "mutation_not_allowed", message: "the spec acts on a destructive control and the target flow is not writable", line };
    }
  }
  return undefined;
}

/** duplicate_flow: every route the candidate visits and every target it acts on is already addressed by an existing or accepted spec. */
export function duplicateViolation(code: string, ctx: Pick<RuleContext, "baseUrl" | "flow" | "existing" | "acceptedThisRun">): RuleViolation | undefined {
  const index = indexSpecs([...ctx.existing, ...ctx.acceptedThisRun], ctx.baseUrl);
  const { routes } = scanSpec({ path: "", text: code }, ctx.baseUrl);
  if (routes.some((r) => index.specsForRoute(r).length === 0)) return undefined;
  for (const t of actedTargets(code)) {
    const elements = ctx.flow.elements.filter((e) => targetMatches(t, e));
    const asked = elements.length > 0 ? elements : [{ role: t.role, name: t.name, mutating: false }];
    if (asked.some((e) => !index.addressesElement(e))) return undefined;
  }
  const first = code.search(/\bgoto\s*\(/);
  return { rule: "duplicate_flow", message: "every route and target in the spec is already covered by an existing spec", line: lineAt(code, Math.max(first, 0)) };
}

/**
 * no_assertion: no assertion after the first action is one a regression could
 * break. A title, `expect(true)`, `toBeDefined` on a locator, and anything
 * asserted before the first action only prove the page loaded.
 */
export function noAssertionViolation(code: string): RuleViolation | undefined {
  const steps = scanSteps(code);
  const action = steps.find((s) => s.kind === "action");
  if (!action) {
    const at = steps.find((s) => s.kind === "navigation") ?? steps[0];
    return { rule: "no_assertion", message: "the spec takes no action, so nothing it asserts can catch a regression", line: at?.startLine ?? 1 };
  }
  if (countingAssertions(steps).length > 0) return undefined;
  return {
    rule: "no_assertion",
    message: "no assertion after the first action checks a URL, visibility, text, value, count, checked state, attribute, or a response's status or JSON",
    line: action.startLine,
  };
}
