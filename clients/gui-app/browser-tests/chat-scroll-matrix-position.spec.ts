import { test, type Page } from "@playwright/test";
import {
  expectAtRest,
  expectPositionKept,
  intentOf,
  settle,
  startTimeline,
  type ChatScrollView,
} from "./support/chat-scroll-oracle";
import { fixture, nextFrames } from "./support/fixtures";

/**
 * The reader's place in the transcript across hide/show and close/reopen:
 * "it's not holding the last open position". Each scenario leaves the reader
 * detached (wheeled into the middle) or following, changes the tile's life,
 * and asks the model's at-rest questions against what the reader left.
 */

type HideKind = "intact" | "collapse";
const HIDE_KINDS: readonly HideKind[] = ["intact", "collapse"];
const TIMELINE_TAIL_LINES = 60;

type Line = "legacy" | "windowed";
const LINES: readonly Line[] = ["legacy", "windowed"];

async function open(page: Page, line: Line): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(
    `${fixture("chat-scroll-model")}${line === "windowed" ? "?line=windowed" : ""}`,
  );
  await nextFrames(page, 30);
}

/** Runs a scenario with a frame timeline, and appends its tail to a failure. */
async function withTimeline(
  page: Page,
  body: () => Promise<void>,
): Promise<void> {
  const stop = await startTimeline(page);
  try {
    await body();
  } catch (error) {
    const lines = (await stop()).split("\n").slice(-TIMELINE_TAIL_LINES);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\n  TIMELINE (last ${String(lines.length)} changes)\n${lines.join("\n")}`,
    );
  }
}

async function wheel(page: Page, deltaY: number): Promise<void> {
  const box = await page
    .locator('[data-testid="chat-messages-scroll"]')
    .boundingBox();
  if (box === null) throw new Error("no scroll node");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

/** The reader wheels up into the middle of the transcript and rests there. */
async function detach(page: Page): Promise<ChatScrollView> {
  await wheel(page, -1500);
  const view = await settle(page, 12);
  if (view.mode !== "free-scrolling") {
    throw new Error(
      `could not detach: mode=${String(view.mode)} fromEnd=${String(view.fromEnd)}`,
    );
  }
  return view;
}

/** Hides the tile and returns the view the reader had in that same task,
 *  before React commits the hide. */
const hideReadingLive = (page: Page, kind: HideKind): Promise<ChatScrollView> =>
  page.evaluate((k) => {
    const probe = window.__chatScrollProbe;
    const geometry = probe.geometry();
    if (geometry === null) throw new Error("no transcript scroll node");
    const view = {
      ...geometry,
      fromEnd:
        geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop,
      mode: probe.mode(),
      pill: probe.pillShown(),
      reading: probe.readingRow(),
    };
    probe.hide(k);
    return view;
  }, kind);

const hide = (page: Page, kind: HideKind): Promise<void> =>
  page.evaluate((k) => window.__chatScrollProbe.hide(k), kind);
const show = (page: Page): Promise<void> =>
  page.evaluate(() => window.__chatScrollProbe.show());
/**
 * How a tile comes back in production. `evict`: it unmounts in one commit and
 * mounts again in a later one; `reopen`: the tab closes and a new tab opens the
 * chat; `move`: a structural move flushes the live capture and remounts. The
 * fixtures' `remount` (a bare key change, the old cleanup running after the new
 * render) is not a production path and is not used here.
 */
type Reopen = "evict" | "reopen" | "move";
const REOPENS: readonly Reopen[] = ["evict", "reopen", "move"];

/** `remountLater` / `remountMoved`: the fixtures' production remount paths,
 *  which the shared probe type does not carry. Resolves on the first frame the
 *  new tile's scroll node exists, so a caller that acts "immediately" acts
 *  while the restore is still converging. */
const reopen = (page: Page, how: Reopen): Promise<void> =>
  page.evaluate(
    (h) =>
      new Promise<void>((resolve, reject) => {
        const selector = '[data-testid="chat-messages-scroll"]';
        const old = document.querySelector(selector);
        const name = h === "move" ? "remountMoved" : "remountLater";
        const method: unknown = Reflect.get(window.__chatScrollProbe, name);
        if (typeof method !== "function") {
          reject(new Error(`probe has no ${name}`));
          return;
        }
        Reflect.apply(
          method,
          window.__chatScrollProbe,
          h === "move" ? [] : [h === "evict"],
        );
        const startedAt = performance.now();
        const poll = (): void => {
          const node = document.querySelector(selector);
          if (node !== null && node !== old) {
            resolve();
          } else if (performance.now() - startedAt > 3000) {
            reject(new Error("the tile did not mount again"));
          } else {
            requestAnimationFrame(poll);
          }
        };
        requestAnimationFrame(poll);
      }),
    how,
  );
const appendTurn = (page: Page): Promise<void> =>
  page.evaluate(() => window.__chatScrollProbe.appendTurn());
const startStream = (page: Page, ms: number): Promise<void> =>
  page.evaluate((m) => window.__chatScrollProbe.startStream(m), ms);
const stopStream = (page: Page): Promise<void> =>
  page.evaluate(() => window.__chatScrollProbe.stopStream());

async function streamFor(page: Page, ms: number): Promise<void> {
  await startStream(page, 50);
  await page.waitForTimeout(ms);
  await stopStream(page);
}

for (const line of LINES) {
  // D1 / D4: following, hidden while a reply streams, shown again.
  for (const kind of HIDE_KINDS) {
    const id = kind === "intact" ? "D1" : "D4";
    test(`${line} ${id}: following, hide ${kind}, stream 1s, show -> tail, following`, async ({
      page,
    }) => {
      await open(page, line);
      await withTimeline(page, async () => {
        await expectAtRest(page, { kind: "tail" }, "start");
        await hide(page, kind);
        await streamFor(page, 1000);
        await show(page);
        await expectAtRest(page, { kind: "tail" }, "after show");
      });
    });
  }

  // D2 / D3: detached, hide, (while hidden: nothing | stream | appendTurn), show.
  for (const kind of HIDE_KINDS) {
    const id = kind === "intact" ? "D2" : "D3";
    for (const whileHidden of ["nothing", "stream", "appendTurn"] as const) {
      test(`${line} ${id}: detached, hide ${kind}, ${whileHidden} while hidden, show -> kept`, async ({
        page,
      }) => {
        await open(page, line);
        await withTimeline(page, async () => {
          const before = await detach(page);
          await expectAtRest(page, intentOf(before), "detached");
          await hide(page, kind);
          await page.waitForTimeout(100);
          if (whileHidden === "stream") await streamFor(page, 1000);
          if (whileHidden === "appendTurn") await appendTurn(page);
          await page.waitForTimeout(200);
          await show(page);
          await expectPositionKept(page, before, "after show");
        });
      });
    }
  }

  // D5: hide/show twice.
  for (const kind of HIDE_KINDS) {
    test(`${line} D5: detached, hide ${kind} + show twice -> kept`, async ({
      page,
    }) => {
      await open(page, line);
      await withTimeline(page, async () => {
        const before = await detach(page);
        for (const round of [1, 2]) {
          await hide(page, kind);
          await page.waitForTimeout(150);
          await show(page);
          await expectPositionKept(page, before, `round ${String(round)}`);
        }
      });
    });
  }

  // D6: hide before the wheel's scroll has settled; the position the reader
  // actually saw (the live view, read in the same task as the hide, before
  // React commits it) is the one that comes back.
  for (const kind of HIDE_KINDS) {
    for (const delayMs of [0, 50, 150]) {
      test(`${line} D6: wheel, hide ${kind} after ${String(delayMs)}ms, show -> the live position at the hide`, async ({
        page,
      }) => {
        await open(page, line);
        await withTimeline(page, async () => {
          await wheel(page, -600);
          await wheel(page, -600);
          await wheel(page, -400);
          if (delayMs > 0) await page.waitForTimeout(delayMs);
          const live = await hideReadingLive(page, kind);
          await page.waitForTimeout(300);
          await show(page);
          await expectPositionKept(
            page,
            live,
            `live at the hide ${JSON.stringify(live.reading)} fromEnd=${live.fromEnd.toFixed(0)}`,
          );
        });
      });
    }
  }
}

for (const line of LINES) {
  const tag = (id: string, how: Reopen): string => `${line} ${id}[${how}]`;

  // E1 / E2: detached, then the tile comes back (E1 also with traffic first).
  for (const how of REOPENS) {
    for (const withTraffic of [false, true]) {
      test(`${tag("E1/E2", how)}: detached, reopen${withTraffic ? " after appendTurn + stream" : ""} -> kept`, async ({
        page,
      }) => {
        await open(page, line);
        await withTimeline(page, async () => {
          const before = await detach(page);
          if (withTraffic) {
            await appendTurn(page);
            await streamFor(page, 600);
            await expectPositionKept(page, before, "after traffic");
          }
          await reopen(page, how);
          await expectPositionKept(page, before, "after reopen");
        });
      });
    }
  }

  // E3: following, the tile comes back.
  for (const how of REOPENS) {
    test(`${tag("E3", how)}: following, reopen -> tail, following`, async ({
      page,
    }) => {
      await open(page, line);
      await withTimeline(page, async () => {
        await expectAtRest(page, { kind: "tail" }, "start");
        await reopen(page, how);
        await expectAtRest(page, { kind: "tail" }, "after reopen");
      });
    });
  }

  // E4: detached, collapsed, the tile comes back while hidden, shown.
  for (const how of REOPENS) {
    test(`${tag("E4", how)}: detached, hide collapse, reopen while hidden, show -> kept`, async ({
      page,
    }) => {
      await open(page, line);
      await withTimeline(page, async () => {
        const before = await detach(page);
        await hide(page, "collapse");
        await page.waitForTimeout(100);
        await reopen(page, how);
        await page.waitForTimeout(300);
        await show(page);
        await expectPositionKept(page, before, "after show");
      });
    });
  }

  // E5: a minimap pick survives the tile coming back, at the reading line.
  for (const how of REOPENS) {
    test(`${tag("E5", how)}: minimap pick, reopen -> the picked turn at 48px`, async ({
      page,
    }) => {
      await open(page, line);
      await withTimeline(page, async () => {
        const items = await page.evaluate(() =>
          window.__chatScrollProbe.pickItems(),
        );
        const messageId = items.at(5);
        if (messageId === undefined)
          throw new Error(`outline has ${String(items.length)} items`);
        await page.evaluate(() => window.__chatScrollProbe.pick(5));
        const intent = { kind: "picked", messageId } as const;
        await expectAtRest(page, intent, "after pick");
        await reopen(page, how);
        await expectAtRest(page, intent, "after reopen");
      });
    });
  }

  // E6: a stream starts while the restore converges; the reader stays put.
  for (const how of REOPENS) {
    for (const streamDelayMs of [0, 100]) {
      test(`${tag("E6", how)}: detached, reopen, stream starts after ${String(streamDelayMs)}ms -> kept`, async ({
        page,
      }) => {
        await open(page, line);
        await withTimeline(page, async () => {
          const before = await detach(page);
          await reopen(page, how);
          if (streamDelayMs > 0) await page.waitForTimeout(streamDelayMs);
          await startStream(page, 50);
          await page.waitForTimeout(1000);
          await stopStream(page);
          await expectPositionKept(page, before, "after stream");
        });
      });
    }
  }

  // E7: the reader wheels right after the mount; their new position wins.
  for (const how of REOPENS) {
    for (const wheelDelayMs of [0, 100]) {
      test(`${tag("E7", how)}: detached, reopen, wheel after ${String(wheelDelayMs)}ms -> the new position wins`, async ({
        page,
      }) => {
        await open(page, line);
        await withTimeline(page, async () => {
          const before = await detach(page);
          await reopen(page, how);
          if (wheelDelayMs > 0) await page.waitForTimeout(wheelDelayMs);
          await wheel(page, -400);
          const after = await settle(page, 12);
          await expectAtRest(page, intentOf(after), "after wheel");
          // The wheel moved the reader 400px up from where the restore put
          // them; a restore that lands afterwards puts them back at `before`
          // (or at the tail). Distance from the end, not scrollTop: the restore
          // replaces estimated row heights with measured ones.
          const moved = after.fromEnd - before.fromEnd;
          if (Math.abs(moved - 400) > 150) {
            throw new Error(
              `the reader's wheel was overridden: fromEnd ${before.fromEnd.toFixed(0)} -> ${after.fromEnd.toFixed(0)} ` +
                `(moved ${moved.toFixed(0)}, wanted ~400 up); reading ${JSON.stringify(before.reading)} -> ${JSON.stringify(after.reading)}`,
            );
          }
        });
      });
    }
  }

  // E8: one wheel notch above the tail must not snap to it.
  for (const how of REOPENS) {
    test(`${tag("E8", how)}: one notch above the tail, reopen -> kept, not snapped to the tail`, async ({
      page,
    }) => {
      await open(page, line);
      await withTimeline(page, async () => {
        await wheel(page, -100);
        const before = await settle(page, 12);
        if (before.mode !== "free-scrolling" || before.fromEnd <= 1) {
          throw new Error(
            `could not detach one notch: mode=${String(before.mode)} fromEnd=${String(before.fromEnd)}`,
          );
        }
        await expectAtRest(page, intentOf(before), "one notch up");
        await reopen(page, how);
        await expectPositionKept(page, before, "after reopen");
      });
    });
  }
}

/** Like `reopen`, but presses a non-interactive point on the new tile the
 *  moment its scroll node exists, so the click lands the same task the
 *  restore starts converging. */
const reopenWithClick = (page: Page, how: Reopen): Promise<void> =>
  page.evaluate(
    (h) =>
      new Promise<void>((resolve, reject) => {
        const selector = '[data-testid="chat-messages-scroll"]';
        const old = document.querySelector(selector);
        const name = h === "move" ? "remountMoved" : "remountLater";
        const method: unknown = Reflect.get(window.__chatScrollProbe, name);
        if (typeof method !== "function") {
          reject(new Error(`probe has no ${name}`));
          return;
        }
        Reflect.apply(
          method,
          window.__chatScrollProbe,
          h === "move" ? [] : [h === "evict"],
        );
        const startedAt = performance.now();
        const poll = (): void => {
          const node = document.querySelector(selector);
          if (node !== null && node !== old) {
            const box = node.getBoundingClientRect();
            const target = document.elementFromPoint(
              box.left + 24,
              box.top + box.height / 2,
            );
            const init = {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: "mouse",
            };
            (target ?? node).dispatchEvent(
              new PointerEvent("pointerdown", init),
            );
            (target ?? node).dispatchEvent(new PointerEvent("pointerup", init));
            resolve();
          } else if (performance.now() - startedAt > 3000) {
            reject(new Error("the tile did not mount again"));
          } else {
            requestAnimationFrame(poll);
          }
        };
        requestAnimationFrame(poll);
      }),
    how,
  );

// E9 (ported from chat-scroll-diag-restore-cancel.spec.ts's R2): a click on a
// non-interactive part of a row lands the same task the tile remounts, while
// the restore is still converging. The click must not cancel it.
test("legacy E9[reopen]: detached, reopen, a click on mount during the restore -> kept", async ({
  page,
}) => {
  await open(page, "legacy");
  await withTimeline(page, async () => {
    const before = await detach(page);
    await reopenWithClick(page, "reopen");
    await expectPositionKept(page, before, "after the click on mount");
  });
});
