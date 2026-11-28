import { chromium, type FullConfig } from "@playwright/test";

import { fixture } from "./fixtures.ts";

/**
 * Launches the browser once and loads one fixture page before any test, and
 * prints how long each took.
 *
 * What a machine pays once for its first Chrome start and first page load is
 * paid here, outside any test's budget. A slow first test after a fast
 * warm-up means each new browser pays it again, and this does not help.
 */
export default async function warmUp(config: FullConfig): Promise<void> {
  // A config with no `projects` still resolves to one, which carries `use`.
  const { use } = config.projects[0];
  const launchStarted = Date.now();
  const browser = await chromium.launch({
    ...use.launchOptions,
    ...(use.channel === undefined ? {} : { channel: use.channel }),
    headless: true,
  });
  const launched = Date.now();
  try {
    const page = await browser.newPage();
    await page.goto(
      `${String(use.baseURL)}${fixture("quit-intercept-cancel")}`,
    );
    process.stdout.write(
      `browser warm-up: launch ${String(launched - launchStarted)} ms, first page ${String(Date.now() - launched)} ms\n`,
    );
  } finally {
    await browser.close();
  }
}
