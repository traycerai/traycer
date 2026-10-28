import { expect, test, type Page } from "@playwright/test";
import {
  expectAtRest,
  expectPositionKept,
  intentOf,
  readView,
  settle,
  startTimeline,
  type ChatScrollView,
  type ReaderIntent,
} from "./support/chat-scroll-oracle";
import { fixture, nextFrames } from "./support/fixtures";

/**
 * The PHONE family of the chat-scroll scenario matrix: the real transcript
 * (`src/__tests__/browser/chat-scroll-model.tsx`) under real CDP touch input
 * at 390x844, in two modes. "chrome" is Chrome's mobile emulation as it is.
 * "ios-like" also withholds `touchmove` from the page once a touch is down
 * and removes `scrollend`, which is what iOS WebKit does once its native pan
 * owns the touch. A failing scenario is a finding about the transcript.
 */

type Mode = "chrome" | "ios-like";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

const STREAM_MS = 50;
const X = 195;

async function load(page: Page, mode: Mode): Promise<() => Promise<string>> {
  if (mode === "ios-like") {
    await page.addInitScript(() => {
      // The patched method delegates to the real one with the same receiver.
      // oxlint-disable-next-line typescript/unbound-method
      const original = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options: boolean | AddEventListenerOptions | undefined,
      ): void {
        if (type === "scrollend") return;
        original.call(this, type, listener, options);
      };
      Object.defineProperty(window, "onscrollend", {
        configurable: true,
        get: () => null,
        set: () => undefined,
      });
      // The page only ever sees `touchstart` and `touchend`; the capture
      // listener goes first, so it runs before the list's own.
      original.call(
        document,
        "touchmove",
        (event: Event) => event.stopImmediatePropagation(),
        { capture: true, passive: true },
      );
    });
  }
  await page.goto(fixture("chat-scroll-model"));
  await nextFrames(page, 30);
  const stopTimeline = await startTimeline(page);
  const view = await expectAtRest(page, { kind: "tail" }, "load");
  expect(view.mode).toBe("following-end");
  return stopTimeline;
}

const startStream = (page: Page): Promise<void> =>
  page.evaluate((ms) => window.__chatScrollProbe.startStream(ms), STREAM_MS);
const stopStream = (page: Page): Promise<void> =>
  page.evaluate(() => window.__chatScrollProbe.stopStream());

/** Stream for `ms`, stop, and check the reader's intent held. */
async function streamThenCheck(
  page: Page,
  intent: ReaderIntent,
  ms: number,
  label: string,
): Promise<ChatScrollView> {
  await startStream(page);
  await page.waitForTimeout(ms);
  await stopStream(page);
  return expectAtRest(page, intent, label);
}

/** One finger from `fromY` to `toY` with a stop before lifting, so there is
 *  no momentum. `gapMs` between moves keeps the velocity low. */
async function slowSwipe(
  page: Page,
  fromY: number,
  toY: number,
  steps: number,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: X, y: fromY }],
    });
    for (let i = 1; i <= steps; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: X, y: fromY + ((toY - fromY) * i) / steps }],
      });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(150);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
}

/** A quick flick that Chrome turns into a fling: 30px every 8ms by event
 *  timestamp, lifted without a stop. The momentum carries on after. */
async function fling(page: Page, moves: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    let t = Date.now() / 1000;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: X, y: 150 }],
      timestamp: t,
    });
    for (let i = 1; i <= moves; i += 1) {
      t += 0.008;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: X, y: 150 + 30 * i }],
        timestamp: t,
      });
    }
    t += 0.004;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
      timestamp: t,
    });
  } finally {
    await cdp.detach();
  }
}

async function tap(page: Page, y: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: X, y }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
}

/** Following, streaming; a slow swipe up detaches; stream stopped; at rest. */
async function detachWhileStreaming(page: Page): Promise<ChatScrollView> {
  await startStream(page);
  await page.waitForTimeout(300);
  await slowSwipe(page, 250, 550, 20);
  await stopStream(page);
  const view = await settle(page, 12);
  expect(view.mode, "a slow swipe up must detach").toBe("free-scrolling");
  return expectAtRest(page, intentOf(view), "detached");
}

/** Run a scenario; on failure append the per-frame timeline to the message. */
function scenario(
  name: string,
  body: (page: Page, mode: Mode) => Promise<void>,
): void {
  for (const mode of ["chrome", "ios-like"] as const) {
    test(`${name} [${mode}]`, async ({ page }) => {
      const stopTimeline = await load(page, mode);
      try {
        await body(page, mode);
      } catch (error) {
        const timeline = (await stopTimeline().catch(() => ""))
          .split("\n")
          .slice(-40)
          .join("\n");
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\n--- timeline (last 40) ---\n${timeline}`);
      }
    });
  }
}

scenario(
  "P1 slow swipe up while following a stream detaches and holds",
  async (page) => {
    await startStream(page);
    await page.waitForTimeout(300);
    await slowSwipe(page, 250, 550, 20);
    // The stream keeps running: the reader's row must not move.
    const during = await readView(page);
    const intent = intentOf(during);
    expect(during.mode).toBe("free-scrolling");
    await page.waitForTimeout(600);
    await stopStream(page);
    await expectAtRest(page, intent, "P1 after stream stop");
    const view = await readView(page);
    expect(view.pill, "pill shown while detached").toBe(true);
  },
);

scenario(
  "P2 fast swipe (fling) while following holds where momentum stopped",
  async (page) => {
    await startStream(page);
    await page.waitForTimeout(300);
    const before = await readView(page);
    await fling(page, 20);
    const a = (await readView(page)).scrollTop;
    await nextFrames(page, 3);
    const b = (await readView(page)).scrollTop;
    expect(a !== b, `momentum was running (${String(a)} -> ${String(b)})`).toBe(
      true,
    );
    await page.waitForTimeout(2500);
    await stopStream(page);
    const view = await settle(page, 12);
    expect(view.scrollTop, "the fling moved the list up").toBeLessThan(
      before.scrollTop - 100,
    );
    const intent = intentOf(view);
    expect(intent.kind, "the fling ended away from the bottom").toBe("at");
    await expectAtRest(page, intent, "P2 at rest");
    await streamThenCheck(page, intent, 600, "P2 stream resumed");
  },
);

scenario("P3 a tap during fling momentum stops it and holds", async (page) => {
  await startStream(page);
  await page.waitForTimeout(300);
  await fling(page, 20);
  const a = (await readView(page)).scrollTop;
  await nextFrames(page, 2);
  const b = (await readView(page)).scrollTop;
  await tap(page, 400);
  const atTap = (await readView(page)).scrollTop;
  await page.waitForTimeout(400);
  const later = (await readView(page)).scrollTop;
  await stopStream(page);
  const view = await settle(page, 12);
  expect(a !== b, `momentum was running (${String(a)} -> ${String(b)})`).toBe(
    true,
  );
  expect(
    Math.abs(later - atTap),
    `list kept moving ${String(Math.abs(later - atTap))}px after the tap`,
  ).toBeLessThanOrEqual(40);
  const intent = intentOf(view);
  expect(intent.kind).toBe("at");
  await expectAtRest(page, intent, "P3 at rest");
  await streamThenCheck(page, intent, 600, "P3 stream resumed");
});

scenario("P4 swiping back to the bottom follows again", async (page) => {
  await detachWhileStreaming(page);
  for (let i = 0; i < 4 && (await settle(page, 12)).fromEnd > 1; i += 1) {
    await slowSwipe(page, 800, 150, 25);
  }
  const view = await expectAtRest(
    page,
    { kind: "tail" },
    "P4 back at the bottom",
  );
  expect(view.mode).toBe("following-end");
  await streamThenCheck(page, { kind: "tail" }, 800, "P4 stream follows");
});

scenario(
  "P5 a Messages pick while following a stream holds the turn",
  async (page) => {
    await startStream(page);
    await page.waitForTimeout(300);
    const items = await page.evaluate(() =>
      window.__chatScrollProbe.pickItems(),
    );
    const target = items.at(3);
    if (target === undefined) throw new Error("no pick item");
    await page.evaluate(() => window.__chatScrollProbe.pick(3));
    await page.waitForTimeout(1200);
    await stopStream(page);
    const intent: ReaderIntent = { kind: "picked", messageId: target };
    await expectAtRest(page, intent, "P5 after pick");
    await streamThenCheck(page, intent, 600, "P5 stream resumed");
  },
);

for (const delayMs of [0, 100, 300]) {
  scenario(
    `P6 swipe up ${String(delayMs)}ms after appendTurn while following holds`,
    async (page) => {
      await startStream(page);
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__chatScrollProbe.appendTurn());
      if (delayMs > 0) await page.waitForTimeout(delayMs);
      await slowSwipe(page, 250, 550, 20);
      const during = await readView(page);
      const intent = intentOf(during);
      expect(during.mode, "the swipe detached").toBe("free-scrolling");
      await page.waitForTimeout(600);
      await stopStream(page);
      await expectAtRest(page, intent, "P6 after stream stop");
    },
  );
}

for (const hide of ["intact", "collapse"] as const) {
  scenario(
    `P7 detached, hide (${hide}) then show keeps the position`,
    async (page) => {
      const before = await detachWhileStreaming(page);
      await page.evaluate((kind) => window.__chatScrollProbe.hide(kind), hide);
      await nextFrames(page, 10);
      await page.evaluate(() => window.__chatScrollProbe.show());
      await expectPositionKept(page, before, `P7 ${hide}`);
    },
  );
}

/** Production's remounts: the tile unmounts in one commit and mounts in a
 *  later one (eviction, close and reopen), or a structural move flushes the
 *  live capture before the key change. A remount in ONE commit with no flush
 *  has no production caller: the new mount would read the saved position
 *  before the old one's unmount saves it. */
const REMOUNTS = [
  { label: "later, same instance", path: "remountLater", same: true },
  { label: "later, new tab", path: "remountLater", same: false },
  { label: "moved", path: "remountMoved", same: true },
] as const;
type Remount = (typeof REMOUNTS)[number];

/** `remountLater` / `remountMoved` ride the probe outside its declared
 *  contract, so they are reached by name. */
async function remountBy(page: Page, remount: Remount): Promise<void> {
  await page.evaluate(
    ({ path, same }) => {
      const probe = window.__chatScrollProbe;
      const method: unknown = Reflect.get(probe, path);
      if (typeof method !== "function")
        throw new Error(`no ${path} on the probe`);
      Reflect.apply(method, probe, path === "remountLater" ? [same] : []);
    },
    { path: remount.path, same: remount.same },
  );
}

for (const remount of REMOUNTS) {
  scenario(
    `P7 detached, remount (${remount.label}) keeps the position`,
    async (page) => {
      const before = await detachWhileStreaming(page);
      const saved = await page.evaluate(() => window.__chatScrollProbe.saved());
      await remountBy(page, remount);
      await nextFrames(page, 20);
      await expectPositionKept(
        page,
        before,
        `P7 remount (saved before: ${JSON.stringify(saved)})`,
      );
    },
  );
}

scenario(
  "P8 the pill returns to the tail and keeps following",
  async (page) => {
    await detachWhileStreaming(page);
    await page.getByLabel("Scroll to end").tap();
    const view = await expectAtRest(
      page,
      { kind: "tail" },
      "P8 after the pill",
    );
    expect(view.mode).toBe("following-end");
    await streamThenCheck(page, { kind: "tail" }, 800, "P8 stream follows");
  },
);

scenario(
  "P9 a tap on the transcript while following is not a departure",
  async (page) => {
    await startStream(page);
    await page.waitForTimeout(300);
    await tap(page, 400);
    await page.waitForTimeout(500);
    const during = await readView(page);
    expect(during.mode, "still following after a tap").toBe("following-end");
    await stopStream(page);
    await expectAtRest(page, { kind: "tail" }, "P9 after the tap");
    await streamThenCheck(page, { kind: "tail" }, 600, "P9 stream follows");
  },
);

// Control for the P7 remounts: the same detach by WHEEL instead of touch, to
// tell a touch-only failure from a remount failure in general.
for (const remount of REMOUNTS) {
  scenario(
    `P7-control wheel-detached, remount (${remount.label}) keeps the position`,
    async (page) => {
      await startStream(page);
      await page.waitForTimeout(300);
      await page.mouse.move(X, 400);
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(200);
      await stopStream(page);
      const before = await settle(page, 12);
      expect(before.mode).toBe("free-scrolling");
      await remountBy(page, remount);
      await nextFrames(page, 20);
      await expectPositionKept(page, before, "P7-control remount");
    },
  );
}
