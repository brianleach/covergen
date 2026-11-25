/**
 * The browser-backed PageReader: a headless Chromium that carries the owner's
 * session and reads pages without touching them.
 *
 * Credentials never appear here. The session arrives as a Playwright storage
 * state file that lives outside the repo, named by an environment variable, and
 * nothing in this process reads its contents. The reader navigates and calls
 * `content()`; it never clicks, fills or submits, so a crawl of a live site
 * cannot write. The rendered HTML goes through the same parser the static reader
 * uses, which is what keeps the DOM reading testable without a browser, and one
 * aria snapshot per page then corrects the names against the accessibility tree.
 *
 * Browsers are not bundled. `playwright-core` finds one through
 * PLAYWRIGHT_BROWSERS_PATH, or COVERGEN_BROWSER_PATH names the executable.
 */

import { mergeAriaNames, parseAriaSnapshot, parseSnapshot } from "./explore-html.js";
import type { PageReader } from "./explore.js";

export interface BrowserReaderOptions {
  /** Playwright storageState file, outside the repo. Absent means no session. */
  storageStatePath?: string;
  /** Milliseconds one navigation may take. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Told, per page, how many names the accessibility tree corrected and added. Counts only, never names. */
  onNames?: (counts: { corrected: number; appended: number }) => void;
}

/**
 * Launch Chromium and return a reader over it. The caller always closes it;
 * every page shares one context, so the session is loaded once.
 */
export async function openBrowserReader(options: BrowserReaderOptions = {}): Promise<PageReader> {
  const env = options.env ?? process.env;
  const { chromium } = await import("playwright-core");
  const executablePath = env.COVERGEN_BROWSER_PATH?.trim() || undefined;
  const browser = await chromium.launch({ executablePath });
  const context = await browser.newContext(
    options.storageStatePath ? { storageState: options.storageStatePath } : {},
  );
  const timeout = options.timeoutMs ?? 30_000;
  return {
    async read(url) {
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        // A client-rendered app paints after domcontentloaded. Settling the
        // network is the cheap approximation; a route that never idles falls
        // back to whatever was rendered by the deadline rather than failing.
        await page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
        const snapshot = parseSnapshot(await page.content(), page.url());
        // One round trip per page, never per element. A page the snapshot fails
        // on keeps the parser's names rather than failing the crawl.
        const tree = await page.locator("body").ariaSnapshot({ timeout }).catch(() => undefined);
        if (tree === undefined) return snapshot;
        const { elements, corrected, appended } = mergeAriaNames(snapshot.elements, parseAriaSnapshot(tree));
        options.onNames?.({ corrected, appended });
        return { ...snapshot, elements };
      } finally {
        await page.close();
      }
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * Whether a browser can actually be launched here. CI has no browser, so the
 * browser-backed tests ask first and skip rather than fail.
 */
export async function browserAvailable(): Promise<boolean> {
  try {
    const reader = await openBrowserReader();
    await reader.close();
    return true;
  } catch {
    return false;
  }
}
