/**
 * Git helpers: changed files since a ref, source globbing that excludes tests,
 * and the tree fingerprint (HEAD plus dirty file contents) that keys the whole-suite
 * baseline cache.
 */

import { createHash } from "node:crypto";
/**
 * The two ways a sweep picks targets: what git says changed, and what the
 * repo's source globs match.
 */

import { execFile } from "node:child_process";
import { glob, lstat, readFile, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RepoConfig } from "./types.js";

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitExec = (args: string[], cwd: string) => Promise<GitExecResult>;

export interface GitDeps {
  exec?: GitExec;
  exists?: (absPath: string) => boolean;
  readFile?: (absPath: string) => Promise<Buffer>;
}

export interface FingerprintOptions extends GitDeps {
  /** Repo-relative directories whose generated contents must not invalidate the cache. */
  exclude?: string[];
  lstat?: (absPath: string) => Promise<{ isSymbolicLink(): boolean; mode?: number }>;
  readlink?: (absPath: string) => Promise<string>;
}

/** Default exec: `git <args>` with an argv array, never a shell string. */
export const runGit: GitExec = (args, cwd) =>
  new Promise((resolvePromise) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
        ? Number((err as NodeJS.ErrnoException & { code?: number }).code)
        : err
          ? 1
          : 0;
      resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
    });
  });

function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

/**
 * Files changed since `sinceRef`, as paths relative to `repoRoot`.
 *
 * Deleted and renamed-away files are filtered out: generating tests for a path
 * that no longer exists wastes a whole gate run.
 */
export async function changedFiles(repoRoot: string, sinceRef: string, deps: GitDeps = {}): Promise<string[]> {
  const exec = deps.exec ?? runGit;
  const exists = deps.exists ?? existsSync;

  const res = await exec(["diff", "--name-only", sinceRef], repoRoot);
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    throw new Error(`git diff --name-only ${sinceRef} failed in ${repoRoot}: ${detail || `exit ${res.exitCode}`}`);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of res.stdout.split("\n")) {
    const rel = toPosix(raw.trim());
    if (rel.length === 0) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!exists(join(repoRoot, rel))) continue;
    out.push(rel);
  }
  return out;
}

const TEST_FILE_PATTERNS = [
  /(^|\/)__tests__\//,
  /(^|\/)(spec|test|tests)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_(spec|test)\.rb$/,
  /(^|\/)test_[^/]*\.py$|_test\.py$/,
];

/**
 * A short fingerprint of HEAD plus the names and contents of every dirty file.
 * Two runs with the same fingerprint can share a whole-suite coverage baseline.
 */
export async function treeFingerprint(repoRoot: string, opts: FingerprintOptions = {}): Promise<string> {
  const exec = opts.exec ?? runGit;
  const read = opts.readFile ?? readFile;
  const inspect = opts.lstat ?? lstat;
  const readLink = opts.readlink ?? readlink;
  const run = async (args: string[]): Promise<string> => {
    const result = await exec(args, repoRoot);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`git ${args.join(" ")} failed in ${repoRoot}: ${detail || `exit ${result.exitCode}`}`);
    }
    return result.stdout;
  };

  const [head, staged, unstaged, untracked] = await Promise.all([
    run(["rev-parse", "HEAD"]),
    run(["diff", "--cached", "--name-only", "-z", "--ignore-submodules=none", "HEAD"]),
    run(["diff", "--name-only", "-z", "--ignore-submodules=none"]),
    run(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const excluded = [".covergen", ...(opts.exclude ?? [])]
    .map((path) => toPosix(relative(repoRoot, join(repoRoot, path))))
    .filter((path) => path.length > 0 && path !== ".." && !path.startsWith("../"));
  const paths = [...new Set(`${staged}${unstaged}${untracked}`.split("\0").filter(Boolean))]
    .filter((path) => !excluded.some((root) => path === root || path.startsWith(`${root}/`)))
    .sort();
  const hash = createHash("sha256").update(`HEAD\0${head.trim()}\0`);

  const inspectPath = async (abs: string): Promise<{ isSymbolicLink(): boolean; mode?: number } | undefined> => {
    try {
      return await inspect(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };

  for (const rel of paths) {
    hash.update(`path\0${rel}\0`);
    const abs = join(repoRoot, rel);
    const info = await inspectPath(abs);
    if (info?.isSymbolicLink()) {
      hash.update(`symlink\0${await readLink(abs)}\0`);
      continue;
    }
    if (info?.mode !== undefined) hash.update(`mode\0${info.mode}\0`);
    try {
      const contents = await read(abs);
      hash.update(`file\0${contents.length}\0`).update(contents);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        hash.update("missing\0");
      } else if (code === "EISDIR") {
        const stage = await run(["ls-files", "--stage", "--", rel]);
        if (!stage.startsWith("160000 ")) throw err;
        const nested = await treeFingerprint(join(repoRoot, rel), { exec, readFile: read });
        hash.update(`git-tree\0${stage}\0${nested}\0`);
      } else {
        throw err;
      }
    }
  }

  return hash.digest("hex").slice(0, 16);
}

export function isTestFile(relPath: string): boolean {
  const p = toPosix(relPath);
  return TEST_FILE_PATTERNS.some((re) => re.test(p));
}

const ALWAYS_EXCLUDED = ["node_modules", ".git", "dist", "build", "coverage", "vendor", "tmp", ".covergen"];

/**
 * Expand `repo.sources` relative to `repo.cwd`. Returns cwd-relative posix
 * paths, sorted and deduped, with test files removed.
 */
export async function listSources(repo: RepoConfig): Promise<string[]> {
  const seen = new Set<string>();
  for (const pattern of repo.sources) {
    const iter = glob(pattern, {
      cwd: repo.cwd,
      exclude: (name: string) => ALWAYS_EXCLUDED.includes(toPosix(name).split("/").pop() ?? ""),
    });
    for await (const entry of iter) {
      const rel = toPosix(typeof entry === "string" ? entry : String(entry));
      if (rel.length === 0) continue;
      if (isTestFile(rel)) continue;
      if (ALWAYS_EXCLUDED.some((dir) => rel === dir || rel.startsWith(`${dir}/`) || rel.includes(`/${dir}/`))) continue;
      if (isExcluded(repo, rel)) continue;
      seen.add(rel);
    }
  }
  return [...seen].sort();
}

/**
 * Tiny glob to RegExp translation, enough for the patterns config allows:
 * `**` (any depth), `*` (one segment), `?` (one char), `{a,b}` alternation.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  const p = toPosix(pattern);
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i]!;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // `**/` matches zero or more segments; a bare `**` matches the rest.
        if (p[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "{") {
      const close = p.indexOf("}", i);
      if (close !== -1) {
        const alts = p.slice(i + 1, close).split(",");
        out += `(?:${alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
        i = close;
        continue;
      }
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * True when a cwd-relative path matches any glob in `repo.exclude`. Exclusion
 * wins over `sources`, which is what makes it usable to drop one extension a
 * runner cannot execute without rewriting the source globs.
 */
export function isExcluded(repo: RepoConfig, relPath: string): boolean {
  const p = toPosix(relPath);
  return (repo.exclude ?? []).some((pattern) => globToRegExp(pattern).test(p));
}

/** True when a cwd-relative path matches any of `repo.sources` and is not a test file. */
export function matchesSources(repo: RepoConfig, relPath: string): boolean {
  const p = toPosix(relPath);
  if (isTestFile(p)) return false;
  if (isExcluded(repo, p)) return false;
  return repo.sources.some((pattern) => globToRegExp(pattern).test(p));
}

/**
 * Convert repo-root-relative paths (git's output) to cwd-relative ones, dropping
 * anything outside cwd. Monorepo repos set `cwd` to a subdirectory.
 */
export function toCwdRelative(repo: RepoConfig, repoRootRelative: string[]): string[] {
  const out: string[] = [];
  for (const rel of repoRootRelative) {
    const abs = resolve(repo.root, rel);
    const cwdRel = toPosix(relative(repo.cwd, abs));
    if (cwdRel.length === 0 || cwdRel.startsWith("../")) continue;
    out.push(cwdRel);
  }
  return out;
}
