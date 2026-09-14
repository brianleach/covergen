import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertBranch, branchName, defaultBranch, dirtyPaths, openDraftPr, openDraftPrs, runCmd } from "./pr.js";
import type { RepoConfig } from "./types.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await runCmd("git", args, cwd);
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
  return res.stdout;
}

/** A work tree with one commit, a bare remote called origin, and origin/HEAD set. */
async function fixture(): Promise<{ tmp: string; work: string; ghLog: string; bodyLog: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "covergen-pr-test-"));
  const remote = join(tmp, "remote.git");
  const work = join(tmp, "work");
  await git(tmp, "init", "--bare", "-b", "main", remote);
  await mkdir(join(work, "src"), { recursive: true });
  await git(tmp, "init", "-b", "main", work);
  await git(work, "config", "user.email", "covergen@example.com");
  await git(work, "config", "user.name", "covergen");
  await writeFile(join(work, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await git(work, "add", "--", "src/a.ts");
  await git(work, "commit", "-m", "initial");
  await git(work, "remote", "add", "origin", remote);
  await git(work, "push", "origin", "main");
  await git(work, "remote", "set-head", "origin", "-a");

  // A fake gh on PATH: the real one would need a network and a login. It logs
  // its arguments, keeps a copy of every body file it was handed, and numbers
  // the PRs it creates so a multi-part run gets distinct URLs.
  const bin = join(tmp, "bin");
  const ghLog = join(tmp, "gh-args.txt");
  const bodyLog = join(tmp, "gh-bodies.md");
  const countFile = join(tmp, "gh-count.txt");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `for arg in "$@"; do echo "$arg" >> ${JSON.stringify(ghLog)}; done`,
      'prev=""',
      `for arg in "$@"; do if [ "$prev" = "--body-file" ]; then cat "$arg" >> ${JSON.stringify(bodyLog)}; fi; prev="$arg"; done`,
      'if [ "$2" = "create" ]; then',
      `  n=$(cat ${JSON.stringify(countFile)} 2>/dev/null || echo 0)`,
      "  n=$((n + 1))",
      `  echo "$n" > ${JSON.stringify(countFile)}`,
      '  echo "https://github.com/example/repo/pull/$n"',
      "fi",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  return { tmp, work, ghLog, bodyLog };
}

function repoAt(root: string): RepoConfig {
  return { name: "fixture", root, runner: "vitest", cwd: root, sources: ["src/**/*.ts"], specPath: (rel) => rel };
}

describe("branchName and assertBranch", () => {
  it("stamps the date and refuses anything outside covergen/", () => {
    expect(branchName(new Date(2026, 8, 9), "abc123")).toBe("covergen/20260909-abc123");
    expect(() => assertBranch("covergen/20260909-abc123")).not.toThrow();
    expect(() => assertBranch("main")).toThrow(/must start with covergen\//);
  });
});

describe("dirtyPaths", () => {
  it("lists modified and untracked files, minus the ignored prefixes", async () => {
    const { work } = await fixture();
    await writeFile(join(work, "src", "a.ts"), "export const a = 2;\n", "utf8");
    // Not the real state dir name: many machines have that one in a global
    // gitignore, and this has to assert the filter, not the machine.
    await mkdir(join(work, "scratch"), { recursive: true });
    await writeFile(join(work, "scratch", "state.json"), "{}", "utf8");
    expect(await dirtyPaths(work)).toEqual(expect.arrayContaining(["src/a.ts", "scratch/"]));
    expect(await dirtyPaths(work, ["scratch"])).toEqual(["src/a.ts"]);
  });
});

describe("defaultBranch", () => {
  it("reads origin/HEAD and prefers the remote tracking ref", async () => {
    const { work } = await fixture();
    expect(await defaultBranch(work)).toEqual({ name: "main", ref: "origin/main" });
  });

  it("falls back to main when no origin/HEAD is set", async () => {
    const { work } = await fixture();
    await git(work, "remote", "remove", "origin");
    expect(await defaultBranch(work)).toEqual({ name: "main", ref: "main" });
  });
});

describe("openDraftPr", () => {
  it("commits the named specs, pushes a covergen branch, opens a draft PR, and restores the branch", async () => {
    const { work, ghLog } = await fixture();
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");
    await writeFile(join(work, "unrelated.txt"), "not covergen's\n", "utf8");

    const url = await openDraftPr({
      repo: repoAt(work),
      files: ["src/a.test.ts"],
      title: "covergen: 1 test accepted in fixture",
      body: "# body\n",
      now: new Date(2026, 8, 9),
      suffix: "abc123",
    });

    expect(url).toBe("https://github.com/example/repo/pull/1");
    const branch = "covergen/20260909-abc123";
    expect(await git(work, "ls-remote", "--heads", "origin")).toContain(`refs/heads/${branch}`);
    const committed = await git(work, "show", "--name-only", "--format=", `origin/${branch}`);
    expect(committed.trim()).toBe("src/a.test.ts");
    expect(await git(work, "rev-parse", "--abbrev-ref", "HEAD")).toContain("main");
    // The file it did not name is still an uncommitted local change.
    expect(await dirtyPaths(work)).toEqual(["unrelated.txt"]);

    const ghArgs = (await readFile(ghLog, "utf8")).split("\n");
    expect(ghArgs).toEqual(expect.arrayContaining(["pr", "create", "--draft", "--base", "main", "--head", branch]));
  });

  it("refuses to run with nothing to commit", async () => {
    const { work } = await fixture();
    await expect(openDraftPr({ repo: repoAt(work), files: [], title: "t", body: "b" })).rejects.toThrow(
      /nothing to commit/,
    );
  });
});

describe("openDraftPrs", () => {
  it("opens one PR when the accepted specs fit under the ceiling", async () => {
    const { work } = await fixture();
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");
    const urls = await openDraftPrs({
      repo: repoAt(work),
      files: ["src/a.test.ts"],
      title: "covergen: 1 test accepted in fixture",
      body: "# body\n",
      maxLines: 600,
      now: new Date(2026, 8, 9),
      suffixes: ["abc123"],
    });
    expect(urls).toEqual(["https://github.com/example/repo/pull/1"]);
    const committed = await git(work, "show", "--name-only", "--format=", "origin/covergen/20260909-abc123");
    expect(committed.trim()).toBe("src/a.test.ts");
  });

  it("splits an oversized run into independent part PRs that link each other", async () => {
    const { work, bodyLog } = await fixture();
    for (const name of ["a", "b", "c"]) await writeFile(join(work, "src", `${name}.test.ts`), "// generated\n", "utf8");

    const urls = await openDraftPrs({
      repo: repoAt(work),
      files: ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"],
      title: "covergen: 3 tests accepted in fixture",
      body: "# body\n",
      maxLines: 600,
      // 400 + 400 does not fit, 400 + 100 does, so the parts are [a] and [b, c].
      sizes: [
        { path: "src/a.test.ts", lines: 400 },
        { path: "src/b.test.ts", lines: 400 },
        { path: "src/c.test.ts", lines: 100 },
      ],
      now: new Date(2026, 8, 9),
      suffixes: ["p1", "p2"],
    });

    expect(urls).toEqual(["https://github.com/example/repo/pull/1", "https://github.com/example/repo/pull/2"]);
    // Each part carries only its own files, and each is branched from the
    // default branch rather than from the part before it, so either can merge
    // alone and in either order.
    const first = await git(work, "show", "--name-only", "--format=", "origin/covergen/20260909-p1");
    const second = await git(work, "show", "--name-only", "--format=", "origin/covergen/20260909-p2");
    expect(first.trim().split("\n")).toEqual(["src/a.test.ts"]);
    expect(second.trim().split("\n")).toEqual(["src/b.test.ts", "src/c.test.ts"]);
    for (const branch of ["p1", "p2"]) {
      const parent = await git(work, "rev-parse", `origin/covergen/20260909-${branch}^`);
      expect(parent.trim()).toBe((await git(work, "rev-parse", "origin/main")).trim());
    }
    // The message each part committed names its own part and its own files.
    expect(await git(work, "log", "-1", "--format=%B", "origin/covergen/20260909-p1")).toContain("(part 1 of 2)");
    expect(await git(work, "log", "-1", "--format=%B", "origin/covergen/20260909-p2")).toContain("`src/c.test.ts` (100 lines)");

    // Part 1 was opened before part 2 existed, so the edit pass is what gives it
    // the sibling link.
    const bodies = await readFile(bodyLog, "utf8");
    expect(bodies).toContain("- part 2: not opened yet");
    expect(bodies).toContain("- part 2: https://github.com/example/repo/pull/2");
    expect(bodies).toContain("- part 1: https://github.com/example/repo/pull/1");
  });
});

it("reports the command, cwd and last five stderr lines when a git command fails", async () => {
  const exec = async () => ({ stdout: "ignored", stderr: "l1\nl2\nl3\nl4\nl5\nl6\n", exitCode: 128 });
  await expect(dirtyPaths("/repo", [], exec)).rejects.toMatchObject({
    message: "git -c core.quotepath=false status --porcelain failed in /repo: l2\nl3\nl4\nl5\nl6",
  });
});

it("falls back to stdout, then to the exit code, when a failing command says nothing on stderr", async () => {
  const fromStdout = async () => ({ stdout: "fatal: not a git repository\n", stderr: "", exitCode: 128 });
  await expect(dirtyPaths("/repo", [], fromStdout)).rejects.toMatchObject({
    message: "git -c core.quotepath=false status --porcelain failed in /repo: fatal: not a git repository",
  });
  const silent = async () => ({ stdout: "", stderr: "  \n", exitCode: 3 });
  await expect(dirtyPaths("/repo", [], silent)).rejects.toMatchObject({
    message: "git -c core.quotepath=false status --porcelain failed in /repo: exit 3",
  });
});
