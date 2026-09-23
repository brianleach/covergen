/**
 * Bounded mutation spot-check.
 *
 * A test that runs a line is not the same as a test that asserts anything about
 * it. This module makes small, deterministic edits to the lines a candidate test
 * newly covered. The gate then re-runs the test against each edited source: a
 * test that still passes with the code broken is not testing the code.
 *
 * Rules that keep this cheap and safe:
 *  - only the given lines are touched, one line per mutant, one edit per line
 *  - at most one mutant per (line, operator), first match on the line wins
 *  - operators are tried in a fixed order and lines ascend, so the set of
 *    mutants for a given input is stable across runs
 *  - string literals and comments are masked before matching, so a mutant never
 *    rewrites a message or a comment (best effort, not a parser)
 *  - every mutant carries the whole mutated file, so the caller writes bytes and
 *    never has to re-derive the edit
 */

import { basename, extname } from "node:path";

export interface Mutant {
  /** Stable within one call: `m<line>-<operator>`. */
  id: string;
  /** 1-based line number in the source file. */
  line: number;
  /** Human readable, shown to the model when a mutant survives. */
  description: string;
  /** The full mutated file text. */
  source: string;
}

export type MutationLang = "ruby" | "js" | "python" | "go" | "rust";

export interface GenerateMutantsArgs {
  /** Source path, used only to pick the language. */
  path: string;
  /** The repo's configured language. Wins over the extension and the shebang. */
  language?: MutationLang;
  source: string;
  /** 1-based line numbers eligible for mutation (the candidate's newly covered lines). */
  lines: number[];
  /** Hard cap on how many mutants to return. */
  max: number;
}

/**
 * The language to mutate `path` as: a configured `language` first, then the file
 * extension, then, for a file with no extension, the interpreter its shebang names.
 * Undefined when none of those is one we have operators for; that file yields no
 * mutants.
 */
export function langFor(path: string, source?: string, language?: MutationLang): MutationLang | undefined {
  if (language) return language;
  const ext = extname(path).toLowerCase();
  if (ext === ".rb") return "ruby";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") return "js";
  if (ext === "" && source !== undefined) return langFromShebang(source);
  return undefined;
}

/**
 * The language a `#!` first line names, e.g. `#!/usr/bin/env python3` or
 * `#!/usr/bin/node`. Shells have no operators here, so `#!/bin/bash` is undefined.
 */
export function langFromShebang(source: string): MutationLang | undefined {
  const first = source.split("\n", 1)[0] ?? "";
  if (!first.startsWith("#!")) return undefined;
  // The interpreter is the last path segment of the program, or the first
  // argument after `env` (skipping flags such as `-S`).
  const words = first.slice(2).trim().split(/\s+/);
  let program = basename(words[0] ?? "");
  if (program === "env") program = basename(words.slice(1).find((w) => !w.startsWith("-") && !w.includes("=")) ?? "");
  if (/^python[\d.]*$/.test(program)) return "python";
  if (/^(?:node|nodejs|bun|deno|tsx|ts-node)$/.test(program)) return "js";
  if (/^ruby[\d.]*$/.test(program)) return "ruby";
  return undefined;
}

/**
 * Blank out string literals and trailing line comments, keeping length and index
 * alignment so a match found in the mask can be applied to the real line.
 */
export function maskLine(line: string, lang: MutationLang): string {
  const out = line.split("");
  let quote: string | undefined;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (quote !== undefined) {
      out[i] = " ";
      if (ch === "\\") {
        if (i + 1 < line.length) out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (ch === quote) quote = undefined;
      i += 1;
      continue;
    }
    // Rust spells lifetimes with the same tick as a char literal (`&'a str`), so
    // only an actual `'x'` or `'\n'` opens a literal there.
    if (ch === "'" && lang === "rust" && line[i + 1] !== "\\" && line[i + 2] !== "'") {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ((lang === "js" || lang === "go") && ch === "`")) {
      quote = ch;
      out[i] = " ";
      i += 1;
      continue;
    }
    const isComment =
      lang === "js" || lang === "go" || lang === "rust" ? ch === "/" && line[i + 1] === "/" : ch === "#";
    if (isComment) {
      for (let j = i; j < line.length; j += 1) out[j] = " ";
      break;
    }
    i += 1;
  }
  return out.join("");
}

interface Edit {
  text: string;
  description: string;
}

/** `source` is the whole file, which only the Go return operator needs. */
type Operator = (line: string, masked: string, lang: MutationLang, source: string) => Edit | undefined;

function splice(line: string, index: number, length: number, replacement: string): string {
  return line.slice(0, index) + replacement + line.slice(index + length);
}

/**
 * Leftmost relational operator on the line, with the compound tokens that merely
 * contain `<` or `>` (hash rockets, arrow functions, shifts, spaceship) skipped.
 */
function relational(line: string, masked: string, lang: MutationLang): Edit | undefined {
  for (let i = 0; i < masked.length; i += 1) {
    const three = masked.slice(i, i + 3);
    if (three === "<=>" || three === "<<=" || three === ">>=") {
      i += 2;
      continue;
    }
    if (three === "===" || three === "!==") {
      if (lang === "js") {
        const to = three === "===" ? "!==" : "===";
        return { text: splice(line, i, 3, to), description: `relational: ${three} to ${to}` };
      }
      i += 2;
      continue;
    }
    const two = masked.slice(i, i + 2);
    // `<-` is Go's channel arrow, not a comparison.
    if (two === "=>" || two === "->" || two === "<-" || two === "<<" || two === ">>") {
      i += 1;
      continue;
    }
    const pairs: Record<string, string> = { "==": "!=", "!=": "==", "<=": ">", ">=": "<" };
    const pair = pairs[two];
    if (pair !== undefined) {
      return { text: splice(line, i, 2, pair), description: `relational: ${two} to ${pair}` };
    }
    const one = masked[i]!;
    // `Vec<u32>` and `::<T>` are type syntax, not comparisons. rustfmt spaces a
    // real comparison, so whitespace on both sides is what separates the two.
    if (lang === "rust" && (one === "<" || one === ">") && !(masked[i - 1] === " " && masked[i + 1] === " ")) continue;
    if (one === "<" || one === ">") {
      const to = one === "<" ? ">=" : "<=";
      return { text: splice(line, i, 1, to), description: `relational: ${one} to ${to}` };
    }
  }
  return undefined;
}

function boolean(line: string, masked: string, lang: MutationLang): Edit | undefined {
  // Python spells them True and False, and is case sensitive about it.
  const re = lang === "python" ? /\b(True|False)\b/ : /\b(true|false)\b/;
  const m = re.exec(masked);
  if (!m) return undefined;
  const from = m[1]!;
  const to = from.toLowerCase() === "true" ? (lang === "python" ? "False" : "false") : lang === "python" ? "True" : "true";
  return { text: splice(line, m.index, from.length, to), description: `boolean: ${from} to ${to}` };
}

function logical(line: string, masked: string, lang: MutationLang): Edit | undefined {
  const re = lang === "python" ? /(\band\b|\bor\b)/ : lang === "ruby" ? /(&&|\|\||\band\b|\bor\b)/ : /(&&|\|\|)/;
  const m = re.exec(masked);
  if (!m) return undefined;
  const from = m[1]!;
  const map: Record<string, string> = { "&&": "||", "||": "&&", and: "or", or: "and" };
  const to = map[from]!;
  return { text: splice(line, m.index, from.length, to), description: `logical: ${from} to ${to}` };
}

/** Index of the `)` matching the `(` at `open`, or -1 if it closes on a later line. */
function matchingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === "(") depth += 1;
    else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function condition(line: string, masked: string, lang: MutationLang): Edit | undefined {
  if (lang === "python") {
    // Python has no `unless`, so negate the condition in place instead. Only a
    // whole `if`/`elif`/`while` header ending in a colon is touched, and the edit
    // stays inside the line, so the block's indentation is untouched and no
    // statement separator is introduced.
    const head = /^(\s*)(if|elif|while)\s+\S/.exec(masked);
    if (!head) return undefined;
    const colon = masked.lastIndexOf(":");
    const start = head[1]!.length + head[2]!.length;
    if (colon <= start) return undefined;
    const test = line.slice(start, colon).trim();
    if (test.length === 0) return undefined;
    return {
      text: `${line.slice(0, start)} not (${test})${line.slice(colon)}`,
      description: `condition: ${head[2]} condition negated`,
    };
  }
  if (lang === "ruby") {
    const m = /\b(if|unless)\b/.exec(masked);
    if (!m) return undefined;
    const from = m[1]!;
    const to = from === "if" ? "unless" : "if";
    return { text: splice(line, m.index, from.length, to), description: `condition: ${from} to ${to}` };
  }
  if (lang === "rust") {
    // `if cond {` becomes `if !(cond) {`. `if let` binds a pattern rather than
    // testing a bool, so negating it would not compile; it is left alone.
    const head = /^\s*(?:\}\s*else\s+)?if\s+/.exec(masked);
    if (!head) return undefined;
    const start = head[0].length;
    if (/^let\b/.test(masked.slice(start))) return undefined;
    const brace = masked.lastIndexOf("{");
    if (brace <= start) return undefined;
    const test = line.slice(start, brace).trim();
    if (test.length === 0) return undefined;
    return { text: `${line.slice(0, start)}!(${test}) ${line.slice(brace)}`, description: "condition: if condition negated" };
  }
  const m = /\bif\s*\(/.exec(masked);
  if (!m) return undefined;
  const open = m.index + m[0].length - 1;
  const close = matchingParen(masked, open);
  if (close === -1) return undefined;
  const text = `${line.slice(0, open + 1)}!(${line.slice(open + 1, close)})${line.slice(close)}`;
  return { text, description: "condition: if condition negated" };
}

const WORDISH = /[\w$.]/;

function numeric(line: string, masked: string): Edit | undefined {
  for (const m of masked.matchAll(/\d+/g)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? masked[start - 1]! : "";
    const after = end < masked.length ? masked[end]! : "";
    // Skip digits glued to an identifier (`utf8`), a decimal or a dotted version.
    if (before !== "" && WORDISH.test(before)) continue;
    if (after !== "" && WORDISH.test(after)) continue;
    const next = String(Number(m[0]) + 1);
    return { text: splice(line, start, m[0].length, next), description: `numeric: ${m[0]} to ${next}` };
  }
  return undefined;
}

function returnValue(line: string, masked: string, lang: MutationLang): Edit | undefined {
  // Rust has no universal empty value to substitute: `return undefined` or
  // `return None` only compiles where the signature already says so, and a
  // mutant that does not compile is a wasted slot.
  if (lang === "rust") return undefined;
  const m = /\breturn\b/.exec(masked);
  if (!m) return undefined;
  const head = line.slice(0, m.index);
  const rest = line.slice(m.index + "return".length);
  if (lang === "ruby" || lang === "python") {
    const empty = lang === "ruby" ? "nil" : "None";
    const value = rest.trim();
    if (value.length === 0 || value === empty) return undefined;
    return { text: `${head}return ${empty}`, description: `return: value replaced with ${empty}` };
  }
  const js = /^\s*(\S.*?);\s*$/.exec(rest);
  if (!js) return undefined;
  if (js[1] === "undefined") return undefined;
  return { text: `${head}return undefined;`, description: "return: value replaced with undefined" };
}

/**
 * Go's error return, flipped. `return err` becomes `return nil`, which is the
 * regression a test either notices or does not, and `return nil` becomes
 * `return err` only where the file has a plain `return err` of its own, so the
 * name is in scope often enough to be worth compiling.
 */
function returnNilErr(line: string, masked: string, lang: MutationLang, source: string): Edit | undefined {
  if (lang !== "go") return undefined;
  const m = /^(\s*)return\s+(err|nil)\s*$/.exec(masked);
  if (!m) return undefined;
  const from = m[2]!;
  if (from === "nil" && !/^\s*return\s+err\s*$/m.test(source)) return undefined;
  const to = from === "err" ? "nil" : "err";
  return { text: `${m[1]}return ${to}`, description: `return: ${from} to ${to}` };
}

const PREDICATE_PAIRS: [string, string][] = [
  [".present?", ".blank?"],
  [".blank?", ".present?"],
  [".empty?", ".any?"],
  [".any?", ".empty?"],
];

/**
 * Ruby predicate flips. `.nil?` is only touched in the simplest possible shape,
 * a whole line that is one optionally negated receiver, because anything more
 * needs to know where the expression starts.
 */
function predicate(line: string, masked: string, lang: MutationLang): Edit | undefined {
  if (lang !== "ruby") return undefined;
  let best: { index: number; from: string; to: string } | undefined;
  for (const [from, to] of PREDICATE_PAIRS) {
    const index = masked.indexOf(from);
    if (index === -1) continue;
    if (!best || index < best.index) best = { index, from, to };
  }
  if (best) {
    return {
      text: splice(line, best.index, best.from.length, best.to),
      description: `predicate: ${best.from} to ${best.to}`,
    };
  }
  const simple = /^(\s*)(!?)([A-Za-z_@][\w.@]*)\.nil\?\s*$/.exec(masked);
  if (!simple) return undefined;
  const negated = simple[2] === "!";
  const text = `${simple[1]}${negated ? "" : "!"}${simple[3]}.nil?`;
  return { text, description: negated ? "predicate: !x.nil? to x.nil?" : "predicate: x.nil? to !x.nil?" };
}

/** Applied in this order for every line, so the mutant set is deterministic. */
const OPERATORS: [string, Operator][] = [
  ["relational", relational],
  ["boolean", boolean],
  ["logical", logical],
  ["condition", condition],
  // Skipped for Rust: `255u8 + 1` is a deny-by-default overflow lint, not a test result.
  ["numeric", (line, masked, lang) => (lang === "rust" ? undefined : numeric(line, masked))],
  ["return", returnValue],
  ["return-err", returnNilErr],
  ["predicate", predicate],
];

/**
 * Up to `max` single-line mutants of `source`, restricted to `lines`.
 *
 * Every returned mutant differs from the input in exactly one line; all other
 * lines are byte identical.
 */
export function generateMutants(args: GenerateMutantsArgs): Mutant[] {
  const lang = langFor(args.path, args.source, args.language);
  if (!lang || args.max <= 0) return [];

  const lines = args.source.split("\n");
  const targets = [...new Set(args.lines)].filter((n) => n >= 1 && n <= lines.length).sort((a, b) => a - b);
  const mutants: Mutant[] = [];

  for (const line of targets) {
    const text = lines[line - 1]!;
    if (text.trim().length === 0) continue;
    const masked = maskLine(text, lang);
    for (const [op, apply] of OPERATORS) {
      if (mutants.length >= args.max) return mutants;
      const edit = apply(text, masked, lang, args.source);
      if (!edit || edit.text === text) continue;
      const mutated = [...lines];
      mutated[line - 1] = edit.text;
      mutants.push({ id: `m${line}-${op}`, line, description: edit.description, source: mutated.join("\n") });
    }
  }
  return mutants;
}
