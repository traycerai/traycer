import { expect, test, type Page } from "@playwright/test";
import {
  expectAtRest,
  intentOf,
  readView,
  settle,
  startTimeline,
  type ChatScrollView,
} from "./support/chat-scroll-oracle";
import { fixture, nextFrames, wheelsDelivered } from "./support/fixtures";

/**
 * A free reader's touch lands while a remount's saved-position restore is
 * still in flight. Each cell reopens the tile with a saved FREE position
 * (`remountLater`, production's unmount-then-mount path), puts a finger down
 * `when` after the new scroll node exists, and drags. "plain" is Chrome's touch
 * sequence; "no-touchmove" is iOS WebKit's: a capturing window listener stops
 * every `touchmove` before it reaches the transcript.
 *
 * (a) the touch scroll must be what the reader sees after hide/show and after
 * another remount; (b) a drag to the strict bottom must resume following, and
 * a streamed reply must be followed; (c) is the `when` axis of both.
 */

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

type Suppression = "plain" | "no-touchmove";
type When = "same-task" | "1-frame" | "50ms" | "150ms" | "500ms";
const WHENS: readonly When[] = [
  "same-task",
  "1-frame",
  "50ms",
  "150ms",
  "500ms",
];
const X = 195;

async function load(page: Page, suppression: Suppression): Promise<void> {
  if (suppression === "no-touchmove") {
    await page.addInitScript(() => {
      window.addEventListener(
        "touchmove",
        (event) => event.stopImmediatePropagation(),
        { capture: true, passive: true },
      );
    });
  }
  await page.goto(fixture("chat-scroll-model"));
  await nextFrames(page, 30);
}

/** Free position well away from the tail, at rest. */
async function parkFree(page: Page): Promise<ChatScrollView> {
  await page.mouse.move(X, 400);
  await wheelsDelivered(
    page,
    Array.from({ length: 4 }, () => ({ deltaX: 0, deltaY: -500 })),
    2,
  );
  await nextFrames(page, 2);
  const view = await settle(page, 12);
  expect(view.mode, "parked away from the tail").toBe("free-scrolling");
  return view;
}

/**
 * Starts `remountLater(true)` and resolves at `when` after the first frame
 * the new scroll node exists. `same-task` and `1-frame` put a pointerdown and
 * touchstart on the new list at that instant (a real CDP touch cannot land
 * that early); the real drag follows.
 */
function reopen(page: Page, when: When): Promise<void> {
  return page.evaluate(
    (w) =>
      new Promise<void>((resolve, reject) => {
        const selector = '[data-testid="chat-messages-scroll"]';
        const old = document.querySelector(selector);
        const press = (): void => {
          const target = document.elementFromPoint(195, 400);
          if (target === null) return;
          target.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              pointerId: 7,
              pointerType: "touch",
              isPrimary: true,
              clientX: 195,
              clientY: 400,
            }),
          );
          const touch = new Touch({
            identifier: 7,
            target,
            clientX: 195,
            clientY: 400,
          });
          Reflect.set(window, "__synthRelease", () => {
            target.dispatchEvent(
              new TouchEvent("touchend", {
                bubbles: true,
                cancelable: true,
                touches: [],
                targetTouches: [],
                changedTouches: [touch],
              }),
            );
            target.dispatchEvent(
              new PointerEvent("pointerup", {
                bubbles: true,
                cancelable: true,
                pointerId: 7,
                pointerType: "touch",
                isPrimary: true,
                clientX: 195,
                clientY: 400,
              }),
            );
          });
          target.dispatchEvent(
            new TouchEvent("touchstart", {
              bubbles: true,
              cancelable: true,
              touches: [touch],
              targetTouches: [touch],
              changedTouches: [touch],
            }),
          );
        };
        const method: unknown = Reflect.get(
          window.__chatScrollProbe,
          "remountLater",
        );
        if (typeof method !== "function") {
          reject(new Error("probe has no remountLater"));
          return;
        }
        Reflect.apply(method, window.__chatScrollProbe, [true]);
        const startedAt = performance.now();
        const poll = (): void => {
          const node = document.querySelector(selector);
          if (node === null || node === old) {
            if (performance.now() - startedAt > 5000)
              reject(new Error("no remount"));
            else requestAnimationFrame(poll);
            return;
          }
          if (w === "same-task") {
            press();
            resolve();
          } else if (w === "1-frame") {
            requestAnimationFrame(() => {
              press();
              resolve();
            });
          } else {
            const delays = { "50ms": 50, "150ms": 150, "500ms": 500 };
            setTimeout(resolve, delays[w]);
          }
        };
        requestAnimationFrame(poll);
      }),
    when,
  );
}

/** Lifts the synthetic finger that `reopen` put down (same-task, 1-frame). */
function releaseSynthetic(page: Page): Promise<void> {
  return page.evaluate(() => {
    const release: unknown = Reflect.get(window, "__synthRelease");
    if (typeof release === "function") Reflect.apply(release, window, []);
  });
}

/** One finger from `fromY` to `toY`, stopping before it lifts. */
async function drag(page: Page, fromY: number, toY: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: X, y: fromY }],
    });
    const steps = 20;
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

function line(view: ChatScrollView): string {
  const r = view.reading;
  return (
    `top=${view.scrollTop.toFixed(0)} fromEnd=${view.fromEnd.toFixed(0)} ${String(view.mode)} ` +
    `pill=${String(view.pill)} reading=${String(r?.messageId)}@${(r?.offset ?? 0).toFixed(0)}`
  );
}

async function soft(
  problems: string[],
  label: string,
  check: () => Promise<unknown>,
): Promise<void> {
  try {
    await check();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    problems.push(`${label}: ${text.split("\n").slice(0, 4).join(" | ")}`);
  }
}

for (const suppression of ["plain", "no-touchmove"] as const) {
  for (const when of WHENS) {
    test(`(a) touch-scroll after reopen [${suppression}, ${when}]: hide/show and remount keep the new position`, async ({
      page,
    }) => {
      await load(page, suppression);
      const stop = await startTimeline(page);
      const parked = await parkFree(page);
      await reopen(page, when);
      const restored = await settle(page, 12);
      // The finger drags content toward the start of the chat.
      await drag(page, 250, 650);
      await releaseSynthetic(page);
      const left = await settle(page, 12);
      const saved = await page.evaluate(() => window.__chatScrollProbe.saved());
      const problems: string[] = [];
      if (left.scrollTop >= restored.scrollTop - 100) {
        problems.push(
          `the drag did not scroll: restored ${line(restored)} -> ${line(left)}`,
        );
      }
      const intent = intentOf(left);
      await soft(problems, "after the drag", () =>
        expectAtRest(page, intent, "after drag"),
      );

      await page.evaluate(() => window.__chatScrollProbe.hide("intact"));
      await nextFrames(page, 10);
      await page.evaluate(() => window.__chatScrollProbe.show());
      await soft(problems, "after hide/show", () =>
        expectAtRest(page, intent, "hide/show"),
      );

      await page.evaluate(() => {
        const method: unknown = Reflect.get(
          window.__chatScrollProbe,
          "remountLater",
        );
        if (typeof method === "function")
          Reflect.apply(method, window.__chatScrollProbe, [true]);
      });
      await page.waitForTimeout(900);
      const back = await settle(page, 12);
      await soft(problems, "after remount", () =>
        expectAtRest(page, intent, "remount"),
      );

      const timeline = (await stop().catch(() => ""))
        .split("\n")
        .slice(-25)
        .join("\n");
      const summary =
        `parked   ${line(parked)}\nrestored ${line(restored)}\nleft     ${line(left)}\n` +
        `saved    ${JSON.stringify(saved)}\nback     ${line(back)}`;
      console.warn(
        `CELL a ${suppression} ${when} ${problems.length === 0 ? "OK" : "FAIL"}\n${summary}`,
      );
      expect(problems, `${summary}\n--- timeline ---\n${timeline}`).toEqual([]);
    });
  }
}

for (const suppression of ["plain", "no-touchmove"] as const) {
  for (const when of WHENS) {
    test(`(b) drag to the bottom after reopen [${suppression}, ${when}]: following again, a streamed reply is followed`, async ({
      page,
    }) => {
      await load(page, suppression);
      const stop = await startTimeline(page);
      const parked = await parkFree(page);
      await reopen(page, when);
      await settle(page, 12);
      // Content toward the tail: the finger moves up.
      for (let i = 0; i < 40 && (await readView(page)).fromEnd > 1; i += 1) {
        await drag(page, 800, 150);
        await releaseSynthetic(page);
        await settle(page, 12);
      }
      const atBottom = await settle(page, 12);
      const problems: string[] = [];
      if (atBottom.fromEnd > 1)
        problems.push(`never reached the bottom: ${line(atBottom)}`);
      await soft(problems, "at the bottom", () =>
        expectAtRest(page, { kind: "tail" }, "bottom"),
      );
      if (atBottom.mode !== "following-end") {
        problems.push(
          `mode ${String(atBottom.mode)}, pill ${String(atBottom.pill)} at the strict bottom`,
        );
      }
      await page.evaluate(() => {
        window.__chatScrollProbe.appendTurn();
        window.__chatScrollProbe.startStream(50);
      });
      await page.waitForTimeout(700);
      await page.evaluate(() => window.__chatScrollProbe.stopStream());
      const after = await settle(page, 12);
      await soft(problems, "reply followed", () =>
        expectAtRest(page, { kind: "tail" }, "stream"),
      );

      const timeline = (await stop().catch(() => ""))
        .split("\n")
        .slice(-25)
        .join("\n");
      const summary = `parked ${line(parked)}\nbottom ${line(atBottom)}\nafter  ${line(after)}`;
      console.warn(
        `CELL b ${suppression} ${when} ${problems.length === 0 ? "OK" : "FAIL"}\n${summary}`,
      );
      expect(problems, `${summary}\n--- timeline ---\n${timeline}`).toEqual([]);
    });
  }
}
