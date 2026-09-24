/** The narrowing target: its spec also loads ../slugs.ts, which must not count toward it. */
export function padSlug(slug: string, width: number): string {
  return slug.padEnd(width, "-");
}
