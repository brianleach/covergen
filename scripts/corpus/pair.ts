/**
 * Pairing resolver: finds the Vitest test files in a checkout and pairs each
 * with the one repository source file it imports most symbols from. Relative
 * imports are preferred; when none resolves, workspace package names and plain
 * tsconfig path aliases are tried. Reads files only; nothing in the checkout is
 * executed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

export type DropReason =
  | "not_vitest"
  | "no_resolvable_source"
  | "workspace_entry_unreadable"
  | "generated"
  | "snapshot";

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

const TEST_FILE = /\.(test|spec)\.tsx?$/;
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
  return resolveBase(root, resolve(root, dirname(fromFile), spec));
}

/** Resolve an absolute path, with or without an extension, to a TypeScript source file inside the repo. */
function resolveBase(root: string, base: string): string | null {
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
  return best(testText, (spec, clause) => {
    const target = resolveImport(root, testPath, spec);
    return target === null ? null : new Map([[target, countSymbols(clause, testText)]]);
  });
}

type Attribution = Map<string, number> | null;

function best(testText: string, attribute: (spec: string, clause: string) => Attribution): string | null {
  const counts = new Map<string, number>();
  for (const m of testText.matchAll(IMPORT_FROM)) {
    for (const [target, n] of attribute(m[2]!, m[1]!) ?? []) counts.set(target, (counts.get(target) ?? 0) + n);
  }
  let top: string | null = null;
  for (const [path, n] of counts) if (top === null || n > counts.get(top)!) top = path;
  return top;
}

/** What a checkout says about non-relative imports: workspace packages by name, tsconfig aliases per directory. */
export interface ImportContext {
  packages: Map<string, string>;
  aliases: Map<string, Alias[]>;
}

export interface Alias {
  key: string;
  target: string;
  baseDir: string;
}

const globRegex = (glob: string): RegExp => {
  const body = glob.replace(/^\.\//, "").replace(/\/+$/, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${body.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);
};

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/**
 * Workspace package names mapped to their directories, from pnpm-workspace.yaml globs or the root
 * package.json `workspaces`. The root package itself is included, since a package may import itself by name.
 */
export function workspacePackages(root: string, files: string[]): Map<string, string> {
  const rootPkg = readJson(join(root, "package.json"));
  let globs: unknown = rootPkg?.workspaces;
  if (globs && !Array.isArray(globs)) globs = (globs as { packages?: unknown }).packages;
  const pnpmFile = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpmFile)) {
    try {
      globs = (parseYaml(readFileSync(pnpmFile, "utf8")) as { packages?: unknown } | null)?.packages ?? globs;
    } catch {
      // An unreadable workspace file declares nothing.
    }
  }
  const list = Array.isArray(globs) ? globs.filter((g): g is string => typeof g === "string") : [];
  const include = list.filter((g) => !g.startsWith("!")).map(globRegex);
  const exclude = list.filter((g) => g.startsWith("!")).map((g) => globRegex(g.slice(1)));
  const out = new Map<string, string>();
  if (typeof rootPkg?.name === "string") out.set(rootPkg.name, "");
  for (const file of files) {
    if (file.split(sep).pop() !== "package.json") continue;
    const dir = dirname(file).split(sep).join("/");
    if (dir === "." || !include.some((r) => r.test(dir)) || exclude.some((r) => r.test(dir))) continue;
    const name = readJson(join(root, file))?.name;
    if (typeof name === "string" && !out.has(name)) out.set(name, dir);
  }
  return out;
}

/** Every string an `exports` entry can point at, conditions flattened in order. */
function exportTargets(exports: unknown, subpath: string): string[] {
  const key = subpath === "" ? "." : `./${subpath}`;
  let node: unknown = typeof exports === "string" ? (key === "." ? exports : undefined) : undefined;
  if (exports && typeof exports === "object" && !Array.isArray(exports)) {
    const keyed = Object.keys(exports).some((k) => k.startsWith("."));
    node = keyed ? (exports as Record<string, unknown>)[key] : key === "." ? exports : undefined;
  }
  const out: string[] = [];
  const flat = (n: unknown): void => {
    if (typeof n === "string") out.push(n);
    else if (n && typeof n === "object") for (const v of Object.values(n)) flat(v);
  };
  flat(node);
  return out;
}

/** The source file behind a workspace package (or one of its subpaths), or null when none can be read. */
export function packageEntry(root: string, pkgDir: string, subpath: string): string | null {
  const pkg = readJson(join(root, pkgDir, "package.json")) ?? {};
  const fields = subpath === "" ? [pkg.source, ...exportTargets(pkg.exports, ""), pkg.module, pkg.main] : exportTargets(pkg.exports, subpath);
  const built = /^(\.\/)?(dist|build|lib|esm|cjs|out)\//;
  const tries: string[] = [];
  for (const f of fields) {
    if (typeof f !== "string") continue;
    tries.push(f);
    if (built.test(f)) tries.push(f.replace(built, "src/").replace(/(\.d)?\.[mc]?[jt]sx?$/, ""));
  }
  tries.push(...(subpath === "" ? ["src/index", "index"] : [`src/${subpath}`, subpath]));
  for (const t of tries) {
    const hit = resolveBase(root, resolve(root, pkgDir, t));
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * True for the alias shapes this resolver follows: one target, and either no wildcard at all or a single
 * trailing wildcard in the key matched by a single wildcard in the target. Anything else is left alone.
 */
export function isPlainAlias(key: string, targets: unknown): targets is [string] {
  if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== "string") return false;
  const stars = (s: string): number => s.split("*").length - 1;
  const k = stars(key);
  return k === stars(targets[0]) && (k === 0 || (k === 1 && key.endsWith("*")));
}

/** Plain path aliases from the nearest tsconfig.json above a file, following relative `extends`. */
export function tsconfigAliases(root: string, fromFile: string, cache = new Map<string, Alias[]>()): Alias[] {
  let dir = dirname(join(root, fromFile));
  for (;;) {
    const cached = cache.get(dir);
    if (cached) return cached;
    const file = join(dir, "tsconfig.json");
    if (existsSync(file)) {
      const aliases = readAliases(file);
      cache.set(dir, aliases);
      return aliases;
    }
    if (resolve(dir) === resolve(root)) return [];
    dir = dirname(dir);
  }
}

function readAliases(file: string): Alias[] {
  let paths: Record<string, unknown> | undefined;
  let pathsDir = "";
  let baseUrl: string | undefined;
  for (let hop = 0; hop < 5 && existsSync(file); hop++) {
    const { config } = ts.readConfigFile(file, (f) => readFileSync(f, "utf8"));
    const opts = (config?.compilerOptions ?? {}) as { paths?: Record<string, unknown>; baseUrl?: string };
    if (paths === undefined && opts.paths) [paths, pathsDir] = [opts.paths, dirname(file)];
    if (baseUrl === undefined && typeof opts.baseUrl === "string") baseUrl = resolve(dirname(file), opts.baseUrl);
    const ext = config?.extends;
    if (typeof ext !== "string" || !ext.startsWith(".")) break;
    file = resolve(dirname(file), ext.endsWith(".json") ? ext : `${ext}.json`);
  }
  return Object.entries(paths ?? {})
    .filter(([key, targets]) => isPlainAlias(key, targets))
    .map(([key, targets]) => ({ key, target: (targets as [string])[0], baseDir: baseUrl ?? pathsDir }));
}

/** Apply the longest matching plain alias to a specifier, as an absolute path, or null when none matches. */
export function applyAlias(aliases: Alias[], spec: string): string | null {
  let hit: { alias: Alias; rest: string } | null = null;
  for (const a of aliases) {
    const prefix = a.key.replace(/\*$/, "");
    const matches = a.key.endsWith("*") ? spec.startsWith(prefix) : spec === a.key;
    if (matches && (hit === null || prefix.length > hit.alias.key.replace(/\*$/, "").length)) {
      hit = { alias: a, rest: spec.slice(prefix.length) };
    }
  }
  return hit && resolve(hit.alias.baseDir, hit.alias.target.replace("*", hit.rest));
}

const escapeRe = (s: string): string => s.replace(/[$]/g, "\\$&");
const stripComments = (s: string): string => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");

/** File texts without comments, read while following re-exports and cleared per checkout. */
const texts = new Map<string, string>();
const readText = (root: string, file: string): string => {
  const full = join(root, file);
  let text = texts.get(full);
  if (text === undefined) texts.set(full, (text = stripComments(readFileSync(full, "utf8"))));
  return text;
};
const IDENT = /^[A-Za-z_$][\w$]*$/;
const REEXPORT_NAMED = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const REEXPORT_ALL = /export\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*['"]([^'"]+)['"]/g;
const HELPER_NAME = /^(?:(?:test|spec)[-_.]?(?:utils?|helpers?|setup)|(?:vitest|test)[-_.]?setup|setup[-_.]?(?:tests?|vitest))$/i;

/** A test helper or setup file by its name, which a package name or alias can reach but is never a source. */
export const isHelperFile = (path: string): boolean => HELPER_NAME.test(basename(path).replace(/\.[^.]+$/, ""));

/** True when a file holds nothing but re-exports: a barrel, which is not a source by itself. */
export const isBarrel = (text: string): boolean =>
  stripComments(text).replace(REEXPORT_NAMED, "").replace(REEXPORT_ALL, "").replace(/[;\s]/g, "") === "";

/** The file that defines an exported `name`, following re-exports from `file`, or null when it cannot be found. */
export function definitionOf(root: string, file: string, name: string, seen = new Set<string>()): string | null {
  if (seen.has(file) || seen.size >= 32) return null;
  seen.add(file);
  const text = readText(root, file);
  for (const m of text.matchAll(REEXPORT_NAMED)) {
    for (const item of m[1]!.split(",")) {
      const parts = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (parts[parts.length - 1] !== name) continue;
      const target = resolveImport(root, file, m[2]!);
      return target && (definitionOf(root, target, parts[0]!, seen) ?? target);
    }
  }
  const n = escapeRe(name);
  const kinds = "(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:const|let|var|function\\*?|class|interface|type|enum|namespace)";
  if (new RegExp(`export\\s+${kinds}\\s+${n}\\b|export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}(?!\\s*from)`).test(text)) return file;
  for (const m of text.matchAll(REEXPORT_ALL)) {
    if (/^export\s*\*\s*as/.test(m[0])) continue;
    const target = resolveImport(root, file, m[1]!);
    const hit = target && definitionOf(root, target, name, seen);
    if (hit) return hit;
  }
  return null;
}

/**
 * Split an import clause's symbols between the files that define them, following the entry's re-exports.
 * A default import counts for the entry. Barrels and test helpers never collect symbols.
 */
function attribute(root: string, entry: string, clause: string, testText: string): Map<string, number> {
  const c = stripComments(clause).replace(/^type\s+/, "").trim();
  const out = new Map<string, number>();
  const add = (file: string): void => {
    if (isHelperFile(file) || isBarrel(readText(root, file))) return;
    out.set(file, (out.get(file) ?? 0) + 1);
  };
  const names: string[] = [];
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(c);
  if (ns) {
    for (const m of testText.matchAll(new RegExp(`\\b${escapeRe(ns[1]!)}\\.([A-Za-z_$][\\w$]*)`, "g"))) names.push(m[1]!);
  }
  for (const item of /\{([^}]*)\}/.exec(c)?.[1]?.split(",") ?? []) names.push(item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!);
  const head = c.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[\w$]+/, "").replace(/,/g, " ").trim();
  if (head !== "") add(entry);
  for (const name of new Set(names.filter((x) => x !== ""))) {
    add(IDENT.test(name) ? (definitionOf(root, entry, name) ?? entry) : entry);
  }
  return out;
}

/** Package name and subpath of a bare specifier: `@scope/pkg/sub` gives [`@scope/pkg`, `sub`]. */
const splitSpec = (spec: string): [string, string] => {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  return [parts.slice(0, n).join("/"), parts.slice(n).join("/")];
};

/**
 * The fallback when no relative import resolves: workspace package names, then plain tsconfig aliases,
 * scored the same way. `workspaceMiss` says an import named a workspace package whose entry could not be read.
 */
export function pickPackageSource(
  root: string,
  testPath: string,
  testText: string,
  ctx: ImportContext,
): { source: string | null; workspaceMiss: boolean } {
  let workspaceMiss = false;
  const source = best(testText, (spec, clause) => {
    if (spec.startsWith(".") || spec.startsWith("node:") || /^vitest(\/|$)/.test(spec)) return null;
    let entry: string | null = null;
    const [name, subpath] = splitSpec(spec);
    const pkgDir = ctx.packages.get(name);
    if (pkgDir !== undefined) {
      entry = packageEntry(root, pkgDir, subpath);
      if (entry === null) workspaceMiss = true;
    }
    if (entry === null) {
      const target = applyAlias(tsconfigAliases(root, testPath, ctx.aliases), spec);
      entry = target === null ? null : resolveBase(root, target);
    }
    return entry === null ? null : attribute(root, entry, clause, testText);
  });
  return { source, workspaceMiss: source === null && workspaceMiss };
}

function pairOne(root: string, testPath: string, ctx: ImportContext): Pair | DropReason {
  if (isSnapshot(testPath)) return "snapshot";
  const text = readFileSync(join(root, testPath), "utf8");
  const range = vitestRange(root, testPath);
  if (!VITEST_IMPORT.test(text) && (OTHER_RUNNER.test(text) || range === null)) return "not_vitest";
  if (isGenerated(testPath, text)) return "generated";
  let sourcePath = pickSource(root, testPath, text);
  if (sourcePath === null) {
    const fallback = pickPackageSource(root, testPath, text, ctx);
    if (fallback.workspaceMiss) return "workspace_entry_unreadable";
    sourcePath = fallback.source;
  }
  if (sourcePath === null) return "no_resolvable_source";
  if (isGenerated(sourcePath, readFileSync(join(root, sourcePath), "utf8"))) return "generated";
  return { testPath, sourcePath, vitestVersion: range ?? "unknown" };
}

/** Pair every Vitest test file in a checkout with its source. */
export function pairRepo(root: string): RepoPairs {
  const result: RepoPairs = { tests: 0, pairs: [], drops: {} };
  const files = walk(root);
  texts.clear();
  const ctx: ImportContext = { packages: workspacePackages(root, files), aliases: new Map() };
  for (const testPath of files.filter(isTestFile).sort()) {
    result.tests++;
    const r = pairOne(root, testPath, ctx);
    if (typeof r === "string") result.drops[r] = (result.drops[r] ?? 0) + 1;
    else result.pairs.push(r);
  }
  return result;
}
