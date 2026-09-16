import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../types.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { createGoRunner, goSettings, packagesForFiles, parseGoVersion, parsePackageList, profileToLcov, resolveProfilePath } from "./go.js";

const MODULE = "example.com/covergen/gomin";

let cwd: string;

/** A profile the way `go test -coverprofile` writes one, plus the package list. */
function profile(): string {
  return [
    "mode: set",
    `${MODULE}/rates.go:3.32,5.2 1 1`,
    `${MODULE}/rates.go:7.31,8.18 1 0`,
    `${MODULE}/rates.go:8.18,10.3 1 0`,
    `${MODULE}/rates.go:11.2,11.11 1 0`,
    `${MODULE}/cmd/gomin/main.go:9.13,11.2 1 0`,
    "",
  ].join("\n");
}

function packages() {
  return parsePackageList(`${MODULE}\t${cwd}\n${MODULE}/cmd/gomin\t${join(cwd, "cmd", "gomin")}\n`);
}

type Options = { version?: string; versionExit?: number; vetExit?: number; writeProfile?: boolean; runExit?: number; gofmtList?: string };

function fakeExec(opts: Options = {}) {
  const calls: string[][] = [];
  const exec = async (cmd: string[], o: ExecOptions): Promise<ExecResult> => {
    calls.push(cmd);
    const ok = (stdout: string, exitCode = 0): ExecResult => ({ exitCode, stdout, stderr: "", durationMs: 1 });
    if (cmd[1] === "version") return ok(opts.version ?? "go version go1.24.7 linux/amd64", opts.versionExit ?? 0);
    if (cmd[1] === "vet") return ok("", opts.vetExit ?? 0);
    if (cmd[1] === "list") return ok(`${MODULE}\t${o.cwd}\n${MODULE}/cmd/gomin\t${join(o.cwd, "cmd", "gomin")}\n`);
    if (cmd[0] === "gofmt") return ok(cmd[1] === "-l" ? (opts.gofmtList ?? "") : "--- a\n+++ b\n-  x := 1\n+\tx := 1\n");
    const flag = cmd.find((a) => a.startsWith("-coverprofile="));
    if (flag && opts.writeProfile !== false) writeFileSync(flag.slice("-coverprofile=".length), profile());
    return ok("ok\t" + MODULE, opts.runExit ?? 0);
  };
  return { calls, exec };
}

function makeRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "go-lib",
    root: cwd,
    runner: "go",
    cwd,
    sources: ["**/*.go"],
    specPath: (rel) => rel.replace(/\.go$/, "_test.go"),
    go: { command: ["go", "test"], packages: ["./..."], race: true },
    ...over,
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "covergen-go-"));
  mkdirSync(join(cwd, "cmd", "gomin"), { recursive: true });
  writeFileSync(join(cwd, "rates.go"), "package rates\n");
  writeFileSync(join(cwd, "rates_test.go"), "package rates\n");
  writeFileSync(join(cwd, "cmd", "gomin", "main.go"), "package main\n");
});

describe("the cover profile converter", () => {
  it("turns every block into DA records for the lines it spans, merged by max", () => {
    const lcov = profileToLcov(profile(), cwd, packages());
    expect(lcov).toContain("SF:rates.go");
    expect(lcov).toContain("SF:cmd/gomin/main.go");
    const start = lcov.indexOf("SF:rates.go");
    const rates = lcov.slice(start, lcov.indexOf("end_of_record", start));
    // 3.32,5.2 covers 3 to 5 with count 1; 7.31,8.18 and 8.18,10.3 both touch
    // line 8 with count 0, and the higher of the two counts wins.
    expect(rates).toContain("DA:3,1");
    expect(rates).toContain("DA:5,1");
    expect(rates).toContain("DA:8,0");
    expect(rates).toContain("DA:10,0");
    expect(rates).toContain("DA:11,0");
    expect(rates).toContain("LF:8");
    expect(rates).toContain("LH:3");
    // Line 6 is blank and line 12 closes the function: neither is in any block.
    expect(rates).not.toContain("DA:6,");
    expect(rates).not.toContain("DA:12,");
  });

  it("drops zero-statement blocks, blocks that close on column 1, and packages outside the repo", () => {
    const text = [
      "mode: count",
      `${MODULE}/rates.go:1.1,4.1 0 0`,
      `${MODULE}/rates.go:20.2,22.1 1 3`,
      "github.com/other/dep/dep.go:1.1,2.2 1 5",
      "",
    ].join("\n");
    const lcov = profileToLcov(text, cwd, packages());
    expect(lcov).not.toContain("dep.go");
    // The zero-statement block instruments nothing, so line 1 never appears.
    expect(lcov).not.toContain("DA:1,");
    // 20.2,22.1 closes on column 1 of line 22, so line 22 is not part of it.
    expect(lcov).toContain("DA:20,3");
    expect(lcov).toContain("DA:21,3");
    expect(lcov).not.toContain("DA:22,");
  });

  it("returns nothing at all for a profile with no block inside the repo", () => {
    expect(profileToLcov("mode: set\n", cwd, packages())).toBe("");
    expect(resolveProfilePath("some/other/x.go", cwd, packages())).toBeUndefined();
  });

  it("prefers the longest matching import path so a nested package is not read as its parent", () => {
    expect(resolveProfilePath(`${MODULE}/cmd/gomin/main.go`, cwd, packages())).toBe("cmd/gomin/main.go");
    expect(resolveProfilePath(`${MODULE}/rates.go`, cwd, packages())).toBe("rates.go");
  });
});

describe("go run", () => {
  it("asks for a profile over the configured packages and converts it to lcov", async () => {
    const { calls, exec } = fakeExec();
    const result = await createGoRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000, wholeProject: true });
    const test = calls.find((c) => c[1] === "test")!;
    expect(test).toContain("-count=1");
    expect(test).toContain("-coverpkg=./...");
    expect(test[test.length - 1]).toBe("./...");
    expect(test).not.toContain("-race");
    expect(result.lcovPath).toBeTruthy();
    expect(readFileSync(result.lcovPath!, "utf8")).toContain("SF:rates.go");
  });

  it("runs the package a named test file lives in, because Go selects tests by package", async () => {
    const { calls, exec } = fakeExec();
    await createGoRunner(exec).run(makeRepo(), { files: ["cmd/gomin/main_test.go", "rates_test.go"], coverage: false, timeoutMs: 1000 });
    const test = calls.find((c) => c[1] === "test")!;
    expect(test.slice(-2)).toEqual([".", "./cmd/gomin"]);
    expect(packagesForFiles(["a/b/x_test.go", "a/b/y_test.go", "z_test.go"])).toEqual([".", "./a/b"]);
  });

  it("passes -race on a gate run and -tags on every run", async () => {
    const { calls, exec } = fakeExec();
    const repo = makeRepo({ go: { command: ["go", "test"], packages: ["./internal/..."], race: true, buildTags: ["integration", "slow"] } });
    await createGoRunner(exec).run(repo, { files: ["internal/rates_test.go"], coverage: true, timeoutMs: 1000, gate: true });
    const test = calls.find((c) => c[1] === "test")!;
    expect(test).toContain("-race");
    expect(test).toContain("-tags=integration,slow");
    expect(test).toContain("-coverpkg=./internal/...");
  });

  it("keeps -race off the baseline and off a repo that turned it off", async () => {
    // The baseline measures coverage, and the instrumented binary costs several
    // times the run for a check only the gate needs.
    const { calls, exec } = fakeExec();
    await createGoRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000, wholeProject: true });
    expect(calls.find((c) => c[1] === "test")!).not.toContain("-race");

    const { calls: off, exec: execOff } = fakeExec();
    const repo = makeRepo({ go: { command: ["go", "test"], packages: ["./..."], race: false } });
    await createGoRunner(execOff).run(repo, { files: ["rates_test.go"], coverage: false, timeoutMs: 1000, gate: true });
    expect(off.find((c) => c[1] === "test")!).not.toContain("-race");
  });

  it("keeps the exit code and reports the missing profile rather than failing the run", async () => {
    const { exec } = fakeExec({ writeProfile: false, runExit: 1 });
    const result = await createGoRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.lcovPath).toBeUndefined();
    expect(result.stderr).toContain("was not written");
  });
});

describe("go preflight", () => {
  const smoked = (calls: string[][]) => calls.some((c) => c.includes("-run") && c.some((a) => a.startsWith("-coverprofile=")));

  it("passes on a module that builds and has a test, without measuring coverage", async () => {
    const { calls, exec } = fakeExec();
    await expect(createGoRunner(exec).preflight(makeRepo())).resolves.toBeUndefined();
    expect(calls.some((c) => c[1] === "vet")).toBe(true);
    // The coverage pass is the deep tier, so the cheap run never asks for one.
    expect(smoked(calls)).toBe(false);
  });

  it("adds the smoke coverage run under --deep", async () => {
    const { calls, exec } = fakeExec();
    await expect(createGoRunner(exec).preflight(makeRepo(), { deep: true })).resolves.toBeUndefined();
    expect(smoked(calls)).toBe(true);
  });

  it("rejects a toolchain older than 1.22", async () => {
    expect(parseGoVersion("go version go1.24.7 linux/amd64")).toEqual([1, 24]);
    expect(parseGoVersion("not a go banner")).toBeUndefined();
    const { exec } = fakeExec({ version: "go version go1.19.13 linux/amd64" });
    await expect(createGoRunner(exec).preflight(makeRepo())).rejects.toThrow(/need Go 1\.22 or newer/);
  });

  it("names the failing command when go vet does not build", async () => {
    const { exec } = fakeExec({ vetExit: 2 });
    await expect(createGoRunner(exec).preflight(makeRepo())).rejects.toThrow(/go vet \.\/\.\.\.` exited 2/);
  });

  it("fails when no package has a test file", async () => {
    const { exec } = fakeExec();
    const bare = mkdtempSync(join(tmpdir(), "covergen-go-bare-"));
    await expect(createGoRunner(exec).preflight(makeRepo({ cwd: bare, root: bare }))).rejects.toThrow(/no _test\.go file/);
  });

  it("fails when the smoke run measures nothing, which is what a wrong package set looks like", async () => {
    const { exec } = fakeExec({ writeProfile: false });
    await expect(createGoRunner(exec).preflight(makeRepo(), { deep: true })).rejects.toThrow(/produced no measurable blocks/);
  });
});

describe("the gofmt check", () => {
  it("accepts a formatted spec and rejects an unformatted one with the diff", async () => {
    const clean = fakeExec();
    await expect(createGoRunner(clean.exec).checkSpec!(makeRepo(), "rates_test.go")).resolves.toBeUndefined();

    const dirty = fakeExec({ gofmtList: "rates_test.go\n" });
    const issue = await createGoRunner(dirty.exec).checkSpec!(makeRepo(), "rates_test.go");
    expect(issue).toContain("not gofmt formatted");
    expect(issue).toContain("+\tx := 1");
  });
});

describe("go settings", () => {
  it("fills in the defaults when the repo entry has no go block", () => {
    expect(goSettings(makeRepo({ go: undefined }))).toEqual({ command: ["go", "test"], packages: ["./..."], race: true, buildTags: undefined });
  });
});

describe("go preflight when the toolchain is missing", () => {
  it("reports the exit code, the command's own output, and how to fix PATH", async () => {
    const { exec } = fakeExec({ version: "go: command not found", versionExit: 127 });
    await expect(createGoRunner(exec).preflight(makeRepo())).rejects.toThrow(
      [
        `go preflight failed in ${cwd}: \`go version\` exited 127.`,
        "go: command not found",
        "Put go on PATH, or set go.command or command_prefix.",
      ].join("\n"),
    );
  });
});

describe("go run with an unmeasurable profile", () => {
  it("discards the profile and explains it held no block inside the repo", async () => {
    let profilePath = "";
    const exec = async (cmd: string[], o: ExecOptions): Promise<ExecResult> => {
      if (cmd[1] === "list") return { exitCode: 0, stdout: `${MODULE}\t${o.cwd}\n`, stderr: "", durationMs: 1 };
      const flag = cmd.find((a) => a.startsWith("-coverprofile="))!;
      profilePath = flag.slice("-coverprofile=".length);
      // Every block belongs to a dependency, so nothing maps back into the repo.
      writeFileSync(profilePath, "mode: set\ngithub.com/other/dep/dep.go:1.1,2.2 1 5\n");
      return { exitCode: 0, stdout: "ok\t" + MODULE, stderr: "", durationMs: 1 };
    };

    const result = await createGoRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });

    expect(result.ok).toBe(true);
    expect(result.lcovPath).toBeUndefined();
    expect(result.stderr).toContain(`the Go cover profile at ${profilePath} held no block inside ${cwd}`);
    // The coverage output was thrown away rather than left behind for the next run.
    expect(() => readFileSync(profilePath, "utf8")).toThrow();
    expect(() => readFileSync(join(profilePath, "..", "lcov.info"), "utf8")).toThrow();
  });
});

describe("the gofmt check when gofmt itself fails", () => {
  it("reports gofmt's own error and does not ask for a diff", async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string[]): Promise<ExecResult> => {
      calls.push(cmd);
      return { exitCode: 2, stdout: "", stderr: "rates_test.go:1:1: expected 'package', found 'x'\n", durationMs: 1 };
    };
    const issue = await createGoRunner(exec).checkSpec!(makeRepo(), "rates_test.go");
    expect(issue).toBe("gofmt could not read rates_test.go:\nrates_test.go:1:1: expected 'package', found 'x'");
    expect(calls).toEqual([["gofmt", "-l", "rates_test.go"]]);
  });
});

describe("the spec path mapping", () => {
  it("derives the _test.go path for a source file through the repo's specPath", () => {
    const { exec } = fakeExec();
    expect(createGoRunner(exec).specPathFor(makeRepo(), "cmd/gomin/main.go")).toBe("cmd/gomin/main_test.go");
  });
});
