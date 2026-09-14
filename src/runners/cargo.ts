/**
 * Rust runner, through cargo-llvm-cov. `cargo llvm-cov --lcov --output-path <file>`
 * writes lcov directly, so there is no conversion step here: the tool is the whole
 * adapter.
 *
 * Three things differ from the other runners. Rust selects tests by crate, never by
 * file, so a gate run over a spec runs the package that file belongs to, resolved
 * through `cargo metadata`. Rust unit tests live inside the source file, in a
 * `#[cfg(test)] mod tests` block, which is where the default spec template points;
 * llvm-cov reports those test lines as coverage of the source file, so this runner
 * strips every `#[cfg(test)]` region out of the lcov before anything diffs it,
 * otherwise a candidate would "cover" its own test body. And `opts.wholeProject`
 * needs no extra flag: llvm-cov reports everything compiled into the test binaries,
 * whether a test loaded it or not.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { maskLine } from "../mutate.js";
import type { CargoOptions, PreflightOptions, RepoConfig, RunOptions, RunResult, Runner } from "../types.js";
import { coverageOutDir, runCommand, withPrefix, type ExecFn } from "./exec.js";

const DEFAULTS: CargoOptions = { command: ["cargo", "llvm-cov"], packages: [], testArgs: [] };
/** A libtest filter no real test name contains, so the smoke run builds and runs nothing. */
const SMOKE_FILTER = "covergen_smoke_selects_nothing";
/**
 * Both routes to the LLVM tools cargo-llvm-cov needs. `cargo llvm-cov --version`
 * answers happily without them, so this hint belongs on the smoke failure too.
 */
const TOOLS_HINT = [
  "Install the driver with:  cargo install cargo-llvm-cov",
  "It also needs llvm-cov and llvm-profdata. On a rustup toolchain: rustup component add llvm-tools-preview.",
  "On a distro cargo with no rustup, point it at the system LLVM instead: LLVM_COV=/usr/bin/llvm-cov LLVM_PROFDATA=/usr/bin/llvm-profdata (the llvm package ships both).",
].join("\n");

/** One workspace member, as `cargo metadata` reports it. */
export interface CargoPackage {
  name: string;
  /** Absolute directory holding the package's Cargo.toml, forward slashes. */
  dir: string;
}

function posix(p: string): string {
  return p.replaceAll("\\", "/");
}

function tail(res: { stderr: string; stdout: string }): string | undefined {
  return (res.stderr.trim() || res.stdout.trim()).split("\n").slice(-15).join("\n") || undefined;
}

/** The repo's cargo settings with every default filled in. */
export function cargoSettings(repo: RepoConfig): CargoOptions {
  const opts = repo.cargo ?? DEFAULTS;
  return {
    command: opts.command.length > 0 ? opts.command : DEFAULTS.command,
    packages: opts.packages ?? [],
    testArgs: opts.testArgs,
  };
}

/**
 * The crate scope for a run that names no file: the configured crates as `-p`
 * flags, or the whole workspace when none are configured.
 *
 * `--workspace` overrides `-p`, so the two can never both be passed. A large
 * workspace with a red test in a crate nobody sweeps needs this: without it the
 * baseline runs (and fails on) crates covergen will never write a test for.
 */
export function packageArgs(repo: RepoConfig): string[] {
  const { packages } = cargoSettings(repo);
  if (packages.length === 0) return ["--workspace"];
  return packages.flatMap((name) => ["-p", name]);
}

/**
 * Crates cargo named as having failing tests, from its own rerun hint
 * (``error: test failed, to rerun pass `-p rates --lib` ``). Deduped, in the
 * order they appeared, so a warning can say where the red test lives.
 */
export function failingCrates(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/to rerun pass `-p ([A-Za-z0-9_.-]+)/g)) names.add(m[1] as string);
  return [...names];
}

/** Workspace members from `cargo metadata --no-deps`, deepest directory first. */
export function parsePackageDirs(text: string): CargoPackage[] {
  let parsed: { packages?: { name?: string; manifest_path?: string }[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return [];
  }
  const out: CargoPackage[] = [];
  for (const pkg of parsed.packages ?? []) {
    if (!pkg.name || !pkg.manifest_path) continue;
    out.push({ name: pkg.name, dir: posix(dirname(pkg.manifest_path)) });
  }
  // Deepest first so a nested member wins over the workspace root it sits in.
  return out.sort((a, b) => b.dir.length - a.dir.length);
}

/** The package owning an absolute file path, or undefined when none does. */
export function packageForFile(absFile: string, packages: CargoPackage[]): string | undefined {
  const file = posix(absFile);
  return packages.find((pkg) => file === pkg.dir || file.startsWith(`${pkg.dir}/`))?.name;
}

function braceDelta(masked: string): number {
  let delta = 0;
  for (const ch of masked) {
    if (ch === "{") delta += 1;
    else if (ch === "}") delta -= 1;
  }
  return delta;
}

/** True for `#[cfg(test)]` and `#[cfg(all(test, ...))]`, false for `#[cfg(feature = "test")]`. */
function isCfgTestAttr(line: string): boolean {
  const attr = /^\s*#\[cfg\((.*)\)\]\s*$/.exec(line);
  if (!attr) return false;
  return /\btest\b/.test(attr[1]!.replaceAll(/"[^"]*"/g, ""));
}

/**
 * 1-based inclusive line ranges of every `#[cfg(test)]` item in a Rust file.
 *
 * A braced item (`mod tests { ... }`) runs to its matching close brace, found by
 * counting braces on masked lines so one inside a string or comment does not
 * count. Anything else (a `#[cfg(test)] use ...`) is the attribute line alone.
 */
export function cfgTestRanges(source: string): [number, number][] {
  const lines = source.split("\n");
  const out: [number, number][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isCfgTestAttr(lines[i]!)) continue;
    // The item this attribute decorates opens on its own line or the next one.
    let open = -1;
    for (let j = i; j < lines.length && j <= i + 1; j += 1) {
      if (maskLine(lines[j]!, "rust").includes("{")) open = j;
      if (open !== -1) break;
    }
    if (open === -1) {
      out.push([i + 1, i + 1]);
      continue;
    }
    let depth = 0;
    let end = lines.length - 1;
    for (let j = open; j < lines.length; j += 1) {
      depth += braceDelta(maskLine(lines[j]!, "rust"));
      if (depth <= 0) {
        end = j;
        break;
      }
    }
    out.push([i + 1, end + 1]);
    i = end;
  }
  return out;
}

/**
 * Drop every DA record that falls inside a `#[cfg(test)]` region of its own file.
 *
 * LF and LH are left as llvm-cov wrote them; the parser in src/lcov.ts reads DA
 * records only, and this file is scratch that nothing else consumes.
 */
export function stripCfgTests(lcov: string, readSource: (sf: string) => string | undefined): string {
  const out: string[] = [];
  let ranges: [number, number][] = [];
  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const source = readSource(line.slice(3).trim());
      ranges = source === undefined ? [] : cfgTestRanges(source);
    } else if (line.startsWith("DA:") && ranges.length > 0) {
      const n = Number(line.slice(3).split(",")[0]);
      if (ranges.some(([start, end]) => n >= start && n <= end)) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function createCargoRunner(exec: ExecFn = runCommand): Runner {
  /** Workspace members, needed to turn a spec path into `-p <package>`. */
  async function listPackages(repo: RepoConfig, timeoutMs: number): Promise<CargoPackage[]> {
    const cargo = cargoSettings(repo).command[0]!;
    const args = [cargo, "metadata", "--no-deps", "--format-version", "1"];
    const res = await exec(withPrefix(repo.commandPrefix, args), { cwd: repo.cwd, timeoutMs });
    return res.exitCode === 0 ? parsePackageDirs(res.stdout) : [];
  }

  /**
   * Package selection for a set of spec files. A file in no known package falls
   * back to the whole workspace, which is slower but never measures nothing.
   */
  async function scopeFor(repo: RepoConfig, files: string[], timeoutMs: number): Promise<string[]> {
    // No file to resolve, or none that maps to a known crate: fall back to the
    // configured crates, and only to the whole workspace when there are none.
    if (files.length === 0) return packageArgs(repo);
    const packages = await listPackages(repo, timeoutMs);
    const names = new Set<string>();
    for (const file of files) {
      const name = packageForFile(isAbsolute(file) ? file : resolve(repo.cwd, file), packages);
      if (name) names.add(name);
    }
    if (names.size === 0) return packageArgs(repo);
    return [...names].sort().flatMap((name) => ["-p", name]);
  }

  /** Read a source file named by an lcov SF record, or undefined when it is not ours. */
  function sourceReader(cwd: string): (sf: string) => string | undefined {
    return (sf) => {
      if (!sf.endsWith(".rs")) return undefined;
      const abs = isAbsolute(sf) ? sf : resolve(cwd, sf);
      try {
        return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
      } catch {
        return undefined;
      }
    };
  }

  return {
    name: "cargo",

    async preflight(repo: RepoConfig, opts?: PreflightOptions): Promise<void> {
      const { command, testArgs } = cargoSettings(repo);
      const shown = command.join(" ");
      const fail = (...lines: (string | undefined)[]) => new Error(lines.filter(Boolean).join("\n"));

      const version = await exec(withPrefix(repo.commandPrefix, [...command, "--version"]), { cwd: repo.cwd, timeoutMs: 120_000 });
      if (version.exitCode !== 0) {
        throw fail(`cargo preflight failed in ${repo.cwd}: \`${shown} --version\` exited ${version.exitCode}.`, tail(version), TOOLS_HINT);
      }

      // Everything below compiles the tree, so it is the deep tier only. The
      // build probe that used to run here (`cargo test --no-run`) is gone: the
      // smoke run builds the same crates with the same errors, and the first
      // baseline builds them again, so it was a third build of the same code.
      if (!opts?.deep) return;

      // Smoke: a real coverage run that selects no test. It is the only thing that
      // proves the LLVM tools resolve, because `--version` answers without them.
      const scope = packageArgs(repo);
      const dir = coverageOutDir(repo);
      const lcovPath = join(dir, "lcov.info");
      const args = [...command, ...scope, "--lcov", "--output-path", lcovPath, "--", SMOKE_FILTER, ...testArgs];
      const smoke = await exec(withPrefix(repo.commandPrefix, args), { cwd: repo.cwd, timeoutMs: 1_800_000 });
      const written = existsSync(lcovPath) ? await readFile(lcovPath, "utf8") : "";
      await discard(dir);
      if (!/^SF:/m.test(written)) {
        throw fail(`cargo preflight failed for ${repo.name}: a coverage run over ${scope.join(" ")} wrote no lcov records.`, tail(smoke), TOOLS_HINT);
      }
    },

    async run(repo: RepoConfig, opts: RunOptions): Promise<RunResult> {
      const { command, testArgs } = cargoSettings(repo);
      const args = [...command, ...(await scopeFor(repo, opts.files, opts.timeoutMs))];
      // The whole-project baseline wants a full measurement, so one failing test
      // must not stop the crates behind it from running. A gate run keeps the
      // default: it is asking whether this spec passes, and the first failure is
      // the answer.
      if (opts.wholeProject) args.push("--no-fail-fast");

      let dir: string | undefined;
      let lcovPath: string | undefined;
      if (opts.coverage) {
        dir = coverageOutDir(repo);
        lcovPath = join(dir, "lcov.info");
        args.push("--lcov", "--output-path", lcovPath);
      }
      if (testArgs.length > 0) args.push("--", ...testArgs);

      const res = await exec(withPrefix(repo.commandPrefix, args), { cwd: repo.cwd, timeoutMs: opts.timeoutMs, env: opts.env });
      const out: RunResult = { ok: res.exitCode === 0, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, durationMs: res.durationMs };
      if (!lcovPath || !dir) return out;

      if (!existsSync(lcovPath)) {
        await discard(dir);
        return { ...out, stderr: `${out.stderr}\ncovergen: expected lcov at ${lcovPath} but it was not written\n` };
      }
      const stripped = stripCfgTests(await readFile(lcovPath, "utf8"), sourceReader(repo.cwd));
      await writeFile(lcovPath, stripped, "utf8");
      return { ...out, lcovPath };
    },

    specPathFor(repo: RepoConfig, relSource: string): string {
      return repo.specPath(relSource);
    },
  };
}

async function discard(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export const cargoRunner: Runner = createCargoRunner();
