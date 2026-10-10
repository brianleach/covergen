/**
 * License filter for the corpus seeds. The license is read from the LICENSE
 * file at the pinned commit, never from package.json, and only MIT, Apache-2.0
 * and BSD-2/3 are accepted. Anything the classifier cannot name is unclear and
 * the seed is dropped.
 */

import { readdirSync } from "node:fs";

export const ALLOWED_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"] as const;
export type AllowedLicense = (typeof ALLOWED_LICENSES)[number];

/** The root LICENSE file of a checkout (LICENSE, LICENSE.md, LICENCE.txt, COPYING), or null. */
export function findLicenseFile(root: string): string | null {
  const names = readdirSync(root).filter((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return names.sort()[0] ?? null;
}

/**
 * Name the license a LICENSE text grants, or null when it is not one of the
 * allowed four or when the text also carries a copyleft license.
 */
export function classifyLicense(text: string): AllowedLicense | null {
  const t = text.replace(/\s+/g, " ");
  if (/GNU (LESSER |AFFERO )?GENERAL PUBLIC|Mozilla Public License|Creative Commons/i.test(t)) {
    return null;
  }
  const mit = /Permission is hereby granted, free of charge/i.test(t) && /AS IS/.test(t);
  const apache = /Apache License/i.test(t) && /Version 2\.0/i.test(t);
  const bsd = /Redistribution and use in source and binary forms/i.test(t);
  if ([mit, apache, bsd].filter(Boolean).length !== 1) return null;
  if (mit) return "MIT";
  if (apache) return "Apache-2.0";
  return /Neither the name|names of its contributors/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
}

export type LicenseVerdict =
  | { ok: true; license: AllowedLicense; file: string }
  | { ok: false; reason: "license_missing" | "license_unclear" | "license_mismatch" };

/** Check a checkout's LICENSE file against the license its seed entry declares. */
export function checkLicense(declared: string, file: string | null, text: string): LicenseVerdict {
  if (file === null) return { ok: false, reason: "license_missing" };
  const found = classifyLicense(text);
  if (found === null) return { ok: false, reason: "license_unclear" };
  if (found !== declared) return { ok: false, reason: "license_mismatch" };
  return { ok: true, license: found, file };
}
