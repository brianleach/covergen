import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBranch, branchName, defaultBranch, dirtyPaths, openDraftPr, openDraftPrs, runCmd } from "./pr.js";
import { reverifyOnBase, type Reverify } from "./reverify.js";
import type { RepoConfig, RunResult } from "./types.js";

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

/**
 * The night the PR step branched from origin/main re-resolved at PR time, found
 * modified files in the checkout, and left thirty proven tests on disk with no
 * PR. Both halves of that are covered here against a real git remote.
 */
describe("openDraftPr and a base that moved under it", () => {
  /** git for real, gh faked, with the body the PR would have been opened with. */
  function watcher() {
    let body = "";
    const exec = async (command: string, args: string[], cwd: string) => {
      if (command !== "gh") return runCmd(command, args, cwd);
      const at = args.indexOf("--body-file");
      body = at === -1 ? "" : await readFile(args[at + 1] as string, "utf8");
      return { stdout: "https://github.com/example/repo/pull/7\n", stderr: "", exitCode: 0 };
    };
    return { exec, body: () => body };
  }

  /** Someone else's commit landing on the default branch while the run gates. */
  async function moveOrigin(tmp: string, file: string): Promise<void> {
    const other = join(tmp, `other-${file.replace(/\W/g, "")}`);
    await git(tmp, "clone", "--quiet", join(tmp, "remote.git"), other);
    await git(other, "config", "user.email", "someone@example.com");
    await git(other, "config", "user.name", "someone");
    await writeFile(join(other, file), "// someone else\n", "utf8");
    await git(other, "add", "--", file);
    await git(other, "commit", "-m", "someone else's merge");
    await git(other, "push", "origin", "main");
  }

  it("cuts the branch from the commit the tests were proven on and says how far the base moved", async () => {
    const { tmp, work } = await fixture();
    const proved = (await git(work, "rev-parse", "HEAD")).trim();
    await moveOrigin(tmp, "src/theirs.ts");
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");
    const gh = watcher();

    const url = await openDraftPr({
      repo: repoAt(work),
      files: ["src/a.test.ts"],
      title: "covergen: 1 test accepted in fixture",
      body: "# body\n",
      now: new Date(2026, 8, 9),
      suffix: "base01",
      baseSha: proved,
      exec: gh.exec,
    });

    expect(url).toBe("https://github.com/example/repo/pull/7");
    const branch = "covergen/20260909-base01";
    // The parent of the pushed commit is the swept commit, not the moved tip.
    expect((await git(work, "rev-parse", `origin/${branch}^`)).trim()).toBe(proved);
    expect((await git(work, "rev-parse", "origin/main")).trim()).not.toBe(proved);
    expect(gh.body()).toContain("Base moved by 1 commit during the run");
    expect(gh.body()).toContain(proved.slice(0, 7));
  });

  it("branches from HEAD rather than losing the tests when the swept commit cannot be checked out", async () => {
    const { tmp, work } = await fixture();
    const head = (await git(work, "rev-parse", "HEAD")).trim();
    // A commit on the same tracked file the checkout has modified: moving to it
    // would overwrite the local change, so git refuses the branch outright.
    await moveOrigin(tmp, "src/a.ts");
    await git(work, "fetch", "origin");
    const moved = (await git(work, "rev-parse", "origin/main")).trim();
    await writeFile(join(work, "src", "a.ts"), "export const a = 99;\n", "utf8");
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");
    const gh = watcher();

    const url = await openDraftPr({
      repo: repoAt(work),
      files: ["src/a.test.ts"],
      title: "covergen: 1 test accepted in fixture",
      body: "# body\n",
      now: new Date(2026, 8, 9),
      suffix: "base02",
      baseSha: moved,
      exec: gh.exec,
    });

    expect(url).toBe("https://github.com/example/repo/pull/7");
    const branch = "covergen/20260909-base02";
    expect((await git(work, "rev-parse", `origin/${branch}^`)).trim()).toBe(head);
    const committed = await git(work, "show", "--name-only", "--format=", `origin/${branch}`);
    expect(committed.trim()).toBe("src/a.test.ts");
    expect(gh.body()).toContain("Branched from HEAD rather than");
    // The local edit that caused it is still exactly where the run left it.
    expect(await readFile(join(work, "src", "a.ts"), "utf8")).toBe("export const a = 99;\n");
  });

  it("gives every part of a split run the same base, and keeps the note through the sibling edit", async () => {
    const { tmp, work, bodyLog } = await fixture();
    const proved = (await git(work, "rev-parse", "HEAD")).trim();
    await moveOrigin(tmp, "src/theirs.ts");
    for (const name of ["a", "b"]) await writeFile(join(work, "src", `${name}.test.ts`), "// generated\n", "utf8");

    const urls = await openDraftPrs({
      repo: repoAt(work),
      files: ["src/a.test.ts", "src/b.test.ts"],
      title: "covergen: 2 tests accepted in fixture",
      body: "# body\n",
      maxLines: 600,
      sizes: [
        { path: "src/a.test.ts", lines: 400 },
        { path: "src/b.test.ts", lines: 400 },
      ],
      now: new Date(2026, 8, 9),
      suffixes: ["q1", "q2"],
      baseSha: proved,
    });

    expect(urls).toHaveLength(2);
    for (const suffix of ["q1", "q2"]) {
      expect((await git(work, "rev-parse", `origin/covergen/20260909-${suffix}^`)).trim()).toBe(proved);
    }
    // Three bodies are written: one per part as it opens, and part one again
    // once part two's URL exists. The note has to survive that rewrite.
    const bodies = await readFile(bodyLog, "utf8");
    expect(bodies.match(/Base moved by 1 commit during the run/g)).toHaveLength(3);
  });
});

/**
 * The accepted specs re-run on a default branch that moved during the run,
 * against a real git remote. Whatever happens, the checkout has to end on the
 * swept commit, on its branch, with the specs as the run left them.
 */
describe("openDraftPr re-verifying on a moved base", () => {
  const passed: RunResult = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };

  /** git for real, gh faked, keeping the title and body the PR was opened with. */
  function watcher() {
    const seen = { title: "", body: "" };
    const exec = async (command: string, args: string[], cwd: string) => {
      if (command !== "gh") return runCmd(command, args, cwd);
      seen.title = args[args.indexOf("--title") + 1] ?? "";
      seen.body = await readFile(args[args.indexOf("--body-file") + 1] as string, "utf8");
      return { stdout: "https://github.com/example/repo/pull/7\n", stderr: "", exitCode: 0 };
    };
    return { exec, seen };
  }

  async function moveOrigin(tmp: string, file: string): Promise<string> {
    const other = join(tmp, "other");
    await git(tmp, "clone", "--quiet", join(tmp, "remote.git"), other);
    await git(other, "config", "user.email", "someone@example.com");
    await git(other, "config", "user.name", "someone");
    await writeFile(join(other, file), "// someone else\n", "utf8");
    await git(other, "add", "--", file);
    await git(other, "commit", "-m", "someone else's merge");
    await git(other, "push", "origin", "main");
    return (await git(other, "rev-parse", "HEAD")).trim();
  }

  async function expectSwept(work: string, proved: string): Promise<void> {
    expect((await git(work, "rev-parse", "HEAD")).trim()).toBe(proved);
    expect((await git(work, "symbolic-ref", "HEAD")).trim()).toBe("refs/heads/main");
  }

  async function open(
    work: string,
    files: string[],
    runSpec: (spec: string) => Promise<RunResult>,
    maxCommits = 200,
    pastDeadline = false,
  ) {
    const gh = watcher();
    const results: Reverify[] = [];
    const url = await openDraftPr({
      repo: repoAt(work),
      files,
      title: "covergen: tests accepted in fixture",
      body: "# body\n",
      now: new Date(2026, 8, 9),
      suffix: "rv",
      baseSha: (await git(work, "rev-parse", "HEAD")).trim(),
      exec: gh.exec,
      reverify: { runSpec, maxCommits, pastDeadline: () => pastDeadline, results },
    });
    return { url, seen: gh.seen, results };
  }

  it("re-runs nothing when the base did not move", async () => {
    const { work } = await fixture();
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");
    const runSpec = vi.fn(async () => passed);

    const { seen, results } = await open(work, ["src/a.test.ts"], runSpec);

    expect(runSpec).not.toHaveBeenCalled();
    expect(results).toEqual([]);
    expect(seen.title).toBe("covergen: tests accepted in fixture");
    expect(seen.body).not.toContain("re-verified");
  });

  it("runs each spec on the moved base and says so when all pass", async () => {
    const { tmp, work } = await fixture();
    const proved = (await git(work, "rev-parse", "HEAD")).trim();
    const moved = await moveOrigin(tmp, "src/theirs.ts");
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");
    const onBase: string[] = [];
    const runSpec = vi.fn(async (spec: string) => {
      onBase.push((await git(work, "rev-parse", "HEAD^")).trim(), await readFile(join(work, spec), "utf8"));
      return passed;
    });

    const { seen, results } = await open(work, ["src/a.test.ts"], runSpec);

    expect(onBase).toEqual([moved, "// generated\n"]);
    expect(results).toEqual([{ base: moved, failed: [] }]);
    expect(seen.title).toBe("covergen: tests accepted in fixture");
    expect(seen.body).toContain("Base moved by 1 commit during the run");
    expect(seen.body).toContain(`re-verified on ${moved.slice(0, 7)}`);
    // The PR branch is still cut from the swept commit and holds the spec.
    expect((await git(work, "rev-parse", "origin/covergen/20260909-rv^")).trim()).toBe(proved);
    expect(await git(work, "show", "origin/covergen/20260909-rv:src/a.test.ts")).toBe("// generated\n");
    await expectSwept(work, proved);
  });

  it("opens the PR as needs rebase and names the spec that failed on the moved base", async () => {
    const { tmp, work } = await fixture();
    const moved = await moveOrigin(tmp, "src/theirs.ts");
    for (const name of ["a", "b"]) await writeFile(join(work, "src", `${name}.test.ts`), "// generated\n", "utf8");
    const runSpec = async (spec: string): Promise<RunResult> =>
      spec === "src/b.test.ts"
        ? { ...passed, ok: false, exitCode: 1, stdout: " FAIL src/b.test.ts\nAssertionError: expected 1 to be 2\n" }
        : passed;

    const { url, seen, results } = await open(work, ["src/a.test.ts", "src/b.test.ts"], runSpec);

    expect(url).toBe("https://github.com/example/repo/pull/7");
    expect(seen.title).toBe("needs rebase: covergen: tests accepted in fixture");
    expect(seen.body).toContain("- `src/b.test.ts`: FAIL src/b.test.ts");
    expect(results).toEqual([{ base: moved, failed: [{ spec: "src/b.test.ts", line: "FAIL src/b.test.ts" }] }]);
    // Both specs are still in the PR: a failure on the new base loses nothing.
    const committed = await git(work, "show", "--name-only", "--format=", "origin/covergen/20260909-rv");
    expect(committed.trim().split("\n").sort()).toEqual(["src/a.test.ts", "src/b.test.ts"]);
  });

  it("counts a spec whose change conflicts with the moved base as failed and still runs the rest", async () => {
    const { tmp, work } = await fixture();
    const proved = (await git(work, "rev-parse", "HEAD")).trim();
    await moveOrigin(tmp, "src/a.test.ts");
    for (const name of ["a", "b"]) await writeFile(join(work, "src", `${name}.test.ts`), "// generated\n", "utf8");
    const runSpec = vi.fn(async () => passed);

    const { seen, results } = await open(work, ["src/a.test.ts", "src/b.test.ts"], runSpec);

    expect(runSpec.mock.calls).toEqual([["src/b.test.ts"]]);
    expect(results[0]?.failed).toEqual([{ spec: "src/a.test.ts", line: expect.stringContaining("rebase conflict") }]);
    expect(seen.title.startsWith("needs rebase: ")).toBe(true);
    await expectSwept(work, proved);
  });

  it("skips the re-run and says why when the base moved further than the cap", async () => {
    const { tmp, work } = await fixture();
    await moveOrigin(tmp, "src/theirs.ts");
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");
    const runSpec = vi.fn(async () => passed);

    const { seen, results } = await open(work, ["src/a.test.ts"], runSpec, 0);

    expect(runSpec).not.toHaveBeenCalled();
    expect(results[0]?.skipped).toContain("over sweep.reverify_max_commits (0)");
    expect(seen.body).toContain("Not re-verified on the moved base");
    expect(seen.title).toBe("covergen: tests accepted in fixture");
  });

  it("skips the re-run when the run is past its wall-clock ceiling", async () => {
    const { tmp, work } = await fixture();
    await moveOrigin(tmp, "src/theirs.ts");
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");
    const runSpec = vi.fn(async () => passed);

    const { results } = await open(work, ["src/a.test.ts"], runSpec, 200, true);

    expect(runSpec).not.toHaveBeenCalled();
    expect(results[0]?.skipped).toBe("the run is past its wall-clock ceiling");
  });

  it("still opens the PR, with a note, when the re-run throws", async () => {
    const { tmp, work } = await fixture();
    const proved = (await git(work, "rev-parse", "HEAD")).trim();
    await moveOrigin(tmp, "src/theirs.ts");
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");

    const { url, seen } = await open(work, ["src/a.test.ts"], async () => {
      throw new Error("runner died");
    });

    expect(url).toBe("https://github.com/example/repo/pull/7");
    expect(seen.body).toContain("the re-run stopped: runner died");
    expect(await git(work, "show", "origin/covergen/20260909-rv:src/a.test.ts")).toBe("// generated\n");
    await expectSwept(work, proved);
  });

  it("ends on the swept commit with the specs in the working tree when the re-run throws", async () => {
    const { tmp, work } = await fixture();
    const proved = (await git(work, "rev-parse", "HEAD")).trim();
    await moveOrigin(tmp, "src/theirs.ts");
    await git(work, "fetch", "origin");
    await writeFile(join(work, "src", "a.test.ts"), "// generated\n", "utf8");

    await expect(
      reverifyOnBase({
        root: work,
        cwd: work,
        files: ["src/a.test.ts"],
        baseRef: "origin/main",
        exec: runCmd,
        runSpec: async () => {
          throw new Error("runner died");
        },
      }),
    ).rejects.toThrow("runner died");

    await expectSwept(work, proved);
    expect(await readFile(join(work, "src", "a.test.ts"), "utf8")).toBe("// generated\n");
    expect(await dirtyPaths(work)).toEqual(["src/a.test.ts"]);
  });
});
