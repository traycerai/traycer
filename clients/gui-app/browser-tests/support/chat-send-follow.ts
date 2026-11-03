import type { Page } from "@playwright/test";

/**
 * Resolves once the reply streaming into `chat-send-follow.tsx` has delivered
 * `deltas` more, or has run out: the wait for "the stream kept running". A page
 * rendering a rich reply on a loaded runner draws few frames a second, so
 * frames here are slower than the stream, and a pause is either too short for
 * the stream or wasted after it.
 */
export async function streamRuns(page: Page, deltas: number): Promise<void> {
  const target = await page.evaluate(
    (count) => (window.__followDriver?.host.deltasDelivered() ?? 0) + count,
    deltas,
  );
  await page.waitForFunction((delivered) => {
    const host = window.__followDriver?.host;
    return (
      host !== undefined &&
      (host.deltasDelivered() >= delivered || !host.streaming())
    );
  }, target);
}
