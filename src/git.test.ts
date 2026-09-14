import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  changedFiles,
  globToRegExp,
  isExcluded,
  isTestFile,
  listSources,
  matchesSources,
  toCwdRelative,
  treeFingerprint,
} from "./git.js";
import type { GitExec } from "./git.js";
import type { RepoConfig } from "./types.js";

function repoAt(root: string, over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "fixture",
    root,
    runner: "rspec",
    cwd: root,
    sources: ["app/**/*.rb"],
    specPath: (rel) => `spec/${rel}`,
    ...over,
  };
}

function fakeExec(stdout: string, exitCode = 0, stderr = ""): { exec: GitExec; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push({ args, cwd });
    return { stdout, stderr, exitCode };
  };
  return { exec, calls };
}

describe("changedFiles", () => {
  it("calls git diff --name-only with the ref in the repo root", async () => {
    const { exec, calls } = fakeExec("app/a.rb\n");
    await changedFiles("/repo", "origin/main", { exec, exists: () => true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["diff", "--name-only", "origin/main"]);
    expect(calls[0]?.cwd).toBe("/repo");
  });

  it("returns one path per line, trimmed", async () => {
    const { exec } = fakeExec("app/a.rb\napp/b.rb\n\n");
    const out = await changedFiles("/repo", "HEAD~3", { exec, exists: () => true });
    expect(out).toEqual(["app/a.rb", "app/b.rb"]);
  });

  it("filters out files that no longer exist", async () => {
    const { exec } = fakeExec("app/a.rb\napp/gone.rb\n");
    const out = await changedFiles("/repo", "HEAD~1", {
      exec,
      exists: (abs) => !abs.endsWith("gone.rb"),
    });
    expect(out).toEqual(["app/a.rb"]);
  });

  it("dedupes repeated paths", async () => {
    const { exec } = fakeExec("app/a.rb\napp/a.rb\n");
    const out = await changedFiles("/repo", "HEAD", { exec, exists: () => true });
    expect(out).toEqual(["app/a.rb"]);
  });

  it("throws with the git stderr when the diff fails", async () => {
    const { exec } = fakeExec("", 128, "fatal: bad revision 'nope'");
    await expect(changedFiles("/repo", "nope", { exec, exists: () => true })).rejects.toThrow(/bad revision/);
  });
});

describe("treeFingerprint", () => {
  it("changes when dirty file contents change without changing porcelain status", async () => {
    let contents = Buffer.from("first");
    const exec: GitExec = async (args) => {
      const command = args.join(" ");
      if (command === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (command === "status --porcelain=v1 -z --untracked-files=all") {
        return { stdout: " M app/a.rb\0", stderr: "", exitCode: 0 };
      }
      if (command === "diff --name-only -z --ignore-submodules=none") {
        return { stdout: "app/a.rb\0", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const deps = { exec, readFile: async () => contents };

    const first = await treeFingerprint("/repo", deps);
    contents = Buffer.from("second");
    const second = await treeFingerprint("/repo", deps);

    expect(second).not.toBe(first);
  });

  it("ignores generated state directories", async () => {
    const exec: GitExec = async (args) => {
      const command = args.join(" ");
      if (command === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (command === "diff --name-only -z --ignore-submodules=none") {
        return { stdout: "app/a.rb\0.covergen/state.json\0cache/state.json\0", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const readFile = vi.fn(async (_path: string) => Buffer.from("contents"));

    await treeFingerprint("/repo", { exec, readFile, exclude: ["/cache"] });

    expect(readFile.mock.calls.map(([path]) => path)).toEqual(["/repo/app/a.rb"]);
  });

  it("fingerprints dirty submodule contents instead of failing on the directory", async () => {
    let nestedContents = Buffer.from("first");
    const exec: GitExec = async (args, cwd) => {
      const command = args.join(" ");
      if (command === "rev-parse HEAD") {
        return { stdout: cwd === "/repo" ? "parent\n" : "nested\n", stderr: "", exitCode: 0 };
      }
      if (command === "diff --name-only -z --ignore-submodules=none") {
        return { stdout: cwd === "/repo" ? "vendor/pkg\0" : "src/a.ts\0", stderr: "", exitCode: 0 };
      }
      if (command === "ls-files --stage -- vendor/pkg") {
        return { stdout: "160000 abcdef 0\tvendor/pkg\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const readFile = async (path: string): Promise<Buffer> => {
      if (path === "/repo/vendor/pkg") {
        throw Object.assign(new Error("directory"), { code: "EISDIR" });
      }
      return nestedContents;
    };

    const first = await treeFingerprint("/repo", { exec, readFile });
    nestedContents = Buffer.from("second");
    const second = await treeFingerprint("/repo", { exec, readFile });

    expect(second).not.toBe(first);
  });

  it("fingerprints a symlink by its destination", async () => {
    let target = "first.ts";
    const exec: GitExec = async (args) => {
      const command = args.join(" ");
      if (command === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (command === "diff --name-only -z --ignore-submodules=none") {
        return { stdout: "src/current.ts\0", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const opts = {
      exec,
      readFile: async () => Buffer.from("same contents"),
      lstat: async () => ({ isSymbolicLink: () => true }),
      readlink: async () => target,
    };

    const first = await treeFingerprint("/repo", opts);
    target = "second.ts";
    const second = await treeFingerprint("/repo", opts);

    expect(second).not.toBe(first);
  });
});

describe("isTestFile", () => {
  it("recognizes the shapes each runner uses", () => {
    expect(isTestFile("spec/services/foo_spec.rb")).toBe(true);
    expect(isTestFile("test/foo_test.rb")).toBe(true);
    expect(isTestFile("src/__tests__/foo.ts")).toBe(true);
    expect(isTestFile("src/foo.test.ts")).toBe(true);
    expect(isTestFile("src/foo.spec.tsx")).toBe(true);
    expect(isTestFile("app/services/foo.rb")).toBe(false);
    expect(isTestFile("src/latest.ts")).toBe(false);
  });
});

describe("globToRegExp", () => {
  it("matches ** across directories and * within one segment", () => {
    expect(globToRegExp("app/**/*.rb").test("app/services/foo.rb")).toBe(true);
    expect(globToRegExp("app/**/*.rb").test("app/foo.rb")).toBe(true);
    expect(globToRegExp("app/**/*.rb").test("lib/foo.rb")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });

  it("supports brace alternation", () => {
    const re = globToRegExp("src/**/*.{ts,tsx}");
    expect(re.test("src/a/b.tsx")).toBe(true);
    expect(re.test("src/a/b.js")).toBe(false);
  });
});

describe("matchesSources", () => {
  const repo = repoAt("/repo", { sources: ["app/**/*.rb", "lib/**/*.rb"] });

  it("matches any configured glob", () => {
    expect(matchesSources(repo, "app/services/foo.rb")).toBe(true);
    expect(matchesSources(repo, "lib/tasks/x.rb")).toBe(true);
    expect(matchesSources(repo, "config/routes.rb")).toBe(false);
  });

  it("never matches a test file", () => {
    expect(matchesSources(repo, "app/services/foo_spec.rb")).toBe(false);
  });

  it("lets exclude win over sources", () => {
    const narrowed = repoAt("/repo", { sources: ["src/**/*.ts", "src/**/*.tsx"], exclude: ["**/*.tsx"] });
    expect(matchesSources(narrowed, "src/lib/a.ts")).toBe(true);
    expect(matchesSources(narrowed, "src/ui/Button.tsx")).toBe(false);
  });
});

describe("isExcluded", () => {
  it("is false when nothing is configured", () => {
    expect(isExcluded(repoAt("/repo"), "app/a.rb")).toBe(false);
  });

  it("matches directories as well as extensions", () => {
    const repo = repoAt("/repo", { exclude: ["src/generated/**", "**/*.tsx"] });
    expect(isExcluded(repo, "src/generated/schema.ts")).toBe(true);
    expect(isExcluded(repo, "src/ui/Button.tsx")).toBe(true);
    expect(isExcluded(repo, "src/lib/a.ts")).toBe(false);
  });
});

describe("toCwdRelative", () => {
  it("rebases repo root paths onto a monorepo cwd and drops the rest", () => {
    const repo = repoAt("/repo", { cwd: "/repo/apps/web" });
    expect(toCwdRelative(repo, ["apps/web/src/a.ts", "apps/api/src/b.ts", "README.md"])).toEqual(["src/a.ts"]);
  });

  it("is a no-op when cwd is the root", () => {
    const repo = repoAt("/repo");
    expect(toCwdRelative(repo, ["app/a.rb"])).toEqual(["app/a.rb"]);
  });
});

describe("listSources", () => {
  it("expands globs relative to cwd and excludes test files", async () => {
    const root = await mkdtemp(join(tmpdir(), "covergen-git-"));
    await mkdir(join(root, "app/services"), { recursive: true });
    await mkdir(join(root, "spec/services"), { recursive: true });
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "app/services/foo.rb"), "class Foo; end\n");
    await writeFile(join(root, "app/services/bar.rb"), "class Bar; end\n");
    await writeFile(join(root, "app/services/foo_spec.rb"), "# spec\n");
    await writeFile(join(root, "spec/services/foo_spec.rb"), "# spec\n");
    await writeFile(join(root, "node_modules/pkg/index.rb"), "# vendored\n");

    const repo = repoAt(root, { sources: ["app/**/*.rb", "**/*.rb"] });
    const out = await listSources(repo);
    expect(out).toContain("app/services/foo.rb");
    expect(out).toContain("app/services/bar.rb");
    expect(out).not.toContain("app/services/foo_spec.rb");
    expect(out).not.toContain("spec/services/foo_spec.rb");
    expect(out.some((p) => p.startsWith("node_modules/"))).toBe(false);
  });

  it("drops paths matched by exclude", async () => {
    const root = await mkdtemp(join(tmpdir(), "covergen-git-"));
    await mkdir(join(root, "src/ui"), { recursive: true });
    await writeFile(join(root, "src/ui/Button.tsx"), "export const Button = () => null;\n");
    await writeFile(join(root, "src/ui/format.ts"), "export const f = () => 1;\n");
    const repo = repoAt(root, { sources: ["src/**/*.ts", "src/**/*.tsx"], exclude: ["**/*.tsx"] });
    expect(await listSources(repo)).toEqual(["src/ui/format.ts"]);
  });

  it("returns a sorted deduped list even when globs overlap", async () => {
    const root = await mkdtemp(join(tmpdir(), "covergen-git-"));
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "app/b.rb"), "\n");
    await writeFile(join(root, "app/a.rb"), "\n");
    const repo = repoAt(root, { sources: ["app/*.rb", "app/**/*.rb"] });
    expect(await listSources(repo)).toEqual(["app/a.rb", "app/b.rb"]);
  });
});

it("runs git and maps success, git failure, and spawn failure to exit codes", async () => {
  const { runGit } = await import("./git.js");
  const root = await mkdtemp(join(tmpdir(), "covergen-git-"));

  const ok = await runGit(["--version"], root);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toMatch(/^git version/);

  const failed = await runGit(["rev-parse", "--verify", "refs/heads/covergen-missing-ref"], root);
  expect(failed.exitCode).toBe(128);
  expect(failed.stderr).toMatch(/fatal/);

  const unspawnable = await runGit(["--version"], join(root, "does-not-exist"));
  expect(unspawnable.exitCode).toBe(1);
  expect(unspawnable.stdout).toBe("");
});

  it("throws with the git stderr when a fingerprint command fails", async () => {
    const { exec } = fakeExec("", 128, "fatal: not a git repository\n");
    await expect(treeFingerprint("/repo", { exec, readFile: async () => Buffer.from("") })).rejects.toThrow(
      /^git .+ failed in \/repo: fatal: not a git repository$/,
    );
  });

  it("records a deleted dirty file with a missing marker after its path", async () => {
    const lstat = async () => ({ isSymbolicLink: () => false });
    const readFile = async (): Promise<Buffer> => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    };
    const deleted: GitExec = async (args) => {
      const command = args.join(" ");
      if (command === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (command === "diff --name-only -z --ignore-submodules=none") {
        return { stdout: "app/gone.rb\0", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    // A clean tree whose HEAD already spells out the same path-then-missing record.
    const clean: GitExec = async (args) =>
      args.join(" ") === "rev-parse HEAD"
        ? { stdout: "abc123\0path\0app/gone.rb\0missing\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 };

    const fromDeleted = await treeFingerprint("/repo", { exec: deleted, readFile, lstat });
    const fromClean = await treeFingerprint("/repo", { exec: clean, readFile, lstat });

    expect(fromDeleted).toBe(fromClean);
  });

  it("rethrows read errors other than missing files and submodule directories", async () => {
    const exec: GitExec = async (args) => {
      const command = args.join(" ");
      if (command === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (command === "diff --name-only -z --ignore-submodules=none") {
        return { stdout: "app/secret.rb\0", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const readFile = async (): Promise<Buffer> => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };

    await expect(
      treeFingerprint("/repo", { exec, readFile, lstat: async () => ({ isSymbolicLink: () => false }) }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

it("matches ? as exactly one character within a segment", () => {
  const re = globToRegExp("src/a?.ts");
  expect(re.test("src/ab.ts")).toBe(true);
  expect(re.test("src/a.ts")).toBe(false);
  expect(re.test("src/abc.ts")).toBe(false);
  expect(re.test("src/a/.ts")).toBe(false);
});

it("rethrows lstat failures other than a missing file", async () => {
  const exec: GitExec = async (args) => {
    const command = args.join(" ");
    if (command === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
    if (command === "diff --name-only -z --ignore-submodules=none") {
      return { stdout: "app/a.rb\0", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const opts = {
    exec,
    readFile: async () => Buffer.from("contents"),
    lstat: async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
  };

  await expect(treeFingerprint("/repo", opts)).rejects.toMatchObject({ code: "EACCES", message: "permission denied" });
});
