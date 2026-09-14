/**
 * Path to glob escaping, shared by every runner that narrows coverage to one file.
 *
 * A coverage include is a glob, not a path: vitest's `--coverage.include` and jest's
 * `--collectCoverageFrom` both run the value through a matcher. Real source paths can
 * carry glob syntax, most often a dynamic route directory such as
 * `app/api/items/[id]/route.ts`, where `[id]` reads as a character class. The include
 * then matches nothing, the lcov comes back with no record for the file, and every
 * generated test for it is rejected as adding no coverage after a full generate plus
 * every repair round.
 *
 * A backslash means "the next character is literal" to both minimatch (vitest) and
 * picomatch (jest), so one escaped string serves both. POSIX separators only, which is
 * what the runners already resolve paths to.
 */

/** Glob syntax that can appear in a real file path. */
const GLOB_METACHARACTERS = new Set(["\\", "[", "]", "{", "}", "(", ")", "*", "?", "!"]);

/** `app/api/items/[id]/route.ts` becomes `app/api/items/\[id\]/route.ts`. */
export function escapeGlob(path: string): string {
  let out = "";
  for (const char of path) out += GLOB_METACHARACTERS.has(char) ? `\\${char}` : char;
  return out;
}
