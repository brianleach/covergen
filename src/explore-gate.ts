/**
 * The end to end gate. This part holds what the gate keeps from a run: output
 * tails go to the report and, later, to the model's repair round, so the base
 * URL and the storage state path are replaced by `${NAME}` before a tail is
 * kept. The base URL and the session path reach the child only through the
 * environment variables the config names.
 */

/**
 * Replace each value with `${NAME}`, the longer value first so a base URL that
 * prefixes another value cannot leave a fragment behind. A trailing slash is
 * optional, so output that prints the origin bare is caught too.
 */
export function scrubEnvValues(text: string, values: Readonly<Record<string, string | undefined>>): string {
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    for (const v of new Set([value, value.replace(/\/+$/, "")])) if (v.length > 0) pairs.push([v, name]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs.reduce((out, [value, name]) => out.replaceAll(value, `\${${name}}`), text);
}
