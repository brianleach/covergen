/**
 * Training corpus builder: clones each seed at its pinned commit, checks its LICENSE, pairs
 * tests with sources, dedupes, applies the p99 size ceiling, writes <out>/corpus.jsonl plus
 * MANIFEST.md and stats.json beside the seed list. Seed checkouts are read, never run.
 *   node --import tsx scripts/corpus/build.ts --seeds <seeds.yaml> --out <dir> [--clones <dir>] [--only a/b,c/d]
 *     [--max-ceiling <tokens>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { getEncoding } from "js-tiktoken";
import { checkLicense, findLicenseFile } from "./license.js";
import { pairRepo } from "./pair.js";
import { type Seed, parseSeeds, renderSeeds } from "./seeds.js";
import { type Percentiles, type Row, dedupe, parseMaxCeiling, sizeCeiling, summarize } from "./stats.js";

const TOKENIZER = "cl100k_base (js-tiktoken)";

type ManifestStats = Record<string, unknown> & {
  distribution_before_ceiling: Record<"source" | "test" | "source_plus_test", Percentiles>;
};

interface SeedResult {
  seed: Seed;
  status: string;
  tests: number;
  pairs: number;
  rows: number;
  drops: Record<string, number>;
}

/** The owner of this repository, from package.json, whose own repositories never seed the corpus. */
function selfOwner(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return /github\.com[/:]([^/]+)\//.exec(pkg.repository?.url ?? "")?.[1]?.toLowerCase() ?? "";
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Shallow checkout of a seed at its pinned commit, or at the default branch tip when unpinned. */
function checkout(seed: Seed, dir: string): string {
  if (seed.commit && existsSync(join(dir, ".git")) && git(dir, "rev-parse", "HEAD") === seed.commit) {
    return seed.commit;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/${seed.repo}.git`;
  if (!seed.commit) {
    git(dir, "clone", "-q", "--depth", "1", url, ".");
  } else {
    git(dir, "init", "-q");
    git(dir, "fetch", "-q", "--depth", "1", url, seed.commit);
    git(dir, "checkout", "-q", "FETCH_HEAD");
  }
  return git(dir, "rev-parse", "HEAD");
}

function main(): void {
  const { values } = parseArgs({
    options: {
      ...{ seeds: { type: "string" }, out: { type: "string" }, clones: { type: "string" } },
      ...{ only: { type: "string" }, "max-ceiling": { type: "string" } },
    },
  });
  if (!values.seeds || !values.out) throw new Error("usage: build.ts --seeds <seeds.yaml> --out <dir>");
  const { seeds: seedsFile, out } = values;
  const clones = values.clones ?? join(out, "clones");
  const only = values.only ? new Set(values.only.split(",")) : null;
  const maxCeiling = parseMaxCeiling(values["max-ceiling"]);
  const seeds = parseSeeds(readFileSync(seedsFile, "utf8"));
  const owner = selfOwner();
  const own = seeds.find((s) => s.repo.split("/")[0]!.toLowerCase() === owner);
  if (own) throw new Error(`seed ${own.repo} belongs to this repository's owner`);

  const results: SeedResult[] = [];
  const candidates: Row[] = [];
  for (const seed of seeds) {
    const r: SeedResult = { seed, status: "not run", tests: 0, pairs: 0, rows: 0, drops: {} };
    results.push(r);
    if (only && !only.has(seed.repo)) continue;
    const dir = join(clones, seed.repo.replace("/", "__"));
    try {
      seed.commit = checkout(seed, dir);
    } catch {
      r.status = "clone_failed";
      continue;
    }
    const file = findLicenseFile(dir);
    const verdict = checkLicense(seed.license, file, file ? readFileSync(join(dir, file), "utf8") : "");
    if (!verdict.ok) {
      r.status = verdict.reason;
      continue;
    }
    seed.license_url = `https://github.com/${seed.repo}/blob/${seed.commit}/${verdict.file}`;
    const paired = pairRepo(dir);
    Object.assign(r, { status: "ran", tests: paired.tests, pairs: paired.pairs.length, drops: { ...paired.drops } });
    const read = (path: string): string => readFileSync(join(dir, path), "utf8");
    for (const p of paired.pairs) {
      candidates.push({
        ...{ repo: seed.repo, commit: seed.commit, license: verdict.license, vitest_version: p.vitestVersion },
        ...{ source_path: p.sourcePath, source: read(p.sourcePath), test_path: p.testPath, test: read(p.testPath) },
      });
    }
  }

  const { kept, dropped } = dedupe(candidates);
  const enc = getEncoding("cl100k_base");
  const measured = kept.map((row) => {
    const source = enc.encode(row.source, [], []).length;
    const test = enc.encode(row.test, [], []).length;
    return { row, source, test, pair: source + test };
  });
  const fields = { source: "source", test: "test", source_plus_test: "pair" } as const;
  const distribution = Object.fromEntries(
    Object.entries(fields).map(([name, key]) => [name, summarize(measured.map((m) => m[key]))]),
  ) as Record<keyof typeof fields, Percentiles>;
  const { tokens: ceiling, rule: ceilingRule } = sizeCeiling(distribution.source_plus_test.p99, maxCeiling);
  const rows = measured.filter((m) => m.pair <= ceiling);
  for (const m of measured) {
    const r = results.find((x) => x.seed.repo === m.row.repo)!;
    if (m.pair <= ceiling) r.rows++;
    else r.drops.over_ceiling = (r.drops.over_ceiling ?? 0) + 1;
  }
  for (const r of results) {
    const dup = r.pairs - r.rows - (r.drops.over_ceiling ?? 0);
    if (dup > 0) r.drops.duplicate = dup;
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "corpus.jsonl"), rows.map((m) => `${JSON.stringify(m.row)}\n`).join(""));
  const stats = {
    tokenizer: TOKENIZER,
    rows: rows.length,
    candidate_pairs: candidates.length,
    duplicates_dropped: dropped,
    size_ceiling_tokens: ceiling,
    size_ceiling_rule: ceilingRule,
    size_ceiling_max: maxCeiling ?? null,
    over_ceiling_dropped: measured.length - rows.length,
    distribution_before_ceiling: distribution,
    pairs_per_repo: Object.fromEntries(results.filter((r) => r.status === "ran").map((r) => [r.seed.repo, r.rows])),
    seeds_run: results.filter((r) => r.status === "ran").length,
    seeds_total: results.length,
  };
  const manifestDir = dirname(seedsFile);
  writeFileSync(join(manifestDir, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
  writeFileSync(join(manifestDir, "MANIFEST.md"), renderManifest(results, stats));
  writeFileSync(seedsFile, renderSeeds(seeds));
  console.log(`rows=${rows.length} duplicates=${dropped} ceiling=${ceiling} seeds_run=${stats.seeds_run}`);
}

function renderManifest(results: SeedResult[], stats: ManifestStats): string {
  const d = stats.distribution_before_ceiling;
  const seedRows = results.map((r) => {
    const drops = Object.entries(r.drops).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
    const lic = r.seed.license_url ? `[${r.seed.license}](${r.seed.license_url})` : r.seed.license;
    return `| ${r.seed.repo} | ${lic} | ${r.seed.commit?.slice(0, 12) ?? "unpinned"} | ${r.status} | ${r.tests} | ${r.pairs} | ${r.rows} | ${drops} |`;
  });
  const pct = (k: keyof typeof d) => `| ${k} | ${d[k].p50} | ${d[k].p90} | ${d[k].p99} |`;
  return `# Corpus manifest

Generated by \`scripts/corpus/build.ts\`. One row is one Vitest test file
(\`.test.ts\`, \`.spec.ts\`, \`.test.tsx\` or \`.spec.tsx\`) plus the one source file
it imports most symbols from. Relative imports are preferred; when none resolves,
workspace package names and plain tsconfig path aliases are tried, following the
entry file's re-exports one level. Rows live in the gitignored
output directory as \`corpus.jsonl\`; this file and \`stats.json\` are the tracked record.

- Rows: ${stats.rows} (from ${stats.candidate_pairs} candidate pairs)
- Duplicates dropped (whitespace-normalized test hash, across repos): ${stats.duplicates_dropped}
- Size ceiling: ${stats.size_ceiling_tokens} tokens of source plus test (${stats.size_ceiling_rule}); ${stats.over_ceiling_dropped} pairs over it dropped
- Ceiling override: \`--max-ceiling <tokens>\` caps the ceiling at min(p99 rule, tokens). It is off
  by default (this build: ${stats.size_ceiling_max ?? "off"}) because a single outlier source file can move the p99 cap.
- Tokenizer: ${TOKENIZER}. It is a proxy: the fine-tune model's own tokenizer will count differently.
- Seeds run: ${stats.seeds_run} of ${stats.seeds_total}

## Provenance

Public tests may themselves have been written with an AI assistant; the builder
cannot know. The seed list leans to projects started before 2023 (valibot is the
exception), but a shallow clone carries no per-file history, so test files are not
dated, and many were rewritten after 2022. The corpus is not claimed to be free of
model text. It contains no covergen or Claude output: every row is a file read
verbatim from a public repository at the pinned commit.

## Seeds

| Repo | License | Commit | Status | Tests | Pairs | Rows | Drops |
| --- | --- | --- | --- | --- | --- | --- | --- |
${seedRows.join("\n")}

Drop reasons: \`not_vitest\` (no vitest import and no vitest dependency up the
tree, or another runner imported), \`no_resolvable_source\` (no relative import,
workspace package name or plain tsconfig path alias resolves to a TypeScript source
outside test directories), \`workspace_entry_unreadable\` (an import named a
workspace package of the seed, but no source entry for it could be read), \`generated\`,
\`snapshot\`, \`duplicate\`, \`over_ceiling\`. A seed whose LICENSE file is
missing, unclear or not the declared license is dropped whole.

## Token lengths before the ceiling

| Field | p50 | p90 | p99 |
| --- | --- | --- | --- |
${pct("source")}
${pct("test")}
${pct("source_plus_test")}
`;
}

main();
