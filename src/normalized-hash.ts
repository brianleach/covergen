/**
 * The one whitespace-collapsing hash covergen uses for test code, both for a
 * candidate (`hashCode`) and for a whole spec file on disk (`specFileHash`).
 *
 * Deliberately dependency free: the journal read path imports it, and pulling
 * the generator module in there would load the model SDK for no reason.
 *
 * Every `specHash` already recorded in a run journal was computed by this
 * function, so changing the normalization makes every existing journal read as
 * drifted. Leave it put, or bump the journal version with it.
 */

import { createHash } from "node:crypto";

/** sha256 hex over the text with every whitespace run collapsed to one space and the ends trimmed. */
export function normalizedHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}
