/**
 * Turn uncovered lines into prompt-sized segments.
 *
 * Uncovered lines are clustered (small covered gaps stay inside one cluster),
 * each cluster is expanded to its enclosing definition when one is detectable,
 * and anything larger than `maxLines` falls back to the cluster plus a few
 * lines of context.
 */

import type { FileCoverage, Segment } from "./types.js";
import { branchCount, branchWeight } from "./value.js";

/** Covered / non-instrumented lines tolerated inside a single cluster. */
const MAX_GAP = 3;
/** Context lines kept on each side when the enclosing block is too big. */
const CONTEXT = 5;

export interface BuildSegmentsArgs {
  path: string;
  source: string;
  coverage: FileCoverage | undefined;
  maxLines: number;
  maxPerFile: number;
}

interface Cluster {
  start: number;
  end: number;
  lines: number[];
}

interface Block {
  start: number;
  end: number;
  symbol?: string;
}

type Language = "ruby" | "brace" | "unknown";

function languageFor(path: string): Language {
  const lower = path.toLowerCase();
  if (lower.endsWith(".rb") || lower.endsWith(".rake")) return "ruby";
  if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(lower)) return "brace";
  return "unknown";
}

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

/** Uncovered lines: instrumented with zero hits, ascending. */
export function uncoveredLines(coverage: FileCoverage | undefined): number[] {
  if (!coverage) return [];
  const out: number[] = [];
  for (const [line, hits] of coverage.lines) {
    if (hits === 0) out.push(line);
  }
  return out.sort((a, b) => a - b);
}

function clusterLines(lines: number[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const line of lines) {
    const last = clusters[clusters.length - 1];
    if (last && line - last.end - 1 <= MAX_GAP) {
      last.end = line;
      last.lines.push(line);
    } else {
      clusters.push({ start: line, end: line, lines: [line] });
    }
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

const RUBY_DEF = /^[ \t]*def\s+([A-Za-z_][\w]*[?!=]?|self\.[A-Za-z_][\w]*[?!=]?|\[\]=?|[<>=+\-*/%!~^&|]+)/;
const RUBY_TYPE = /^[ \t]*(class|module)\s+([A-Za-z_][\w:]*)/;

function rubyBlockAt(lines: string[], index: number): Block | undefined {
  const line = lines[index];
  if (line === undefined) return undefined;
  const def = RUBY_DEF.exec(line);
  const type = def ? undefined : RUBY_TYPE.exec(line);
  if (!def && !type) return undefined;
  const indent = indentOf(line);
  for (let i = index + 1; i < lines.length; i += 1) {
    const candidate = lines[i];
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    if (trimmed !== "end" && !trimmed.startsWith("end ") && !trimmed.startsWith("end;")) continue;
    if (indentOf(candidate) !== indent) continue;
    return { start: index + 1, end: i + 1, symbol: def ? def[1] : type?.[2] };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Brace languages (TypeScript / JavaScript)
// ---------------------------------------------------------------------------

const TS_FUNCTION = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*[(<]/;
const TS_ASSIGNED = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|[(<])/;
const TS_CLASS = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const TS_METHOD =
  /^[ \t]*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const TS_NOT_A_DECL = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "await",
  "typeof",
  "throw",
  "new",
  "do",
  "else",
  "yield",
  "import",
  "export",
  "require",
  "describe",
  "it",
  "test",
  "expect",
]);

/** The declaration name on this line, or undefined when it is not a declaration. */
function braceDeclName(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("*")) return undefined;
  for (const pattern of [TS_FUNCTION, TS_ASSIGNED, TS_CLASS]) {
    const match = pattern.exec(line);
    if (match) return match[1] ?? "(anonymous)";
  }
  // A method signature ends with the opening brace or continues onto the next line.
  if (trimmed.endsWith("{") || trimmed.endsWith("(")) {
    const method = TS_METHOD.exec(line);
    const name = method?.[1];
    if (name && !TS_NOT_A_DECL.has(name)) return name;
  }
  return undefined;
}

function countBraces(line: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
}

function braceBlockAt(lines: string[], index: number): Block | undefined {
  const declLine = lines[index];
  if (declLine === undefined) return undefined;
  const symbol = braceDeclName(declLine);
  if (symbol === undefined) return undefined;

  let depth = 0;
  let opened = false;
  for (let i = index; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const delta = countBraces(line);
    if (!opened && delta <= 0 && i > index + 2) return undefined; // no body found nearby
    depth += delta;
    if (depth > 0) opened = true;
    if (opened && depth <= 0) {
      return { start: index + 1, end: i + 1, symbol: symbol === "(anonymous)" ? undefined : symbol };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------

/** Innermost declaration block that fully contains [start, end]. */
function enclosingBlock(lines: string[], language: Language, start: number, end: number): Block | undefined {
  if (language === "unknown") return undefined;
  const at = language === "ruby" ? rubyBlockAt : braceBlockAt;
  for (let index = start - 1; index >= 0; index -= 1) {
    const block = at(lines, index);
    if (block && block.end >= end && block.start <= start) return block;
  }
  return undefined;
}

function clipToMaxLines(cluster: Cluster, totalLines: number, maxLines: number): { start: number; end: number } {
  let start = Math.max(1, cluster.start - CONTEXT);
  let end = Math.min(totalLines, cluster.end + CONTEXT);
  // Trim the larger side first so the cluster stays roughly centered.
  while (end - start + 1 > maxLines && (start < cluster.start || end > cluster.end)) {
    const leading = cluster.start - start;
    const trailing = end - cluster.end;
    if (trailing > 0 && trailing >= leading) end -= 1;
    else if (leading > 0) start += 1;
    else break;
  }
  if (end - start + 1 > maxLines) end = start + maxLines - 1;
  return { start, end: Math.min(end, totalLines) };
}

/** Source text for [startLine, endLine] with 1-based `${n}: ` prefixes. */
export function numberLines(lines: string[], startLine: number, endLine: number): string {
  const out: string[] = [];
  for (let n = startLine; n <= endLine; n += 1) {
    out.push(`${n}: ${lines[n - 1] ?? ""}`);
  }
  return out.join("\n");
}

export function buildSegments(args: BuildSegmentsArgs): Segment[] {
  const { path, source, coverage, maxLines, maxPerFile } = args;
  const missing = uncoveredLines(coverage);
  if (missing.length === 0 || maxPerFile <= 0 || maxLines <= 0) return [];

  const lines = source.split(/\r?\n/);
  const totalLines = lines.length;
  const language = languageFor(path);
  const clusters = clusterLines(missing.filter((n) => n >= 1 && n <= totalLines));

  const segments: Segment[] = [];
  for (const cluster of clusters) {
    const block = enclosingBlock(lines, language, cluster.start, cluster.end);
    let startLine: number;
    let endLine: number;
    let symbol: string | undefined;

    if (block && block.end - block.start + 1 <= maxLines) {
      startLine = block.start;
      endLine = block.end;
      symbol = block.symbol;
    } else {
      const clipped = clipToMaxLines(cluster, totalLines, maxLines);
      startLine = clipped.start;
      endLine = clipped.end;
      symbol = block?.symbol;
    }

    const existing = segments.find((s) => s.startLine === startLine && s.endLine === endLine);
    if (existing) {
      for (const line of cluster.lines) {
        if (!existing.uncoveredLines.includes(line)) existing.uncoveredLines.push(line);
      }
      existing.uncoveredLines.sort((a, b) => a - b);
      continue;
    }

    segments.push({
      path,
      startLine,
      endLine,
      uncoveredLines: [...cluster.lines],
      text: numberLines(lines, startLine, endLine),
      ...(symbol ? { symbol } : {}),
    });
  }

  // Target ordering's idea one level down: `maxPerFile` decides which holes in
  // this file get a prompt, and a branchy hole is worth more than a longer
  // straight-line one, so weight the line count by branch density. Size stays
  // linear here, unlike the cross-file score: these holes are all in one file
  // and a longer one really does need more of the prompt budget.
  const weights = new Map(
    segments.map((s) => {
      const text = s.uncoveredLines.map((n) => lines[n - 1] ?? "").join("\n");
      return [s, s.uncoveredLines.length * branchWeight(branchCount(text), s.uncoveredLines.length)] as const;
    }),
  );
  segments.sort((a, b) => weights.get(b)! - weights.get(a)! || a.startLine - b.startLine);
  return segments.slice(0, maxPerFile);
}
