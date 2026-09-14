/**
 * The draft PR path for an unattended sweep: branch, commit the accepted spec
 * files, push, and open a draft PR with `gh`.
 *
 * Rules that are load-bearing rather than stylistic:
 *  - the checkout must be clean before the run, so the commit can name the spec
 *    paths covergen wrote and nothing else. `git add -A` is never used.
 *  - the branch always starts with `covergen/`, asserted again immediately
 *    before the push, and the push uses an explicit `HEAD:refs/heads/<branch>`
 *    refspec so a misconfigured upstream cannot send it anywhere else.
 *  - the checkout is put back on the branch it started on, so the next night
 *    finds it clean and on the branch a human left it on.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countLines, packSpecFiles, partBody, partTitle, type SpecFile } from "./chunk.js";
import type { GitExecResult } from "./git.js";
import type { RepoConfig } from "./types.js";

export const BRANCH_PREFIX = "covergen/";

/** One command with an argv array, never a shell string. Injected in tests. */
export type CmdExec = (command: string, args: string[], cwd: string) => Promise<GitExecResult>;

export const runCmd: CmdExec = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as (NodeJS.ErrnoException & { code?: number }) | null)?.code;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode: typeof code === "number" ? code : err ? 1 : 0 });
    });
  });

async function must(exec: CmdExec, command: string, args: string[], cwd: string): Promise<string> {
  const res = await exec(command, args, cwd);
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout).trim().split("\n").slice(-5).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}: ${detail || `exit ${res.exitCode}`}`);
  }
  return res.stdout;
}

/** `covergen/<yyyymmdd>-<short random>`, unique enough that two runs never collide. */
export function branchName(now: Date = new Date(), suffix?: string): string {
  const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, "0"))
    .join("");
  const rand = suffix ?? Math.random().toString(36).slice(2, 8);
  return `${BRANCH_PREFIX}${stamp}-${rand}`;
}

export function assertBranch(branch: string): void {
  if (!branch.startsWith(BRANCH_PREFIX)) throw new Error(`refusing to push "${branch}": branch must start with ${BRANCH_PREFIX}`);
}

/**
 * The repo's default branch, read from the remote HEAD symref, with `main` as
 * the fallback for a checkout that never fetched one. `ref` is what a new branch
 * is cut from, preferring the remote-tracking ref so the branch is not built on
 * a stale local copy.
 */
export async function defaultBranch(root: string, exec: CmdExec = runCmd): Promise<{ name: string; ref: string }> {
  const symref = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], root);
  const name = symref.exitCode === 0 ? (symref.stdout.trim().split("/").pop() ?? "main") : "main";
  const remote = `origin/${name}`;
  const has = await exec("git", ["rev-parse", "--verify", "--quiet", remote], root);
  return { name, ref: has.exitCode === 0 ? remote : name };
}

/**
 * Working-tree paths that are neither committed nor ignorable. `ignore` holds
 * repo-relative prefixes, which is how covergen's own state directory stays out
 * of the answer in a repo that has not gitignored it.
 */
export async function dirtyPaths(root: string, ignore: string[] = [], exec: CmdExec = runCmd): Promise<string[]> {
  const out = await must(exec, "git", ["-c", "core.quotepath=false", "status", "--porcelain"], root);
  return out
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0)
    .filter((path) => !ignore.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)));
}

export interface OpenDraftPrArgs {
  repo: RepoConfig;
  /** Spec paths relative to repo.cwd, exactly what the run wrote. */
  files: string[];
  title: string;
  body: string;
  exec?: CmdExec;
  now?: Date;
  /** Fixed random suffix, for tests. */
  suffix?: string;
}

/** Branch, commit, push and open the draft PR. Returns the PR URL `gh` printed. */
export async function openDraftPr(args: OpenDraftPrArgs): Promise<string> {
  const { repo, files, title, body } = args;
  const exec = args.exec ?? runCmd;
  if (files.length === 0) throw new Error(`nothing to commit for ${repo.name}`);
  const root = repo.root;
  const branch = branchName(args.now, args.suffix);
  assertBranch(branch);

  const head = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
  const startedOn = head.exitCode === 0 ? head.stdout.trim() : "";
  const base = await defaultBranch(root, exec);
  const scratch = await mkdtemp(join(tmpdir(), "covergen-pr-"));
  const messageFile = join(scratch, "message.txt");
  const bodyFile = join(scratch, "body.md");

  try {
    await writeFile(messageFile, `${title}\n\n${body}`, "utf8");
    await writeFile(bodyFile, body, "utf8");
    await must(exec, "git", ["checkout", "-b", branch, base.ref], root);
    // Named paths only. A sweep runs unattended in someone's checkout and must
    // never sweep up an unrelated edit that appeared while it was running.
    await must(exec, "git", ["add", "--", ...files], repo.cwd);
    await must(exec, "git", ["commit", "-F", messageFile], repo.cwd);
    assertBranch(branch);
    await must(exec, "git", ["push", "origin", `HEAD:refs/heads/${branch}`], root);
    const created = await must(
      exec,
      "gh",
      ["pr", "create", "--draft", "--base", base.name, "--head", branch, "--title", title, "--body-file", bodyFile],
      root,
    );
    const url = created.trim().split("\n").filter(Boolean).pop() ?? "";
    if (!url.startsWith("http")) throw new Error(`gh pr create printed no PR URL: ${created.trim().slice(0, 200)}`);
    return url;
  } finally {
    // Best effort: the commit is safe on the branch either way, and a failure
    // here must not lose the PR URL the caller is waiting for.
    if (startedOn && startedOn !== "HEAD") await exec("git", ["checkout", startedOn], root);
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Line counts for the spec files a run wrote, read from the checkout before any
 * of them is committed: once a part is committed and the checkout goes back to
 * the branch it started on, that part's files hold their default-branch content
 * again. A file that cannot be read counts as empty rather than failing the run.
 */
export async function specSizes(repo: RepoConfig, files: string[]): Promise<SpecFile[]> {
  return Promise.all(
    files.map(async (path) => {
      const text = await readFile(resolve(repo.cwd, path), "utf8").catch(() => "");
      return { path, lines: countLines(text) };
    }),
  );
}

export interface UpdatePrBodyArgs {
  repo: RepoConfig;
  url: string;
  body: string;
  exec?: CmdExec;
}

/** Replace an open PR's body. Used to give the earlier parts their sibling links. */
export async function updatePrBody(args: UpdatePrBodyArgs): Promise<void> {
  const exec = args.exec ?? runCmd;
  const scratch = await mkdtemp(join(tmpdir(), "covergen-pr-"));
  const bodyFile = join(scratch, "body.md");
  try {
    await writeFile(bodyFile, args.body, "utf8");
    await must(exec, "gh", ["pr", "edit", args.url, "--body-file", bodyFile], args.repo.root);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface OpenDraftPrsArgs extends Omit<OpenDraftPrArgs, "suffix"> {
  /** sweep.pr_max_lines. 0 opens one PR however large the run was. */
  maxLines: number;
  /** Sizes of `files`, read from the checkout when absent. */
  sizes?: SpecFile[];
  /** Fixed random suffixes, one per part, for tests. */
  suffixes?: string[];
}

/**
 * Open the draft PRs for one repo's accepted specs: one when the run fits under
 * `maxLines`, otherwise one per packed part, each cut from the default branch so
 * it is mergeable on its own. Returns the PR URLs in part order.
 *
 * The parts are opened in order, so a part can only link the ones already open.
 * A second pass edits every part but the last, which gives each body the full
 * sibling list once all the URLs exist.
 */
export async function openDraftPrs(args: OpenDraftPrsArgs): Promise<string[]> {
  const { repo, files, title, body } = args;
  const exec = args.exec ?? runCmd;
  if (files.length === 0) throw new Error(`nothing to commit for ${repo.name}`);
  const sizes = args.sizes ?? (await specSizes(repo, files));
  const parts = packSpecFiles(sizes, args.maxLines);
  if (parts.length <= 1) {
    return [await openDraftPr({ repo, files, title, body, exec, now: args.now, suffix: args.suffixes?.[0] })];
  }

  const urls: (string | undefined)[] = parts.map(() => undefined);
  const infoFor = (index: number): Parameters<typeof partBody>[1] => ({
    index: index + 1,
    total: parts.length,
    files: parts[index] ?? [],
    siblings: urls,
  });
  for (let i = 0; i < parts.length; i += 1) {
    urls[i] = await openDraftPr({
      repo,
      files: (parts[i] ?? []).map((f) => f.path),
      title: partTitle(title, i + 1, parts.length),
      body: partBody(body, infoFor(i)),
      exec,
      now: args.now,
      suffix: args.suffixes?.[i],
    });
  }
  for (let i = 0; i < parts.length - 1; i += 1) {
    const url = urls[i];
    if (url) await updatePrBody({ repo, url, body: partBody(body, infoFor(i)), exec });
  }
  return urls.filter((url): url is string => Boolean(url));
}
