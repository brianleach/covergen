/**
 * The support matrix, executable. Each fixture under fixtures/ is a tiny repo
 * with one covered function and one deliberately uncovered one, and this drives
 * the real runner over it: preflight, a whole-project coverage baseline, lcov
 * parsing, and segment extraction. No network and no Anthropic key, so the
 * chain stops one step short of generation.
 *
 * A fixture whose toolchain is not installed here is skipped, not failed:
 * docs/SUPPORT.md records which rows that leaves unproven on a given machine.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepo, loadConfig } from "./config.js";
import { discardCoverageDir, readLcov } from "./lcov.js";
import { ruleViolations } from "./rules.js";
import { getRunner } from "./runners/index.js";
import { buildSegments } from "./segments.js";
import type { RepoConfig } from "./types.js";

const CONFIG = resolve(import.meta.dirname, "..", "fixtures", "covergen.fixtures.yaml");
const config = loadConfig(CONFIG);

/** True when `cmd --version` runs at all. Used to skip, never to fail. */
function onPath(cmd: string): boolean {
  try {
    return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

interface Fixture {
  repo: string;
  /** Source file with the uncovered function, relative to the fixture cwd. */
  target: string;
  /** Function that no test reaches. Its lines must all be uncovered. */
  uncoveredSymbol: string;
  available: () => boolean;
  /** Overrides the default per-test ceiling. Rust compiles before it measures. */
  timeoutMs?: number;
}

const fixtures: Fixture[] = [
  {
    repo: "vitest-esm-lib",
    target: "src/rates.ts",
    uncoveredSymbol: "refundFee",
    available: () => existsSync(join(config.repos[0]!.root, "node_modules", "@vitest", "coverage-v8")),
  },
  { repo: "bun-lib", target: "src/slugs.ts", uncoveredSymbol: "shorten", available: () => onPath("bun") },
  {
    repo: "jest-cjs",
    target: "src/retry.js",
    uncoveredSymbol: "shouldRetry",
    available: () => existsSync(join(config.repos[0]!.root, "node_modules", ".bin", "jest")),
  },
  // Ruby fixture: needs bundler plus an installed bundle (rspec, simplecov,
  // simplecov-lcov). Skipped wherever that is not present.
  { repo: "rspec-min", target: "lib/quota.rb", uncoveredSymbol: "tier", available: () => onPath("bundle") },
  // pytest alone writes no lcov, so pytest-cov is what decides this one.
  { repo: "pytest-min", target: "src/shop/rates.py", uncoveredSymbol: "refund_fee", available: () => hasPytestCov("pytest-min") },
  // `go version`, not `go --version`, which the tool does not accept.
  { repo: "go-min", target: "rates.go", uncoveredSymbol: "RefundFee", available: () => hasGo() },
  // Rust compiles twice here (once for `cargo test --no-run`, once instrumented),
  // so this one gets a longer ceiling than the interpreted fixtures need.
  { repo: "rust-min", target: "src/rates.rs", uncoveredSymbol: "refund_fee", available: () => hasCargoLlvmCov(), timeoutMs: 600_000 },
];

/**
 * True when cargo-llvm-cov is installed and can reach llvm-cov and llvm-profdata.
 * `cargo llvm-cov --version` answers without the LLVM tools, so the tools are
 * checked separately: the rustup component, or the LLVM_COV/LLVM_PROFDATA pair a
 * distro toolchain uses instead. Used to skip, never to fail.
 */
function hasCargoLlvmCov(): boolean {
  try {
    if (spawnSync("cargo", ["llvm-cov", "--version"], { stdio: "ignore" }).status !== 0) return false;
    if (process.env.LLVM_COV && process.env.LLVM_PROFDATA) return true;
    const host = /^host:\s*(\S+)/m.exec(spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout ?? "")?.[1];
    const sysroot = spawnSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).stdout?.trim();
    return Boolean(host && sysroot && existsSync(join(sysroot, "lib", "rustlib", host, "bin", "llvm-profdata")));
  } catch {
    return false;
  }
}

/** True when the Go toolchain answers `go version`. Used to skip, never to fail. */
function hasGo(): boolean {
  try {
    return spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** True when the fixture's configured pytest can write coverage. Used to skip, never to fail. */
function hasPytestCov(name: string): boolean {
  const [file, ...rest] = findRepo(config, name).pytest?.command ?? ["python", "-m", "pytest"];
  try {
    const res = spawnSync(file!, [...rest, "--version", "--version"], { encoding: "utf8" });
    return /pytest[-_]cov/i.test(`${res.stdout ?? ""}${res.stderr ?? ""}`);
  } catch {
    return false;
  }
}

/** Line numbers of the named function's body, by finding the definition and its indentation. */
function bodyLines(source: string, symbol: string): number[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes(symbol) && /\b(function|def|=>|\()/.test(line));
  expect(start, `${symbol} not found in the fixture source`).toBeGreaterThanOrEqual(0);
  const out: number[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    if (/^\S/.test(line) && !/^[)}\]]/.test(line)) break;
    out.push(i + 1);
  }
  return out;
}

describe("fixture repos", () => {
  for (const fixture of fixtures) {
    const repo: RepoConfig = findRepo(config, fixture.repo);
    const run = fixture.available() ? it : it.skip;

    run(
      `${fixture.repo}: preflight passes, the baseline reports the uncovered function, and segments cover it`,
      async () => {
        const runner = getRunner(repo.runner);
        await runner.preflight(repo);

        const result = await runner.run(repo, {
          files: [],
          coverage: true,
          timeoutMs: config.gate.baseline_timeout_ms,
          wholeProject: true,
        });
        expect(result.lcovPath, `${fixture.repo} produced no lcov:\n${result.stderr}\n${result.stdout}`).toBeTruthy();

        try {
          const map = await readLcov(result.lcovPath!, { cwd: repo.cwd });
          const file = map.get(fixture.target);
          expect(file, `${fixture.target} missing from the lcov, keys: ${[...map.keys()].join(", ")}`).toBeDefined();

          const source = readFileSync(join(repo.cwd, fixture.target), "utf8");
          const hit = [...file!.lines.entries()].filter(([, hits]) => hits > 0);
          expect(hit.length, "the covered function should report hits").toBeGreaterThan(0);

          // Every instrumented line of the uncovered function reads zero.
          const inBody = new Set(bodyLines(source, fixture.uncoveredSymbol));
          const measured = [...file!.lines.entries()].filter(([line]) => inBody.has(line));
          expect(measured.length, "the uncovered function should be instrumented").toBeGreaterThan(0);
          expect(measured.filter(([, hits]) => hits > 0)).toEqual([]);

          const segments = buildSegments({
            path: fixture.target,
            source,
            coverage: file!,
            maxLines: config.segments.max_lines,
            maxPerFile: config.segments.max_per_file,
          });
          expect(segments.length).toBeGreaterThan(0);
          expect(segments.some((s) => s.uncoveredLines.some((line) => inBody.has(line)))).toBe(true);
          expect(segments.every((s) => s.text.length > 0)).toBe(true);
        } finally {
          await discardCoverageDir(result.lcovPath!);
        }
      },
      fixture.timeoutMs ?? 120_000,
    );
  }
});

/**
 * Dynamic-route paths. A coverage include is a glob, so a source path holding a
 * character class, the shape `app/api/items/[id]/route.ts` produces, has to be
 * escaped or the include matches nothing and the lcov comes back without the
 * file. Before the escape this run returned zero SF records.
 */
describe("a source path with glob metacharacters", () => {
  const repo: RepoConfig = findRepo(config, "vitest-esm-lib");
  const target = "src/routes/[id]/route.ts";
  const run = existsSync(join(repo.root, "node_modules", "@vitest", "coverage-v8")) ? it : it.skip;

  run(
    "still gets an lcov record when coverage is narrowed to it",
    async () => {
      const result = await getRunner(repo.runner).run(repo, {
        files: ["src/routes/[id]/route.test.ts"],
        coverage: true,
        timeoutMs: config.gate.baseline_timeout_ms,
        env: { COVERGEN_SOURCE: target },
      });
      expect(result.lcovPath, `no lcov:\n${result.stderr}\n${result.stdout}`).toBeTruthy();

      try {
        const map = await readLcov(result.lcovPath!, { cwd: repo.cwd });
        expect(map.get(target), `${target} missing from the lcov, keys: ${[...map.keys()].join(", ")}`).toBeDefined();
      } finally {
        await discardCoverageDir(result.lcovPath!);
      }
    },
    120_000,
  );
});

/**
 * The Go gate under `-race`, on the real toolchain.
 *
 * Three candidates, the three outcomes the gate has to produce. The racy one
 * writes a captured variable from goroutines nobody synchronizes: it passes the
 * plain run and pass^k with it, and only the detector rejects it, which is the
 * argument for the flag. The procfs one is turned away by `no-os-specific`
 * before anything runs, and the guarded one, reading the same path behind a
 * `runtime.GOOS` skip, is clean and passes instrumented.
 *
 * The fixture is copied to a temp directory rather than written into
 * fixtures/go-min: these files must never be left behind for the baseline test
 * above to compile.
 */
describe("the Go gate under -race", () => {
  const source: RepoConfig = findRepo(config, "go-min");
  const run = hasGo() ? it : it.skip;

  const racy = `package rates

import (
	"sync"
	"testing"
)

func TestServiceFeeConcurrently(t *testing.T) {
	total := 0
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			total += ServiceFee(100)
		}()
	}
	wg.Wait()
	if total < 10 {
		t.Errorf("total = %d, want at least 10", total)
	}
}
`;

  const procfs = `package rates

import (
	"os"
	"testing"
)

func TestRefundFeeAgainstProcfs(t *testing.T) {
	if _, err := os.Stat("/proc/self/cmdline"); err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if got := RefundFee(2000); got != 25 {
		t.Errorf("RefundFee(2000) = %d, want 25", got)
	}
}
`;

  const guarded = `package rates

import (
	"os"
	"runtime"
	"testing"
)

func TestRefundFeeAgainstProcfs(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("/proc/self/cmdline only exists on Linux")
	}
	if _, err := os.Stat("/proc/self/cmdline"); err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if got := RefundFee(2000); got != 25 {
		t.Errorf("RefundFee(2000) = %d, want 25", got)
	}
}
`;

  run(
    "fails the racy candidate, passes the guarded one, and leaves the procfs one to the rule",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "covergen-go-race-"));
      const repo: RepoConfig = { ...source, root: dir, cwd: dir };
      const runner = getRunner("go");
      const gate = { coverage: false, timeoutMs: 300_000, gate: true };
      try {
        for (const name of ["go.mod", "rates.go", "rates_test.go"]) {
          copyFileSync(join(source.cwd, name), join(dir, name));
        }

        // Rules first: neither the racy nor the guarded candidate is rejectable on
        // its text, and the procfs one never reaches the runner.
        expect(ruleViolations(racy, "go")).toEqual([]);
        expect(ruleViolations(guarded, "go")).toEqual([]);
        expect(ruleViolations(procfs, "go").map((v) => v.id)).toEqual(["no-os-specific"]);

        writeFileSync(join(dir, "guarded_test.go"), guarded);
        const clean = await runner.run(repo, { ...gate, files: ["guarded_test.go"] });
        expect(clean.ok, `guarded candidate failed:\n${clean.stderr}\n${clean.stdout}`).toBe(true);
        rmSync(join(dir, "guarded_test.go"));

        writeFileSync(join(dir, "racy_test.go"), racy);
        const uninstrumented = await runner.run(repo, { files: ["racy_test.go"], coverage: false, timeoutMs: 300_000 });
        expect(uninstrumented.ok, "the racy candidate should pass without -race, which is the point").toBe(true);

        const instrumented = await runner.run(repo, { ...gate, files: ["racy_test.go"] });
        expect(instrumented.ok).toBe(false);
        expect(`${instrumented.stdout}${instrumented.stderr}`).toContain("DATA RACE");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
