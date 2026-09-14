import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../types.js";
import {
  cargoSettings,
  cfgTestRanges,
  createCargoRunner,
  failingCrates,
  packageArgs,
  packageForFile,
  parsePackageDirs,
  stripCfgTests,
} from "./cargo.js";
import type { ExecOptions, ExecResult } from "./exec.js";

let cwd: string;

const SOURCE = [
  "pub fn refund_fee(cents: i64) -> i64 {", // 1
  "    if cents > 1000 {", // 2
  "        return 25;", // 3
  "    }", // 4
  "    10", // 5
  "}", // 6
  "", // 7
  "#[cfg(test)]", // 8
  "mod tests {", // 9
  "    use super::*;", // 10
  "", // 11
  "    #[test]", // 12
  '    fn fee() {', // 13
  "        assert_eq!(refund_fee(2000), 25);", // 14
  "    }", // 15
  "}", // 16
].join("\n");

/** lcov the way cargo-llvm-cov writes it: absolute SF paths, test lines included. */
function lcov(): string {
  return ["SF:{CWD}/src/rates.rs", "DA:1,1", "DA:2,1", "DA:3,0", "DA:5,1", "DA:13,1", "DA:14,1", "LF:6", "LH:5", "end_of_record", ""].join("\n");
}

function metadata(): string {
  return JSON.stringify({
    packages: [
      { name: "workspace-root", manifest_path: join(cwd, "Cargo.toml") },
      { name: "rates", manifest_path: join(cwd, "crates", "rates", "Cargo.toml") },
    ],
  });
}

type Options = { versionExit?: number; buildExit?: number; writeLcov?: boolean };

function fakeExec(opts: Options = {}) {
  const calls: string[][] = [];
  const exec = async (cmd: string[], o: ExecOptions): Promise<ExecResult> => {
    calls.push(cmd);
    const ok = (stdout: string, exitCode = 0): ExecResult => ({ exitCode, stdout, stderr: "", durationMs: 1 });
    if (cmd.includes("--version")) return ok("cargo-llvm-cov 0.9.1", opts.versionExit ?? 0);
    if (cmd[1] === "metadata") return ok(metadata());
    if (cmd[1] === "test") return ok("", opts.buildExit ?? 0);
    const at = cmd.indexOf("--output-path");
    if (at !== -1 && opts.writeLcov !== false) writeFileSync(cmd[at + 1]!, lcov().replaceAll("{CWD}", o.cwd));
    return ok("test result: ok. 0 passed");
  };
  return { calls, exec };
}

function makeRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "rust-lib",
    root: cwd,
    runner: "cargo",
    cwd,
    sources: ["src/**/*.rs"],
    specPath: (rel) => rel,
    cargo: { command: ["cargo", "llvm-cov"], packages: [], testArgs: [] },
    ...over,
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "covergen-cargo-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "crates", "rates", "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "rates.rs"), SOURCE);
});

describe("cargo settings and package resolution", () => {
  it("fills in the defaults and reads the workspace members deepest first", () => {
    expect(cargoSettings(makeRepo({ cargo: undefined })).command).toEqual(["cargo", "llvm-cov"]);
    const packages = parsePackageDirs(metadata());
    expect(packages.map((p) => p.name)).toEqual(["rates", "workspace-root"]);
    expect(packageForFile(join(cwd, "crates", "rates", "src", "lib.rs"), packages)).toBe("rates");
    expect(packageForFile(join(cwd, "src", "rates.rs"), packages)).toBe("workspace-root");
    expect(packageForFile("/elsewhere/lib.rs", packages)).toBeUndefined();
  });

  it("returns nothing for metadata that is not JSON, rather than throwing", () => {
    expect(parsePackageDirs("error: no Cargo.toml")).toEqual([]);
  });
});

describe("cfg(test) regions", () => {
  it("spans the whole module and leaves a feature named test alone", () => {
    expect(cfgTestRanges(SOURCE)).toEqual([[8, 16]]);
    expect(cfgTestRanges('#[cfg(feature = "test")]\nmod helpers {\n}\n')).toEqual([]);
    expect(cfgTestRanges("#[cfg(all(test, unix))]\nmod t {\n    fn f() {}\n}\n")).toEqual([[1, 4]]);
    // An attribute on something that is not a block covers its own line only.
    expect(cfgTestRanges("#[cfg(test)]\nuse std::fs;\n")).toEqual([[1, 1]]);
  });

  it("drops only the DA records inside those regions", () => {
    const stripped = stripCfgTests(lcov().replaceAll("{CWD}", cwd), () => SOURCE);
    expect(stripped).toContain("DA:3,0");
    expect(stripped).not.toContain("DA:13,1");
    expect(stripped).not.toContain("DA:14,1");
    // A file we cannot read keeps every record: dropping them would invent coverage.
    expect(stripCfgTests(lcov(), () => undefined)).toContain("DA:14,1");
  });
});

describe("the cargo runner", () => {
  it("measures the whole workspace for a suite run and one package for a spec run", async () => {
    const { calls, exec } = fakeExec();
    const runner = createCargoRunner(exec);
    const repo = makeRepo();

    const whole = await runner.run(repo, { files: [], coverage: true, timeoutMs: 1000, wholeProject: true });
    expect(whole.lcovPath).toBeTruthy();
    expect(calls.at(-1)).toContain("--workspace");

    await runner.run(repo, { files: ["crates/rates/src/lib.rs"], coverage: false, timeoutMs: 1000 });
    expect(calls.at(-1)).toEqual(["cargo", "llvm-cov", "-p", "rates"]);
  });

  it("strips the in-file test module out of the lcov it returns", async () => {
    const { exec } = fakeExec();
    const result = await createCargoRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
    const written = readFileSync(result.lcovPath!, "utf8");
    expect(written).toContain("DA:3,0");
    expect(written).not.toContain("DA:14,1");
  });

  it("passes test_args to the harness after a -- separator", async () => {
    const { calls, exec } = fakeExec();
    const repo = makeRepo({ cargo: { command: ["cargo", "llvm-cov"], packages: [], testArgs: ["--test-threads=1"] } });
    await createCargoRunner(exec).run(repo, { files: [], coverage: false, timeoutMs: 1000 });
    expect(calls.at(-1)).toEqual(["cargo", "llvm-cov", "--workspace", "--", "--test-threads=1"]);
  });

  it("reports a missing lcov without calling the run a failure", async () => {
    const { exec } = fakeExec({ writeLcov: false });
    const result = await createCargoRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    expect(result.lcovPath).toBeUndefined();
    expect(result.stderr).toContain("but it was not written");
  });
});

describe("cargo preflight tiers", () => {
  it("checks the tool and nothing else by default", async () => {
    const { calls, exec } = fakeExec();
    await expect(createCargoRunner(exec).preflight(makeRepo())).resolves.toBeUndefined();
    expect(calls).toEqual([["cargo", "llvm-cov", "--version"]]);
  });

  it("still reports a missing tool in the cheap tier", async () => {
    const { exec } = fakeExec({ versionExit: 127 });
    await expect(createCargoRunner(exec).preflight(makeRepo())).rejects.toThrow(/--version` exited 127/);
  });

  it("adds the smoke coverage run under --deep, and no build probe", async () => {
    const { calls, exec } = fakeExec();
    await expect(createCargoRunner(exec).preflight(makeRepo(), { deep: true })).resolves.toBeUndefined();
    expect(calls.some((c) => c.includes("covergen_smoke_selects_nothing"))).toBe(true);
    // `cargo test --no-run` built the same crates the smoke run builds.
    expect(calls.some((c) => c.includes("--no-run"))).toBe(false);
  });

  it("scopes the smoke run to the configured crates", async () => {
    const { calls, exec } = fakeExec();
    const repo = makeRepo({ cargo: { command: ["cargo", "llvm-cov"], packages: ["rates"], testArgs: [] } });
    await createCargoRunner(exec).preflight(repo, { deep: true });
    const smoke = calls.find((c) => c.includes("covergen_smoke_selects_nothing"))!;
    expect(smoke.slice(0, 4)).toEqual(["cargo", "llvm-cov", "-p", "rates"]);
    expect(smoke).not.toContain("--workspace");
  });

  it("names both routes to the LLVM tools when the smoke run writes no records", async () => {
    const { exec } = fakeExec({ writeLcov: false });
    await expect(createCargoRunner(exec).preflight(makeRepo(), { deep: true })).rejects.toThrow(
      /llvm-tools-preview[\s\S]*LLVM_PROFDATA/,
    );
  });
});

describe("cargo package scoping", () => {
  it("turns the configured crates into -p flags and falls back to the workspace", () => {
    expect(packageArgs(makeRepo())).toEqual(["--workspace"]);
    const scoped = makeRepo({ cargo: { command: ["cargo", "llvm-cov"], packages: ["rates", "engine"], testArgs: [] } });
    expect(packageArgs(scoped)).toEqual(["-p", "rates", "-p", "engine"]);
  });

  it("keeps the baseline inside those crates and adds --no-fail-fast", async () => {
    const { calls, exec } = fakeExec();
    const repo = makeRepo({ cargo: { command: ["cargo", "llvm-cov"], packages: ["rates"], testArgs: [] } });
    await createCargoRunner(exec).run(repo, { files: [], coverage: false, timeoutMs: 1000, wholeProject: true });
    expect(calls.at(-1)).toEqual(["cargo", "llvm-cov", "-p", "rates", "--no-fail-fast"]);
  });

  it("leaves a gate run fail-fast and scoped to the spec's own crate", async () => {
    const { calls, exec } = fakeExec();
    const repo = makeRepo({ cargo: { command: ["cargo", "llvm-cov"], packages: ["rates", "engine"], testArgs: [] } });
    await createCargoRunner(exec).run(repo, { files: ["crates/rates/src/lib.rs"], coverage: false, timeoutMs: 1000 });
    expect(calls.at(-1)).toEqual(["cargo", "llvm-cov", "-p", "rates"]);
  });

  it("reads the failing crate out of cargo's own rerun hint", () => {
    const output = [
      "error: test failed, to rerun pass `-p legacy-sync --lib`",
      "error: test failed, to rerun pass `-p legacy-sync --lib`",
      "error: test failed, to rerun pass `-p rates --test integration`",
    ].join("\n");
    expect(failingCrates(output)).toEqual(["legacy-sync", "rates"]);
    expect(failingCrates("test result: ok. 12 passed")).toEqual([]);
  });
});

it("keeps every record for an SF path it cannot read as a file", async () => {
  mkdirSync(join(cwd, "src", "folder.rs"), { recursive: true });
  const exec = async (cmd: string[], o: ExecOptions): Promise<ExecResult> => {
    const at = cmd.indexOf("--output-path");
    if (at !== -1) writeFileSync(cmd[at + 1]!, lcov().replaceAll("{CWD}/src/rates.rs", join(o.cwd, "src", "folder.rs")));
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  };
  const result = await createCargoRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
  const written = readFileSync(result.lcovPath!, "utf8");
  expect(written).toContain(`SF:${join(cwd, "src", "folder.rs")}`);
  expect(written).toContain("DA:13,1");
  expect(written).toContain("DA:14,1");
});

it("stops at a failing --version and shows its output with the install hint", async () => {
  const { calls, exec } = fakeExec({ versionExit: 127 });
  const error = await createCargoRunner(exec).preflight(makeRepo()).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain(`cargo preflight failed in ${cwd}: \`cargo llvm-cov --version\` exited 127.`);
  expect(message).toContain("cargo-llvm-cov 0.9.1");
  expect(message).toContain("cargo install cargo-llvm-cov");
  expect(calls.some((c) => c.includes("--no-run"))).toBe(false);
});

it("delegates the spec path for a source file to the repo's own mapping", () => {
  const { exec } = fakeExec();
  const repo = makeRepo({ specPath: (rel) => `tests/${rel.replace(/\.rs$/, "_test.rs")}` });
  expect(createCargoRunner(exec).specPathFor(repo, "src/rates.rs")).toBe("tests/src/rates_test.rs");
});
