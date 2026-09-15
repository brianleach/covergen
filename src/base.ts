/**
 * Keeping an unattended run on a base it can merge onto.
 *
 * Two defects this exists for, both from real nights:
 *  - the sweep ran in a checkout nobody had updated for days, so every test it
 *    proved was proved against a stale base;
 *  - the PR step cut its branch from the default branch re-resolved hours later,
 *    which is a different commit from the one the tests passed on, and when the
 *    checkout also held modified files the branch could not be created at all.
 *
 * So: fast-forward before the run and hand the PR step the commit the run was
 * proved on. Two rules hold here. Nothing discards a commit: a checkout carrying
 * work of its own is left exactly where it is. And nothing throws: a checkout
 * that cannot be refreshed is reported with a reason and the run continues on
 * the base it already has.
 */

import { defaultBranch, dirtyPaths, runCmd, type CmdExec } from "./pr.js";

export interface BaseRefresh {
  /** HEAD before and after. Equal whenever nothing moved. */
  before: string;
  after: string;
  refreshed: boolean;
  /** Branch the checkout is on, or "HEAD" when it is detached. */
  branch: string;
  /** Default branch name, empty when it could not be resolved. */
  base: string;
  /** Why the checkout was left where it was, when it was. */
  reason?: string;
}

export interface RefreshBaseArgs {
  root: string;
  /** false keeps the older behavior: the checkout is used exactly as it is found. */
  enabled?: boolean;
  /** Repo-relative prefixes that do not count as dirty, e.g. covergen's state dir. */
  ignore?: string[];
  exec?: CmdExec;
}

/** stdout of a git command that succeeded, trimmed, or undefined when it failed. */
async function line(exec: CmdExec, args: string[], root: string): Promise<string | undefined> {
  const res = await exec("git", args, root);
  return res.exitCode === 0 ? res.stdout.trim() : undefined;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * Fast-forward `root` to the tip of its default branch before a run, and report
 * the commit the run will be proved on either way.
 */
export async function refreshBase(args: RefreshBaseArgs): Promise<BaseRefresh> {
  const exec = args.exec ?? runCmd;
  const { root } = args;
  const before = (await line(exec, ["rev-parse", "HEAD"], root)) ?? "";
  const branch = (await line(exec, ["rev-parse", "--abbrev-ref", "HEAD"], root)) ?? "HEAD";
  const stay = (reason: string, base = ""): BaseRefresh => ({
    before,
    after: before,
    refreshed: false,
    branch,
    base,
    reason,
  });

  if (before === "") return stay("no commit to refresh from");
  if (args.enabled === false) return stay("refresh_base: false");

  const fetched = await exec("git", ["fetch", "--quiet", "origin"], root);
  if (fetched.exitCode !== 0) return stay(`git fetch origin failed: ${firstLine(fetched.stderr || fetched.stdout)}`);

  const base = await defaultBranch(root, exec);
  // defaultBranch falls back to the bare branch name when there is no
  // remote-tracking ref, and a local ref is not something to refresh from.
  if (base.ref === base.name) return stay(`no origin/${base.name} to refresh from`, base.name);

  const target = await line(exec, ["rev-parse", base.ref], root);
  if (target === undefined) return stay(`cannot resolve ${base.ref}`, base.name);
  if (target === before) return stay(`already at ${base.ref}`, base.name);

  let dirty: string[];
  try {
    dirty = await dirtyPaths(root, args.ignore ?? [], exec);
  } catch (err) {
    return stay(`cannot read the working tree: ${firstLine(String(err))}`, base.name);
  }
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 3).join(", ");
    return stay(`checkout is dirty (${shown}${dirty.length > 3 ? ", ..." : ""})`, base.name);
  }

  // Never discard a commit. A branch holding work of its own is the difference
  // between a stale base and a lost afternoon, so it is left alone.
  const ahead = Number((await line(exec, ["rev-list", "--count", `${base.ref}..HEAD`], root)) ?? "0");
  if (Number.isFinite(ahead) && ahead > 0) {
    return stay(`${branch} has ${ahead} commit${ahead === 1 ? "" : "s"} not on ${base.ref}`, base.name);
  }

  const reset = await exec("git", ["reset", "--hard", base.ref], root);
  if (reset.exitCode !== 0) {
    return stay(`git reset --hard ${base.ref} failed: ${firstLine(reset.stderr || reset.stdout)}`, base.name);
  }
  return { before, after: target, refreshed: true, branch, base: base.name };
}
