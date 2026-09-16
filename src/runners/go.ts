/**
 * Go runner. `go test -coverprofile` writes Go's own block profile, not lcov, so
 * the conversion happens here rather than through an external tool: covergen adds
 * no dependency for it and the parser is 30 lines.
 *
 * Three things differ from the other runners. Go tests are selected by package,
 * never by file, so a gate run over `foo_test.go` runs the package that file
 * lives in. A profile block carries statement counts, so the line coverage this
 * reports is statements-based: a block spanning several lines marks all of them
 * with the block's count. And `gofmt` is a gate: Go projects treat unformatted
 * code as a failure, so an unformatted candidate is rejected before the suite runs.
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GoOptions, PreflightOptions, RepoConfig, RunOptions, RunResult, Runner } from "../types.js";
import { coverageOutDir, runCommand, withPrefix, type ExecFn } from "./exec.js";

const DEFAULTS: GoOptions = { command: ["go", "test"], packages: ["./..."], race: true };
/** `go version` prints "go1.22.5"; anything older than this has no `go test -coverprofile` we support. */
const MIN_GO = [1, 22] as const;
const LIST_FORMAT = "{{.ImportPath}}\t{{.Dir}}";

/** One local package, as `go list` reports it. */
export interface GoPackage {
  importPath: string;
  dir: string;
}

function posix(p: string): string {
  return p.replaceAll("\\", "/");
}

/** The repo's go settings with every default filled in. */
export function goSettings(repo: RepoConfig): GoOptions {
  const opts = repo.go ?? DEFAULTS;
  return {
    command: opts.command.length > 0 ? opts.command : DEFAULTS.command,
    packages: opts.packages.length > 0 ? opts.packages : DEFAULTS.packages,
    race: opts.race,
    buildTags: opts.buildTags,
  };
}

/** `[major, minor]` from a `go version` banner, or undefined when it is not one. */
export function parseGoVersion(banner: string): [number, number] | undefined {
  const m = /\bgo(\d+)\.(\d+)/.exec(banner);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2])];
}

/** `go list -f "{{.ImportPath}}\t{{.Dir}}"` output, longest import path first. */
export function parsePackageList(text: string): GoPackage[] {
  const out: GoPackage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const [importPath, dir] = raw.trim().split("\t");
    if (!importPath || !dir) continue;
    out.push({ importPath, dir });
  }
  // Longest first so a nested package wins over its parent's prefix.
  return out.sort((a, b) => b.importPath.length - a.importPath.length);
}

/**
 * A profile's file field is `<import path>/<file name>`. Map it back to a path
 * relative to `cwd`, or undefined when it belongs to a package outside the repo
 * (a dependency `-coverpkg` pulled in), which is not ours to report on.
 */
export function resolveProfilePath(source: string, cwd: string, packages: GoPackage[]): string | undefined {
  for (const pkg of packages) {
    if (!source.startsWith(`${pkg.importPath}/`)) continue;
    const abs = resolve(pkg.dir, source.slice(pkg.importPath.length + 1));
    const rel = posix(relative(resolve(cwd), abs));
    if (rel.length === 0 || rel.startsWith("../") || isAbsolute(rel)) return undefined;
    return rel;
  }
  return undefined;
}

/**
 * Convert a Go cover profile to lcov.
 *
 * Every `file:startLine.col,endLine.col numStmts count` block becomes a DA record
 * per line in `[startLine, endLine]`, and lines shared by several blocks take the
 * highest count, so a line reached by any block reads as covered. A block ending
 * at column 1 closes on the line before, so that line is not included. Blocks with
 * zero statements are bookkeeping and instrument nothing; they are skipped.
 */
export function profileToLcov(profile: string, cwd: string, packages: GoPackage[]): string {
  const files = new Map<string, Map<number, number>>();
  const BLOCK = /^(.*):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/;

  for (const raw of profile.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("mode:")) continue;
    const m = BLOCK.exec(line);
    if (!m) continue;
    const [, source, startRaw, , endRaw, endColRaw, stmtsRaw, countRaw] = m;
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (Number(stmtsRaw) === 0 || end < start) continue;
    const path = resolveProfilePath(source!, cwd, packages);
    if (path === undefined) continue;
    const count = Number(countRaw);
    const last = Number(endColRaw) === 1 ? end - 1 : end;
    let lines = files.get(path);
    if (!lines) {
      lines = new Map<number, number>();
      files.set(path, lines);
    }
    for (let n = start; n <= last; n += 1) lines.set(n, Math.max(lines.get(n) ?? 0, count));
  }

  const out: string[] = [];
  for (const path of [...files.keys()].sort()) {
    const lines = files.get(path)!;
    const numbers = [...lines.keys()].sort((a, b) => a - b);
    out.push("TN:", `SF:${path}`);
    for (const n of numbers) out.push(`DA:${n},${lines.get(n)!}`);
    out.push(`LF:${numbers.length}`, `LH:${numbers.filter((n) => lines.get(n)! > 0).length}`, "end_of_record");
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/**
 * Package patterns for a set of test files. Go selects tests by package, so a
 * gate run over one `_test.go` file runs the package that file sits in.
 */
export function packagesForFiles(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const dir = posix(dirname(file));
    dirs.add(dir === "." || dir === "" ? "." : `./${dir.replace(/^\.\//, "")}`);
  }
  return [...dirs].sort();
}

export function createGoRunner(exec: ExecFn = runCommand): Runner {
  /** The local package list, needed to map profile import paths back to files. */
  async function listPackages(repo: RepoConfig, timeoutMs: number): Promise<GoPackage[]> {
    const { command, packages } = goSettings(repo);
    const go = command[0]!;
    const res = await exec(withPrefix(repo.commandPrefix, [go, "list", "-f", LIST_FORMAT, ...packages]), {
      cwd: repo.cwd,
      timeoutMs,
    });
    return res.exitCode === 0 ? parsePackageList(res.stdout) : [];
  }

  return {
    name: "go",

    async preflight(repo: RepoConfig, opts?: PreflightOptions): Promise<void> {
      const { command, packages, race, buildTags } = goSettings(repo);
      const go = command[0]!;
      const fail = (...lines: (string | undefined)[]) => new Error(lines.filter(Boolean).join("\n"));
      const probe = { cwd: repo.cwd, timeoutMs: 120_000 };

      const version = await exec(withPrefix(repo.commandPrefix, [go, "version"]), probe);
      if (version.exitCode !== 0) {
        throw fail(`go preflight failed in ${repo.cwd}: \`${go} version\` exited ${version.exitCode}.`,
          version.stderr.trim() || version.stdout.trim(),
          `Put ${go} on PATH, or set go.command or command_prefix.`);
      }
      const found = parseGoVersion(`${version.stdout}\n${version.stderr}`);
      if (!found || found[0] < MIN_GO[0] || (found[0] === MIN_GO[0] && found[1] < MIN_GO[1])) {
        throw fail(`go preflight failed for ${repo.name}: need Go ${MIN_GO[0]}.${MIN_GO[1]} or newer, \`${go} version\` reported ${version.stdout.trim() || "nothing"}.`,
          "Upgrade the toolchain, or point go.command at a newer one.");
      }

      // `go vet` is the cheap proof that the packages compile. A repo that does not
      // build produces no profile, and every candidate would then be rejected for
      // adding no coverage.
      const tagArgs = buildTags && buildTags.length > 0 ? [`-tags=${buildTags.join(",")}`] : [];
      const vet = await exec(withPrefix(repo.commandPrefix, [go, "vet", ...tagArgs, ...packages]), probe);
      if (vet.exitCode !== 0) {
        throw fail(`go preflight failed for ${repo.name}: \`${go} vet ${packages.join(" ")}\` exited ${vet.exitCode} in ${repo.cwd}.`,
          (vet.stderr.trim() || vet.stdout.trim()).split("\n").slice(-15).join("\n") || undefined,
          "Fix the build, or set go.packages to the packages covergen should measure.");
      }

      const pkgs = await listPackages(repo, 120_000);
      if (!pkgs.some((pkg) => hasTestFile(pkg.dir))) {
        throw fail(`go preflight failed for ${repo.name}: no _test.go file exists under ${packages.join(", ")} in ${repo.cwd}.`,
          "Write one test by hand first: covergen extends a suite, it does not start one.");
      }

      // Smoke: a real coverage run that selects no test, which is the cheapest
      // proof that go.packages is right. A wrong package set is otherwise silent.
      // Deep tier only: it links every test binary, and the first baseline proves
      // the same thing on its way to a real measurement.
      if (!opts?.deep) return;

      const dir = coverageOutDir(repo);
      const profile = join(dir, "cover.out");
      const args = [...command, "-count=1", "-run", "CovergenSmokeSelectsNothing", ...tagArgs];
      if (race) args.push("-race");
      args.push(`-coverprofile=${profile}`, `-coverpkg=${packages.join(",")}`, ...packages);
      const smoke = await exec(withPrefix(repo.commandPrefix, args), { cwd: repo.cwd, timeoutMs: 300_000 });
      const written = existsSync(profile) ? await readFile(profile, "utf8") : "";
      const lcov = profileToLcov(written, repo.cwd, pkgs);
      await discard(dir);
      if (!/^SF:/m.test(lcov)) {
        throw fail(`go preflight failed for ${repo.name}: a coverage run over ${packages.join(", ")} produced no measurable blocks.`,
          (smoke.stderr.trim() || smoke.stdout.trim()).split("\n").slice(-15).join("\n") || undefined,
          "Set go.packages to the packages this module actually builds, for example [\"./internal/...\"].");
      }
    },

    async run(repo: RepoConfig, opts: RunOptions): Promise<RunResult> {
      const { command, packages, race, buildTags } = goSettings(repo);
      // -count=1 defeats the test cache: without it the repeat runs behind pass^k
      // and every mutant re-run would replay the first result.
      const args = [...command, "-count=1"];
      // -race on the gate runs only. The detector is the one check that sees a
      // data race, which pass^k never can: k runs on one idle machine all pass and
      // the same test fails in the repo's CI. Baselines skip it, because they are
      // measuring coverage and the instrumented binary costs several times the run.
      if (race && opts.gate) args.push("-race");
      if (buildTags && buildTags.length > 0) args.push(`-tags=${buildTags.join(",")}`);

      let dir: string | undefined;
      let profile: string | undefined;
      if (opts.coverage) {
        dir = coverageOutDir(repo);
        profile = join(dir, "cover.out");
        // -coverpkg stays the configured set whatever is being run, so the profile
        // from a one-package gate run is comparable to the whole-suite baseline.
        args.push(`-coverprofile=${profile}`, `-coverpkg=${packages.join(",")}`);
      }
      args.push(...(opts.files.length > 0 ? packagesForFiles(opts.files) : packages));

      const res = await exec(withPrefix(repo.commandPrefix, args), { cwd: repo.cwd, timeoutMs: opts.timeoutMs, env: opts.env });
      const out: RunResult = { ok: res.exitCode === 0, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, durationMs: res.durationMs };
      if (!profile || !dir) return out;

      if (!existsSync(profile)) {
        await discard(dir);
        return { ...out, stderr: `${out.stderr}\ncovergen: expected a Go cover profile at ${profile} but it was not written\n` };
      }
      const lcov = profileToLcov(await readFile(profile, "utf8"), repo.cwd, await listPackages(repo, opts.timeoutMs));
      if (lcov.length === 0) {
        await discard(dir);
        return { ...out, stderr: `${out.stderr}\ncovergen: the Go cover profile at ${profile} held no block inside ${repo.cwd}\n` };
      }
      const lcovPath = join(dir, "lcov.info");
      await writeFile(lcovPath, lcov, "utf8");
      return { ...out, lcovPath };
    },

    /**
     * gofmt is not a style preference in Go, it is the format every tool assumes,
     * so an unformatted candidate is rejected before the suite runs and the diff
     * goes into the repair loop.
     */
    async checkSpec(repo: RepoConfig, specPath: string): Promise<string | undefined> {
      const probe = { cwd: repo.cwd, timeoutMs: 60_000 };
      const listed = await exec(withPrefix(repo.commandPrefix, ["gofmt", "-l", specPath]), probe);
      if (listed.exitCode !== 0) {
        return `gofmt could not read ${specPath}:\n${(listed.stderr.trim() || listed.stdout.trim()).split("\n").slice(-20).join("\n")}`;
      }
      if (listed.stdout.trim().length === 0) return undefined;
      const diff = await exec(withPrefix(repo.commandPrefix, ["gofmt", "-d", specPath]), probe);
      return [`${specPath} is not gofmt formatted. Return it formatted exactly as gofmt would write it:`, diff.stdout.trim().split("\n").slice(0, 60).join("\n")]
        .filter((s) => s.length > 0)
        .join("\n");
    },

    specPathFor(repo: RepoConfig, relSource: string): string {
      return repo.specPath(relSource);
    },
  };
}

/** True when the directory holds at least one `_test.go` file. Preflight only. */
function hasTestFile(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith("_test.go"));
  } catch {
    return false;
  }
}

async function discard(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export const goRunner: Runner = createGoRunner();
