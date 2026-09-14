/** Covered by the fixture spec. */
export function slugify(input: string): string {
  return input.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Deliberately uncovered: the segment covergen is expected to find. */
export function shorten(slug: string, max: number): string {
  if (slug.length <= max) {
    return slug;
  }
  const cut = slug.slice(0, max);
  const lastDash = cut.lastIndexOf("-");
  return lastDash > 0 ? cut.slice(0, lastDash) : cut;
}
