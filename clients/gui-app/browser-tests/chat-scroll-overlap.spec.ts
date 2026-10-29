import { expect, test, type Page } from "@playwright/test";
import {
  startOverlapWatch,
  stopOverlapWatch,
} from "./support/chat-scroll-overlap-oracle";
import { settle } from "./support/chat-scroll-oracle";
import { fixture, nextFrames } from "./support/fixtures";

/**
 * Overlapping rows and a collapsing content height in a long windowed chat.
 *
 * A placeholder row and the hydrated row that replaces it share a key and
 * differ in list item type. The list used to average the hydrated row's
 * height against the placeholder's measurement, in a type that had never
 * counted that key, so every hydration (and every evict-and-rehydrate cycle)
 * pulled that type's running average down by about a turn's height. Once it
 * reached zero the list placed rows it had not measured at negative sizes:
 * distant rows landed inside the viewport on top of each other, and the
 * content height fell below what was already measured.
 *
 * `?shape=longTail` is a 300-turn chat with a long tail of tall replies. Each
 * cell is a path the reader takes through it; the watch samples every frame.
 */

const SCROLL = '[data-testid="chat-messages-scroll"]';
/** Frames the view must hold still, once, for a path to be at rest. */
const REST_FRAMES = 40;
/** Evict-and-rehydrate cycles of the longest cell. */
const EVICT_CYCLES = 12;

test.describe.configure({ mode: "default" });
test.setTimeout(240_000);

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(
    `${fixture("chat-scroll-model")}?line=windowed&shape=longTail`,
  );
  await page.waitForFunction(
    () =>
      "__chatScrollProbe" in window &&
      window.__chatScrollProbe.line() === "windowed",
    undefined,
    { polling: "raf", timeout: 60_000 },
  );
  await nextFrames(page, 30);
  await settle(page, 12);
}

async function pointAtTranscript(page: Page): Promise<void> {
  const box = await page.locator(SCROLL).boundingBox();
  if (box === null) throw new Error("no scroll node");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function wheelSteps(
  page: Page,
  deltaY: number,
  steps: number,
  framesPerStep: number,
): Promise<void> {
  await pointAtTranscript(page);
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, deltaY);
    await nextFrames(page, framesPerStep);
  }
}

/** A hard flick from the tail to the top of the chat. */
async function flickToTop(page: Page): Promise<void> {
  await wheelSteps(page, -5000, 60, 1);
  await settle(page, REST_FRAMES);
}

/** The trackpad reading on from where the view rests. */
async function readDown(page: Page): Promise<void> {
  await wheelSteps(page, 40, 30, 1);
  await settle(page, REST_FRAMES);
}

async function scrollTopOf(page: Page): Promise<number> {
  return page.evaluate(
    () => window.__chatScrollProbe.geometry()?.scrollTop ?? 0,
  );
}

/** The tab unmounts in one commit and mounts again in a later one, and the
 *  list starts over on the new scroll node: resolves once that node is up. */
async function remountLater(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (node === null) throw new Error("no scroll node");
    node.setAttribute("data-before-remount", "");
    const probe = window.__chatScrollProbe;
    const remountLater: unknown = Reflect.get(probe, "remountLater");
    if (typeof remountLater !== "function") {
      throw new Error("no remountLater on the probe");
    }
    Reflect.apply(remountLater, probe, [true]);
  }, SCROLL);
  await page.waitForSelector(`${SCROLL}:not([data-before-remount])`);
  await nextFrames(page, 30);
}

/** Picks a turn and waits for the view to leave where it was and come to rest. */
async function pickAndRest(page: Page, turn: number): Promise<void> {
  const before = await scrollTopOf(page);
  await page.evaluate((index) => {
    window.__chatScrollProbe.pick(index);
  }, turn);
  await expect
    .poll(() => scrollTopOf(page), {
      message: `the pick of turn ${String(turn)} moves the view`,
    })
    .not.toBe(before);
  await settle(page, REST_FRAMES);
}

/** Runs `body` under the per-frame watch and asserts what a reader would see
 *  break, each claim on its own so one run reports all that fail. */
async function expectNoBrokenFrames(
  page: Page,
  body: () => Promise<void>,
): Promise<void> {
  await startOverlapWatch(page);
  let report;
  try {
    await body();
  } finally {
    report = await stopOverlapWatch(page);
  }
  expect(report.frames, "the watch sampled the list").toBeGreaterThan(0);
  expect
    .soft(
      report.negativeAverageFrames,
      `frames with a running size average at or below zero; first: ${String(report.firstNegativeAverage)}`,
    )
    .toBe(0);
  expect
    .soft(
      report.overlapFrames,
      `frames with rows overlapping or out of order in the viewport; first: ${String(report.firstOverlap)}`,
    )
    .toBe(0);
  expect
    .soft(
      report.shortContentFrames,
      `frames with the content height below the rows already measured; first: ${String(report.firstShortContent)}`,
    )
    .toBe(0);
}

test("a flick from the tail to the top keeps every row apart", async ({
  page,
}) => {
  await open(page);
  await expectNoBrokenFrames(page, async () => {
    await flickToTop(page);
    await readDown(page);
  });
});

test("a remount at the top keeps every row apart", async ({ page }) => {
  await open(page);
  await expectNoBrokenFrames(page, async () => {
    await flickToTop(page);
    await remountLater(page);
    await settle(page, REST_FRAMES);
    await readDown(page);
  });
});

test("picking the same turns across evict-and-rehydrate cycles keeps every row apart", async ({
  page,
}) => {
  await open(page);
  await expectNoBrokenFrames(page, async () => {
    for (let cycle = 0; cycle < EVICT_CYCLES; cycle += 1) {
      for (const turn of [40, 120, 200]) {
        await pickAndRest(page, turn);
      }
      await page.evaluate(() => {
        window.__chatScrollProbe.evictCold();
      });
      await nextFrames(page, 6);
    }
    await pickAndRest(page, 0);
    await readDown(page);
  });
});
