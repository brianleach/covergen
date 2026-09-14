/**
 * A source file under a dynamic-route directory, the shape a Next.js app uses
 * for app/api/items/[id]/route.ts. The `[id]` segment is a glob character
 * class, so a coverage include built from this path without escaping matches
 * nothing and the lcov comes back with no record for the file.
 */

export function routeLabel(id: string): string {
  return `item:${id}`;
}

/** Deliberately uncovered: no test reaches it. */
export function missingId(): string {
  return "id is required";
}
