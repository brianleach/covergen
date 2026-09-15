import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coveredTargets, openPrCover } from "./backlog.js";
import type { RepoConfig } from "./types.js";

function repoAt(root: string, cwd = root): RepoConfig {
  return {
    name: "fixture",
    root,
    runner: "vitest",
    cwd,
    sources: ["src/**/*.ts"],
    specPath: (rel) => rel.replace(/\.ts$/, ".test.ts"),
  };
}

/** A stand-in for `gh pr list` that records what it was asked. */
function fakeGh(payload: unknown, exitCode = 0) {
  const calls: string[][] = [];
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return { stdout: typeof payload === "string" ? payload : JSON.stringify(payload), stderr: "", exitCode };
  };
  return { exec, calls };
}

const pr = (number: number, branch: string, files: string[]) => ({
  number,
  url: `https://github.com/example/repo/pull/${number}`,
  headRefName: branch,
  files: files.map((path) => ({ path })),
});

describe("openPrCover", () => {
  it("collects the files of open covergen PRs and ignores every other branch", async () => {
    const { exec, calls } = fakeGh([
      pr(1, "covergen/20260913-aaa", ["src/a.test.ts", "src/b.test.ts"]),
      pr(2, "feature/unrelated", ["src/c.test.ts"]),
    ]);
    const cover = await openPrCover(repoAt("/repo"), exec);

    expect([...cover.paths].sort()).toEqual(["src/a.test.ts", "src/b.test.ts"]);
    expect(cover.prs).toEqual([{ number: 1, url: "https://github.com/example/repo/pull/1", branch: "covergen/20260913-aaa" }]);
    expect(calls[0]).toEqual([
      "gh",
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      "number,url,headRefName,files",
    ]);
  });

  it("drops paths outside the package cwd, so one package is not skipped over another's PR", async () => {
    const { exec } = fakeGh([pr(3, "covergen/20260913-bbb", ["apps/web/src/a.test.ts", "apps/api/src/z.test.ts"])]);
    const cover = await openPrCover(repoAt("/repo", join("/repo", "apps", "web")), exec);
    expect([...cover.paths]).toEqual(["src/a.test.ts"]);
  });

  it("excludes nothing when gh fails or answers with something that is not a PR list", async () => {
    const failed = await openPrCover(repoAt("/repo"), fakeGh([], 1).exec);
    expect(failed.paths.size).toBe(0);
    const garbage = await openPrCover(repoAt("/repo"), fakeGh("not json").exec);
    expect(garbage.paths.size).toBe(0);
    const wrongShape = await openPrCover(repoAt("/repo"), fakeGh({ message: "Not Found" }).exec);
    expect(wrongShape.paths.size).toBe(0);
  });
});

describe("coveredTargets", () => {
  const repo = repoAt("/repo");

  it("matches a target by the spec it would be written to, and by itself", async () => {
    const { exec } = fakeGh([pr(4, "covergen/20260913-ccc", ["src/a.test.ts", "src/inline.ts"])]);
    const cover = await openPrCover(repo, exec);
    expect(coveredTargets(repo, ["src/a.ts", "src/b.ts", "src/inline.ts"], cover)).toEqual(["src/a.ts", "src/inline.ts"]);
  });

  it("covers nothing when no covergen PR is open", async () => {
    const { exec } = fakeGh([]);
    const cover = await openPrCover(repo, exec);
    expect(coveredTargets(repo, ["src/a.ts"], cover)).toEqual([]);
  });
});
