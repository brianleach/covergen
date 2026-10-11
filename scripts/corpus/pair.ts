/**
 * Pairing resolver: finds the Vitest test files in a checkout and pairs each
 * with the one repository source file it imports most symbols from. Reads
 * files only; nothing in the checkout is executed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

export type DropReason = "not_vitest" | "no_resolvable_source" | "generated" | "snapshot";

export interface Pair {
  testPath: string;
  sourcePath: string;
  vitestVersion: string;
}

export interface RepoPairs {
  tests: number;
  pairs: Pair[];
  drops: Partial<Record<DropReason, number>>;
}

const TEST_FILE = /\.(test|spec)\.ts$/;
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts"];
const TEST_DIRS = new Set(["test", "tests", "__tests__", "fixtures", "__fixtures__", "__mocks__"]);
const GENERATED_DIRS = new Set(["dist", "build", "generated", "__generated__"]);
const GENERATED_HEADER = /@generated|auto-?generated|code generated|do not edit/i;
const OTHER_RUNNER = /from\s*['"](@jest\/globals|node:test|bun:test|mocha|ava|uvu)['"]/;
const VITEST_IMPORT = /(from\s*|import\s*\(?\s*)['"]vitest(\/[^'"]*)?['"]/;
const IMPORT_FROM = /(?:^|[\n;])\s*(?:import|export)\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (st?.isDirectory()) walk(root, full, out);
    else if (st?.isFile()) out.push(relative(root, full));
  }
  return out;
}

const segments = (path: string): string[] => path.split(sep);
export const isTestFile = (path: string): boolean => TEST_FILE.test(path) && !path.endsWith(".d.ts");
const isSnapshot = (path: string): boolean => segments(path).includes("__snapshots__") || path.endsWith(".snap");
const isGenerated = (path: string, text: string): boolean =>
  segments(path).some((s) => GENERATED_DIRS.has(s)) || GENERATED_HEADER.test(text.slice(0, 512));

/**
 * The vitest range declared by the nearest package.json, walking up from the
 * test to the repo root, or null when none declares it. A pnpm `catalog:`
 * range is read from pnpm-workspace.yaml.
 */
export function vitestRange(root: string, testPath: string): string | null {
  let dir = dirname(join(root, testPath));
  for (;;) {
    const pkgFile = join(dir, "package.json");
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, Record<string, string>>;
      const range = pkg.devDependencies?.vitest ?? pkg.dependencies?.vitest ?? pkg.peerDependencies?.vitest;
      if (range) return range.startsWith("catalog:") ? catalogRange(root, range) : range;
    }
    if (resolve(dir) === resolve(root)) return null;
    dir = dirname(dir);
  }
}

function catalogRange(root: string, range: string): string {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return range;
  const ws = (parseYaml(readFileSync(file, "utf8")) ?? {}) as {
    catalog?: Record<string, string>;
    catalogs?: Record<string, Record<string, string>>;
  };
  const name = range.slice("catalog:".length);
  const found = name === "" || name === "default" ? ws.catalog?.vitest : ws.catalogs?.[name]?.vitest;
  return found ?? range;
}

/** Count the symbols one import clause brings in. A namespace import counts its distinct members used. */
export function countSymbols(clause: string, testText: string): number {
  const c = clause.replace(/^type\s+/, "").trim();
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(c);
  if (ns) {
    const members = new Set(testText.match(new RegExp(`\\b${ns[1]}\\.([A-Za-z_$][\\w$]*)`, "g")) ?? []);
    return Math.max(1, members.size);
  }
  const braces = /\{([^}]*)\}/.exec(c);
  const named = braces ? braces[1]!.split(",").filter((s) => s.trim() !== "").length : 0;
  const head = c.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
  return named + (head !== "" && head !== "*" ? 1 : 0);
}

/** Resolve a relative specifier to a TypeScript source file inside the repo, or null. */
export function resolveImport(root: string, fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(root, dirname(fromFile), spec);
  if (!base.startsWith(resolve(root) + sep)) return null;
  const candidates = /\.(ts|tsx|mts|cts)$/.test(base)
    ? [base]
    : /\.[mc]?js$/.test(base)
      ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base.replace(/\.mjs$/, ".mts"), base.replace(/\.cjs$/, ".cts")]
      : [...SOURCE_EXTS.map((e) => base + e), join(base, "index.ts"), join(base, "index.tsx")];
  for (const c of candidates) {
    if (!SOURCE_EXTS.some((e) => c.endsWith(e)) || c.endsWith(".d.ts")) continue;
    if (!statSync(c, { throwIfNoEntry: false })?.isFile()) continue;
    const rel = relative(root, c);
    if (isTestFile(rel) || isSnapshot(rel) || segments(rel).some((s) => TEST_DIRS.has(s))) return null;
    return rel;
  }
  return null;
}

/** The source a test imports most symbols from; ties go to the first relative import. */
export function pickSource(root: string, testPath: string, testText: string): string | null {
  const counts = new Map<string, number>();
  for (const m of testText.matchAll(IMPORT_FROM)) {
    const target = resolveImport(root, testPath, m[2]!);
    if (target === null) continue;
    counts.set(target, (counts.get(target) ?? 0) + countSymbols(m[1]!, testText));
  }
  let best: string | null = null;
  for (const [path, n] of counts) if (best === null || n > counts.get(best)!) best = path;
  return best;
}

function pairOne(root: string, testPath: string): Pair | DropReason {
  if (isSnapshot(testPath)) return "snapshot";
  const text = readFileSync(join(root, testPath), "utf8");
  const range = vitestRange(root, testPath);
  if (!VITEST_IMPORT.test(text) && (OTHER_RUNNER.test(text) || range === null)) return "not_vitest";
  if (isGenerated(testPath, text)) return "generated";
  const sourcePath = pickSource(root, testPath, text);
  if (sourcePath === null) return "no_resolvable_source";
  if (isGenerated(sourcePath, readFileSync(join(root, sourcePath), "utf8"))) return "generated";
  return { testPath, sourcePath, vitestVersion: range ?? "unknown" };
}

/** Pair every Vitest test file in a checkout with its source. */
export function pairRepo(root: string): RepoPairs {
  const result: RepoPairs = { tests: 0, pairs: [], drops: {} };
  for (const testPath of walk(root).filter(isTestFile).sort()) {
    result.tests++;
    const r = pairOne(root, testPath);
    if (typeof r === "string") result.drops[r] = (result.drops[r] ?? 0) + 1;
    else result.pairs.push(r);
  }
  return result;
}
