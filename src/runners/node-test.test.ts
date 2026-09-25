import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../types.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { atLeast, createNodeTestRunner, literalTestPath, nodeTestSettings, parseNodeVersion } from "./node-test.js";

const LCOV = [
  "TN:\nSF:src/rates.ts\nDA:1,1\nend_of_record",
  "TN:\nSF:src/rates.test.ts\nDA:1,1\nend_of_record",
  "TN:\nSF:src/other.ts\nDA:1,0\nend_of_record",
].join("\n") + "\n";

type Options = { node?: string; nodeExit?: number; probeExit?: number; writeLcov?: boolean };

function fakeExec(opts: Options = {}) {
  const calls: string[][] = [];
  const exec = async (cmd: string[], _o: ExecOptions): Promise<ExecResult> => {
    calls.push(cmd);
    if (cmd.at(-1) === "--version" && cmd.at(-2) === "node") {
      return { exitCode: opts.nodeExit ?? 0, stdout: opts.node ?? "v22.22.2\n", stderr: "", durationMs: 1 };
    }
    if (cmd.at(-1) === "--version") return { exitCode: opts.probeExit ?? 0, stdout: "v22.22.2\n", stderr: "", durationMs: 1 };
    const dest = cmd.filter((a) => a.startsWith("--test-reporter-destination=")).map((a) => a.slice(28)).find((d) => d !== "stdout");
    if (dest && opts.writeLcov !== false) writeFileSync(dest, LCOV);
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 2 };
  };
  return { calls, exec };
}

let cwd: string;

function makeRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "ts-lib",
    root: cwd,
    runner: "node-test",
    cwd,
    sources: ["src/**/*.ts"],
    specPath: (rel) => rel.replace(/\.ts$/, ".test.ts"),
    nodeTest: { command: ["node", "--import", "tsx", "--test"], testGlob: "**/*.test.ts" },
    ...over,
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "covergen-node-test-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "rates.test.ts"), 'import { it } from "node:test";\nit("x", () => {});\n');
});

describe("node versions", () => {
  it("parses and compares", () => {
    expect(parseNodeVersion("v22.5.1\n")).toEqual([22, 5, 1]);
    expect(parseNodeVersion("tsx v4.0.0\nnode v22.4.0")).toEqual([4, 0, 0]);
    expect(parseNodeVersion("nope")).toBeUndefined();
    expect(atLeast([22, 5, 0], [22, 5, 0])).toBe(true);
    expect(atLeast([22, 4, 9], [22, 5, 0])).toBe(false);
    expect(atLeast([23, 0, 0], [22, 5, 0])).toBe(true);
  });

  it("escapes glob syntax in a test file path with character classes", () => {
    expect(literalTestPath("app/[id]/(group)/x.test.ts")).toBe("app/[[]id]/[(]group)/x.test.ts");
    expect(literalTestPath("src/plain.test.ts")).toBe("src/plain.test.ts");
  });

  it("defaults coverage_include to sources", () => {
    expect(nodeTestSettings(makeRepo()).include).toEqual(["src/**/*.ts"]);
    const repo = makeRepo({ nodeTest: { command: ["tsx", "--test"], testGlob: "test/**/*.ts", coverageInclude: ["lib/**"] } });
    expect(nodeTestSettings(repo)).toEqual({ command: ["tsx", "--test"], testGlob: "test/**/*.ts", include: ["lib/**"] });
  });
});

describe("node-test preflight", () => {
  it("checks node, probes the command, and stops there by default", async () => {
    const { calls, exec } = fakeExec();
    await expect(createNodeTestRunner(exec).preflight(makeRepo())).resolves.toBeUndefined();
    expect(calls).toEqual([
      ["node", "--version"],
      ["node", "--import", "tsx", "--test", "--version"],
    ]);
  });

  it("refuses a Node older than 22", async () => {
    const { exec } = fakeExec({ node: "v20.11.0" });
    await expect(createNodeTestRunner(exec).preflight(makeRepo())).rejects.toThrow(/older than 22\.0\.0/);
  });

  it("names tsx when the command does not answer", async () => {
    const { exec } = fakeExec({ probeExit: 1 });
    await expect(createNodeTestRunner(exec).preflight(makeRepo())).rejects.toThrow(/npm i -D tsx/);
  });

  it("fails when nothing matches the test glob", async () => {
    const { exec } = fakeExec();
    const repo = makeRepo({ nodeTest: { command: ["tsx", "--test"], testGlob: "test/**/*.spec.ts" } });
    await expect(createNodeTestRunner(exec).preflight(repo)).rejects.toThrow(/no test file matches "test\/\*\*\/\*\.spec\.ts"/);
  });

  it("runs a smoke coverage pass under --deep that selects no test", async () => {
    const { calls, exec } = fakeExec();
    await expect(createNodeTestRunner(exec).preflight(makeRepo(), { deep: true })).resolves.toBeUndefined();
    const smoke = calls[2]!;
    expect(smoke).toContain("--test-reporter=lcov");
    expect(smoke.some((a) => a.startsWith("--test-name-pattern="))).toBe(true);
    expect(smoke.at(-1)).toBe("src/rates.test.ts");
  });

  it("fails the deep smoke when no lcov record comes back", async () => {
    const { exec } = fakeExec({ writeLcov: false });
    await expect(createNodeTestRunner(exec).preflight(makeRepo(), { deep: true })).rejects.toThrow(/wrote no lcov records/);
  });

  it("prepends commandPrefix to every probe", async () => {
    const { calls, exec } = fakeExec();
    await createNodeTestRunner(exec).preflight(makeRepo({ commandPrefix: ["docker", "exec", "app"] }));
    expect(calls.every((c) => c.slice(0, 3).join(" ") === "docker exec app")).toBe(true);
  });
});

describe("node-test run", () => {
  it("passes include and exclude flags on Node 22.5 and newer, and leaves the lcov alone", async () => {
    const { calls, exec } = fakeExec({ node: "v22.5.0" });
    const res = await createNodeTestRunner(exec).run(makeRepo({ exclude: ["src/gen/**"] }), { files: [], coverage: true, timeoutMs: 1000 });
    const args = calls.at(-1)!;
    expect(args).toContain("--test-coverage-include=src/**/*.ts");
    expect(args).toContain("--test-coverage-exclude=**/*.test.ts");
    expect(args).toContain("--test-coverage-exclude=src/gen/**");
    expect(args).toContain("--enable-source-maps");
    // No files means the whole suite, which Node expands from the glob.
    expect(args.at(-1)).toBe("**/*.test.ts");
    expect(readFileSync(res.lcovPath!, "utf8")).toBe(LCOV);
  });

  it("narrows the include to COVERGEN_SOURCE, escaping glob syntax", async () => {
    const { calls, exec } = fakeExec();
    await createNodeTestRunner(exec).run(makeRepo(), {
      files: ["app/[id]/route.test.ts"],
      coverage: true,
      timeoutMs: 1000,
      env: { COVERGEN_SOURCE: "app/[id]/route.ts" },
    });
    const args = calls.at(-1)!;
    expect(args.filter((a) => a.startsWith("--test-coverage-include="))).toEqual(["--test-coverage-include=app/\\[id\\]/route.ts"]);
    // Node globs file arguments too, and only a character class escapes there.
    expect(args.at(-1)).toBe("app/[[]id]/route.test.ts");
    expect(args.some((a) => a.startsWith("--test-coverage-exclude="))).toBe(false);
  });

  it("filters the lcov by sources when Node has no include flag", async () => {
    const { calls, exec } = fakeExec({ node: "v22.4.1" });
    const res = await createNodeTestRunner(exec).run(makeRepo(), { files: [], coverage: true, timeoutMs: 1000 });
    expect(calls.at(-1)!.some((a) => a.startsWith("--test-coverage-"))).toBe(false);
    const kept = readFileSync(res.lcovPath!, "utf8");
    expect(kept).toContain("SF:src/rates.ts");
    expect(kept).toContain("SF:src/other.ts");
    expect(kept).not.toContain("rates.test.ts");
  });

  it("filters the lcov to COVERGEN_SOURCE when Node has no include flag", async () => {
    const { exec } = fakeExec({ node: "v22.4.1" });
    const res = await createNodeTestRunner(exec).run(makeRepo(), {
      files: ["src/rates.test.ts"],
      coverage: true,
      timeoutMs: 1000,
      env: { COVERGEN_SOURCE: "src/rates.ts" },
    });
    expect(readFileSync(res.lcovPath!, "utf8")).toBe("TN:\nSF:src/rates.ts\nDA:1,1\nend_of_record\n");
  });

  it("escapes a case filter into a name pattern and runs without coverage flags when none is asked", async () => {
    const { calls, exec } = fakeExec();
    const res = await createNodeTestRunner(exec).run(makeRepo(), { files: ["src/rates.test.ts"], coverage: false, timeoutMs: 1000, caseFilter: "adds (a) rate" });
    expect(calls.at(-1)).toEqual(["node", "--import", "tsx", "--test", "--test-name-pattern=adds \\(a\\) rate", "src/rates.test.ts"]);
    expect(res.lcovPath).toBeUndefined();
  });
});
