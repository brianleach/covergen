/**
 * The seed list: schema, parse and the canonical form build.ts writes back after pinning.
 */

import { parse as parseYaml, stringify } from "yaml";
import { z } from "zod";
import { ALLOWED_LICENSES } from "./license.js";

export const Seed = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  license: z.enum(ALLOWED_LICENSES),
  commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  license_url: z.string().url().optional(),
});
export type Seed = z.infer<typeof Seed>;
const SeedFile = z.object({ seeds: z.array(Seed).min(1) });

const HEADER = "# Corpus seeds. commit and license_url are pinned by build.ts on first run.\n";

export function parseSeeds(text: string): Seed[] {
  return SeedFile.parse(parseYaml(text)).seeds;
}

export function renderSeeds(seeds: Seed[]): string {
  return HEADER + stringify({ seeds }, { lineWidth: 0 });
}
