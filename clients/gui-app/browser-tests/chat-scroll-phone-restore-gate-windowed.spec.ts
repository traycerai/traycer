import { expect, test, type Page } from "@playwright/test";
import { readView, settle, startTimeline } from "./support/chat-scroll-oracle";
import { fixture, nextFrames, wheelsDelivered } from "./support/fixtures";

/**
 * On the windowed line, the saved FREE anchor is in a turn that is not
 * hydrated at the reopen (`remountEvicted`, hydration slowed to 600ms). The
 * reader's finger lands 150ms after the new list exists and drags further into
 * the scrollback; then the anchor's turn hydrates. The view must stay with the
 * reader and not be pulled back to the old anchor. "no-touchmove" withholds
 * every `touchmove` from the transcript, as iOS WebKit does; "control" never
 * touches.
 */

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

const X = 195;

/** Calls a probe method; resolves with its result as JSON. */
async function call(
  page: Page,
  name: string,
  args: unknown[],
): Promise<string> {
  return page.evaluate(
    ({ n, a }) => {
      const probe = window.__chatScrollProbe;
      const method: unknown = Reflect.get(probe, n);
      if (typeof method !== "function") throw new Error(`no ${n}`);
      const result: unknown = Reflect.apply(method, probe, a);
      return String(JSON.stringify(result));
    },
    { n: name, a: args },
  );
}

async function readingOrdinal(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const probe = window.__chatScrollProbe;
    const id = probe.readingRow()?.messageId ?? null;
    return id === null ? null : probe.ordinalOf(id);
  });
}

async function drag(page: Page, fromY: number, toY: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: X, y: fromY }],
    });
    for (let i = 1; i <= 20; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: X, y: fromY + ((toY - fromY) * i) / 20 }],
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

for (const variant of ["plain", "no-touchmove", "control"] as const) {
  test(`windowed: touch-scroll while the saved anchor is cold, then it hydrates [${variant}]`, async ({
    page,
  }) => {
    if (variant === "no-touchmove") {
      await page.addInitScript(() => {
        window.addEventListener(
          "touchmove",
          (event) => event.stopImmediatePropagation(),
          { capture: true, passive: true },
        );
      });
    }
    await page.goto(`${fixture("chat-scroll-model")}?line=windowed`);
    await page.waitForFunction(
      () =>
        "__chatScrollProbe" in window &&
        window.__chatScrollProbe.line() === "windowed",
      undefined,
      { polling: "raf" },
    );
    await nextFrames(page, 30);
    await settle(page, 12);
    const stop = await startTimeline(page);

    // Park deep in the scrollback that was cold at mount.
    await page.mouse.move(X, 400);
    await wheelsDelivered(
      page,
      Array.from({ length: 6 }, () => ({ deltaX: 0, deltaY: -1200 })),
      2,
    );
    await nextFrames(page, 2);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => window.__chatScrollProbe.readingRow()?.placeholder ?? true,
          ),
        { timeout: 8000 },
      )
      .toBe(false);
    const parked = await settle(page, 12);
    expect(parked.mode).toBe("free-scrolling");
    const anchorOrdinal = await readingOrdinal(page);

    const rowCount = await page.evaluate(
      () => window.__chatScrollProbe.hydratedRange()?.rowCount ?? 0,
    );
    await call(page, "setHydrationLatency", [600]);
    await page.evaluate(
      ({ keep }) =>
        new Promise<void>((resolve, reject) => {
          const old = document.querySelector(
            '[data-testid="chat-messages-scroll"]',
          );
          const method: unknown = Reflect.get(
            window.__chatScrollProbe,
            "remountEvicted",
          );
          if (typeof method !== "function") {
            reject(new Error("no remountEvicted"));
            return;
          }
          Reflect.apply(method, window.__chatScrollProbe, [keep]);
          const startedAt = performance.now();
          const poll = (): void => {
            const node = document.querySelector(
              '[data-testid="chat-messages-scroll"]',
            );
            if (node !== null && node !== old) {
              setTimeout(resolve, 150);
            } else if (performance.now() - startedAt > 5000) {
              reject(new Error("no remount"));
            } else {
              requestAnimationFrame(poll);
            }
          };
          requestAnimationFrame(poll);
        }),
      { keep: rowCount - 2 },
    );
    const pendingAtReopen = await call(page, "pendingRestore", []);

    if (variant !== "control") {
      for (let i = 0; i < 4; i += 1) {
        await drag(page, 250, 650);
      }
    }
    const left = await readView(page);
    const leftOrdinal = await readingOrdinal(page);
    const pendingAfterTouch = await call(page, "pendingRestore", []);

    // Let the anchor's turn and the reader's rows hydrate.
    await call(page, "setHydrationLatency", [0]);
    await page.waitForTimeout(3000);
    await nextFrames(page, 20);
    const final = await settle(page, 20);
    const finalOrdinal = await readingOrdinal(page);
    const pendingFinal = await call(page, "pendingRestore", []);

    const summary =
      `anchor ordinal ${String(anchorOrdinal)}; after the drag the reader is at ordinal ${String(leftOrdinal)} ` +
      `(top=${left.scrollTop.toFixed(0)} ${String(left.mode)}); after hydration ordinal ${String(finalOrdinal)} ` +
      `(top=${final.scrollTop.toFixed(0)} ${String(final.mode)})\n` +
      `pendingRestore: at reopen ${pendingAtReopen}; after touch ${pendingAfterTouch}; final ${pendingFinal}`;
    console.warn(`CELL windowed ${variant}\n${summary}`);
    const timeline = (await stop().catch(() => ""))
      .split("\n")
      .slice(-25)
      .join("\n");
    if (variant === "control") return;
    if (anchorOrdinal === null || leftOrdinal === null || finalOrdinal === null)
      throw new Error(
        `no reading row to measure a position from\n${summary}\n--- timeline ---\n${timeline}`,
      );
    expect(leftOrdinal, "the drag moved the reader").not.toBe(anchorOrdinal);
    expect(
      Math.abs(finalOrdinal - leftOrdinal),
      `the view was pulled from the reader's place\n${summary}\n--- timeline ---\n${timeline}`,
    ).toBeLessThanOrEqual(3);
  });
}
