/**
 * Re-running the accepted specs on a default branch that moved while the run
 * gated them. The PR branch is still cut from the commit the tests were proven
 * on; this only tells the reviewer whether they also pass on the newer commit.
 *
 * It works in the run's own checkout, which already has every dependency the
 * runner needs: the accepted specs go into a temporary commit on a detached
 * HEAD, that commit is rebased onto the moved default branch, each spec runs on
 * its own, and the checkout goes back to the swept commit with the specs as
 * uncommitted files again. The branch the checkout was on never moves.
 */

import type { CmdExec } from "./pr.js";
import type { RunResult } from "./types.js";

export interface FailedSpec {
  spec: string;
  /** The first assertion line of the failure, or why the spec could not run. */
  line: string;
}

/** What the report records as `repos[].reverify`. */
export interface Reverify {
  /** The default-branch commit the specs were re-run on. */
  base: string;
  failed: FailedSpec[];
  /** Why the specs were not re-run at all. */
  skipped?: string;
}

export interface ReverifyOptions {
  /** The runner's per-spec test command, the one the gate uses. */
  runSpec: (spec: string) => Promise<RunResult>;
  /** sweep.reverify_max_commits: more drift than this skips the re-run. */
  maxCommits: number;
  /** True once the run is past its wall-clock ceiling. */
  pastDeadline: () => boolean;
  /** Each PR's outcome is pushed here, so a split run reports every part. */
  results: Reverify[];
}

export interface ReverifyArgs {
  root: string;
  cwd: string;
  /** Spec paths relative to cwd. */
  files: string[];
  /** The moved default branch, already fetched. */
  baseRef: string;
  runSpec: ReverifyOptions["runSpec"];
  exec: CmdExec;
}

/** Temporary commits must not depend on the machine's identity or hooks. */
const COMMIT = ["-c", "user.name=covergen", "-c", "user.email=covergen@localhost", "-c", "core.hooksPath=/dev/null"];

async function must(exec: CmdExec, args: string[], cwd: string): Promise<string> {
  const res = await exec("git", args, cwd);
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout).trim()}`);
  return res.stdout;
}

/** The line a reviewer needs from a failing run: its first assertion, else its last word. */
export function firstAssertion(res: RunResult): string {
  const lines = `${res.stdout}\n${res.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /assert|expect|Error\b|FAIL/.test(l)) ?? lines.at(-1) ?? `exit ${res.exitCode}`;
  return hit.slice(0, 200);
}

/**
 * Commit `files` from `from` on top of the swept commit and rebase that commit
 * onto the base. Returns the specs whose changes conflicted, which is empty when
 * the rebase went through and HEAD now holds every spec on the moved base.
 */
async function rebaseSpecs(args: ReverifyArgs, swept: string, from: string, files: string[]): Promise<string[]> {
  const { exec, cwd } = args;
  await must(exec, ["checkout", "-q", "-f", "--detach", swept], cwd);
  await must(exec, ["checkout", from, "--", ...files], cwd);
  await must(exec, [...COMMIT, "commit", "-q", "--no-verify", "-m", "covergen: re-verify (temporary)"], cwd);
  const rebased = await exec("git", [...COMMIT, "rebase", "-q", args.baseRef], cwd);
  if (rebased.exitCode === 0) return [];
  const unmerged = await exec("git", ["diff", "--name-only", "--relative", "--diff-filter=U"], cwd);
  await exec("git", ["rebase", "--abort"], cwd);
  const conflicted = unmerged.stdout.split("\n").map((l) => l.trim()).filter((l) => files.includes(l));
  // A rebase that stopped without naming a spec cannot be narrowed further.
  return conflicted.length > 0 ? conflicted : files;
}

/**
 * Re-run each accepted spec on the moved base. HEAD is the swept commit. Throws
 * only when git itself fails, and even then the checkout ends on that commit, on the branch it
 * started on, with every spec back in the working tree.
 */
export async function reverifyOnBase(args: ReverifyArgs): Promise<Reverify> {
  const { exec, root, cwd } = args;
  const base = (await must(exec, ["rev-parse", args.baseRef], root)).trim();
  const swept = (await must(exec, ["rev-parse", "HEAD"], root)).trim();
  const head = await exec("git", ["symbolic-ref", "-q", "HEAD"], root);
  const startedOn = head.exitCode === 0 ? head.stdout.trim() : "";
  let held: string | undefined;
  const failed: FailedSpec[] = [];
  try {
    // Every spec as the run left it, committed once so each attempt and the
    // final restore read from one place instead of the working tree.
    await must(exec, ["checkout", "-q", "--detach"], root);
    await must(exec, ["add", "--", ...args.files], cwd);
    await must(exec, [...COMMIT, "commit", "-q", "--no-verify", "-m", "covergen: accepted specs (temporary)"], cwd);
    held = (await must(exec, ["rev-parse", "HEAD"], root)).trim();

    let pending = args.files;
    while (pending.length > 0) {
      const conflicted = await rebaseSpecs(args, swept, held, pending);
      if (conflicted.length === 0) break;
      for (const spec of conflicted) failed.push({ spec, line: `rebase conflict on ${base.slice(0, 7)}` });
      pending = pending.filter((f) => !conflicted.includes(f));
    }
    for (const spec of pending) {
      const res = await args.runSpec(spec);
      if (!res.ok) failed.push({ spec, line: firstAssertion(res) });
    }
    return { base, failed };
  } finally {
    await exec("git", ["rebase", "--abort"], root);
    if (held) await exec("git", ["checkout", "-q", "-f", "--detach", held], root);
    // Back to the swept commit, with the specs uncommitted in the working tree
    // exactly as the run wrote them, and HEAD re-attached to its branch.
    await exec("git", ["reset", "-q", swept], root);
    if (startedOn) await exec("git", ["symbolic-ref", "HEAD", startedOn], root);
  }
}

/** The PR body line for one outcome. */
export function reverifyNote(r: Reverify): string {
  if (r.skipped) return `Not re-verified on the moved base: ${r.skipped}.`;
  if (r.failed.length === 0) return `All accepted specs re-verified on ${r.base.slice(0, 7)}.`;
  return [
    `Re-run on ${r.base.slice(0, 7)}, ${r.failed.length} spec${r.failed.length === 1 ? "" : "s"} failed. ` +
      "The tests here passed on the commit this branch is cut from; rebase and fix these before merging:",
    ...r.failed.map((f) => `- \`${f.spec}\`: ${f.line}`),
  ].join("\n");
}
