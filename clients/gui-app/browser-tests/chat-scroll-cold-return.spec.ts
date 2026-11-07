import { expect, test, type Page } from "@playwright/test";
import { settle } from "./support/chat-scroll-oracle";
import { fixture, nextFrames } from "./support/fixtures";

/**
 * A tab reopened over a long chat cold: the tail snapshot and a skeleton that
 * streams in chunks. The reader saved a position inside a turn the list cannot
 * name yet. The rule: restore it exactly, or follow the latest; never sit at
 * the top.
 */

const VIEWPORT = { width: 900, height: 700 };
const TURNS = 400;
const SPLIT_TURN = 200;
const OWNER = `assistant:turn-${String(SPLIT_TURN)}`;
const SAVED_OFFSET = -120;
const SCROLL = '[data-testid="chat-messages-scroll"]';
/** Rows above this offset of the top are "the first message". */
const NEAR_TOP_PX = 200;

interface Seed {
  readonly mode: "free-scrolling";
  readonly anchorMessageId: string;
  readonly anchorRowKey: string;
  readonly anchorIndex: number;
  readonly offset: number;
}

const PART_ANCHOR: Seed = {
  mode: "free-scrolling",
  anchorMessageId: `${OWNER}#message-${String(2 * SPLIT_TURN + 1)}:text-2`,
  anchorRowKey: OWNER,
  anchorIndex: 410,
  offset: SAVED_OFFSET,
};
const OWNER_NEVER_NAMED: Seed = {
  mode: "free-scrolling",
  anchorMessageId: "assistant:no-such-turn#x",
  anchorRowKey: "assistant:no-such-turn",
  anchorIndex: 81,
  offset: -60,
};
const SEGMENT_GONE: Seed = {
  mode: "free-scrolling",
  anchorMessageId: `${OWNER}#gone-seg`,
  anchorRowKey: OWNER,
  anchorIndex: 410,
  offset: SAVED_OFFSET,
};

interface Frame {
  readonly top: number;
  readonly fromEnd: number;
  readonly mode: string | null;
  readonly pending: boolean;
  readonly skeleton: number;
  readonly complete: boolean;
  /** The skeleton names the saved row. */
  readonly named: boolean;
}

declare global {
  interface Window {
    /** Written by `startSampling`. */
    __coldReturnStop?: () => Frame[];
  }
}

/** The mount sequence of a tab reopened in a new renderer session: the page
 *  loads with the tab withheld, the saved position is seeded, then it opens. */
async function coldMount(
  page: Page,
  seed: Seed,
  splitTurn: number,
  skeletonFirst: boolean,
): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    `${fixture("chat-scroll-model")}?line=windowed&mountLater=1` +
      `&turns=${String(TURNS)}&splitTurn=${String(splitTurn)}` +
      `&skeletonChunkMs=300&tailBytes=512`,
  );
  await page.waitForFunction(() => "__chatScrollProbe" in window, undefined, {
    polling: "raf",
  });
  await nextFrames(page, 2);
  if (skeletonFirst) await waitForSkeletonComplete(page);
  await page.evaluate((saved) => {
    window.__chatScrollProbe.seedSaved(saved);
    window.__chatScrollProbe.mountNow();
  }, seed);
}

/** One reading per painted frame from the moment the tab has a scroll node. */
async function startSampling(page: Page): Promise<() => Promise<Frame[]>> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    let running = true;
    const tick = (): void => {
      if (!running) return;
      const probe = window.__chatScrollProbe;
      const g = probe.geometry();
      const w = probe.windowState();
      if (g !== null && w !== null) {
        frames.push({
          top: g.scrollTop,
          fromEnd: g.scrollHeight - g.clientHeight - g.scrollTop,
          mode: probe.mode(),
          pending: probe.pendingRestore() !== null,
          skeleton: w.skeletonLength,
          complete: w.skeletonComplete,
          named: probe.ordinalOf("assistant:turn-200") !== null,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__coldReturnStop = () => {
      running = false;
      return frames;
    };
  });
  return () =>
    page.evaluate(() => {
      const stop = window.__coldReturnStop;
      if (stop === undefined) throw new Error("no sampler");
      return stop();
    });
}

/** The tab is mounted over a skeleton that cannot name the saved row yet: a
 *  change to the fixture that names it at mount fails here, not silently in
 *  the cases below. */
async function expectParkedAtMount(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__chatScrollProbe.geometry() !== null,
    undefined,
    { polling: "raf" },
  );
  const state = await page.evaluate((owner) => {
    const probe = window.__chatScrollProbe;
    return {
      pending: probe.pendingRestore() !== null,
      complete: probe.windowState()?.skeletonComplete ?? null,
      ordinal: probe.ordinalOf(owner),
    };
  }, OWNER);
  expect(state.complete, "the skeleton is still streaming at mount").toBe(
    false,
  );
  expect(state.ordinal, "the skeleton has not named the saved row").toBeNull();
  expect(state.pending, "the saved position is waiting at mount").toBe(true);
}

async function waitForSkeletonComplete(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__chatScrollProbe.windowState()?.skeletonComplete === true,
    undefined,
    { polling: "raf", timeout: 30_000 },
  );
}

/** Where a list item, by row key (a part included), sits below the top of the
 *  viewport; `null` when it is not drawn. */
function itemTop(page: Page, rowKey: string): Promise<number | null> {
  return page.evaluate(
    ({ selector, key }) => {
      const node = document.querySelector<HTMLElement>(selector);
      const row = node?.querySelector<HTMLElement>(
        `[data-row-key="${CSS.escape(key)}"]`,
      );
      if (node === null || row === null || row === undefined) return null;
      return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
    },
    { selector: SCROLL, key: rowKey },
  );
}

/** Whether the finished skeleton names the saved row. */
function isNamed(page: Page, rowKey: string): Promise<boolean> {
  return page.evaluate(
    (key) => window.__chatScrollProbe.ordinalOf(key) !== null,
    rowKey,
  );
}

/** Frames of a reader waiting on a restore: free-scrolling, within a screenful
 *  of the end. Not the strict edge: a tail row measured after the landing can
 *  push the end away, and nothing follows it while the reader is not
 *  following. A single frame may sit further out while a batch of rows lays
 *  out before the scroll catches up; a reader left away from the end stays
 *  there for many. */
const LAYOUT_TRANSIENT_FRAMES = 2;
function expectParkedAtTail(waiting: readonly Frame[]): void {
  let farRun = 0;
  let longestFarRun = 0;
  for (const f of waiting) {
    expect(f.mode).toBe("free-scrolling");
    farRun = f.fromEnd > VIEWPORT.height ? farRun + 1 : 0;
    longestFarRun = Math.max(longestFarRun, farRun);
  }
  expect(
    longestFarRun,
    "frames in a row further than a screenful from the end",
  ).toBeLessThanOrEqual(LAYOUT_TRANSIENT_FRAMES);
}

function nearTop(frames: readonly Frame[]): Frame[] {
  return frames.filter((f) => f.top < NEAR_TOP_PX);
}

test.describe("a cold return over a saved position the list cannot name yet", () => {
  test("a part of a long turn waits at the tail, then lands exactly", async ({
    page,
  }) => {
    await coldMount(page, PART_ANCHOR, SPLIT_TURN, false);
    const stop = await startSampling(page);
    await expectParkedAtMount(page);
    await waitForSkeletonComplete(page);
    expect(
      await isNamed(page, OWNER),
      "the finished skeleton and the saved row",
    ).toBe(true);
    const view = await settle(page, 20);
    const frames = await stop();

    expect(frames.length).toBeGreaterThan(10);
    expect(nearTop(frames), "no frame sits at the first message").toEqual([]);
    const waiting = frames.filter((f) => f.pending && !f.named);
    expect(waiting.length, "the reader waited").toBeGreaterThan(5);
    expectParkedAtTail(waiting);

    expect(view.mode).toBe("free-scrolling");
    const partTop = await itemTop(page, PART_ANCHOR.anchorMessageId);
    expect(partTop, "the saved part is drawn").not.toBeNull();
    expect(Math.abs((partTop ?? 0) - SAVED_OFFSET)).toBeLessThanOrEqual(1);
  });

  test("a wheel up while it waits retires the restore and the reader stays", async ({
    page,
  }) => {
    await coldMount(page, PART_ANCHOR, SPLIT_TURN, false);
    await expectParkedAtMount(page);
    await nextFrames(page, 10);
    const stop = await startSampling(page);
    await page.mouse.move(450, 300);
    await page.mouse.wheel(0, -500);
    await page.waitForFunction(
      () => window.__chatScrollProbe.pendingRestore() === null,
      undefined,
      { polling: "raf" },
    );
    const moved = await settle(page, 20);
    expect(moved.mode).toBe("free-scrolling");
    expect(moved.fromEnd).toBeGreaterThan(100);
    const before = moved.reading;

    await waitForSkeletonComplete(page);
    expect(
      await isNamed(page, OWNER),
      "the finished skeleton and the saved row",
    ).toBe(true);
    const after = await settle(page, 20);
    const frames = await stop();

    expect(nearTop(frames), "no frame sits at the first message").toEqual([]);
    expect(after.mode).toBe("free-scrolling");
    expect(after.reading?.messageId).toBe(before?.messageId);
    expect(
      Math.abs((after.reading?.offset ?? 0) - (before?.offset ?? 0)),
    ).toBeLessThanOrEqual(2);
    const partTop = await itemTop(page, PART_ANCHOR.anchorMessageId);
    expect(
      partTop === null || Math.abs(partTop - SAVED_OFFSET) > 50,
      "the skeleton finishing does not carry the reader to the saved row",
    ).toBe(true);
  });

  test("an owner the transcript never names waits, then follows the latest", async ({
    page,
  }) => {
    await coldMount(page, OWNER_NEVER_NAMED, SPLIT_TURN, false);
    const stop = await startSampling(page);
    await expectParkedAtMount(page);
    await waitForSkeletonComplete(page);
    expect(
      await isNamed(page, OWNER_NEVER_NAMED.anchorRowKey),
      "the finished skeleton and the saved row",
    ).toBe(false);
    const view = await settle(page, 20);
    const frames = await stop();

    expect(nearTop(frames), "no frame sits at the first message").toEqual([]);
    const waiting = frames.filter((f) => f.pending && !f.complete);
    expect(waiting.length, "the reader waited").toBeGreaterThan(5);
    expectParkedAtTail(waiting);
    expect(view.mode).toBe("following-end");
    expect(view.fromEnd).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => window.__chatScrollProbe.pendingRestore()),
    ).toBeNull();

    await page.evaluate(() => {
      window.__chatScrollProbe.remountLater(true);
    });
    await nextFrames(page, 10);
    const remounted = await settle(page, 20);
    expect(remounted.mode).toBe("following-end");
    expect(remounted.fromEnd).toBeLessThanOrEqual(1);
    const saved = await page.evaluate(() => window.__chatScrollProbe.saved());
    expect(saved?.anchorMessageId).not.toBe(OWNER_NEVER_NAMED.anchorMessageId);
  });

  test("an owner present without the saved segment follows the latest", async ({
    page,
  }) => {
    await coldMount(page, SEGMENT_GONE, SPLIT_TURN, false);
    const stop = await startSampling(page);
    await expectParkedAtMount(page);
    await waitForSkeletonComplete(page);
    expect(
      await isNamed(page, OWNER),
      "the finished skeleton and the saved row",
    ).toBe(true);
    const view = await settle(page, 20);
    const frames = await stop();

    expect(nearTop(frames), "no frame sits at the first message").toEqual([]);
    const waiting = frames.filter((f) => f.pending && !f.named);
    expect(waiting.length, "the reader waited").toBeGreaterThan(5);
    expectParkedAtTail(waiting);
    expect(view.mode).toBe("following-end");
    expect(view.fromEnd).toBeLessThanOrEqual(1);
  });

  test("a first-turn owner already named at mount follows the latest, not the top", async ({
    page,
  }) => {
    // Not parked: the skeleton is complete before the tab opens, so the mount
    // lands on the owner row. Turn 0 is the first message of the chat.
    const firstTurn = "assistant:turn-0";
    await coldMount(
      page,
      {
        mode: "free-scrolling",
        anchorMessageId: `${firstTurn}#gone-seg`,
        anchorRowKey: firstTurn,
        anchorIndex: 2,
        offset: SAVED_OFFSET,
      },
      0,
      true,
    );
    expect(await isNamed(page, firstTurn), "the owner is named at mount").toBe(
      true,
    );
    await page.waitForFunction(
      () => window.__chatScrollProbe.geometry() !== null,
      undefined,
      { polling: "raf" },
    );
    const view = await settle(page, 20);

    expect(view.mode).toBe("following-end");
    expect(view.fromEnd).toBeLessThanOrEqual(1);
    expect(view.scrollTop, "not at the first message").toBeGreaterThan(
      NEAR_TOP_PX,
    );
    expect(
      await page.evaluate(() => window.__chatScrollProbe.pendingRestore()),
    ).toBeNull();
  });
});
