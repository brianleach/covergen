/**
 * Splitting one unattended run into reviewable pieces.
 *
 * Two ceilings, both about the size of what a human is asked to read:
 *  - `sweep.pr_max_lines` caps one PR. A run that accepts more than that is
 *    opened as several draft PRs instead of one, each branched from the default
 *    branch on its own so the parts merge alone and in any order.
 *  - `sweep.pr_max_lines_per_file` caps one spec file. Once a spec has reached
 *    it the run stops adding segments to that file and leaves the rest for the
 *    next night, because `segments.max_per_file` bounds candidates rather than
 *    the lines those candidates add.
 *
 * Everything here is pure: the packing decides, the caller does the git work.
 */

/** One accepted spec file and its size after the run wrote into it. */
export interface SpecFile {
  /** Spec path relative to repo.cwd, exactly what the run wrote. */
  path: string;
  lines: number;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/**
 * Pack the accepted spec files into PR-sized groups, greedily and in accepted
 * order. Order is kept rather than sorted by size: the accepted order is the
 * order the run reasoned in, and a reviewer reading the parts in sequence sees
 * the same story the report tells.
 *
 * A file larger than the whole budget gets a part to itself rather than being
 * split, because a spec file is only reviewable whole. `maxLines` of 0 disables
 * the split and returns one part.
 */
export function packSpecFiles(files: SpecFile[], maxLines: number): SpecFile[][] {
  if (files.length === 0) return [];
  if (maxLines <= 0) return [files];
  const parts: SpecFile[][] = [];
  let current: SpecFile[] = [];
  let total = 0;
  for (const file of files) {
    // Only flush a part that already holds something: an oversized file would
    // otherwise open an empty PR ahead of its own.
    if (current.length > 0 && total + file.lines > maxLines) {
      parts.push(current);
      current = [];
      total = 0;
    }
    current.push(file);
    total += file.lines;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** `covergen: 9 tests accepted in api (part 2 of 3)`. */
export function partTitle(title: string, index: number, total: number): string {
  return `${title} (part ${index} of ${total})`;
}

export interface PartInfo {
  /** 1-based part number. */
  index: number;
  total: number;
  files: SpecFile[];
  /** PR URL per part, 0-based, undefined for a part that is not open yet. */
  siblings: (string | undefined)[];
}

/**
 * The shared run report with a header that says what this part holds and where
 * its siblings are. The report below the rule describes the whole run, so the
 * header says so instead of letting a reviewer read it as this PR's contents.
 */
export function partBody(body: string, part: PartInfo): string {
  const out: string[] = [];
  out.push(`**Part ${part.index} of ${part.total}** of one covergen sweep, split so each PR stays reviewable.`);
  out.push("");
  out.push("Each part is branched from the default branch on its own, so any part can merge alone and the parts can merge in any order.");
  out.push("");
  out.push("Spec files in this part:");
  out.push("");
  for (const file of part.files) out.push(`- \`${file.path}\` (${file.lines} ${file.lines === 1 ? "line" : "lines"})`);
  out.push("");
  const siblings = part.siblings.map((url, i) => ({ number: i + 1, url })).filter((s) => s.number !== part.index);
  if (siblings.length > 0) {
    out.push("The other parts of this sweep:");
    out.push("");
    for (const s of siblings) out.push(`- part ${s.number}: ${s.url ?? "not opened yet"}`);
    out.push("");
  }
  out.push("The report below covers the whole sweep, including the tests that landed in the other parts.");
  out.push("");
  out.push("---");
  out.push("");
  return `${out.join("\n")}\n${body}`;
}

/**
 * True when a spec file has reached the per-file ceiling, so nothing more should
 * be added to it this run. Checked before a file's segments are generated and
 * again after a block lands, which is what turns the ceiling into "stop adding"
 * rather than "reject what already passed the gate". 0 disables the ceiling.
 */
export function specFileFull(lines: number, maxLines: number): boolean {
  return maxLines > 0 && lines >= maxLines;
}
