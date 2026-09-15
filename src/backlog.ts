/**
 * Open-PR awareness for an unattended sweep.
 *
 * Two consecutive nights once regenerated tests for the same files, because the
 * first night's PRs were still open: the checkout had none of those specs, so
 * every uncovered line was still uncovered and every target was still a target.
 * The second run cost as much as the first and produced a PR nobody could merge
 * without resolving it against the first.
 *
 * So before targeting, read the spec files the repo's open `covergen/` PRs
 * already hold and take their sources off the list. Nothing here is fatal: a
 * `gh` that cannot answer means no exclusions, which is the older behavior.
 */

import { toCwdRelative } from "./git.js";
import { BRANCH_PREFIX, runCmd, type CmdExec } from "./pr.js";
import type { RepoConfig } from "./types.js";

export interface OpenPr {
  number: number;
  url: string;
  branch: string;
}

export interface OpenPrCover {
  /** Paths, relative to repo.cwd, that an open covergen PR already writes. */
  paths: Set<string>;
  /** The PRs those paths came from. */
  prs: OpenPr[];
}

interface GhPr {
  number?: number;
  url?: string;
  headRefName?: string;
  files?: { path?: string }[];
}

/**
 * The files every open PR on a `covergen/` branch touches, as paths relative to
 * `repo.cwd`. Paths outside cwd are dropped, which is what keeps one package of
 * a monorepo from being skipped over another package's PR.
 */
export async function openPrCover(repo: RepoConfig, exec: CmdExec = runCmd, limit = 50): Promise<OpenPrCover> {
  const res = await exec(
    "gh",
    ["pr", "list", "--state", "open", "--limit", String(limit), "--json", "number,url,headRefName,files"],
    repo.root,
  );
  if (res.exitCode !== 0) return { paths: new Set(), prs: [] };

  let parsed: GhPr[];
  try {
    parsed = JSON.parse(res.stdout || "[]") as GhPr[];
  } catch {
    return { paths: new Set(), prs: [] };
  }
  if (!Array.isArray(parsed)) return { paths: new Set(), prs: [] };

  const prs: OpenPr[] = [];
  const rootRelative: string[] = [];
  for (const pr of parsed) {
    const branch = pr.headRefName ?? "";
    if (!branch.startsWith(BRANCH_PREFIX)) continue;
    prs.push({ number: pr.number ?? 0, url: pr.url ?? "", branch });
    for (const file of pr.files ?? []) if (file.path) rootRelative.push(file.path);
  }
  return { paths: new Set(toCwdRelative(repo, rootRelative)), prs };
}

/**
 * Targets whose spec an open covergen PR already holds. The match is on the spec
 * path the target would be written to, plus the target itself for the runners
 * whose tests live in the source file. A target whose accepted test would land
 * in an existing nearest spec instead is not caught here: the cost of that
 * miss is one duplicated file, the cost of guessing wider is a target skipped
 * for a PR that never touches it.
 */
export function coveredTargets(repo: RepoConfig, targets: string[], cover: OpenPrCover): string[] {
  if (cover.paths.size === 0) return [];
  return targets.filter((rel) => cover.paths.has(rel) || cover.paths.has(repo.specPath(rel)));
}
