/**
 * Listing the test cases inside one spec file, for the audit.
 *
 * Regex over the text, in the spirit of segments.ts: a parser per language is
 * the correct tool and none of them is worth a dependency here. The failure
 * modes are both cheap. A case this misses is one case the audit never judges,
 * and a name it invents selects nothing when the runner is asked to run it, so
 * the case reports no coverage and no planted bug rather than a wrong verdict.
 *
 * Two cases in one file may share a name. The name filter then runs both, which
 * makes their coverage and their wall time indistinguishable; the audit reports
 * them as it found them rather than guessing which half is which.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoConfig, TestCase } from "../types.js";

/** it("name") / test('name'), including the modifiers that still run the case. */
const JS_CASE = /^\s*(?:it|test)(?:\.(?:only|concurrent|sequential|fails|skip|todo))?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
/** Go names a test by its function: `func TestApplyRate(t *testing.T)`. */
const GO_CASE = /^\s*func\s+(Test\w*)\s*\(/;
/** pytest collects module-level and method `test_` functions alike. */
const PY_CASE = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/;

function scan(text: string, pattern: RegExp, group: number): TestCase[] {
  const out: TestCase[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const name = pattern.exec(lines[i] ?? "")?.[group];
    if (name === undefined || name.length === 0) continue;
    out.push({ name, line: i + 1 });
  }
  return out;
}

export function jsCases(text: string): TestCase[] {
  return scan(text, JS_CASE, 2);
}

export function goCases(text: string): TestCase[] {
  return scan(text, GO_CASE, 1);
}

export function pytestCases(text: string): TestCase[] {
  return scan(text, PY_CASE, 1);
}

/** Read one spec file and list its cases. An unreadable file has no cases, and never throws. */
export async function casesIn(
  repo: RepoConfig,
  specPath: string,
  parse: (text: string) => TestCase[],
): Promise<TestCase[]> {
  try {
    return parse(await readFile(join(repo.cwd, specPath), "utf8"));
  } catch {
    return [];
  }
}
