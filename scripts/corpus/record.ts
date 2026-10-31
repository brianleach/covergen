/**
 * Where a corpus build writes its stats and manifest. A full run writes the tracked record
 * (stats.json and MANIFEST.md beside the seed list). A run narrowed with --only covers some
 * seeds, so its numbers are not the corpus: it writes stats.only.json and MANIFEST.only.md
 * into the run's output directory and leaves the tracked record alone.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RecordPaths {
  stats: string;
  manifest: string;
}

export function recordPaths(seedsFile: string, out: string, only: boolean): RecordPaths {
  if (only) return { stats: join(out, "stats.only.json"), manifest: join(out, "MANIFEST.only.md") };
  const dir = dirname(seedsFile);
  return { stats: join(dir, "stats.json"), manifest: join(dir, "MANIFEST.md") };
}

export function writeRecord(paths: RecordPaths, stats: unknown, manifest: string): void {
  for (const path of [paths.stats, paths.manifest]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(paths.stats, `${JSON.stringify(stats, null, 2)}\n`);
  writeFileSync(paths.manifest, manifest);
}
