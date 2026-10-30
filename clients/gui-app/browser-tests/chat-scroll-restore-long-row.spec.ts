import { test, type Page } from "@playwright/test";
import {
  expectAtRest,
  expectPositionKept,
  intentOf,
  settle,
} from "./support/chat-scroll-oracle";
import { fixture, nextFrames, wheelsDelivered } from "./support/fixtures";

/**
 * R4 (ported from chat-scroll-diag-long-anchor.spec.ts): the saved reading
 * anchor is not at a turn boundary but deep inside one long row — a reply
 * split across many paragraphs. A remount must put the reader back at that
 * exact row and offset, not just "somewhere in the right turn".
 */

const VIEWPORT_HEIGHT = 700;
const TALL_PARAGRAPHS = 33;
const TALL_ID_MID = 29;
const VIEWPORT_DEPTH = 2;

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: VIEWPORT_HEIGHT });
  await page.goto(
    `${fixture("chat-scroll-model")}?short=1&tallAt=${String(TALL_ID_MID)}&tallp=${String(TALL_PARAGRAPHS)}`,
  );
  await nextFrames(page, 30);
  const box = await page
    .locator('[data-testid="chat-messages-scroll"]')
    .boundingBox();
  if (box === null) throw new Error("no scroll node");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/** The reply's first mounted part top, relative to the scroll node; null when
 *  no part is mounted. A long reply splits into parts whose ids start with
 *  the reply's own id. */
const replyTop = (page: Page, id: number): Promise<number | null> =>
  page.evaluate((messageId) => {
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-messages-scroll"]',
    );
    if (node === null) return null;
    const top = node.getBoundingClientRect().top;
    const parts = Array.from(
      node.querySelectorAll<HTMLElement>(
        `[data-message-id^="message-${String(messageId)}"]`,
      ),
    );
    if (parts.length === 0) return null;
    return Math.min(
      ...parts.map((part) => part.getBoundingClientRect().top - top),
    );
  }, id);

/** Scrolls with the wheel until the row's top sits `into` px above the
 *  scroll node's top. */
async function scrollInto(page: Page, id: number, into: number): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const top = await replyTop(page, id);
    if (top === null) {
      await wheelsDelivered(page, [{ deltaX: 0, deltaY: -1500 }], 0);
      await settle(page, 6);
      continue;
    }
    const delta = top + into;
    if (Math.abs(delta) <= 2) return;
    await wheelsDelivered(
      page,
      [{ deltaX: 0, deltaY: Math.max(-1500, Math.min(1500, delta)) }],
      0,
    );
    await settle(page, 6);
  }
}

/** `remountLater`: production's unmount-then-mount reopen, resolving on the
 *  first frame the new scroll node exists. */
const reopen = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const selector = '[data-testid="chat-messages-scroll"]';
        const old = document.querySelector(selector);
        const method: unknown = Reflect.get(
          window.__chatScrollProbe,
          "remountLater",
        );
        if (typeof method !== "function") {
          reject(new Error("probe has no remountLater"));
          return;
        }
        Reflect.apply(method, window.__chatScrollProbe, [false]);
        const startedAt = performance.now();
        const poll = (): void => {
          const node = document.querySelector(selector);
          if (node !== null && node !== old) resolve();
          else if (performance.now() - startedAt > 3000)
            reject(new Error("the tile did not mount again"));
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }),
  );

test("a saved anchor deep inside one long row survives a reopen", async ({
  page,
}) => {
  await open(page);
  await scrollInto(page, TALL_ID_MID, VIEWPORT_DEPTH * VIEWPORT_HEIGHT);
  const before = await settle(page, 12);
  await expectAtRest(page, intentOf(before), "scrolled into the long row");
  await reopen(page);
  await expectPositionKept(page, before, "after reopen");
});
