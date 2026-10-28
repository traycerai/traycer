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
 * WINDOWED family of the scroll scenario matrix: the transcript line
 * production renders (`chat-scroll-model.html?line=windowed`), where the
 * scrollback is placeholders the host hydrates as the viewport nears them,
 * and where completions, eviction and remounts turn hydrated rows back into
 * placeholders. Every step asks the model's at-rest questions
 * (`expectAtRest`, `expectPositionKept`); a failure carries the frame
 * timeline and the host's frames.
 */

const SCROLL = '[data-testid="chat-messages-scroll"]';
const TIMELINE_TAIL_LINES = 60;
const FRAME_LOG_TAIL_LINES = 30;

/** Opens the windowed line; resolves with the time the transcript mounted
 *  (the probe is written in its first layout effect). */
async function open(page: Page, query: string): Promise<number> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`${fixture("chat-scroll-model")}?line=windowed${query}`);
  await page.waitForFunction(
    () =>
      "__chatScrollProbe" in window &&
      window.__chatScrollProbe.line() === "windowed",
    undefined,
    { polling: "raf" },
  );
  return Date.now();
}

async function openAtRest(page: Page, query: string): Promise<void> {
  await open(page, query);
  await nextFrames(page, 30);
  const view = await settle(page, 12);
  expect(view.mode, "mounted following the tail").toBe("following-end");
}

async function withTimeline(
  page: Page,
  body: () => Promise<void>,
): Promise<void> {
  const stop = await startTimeline(page);
  try {
    await body();
  } catch (error) {
    const lines = (await stop()).split("\n").slice(-TIMELINE_TAIL_LINES);
    const frames = (
      await page.evaluate(() => window.__chatScrollProbe.frameLog())
    ).slice(-FRAME_LOG_TAIL_LINES);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\n  TIMELINE (last ${String(lines.length)} changes)\n${lines.join("\n")}` +
        `\n  HOST FRAMES (last ${String(frames.length)})\n${frames.join("\n")}`,
    );
  }
}

async function pointAtTranscript(page: Page): Promise<void> {
  const box = await page.locator(SCROLL).boundingBox();
  if (box === null) throw new Error("no scroll node");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function wheel(page: Page, deltaY: number): Promise<void> {
  await page.mouse.wheel(0, deltaY);
}

/** A trackpad flick DOWN: 40 notches of 40px, one per frame, then a
 *  decaying momentum tail. */
async function wheelDownBurst(page: Page): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    await wheel(page, 40);
    await nextFrames(page, 1);
  }
  for (const delta of [30, 20, 12, 6, 3, 2, 1]) {
    await wheel(page, delta);
    await nextFrames(page, 1);
  }
}

/** Waits until the row at the top of the viewport is hydrated, then rests. */
async function restHydrated(page: Page): Promise<ChatScrollView> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__chatScrollProbe.readingRow()?.placeholder ?? true,
        ),
      { message: "the reading row hydrates", timeout: 8_000 },
    )
    .toBe(false);
  return settle(page, 12);
}

/** Wheels far up into the scrollback that was cold at mount. */
async function parkInCold(page: Page, steps: number): Promise<ChatScrollView> {
  await pointAtTranscript(page);
  for (let step = 0; step < steps; step += 1) {
    await wheel(page, -1200);
    await nextFrames(page, 2);
  }
  const view = await restHydrated(page);
  expect(view.mode).toBe("free-scrolling");
  return view;
}

function intentFrom(view: ChatScrollView): ReaderIntent {
  const intent = intentOf(view);
  expect(intent.kind, "the reader is parked away from the tail").toBe("at");
  return intent;
}

async function readingOrdinal(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const probe = window.__chatScrollProbe;
    const id = probe.readingRow()?.messageId ?? null;
    return id === null ? null : probe.ordinalOf(id);
  });
}

async function pickItem(page: Page, index: number): Promise<ReaderIntent> {
  const items = await page.evaluate(() => window.__chatScrollProbe.pickItems());
  const messageId = items.at(index);
  if (messageId === undefined) throw new Error(`no pick item ${String(index)}`);
  await page.evaluate((i) => window.__chatScrollProbe.pick(i), index);
  return { kind: "picked", messageId };
}

/** `remountLater` / `remountMoved` ride the probe outside its declared
 *  contract (both lines add them), so they are reached by name. */
async function remountVia(
  page: Page,
  path: "remountLater" | "remountMoved",
): Promise<void> {
  await page.evaluate((name) => {
    const probe = window.__chatScrollProbe;
    const method: unknown = Reflect.get(probe, name);
    if (typeof method !== "function")
      throw new Error(`no ${name} on the probe`);
    Reflect.apply(method, probe, name === "remountLater" ? [true] : []);
  }, path);
}

/** Records, per painted frame, whether `messageId` is a placeholder. */
async function watchPlaceholder(
  page: Page,
  messageId: string,
): Promise<() => Promise<number>> {
  await page.evaluate((id) => {
    let frames = 0;
    let running = true;
    const tick = (): void => {
      if (!running) return;
      if (window.__chatScrollProbe.isPlaceholder(id) === true) frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    Reflect.set(window, "__placeholderWatchStop", () => {
      running = false;
      return frames;
    });
  }, messageId);
  return () =>
    page.evaluate(() => {
      const stop: unknown = Reflect.get(window, "__placeholderWatchStop");
      if (typeof stop !== "function") return -1;
      const frames: unknown = Reflect.apply(stop, window, []);
      return typeof frames === "number" ? frames : -1;
    });
}

test.describe("W1: a reader parked in the cold region through a re-estimate", () => {
  test("a send ~1s after mount holds the reading row", async ({ page }) => {
    const startedAt = await open(page, "");
    await nextFrames(page, 5);
    const parked = await parkInCold(page, 12);
    const intent = intentFrom(parked);
    const elapsed = Date.now() - startedAt;
    test.info().annotations.push({
      type: "send after mount",
      description: `${String(elapsed)}ms`,
    });
    await withTimeline(page, async () => {
      await page.evaluate(() => {
        window.__chatScrollProbe.send("A prompt from the scrollback");
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => window.__chatScrollProbe.hostAccept());
      await expectAtRest(
        page,
        intent,
        `W1 send ${String(elapsed)}ms after mount`,
      );
    });
  });

  test("a same-instance remount (remountLater) holds the reading row", async ({
    page,
  }) => {
    await openAtRest(page, "");
    const parked = await parkInCold(page, 40);
    await withTimeline(page, async () => {
      await remountVia(page, "remountLater");
      await page.waitForTimeout(500);
      await expectPositionKept(page, parked, "W1 remountLater(true)");
    });
  });

  test("evictCold holds the reading row", async ({ page }) => {
    await openAtRest(page, "");
    const intent = intentFrom(await parkInCold(page, 40));
    await withTimeline(page, async () => {
      await page.evaluate(() => window.__chatScrollProbe.evictCold());
      await page.waitForTimeout(500);
      await expectAtRest(page, intent, "W1 evictCold");
    });
  });
});

test.describe("W2: a reader parked on rows a completion snapshot dehydrates", () => {
  test("the turn ends and the reading row is held", async ({ page }) => {
    await openAtRest(page, "");
    await pointAtTranscript(page);
    // Up into the tail the bootstrap snapshot hydrated, above its last turns.
    for (let step = 0; step < 60; step += 1) {
      const ordinal = await readingOrdinal(page);
      if (ordinal !== null && ordinal <= 311) break;
      await wheel(page, -300);
      await nextFrames(page, 2);
    }
    const parked = await restHydrated(page);
    const intent = intentFrom(parked);
    if (intent.kind !== "at") throw new Error("not parked");
    const ordinal = await readingOrdinal(page);
    await withTimeline(page, async () => {
      await page.evaluate(() =>
        window.__chatScrollProbe.startParagraphStream(100),
      );
      await page.waitForTimeout(1_500);
      await page.evaluate(() => window.__chatScrollProbe.stopStream());
      await expectAtRest(
        page,
        intent,
        `W2 after the stream (ordinal ${String(ordinal)})`,
      );
      const stopWatch = await watchPlaceholder(page, intent.messageId);
      await page.evaluate(() => window.__chatScrollProbe.finishTurn());
      await page.waitForTimeout(600);
      const placeholderFrames = await stopWatch();
      test.info().annotations.push({
        type: "reading row placeholder frames",
        description: `ordinal ${String(ordinal)}: ${String(placeholderFrames)}`,
      });
      const state = await page.evaluate(() =>
        window.__chatScrollProbe.windowState(),
      );
      await expectAtRest(
        page,
        intent,
        `W2 turn ended (ordinal ${String(ordinal)} was a placeholder for ${String(placeholderFrames)} frames; spans ${JSON.stringify(state?.spans)})`,
      );
    });
  });
});

test.describe("W3: evictCold while the reader is parked", () => {
  for (const latency of [120, 800]) {
    test(`at ${String(latency)}ms latency the reading row is held`, async ({
      page,
    }) => {
      await openAtRest(page, "");
      const intent = intentFrom(await parkInCold(page, 40));
      await page.evaluate(
        (ms) => window.__chatScrollProbe.setHydrationLatency(ms),
        latency,
      );
      await withTimeline(page, async () => {
        await page.evaluate(() => window.__chatScrollProbe.evictCold());
        await page.waitForTimeout(latency + 500);
        await expectAtRest(
          page,
          intent,
          `W3 evictCold at ${String(latency)}ms`,
        );
      });
    });
  }
});

test.describe("W4: minimap picks into cold turns", () => {
  test("idle", async ({ page }) => {
    await openAtRest(page, "");
    await withTimeline(page, async () => {
      for (const index of [20, 60, 120]) {
        const intent = await pickItem(page, index);
        await expectAtRest(page, intent, `W4 idle pick ${String(index)}`);
      }
    });
  });

  test("while streaming", async ({ page }) => {
    await openAtRest(page, "");
    await withTimeline(page, async () => {
      await page.evaluate(() => window.__chatScrollProbe.startStream(50));
      await page.waitForTimeout(300);
      const intent = await pickItem(page, 30);
      await page.waitForTimeout(1_000);
      await page.evaluate(() => window.__chatScrollProbe.stopStream());
      await expectAtRest(page, intent, "W4 pick 30 while streaming");
    });
  });

  test("within 1s of mount", async ({ page }) => {
    const startedAt = await open(page, "");
    await expect
      .poll(
        () => page.evaluate(() => window.__chatScrollProbe.pickItems().length),
        {
          timeout: 5_000,
        },
      )
      .toBeGreaterThan(100);
    await nextFrames(page, 5);
    await withTimeline(page, async () => {
      const elapsed = Date.now() - startedAt;
      test.info().annotations.push({
        type: "pick after mount",
        description: `${String(elapsed)}ms`,
      });
      const intent = await pickItem(page, 40);
      await expectAtRest(
        page,
        intent,
        `W4 pick 40 ${String(elapsed)}ms after mount`,
      );
    });
  });

  test("two quick picks", async ({ page }) => {
    await openAtRest(page, "");
    await withTimeline(page, async () => {
      await pickItem(page, 20);
      await nextFrames(page, 1);
      const intent = await pickItem(page, 90);
      await expectAtRest(page, intent, "W4 pick 20 then 90 a frame later");
    });
  });

  test("a pick then evictCold", async ({ page }) => {
    await openAtRest(page, "");
    await withTimeline(page, async () => {
      const intent = await pickItem(page, 50);
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__chatScrollProbe.evictCold());
      await expectAtRest(page, intent, "W4 pick 50 then evictCold");
    });
  });
});

test.describe("W5: the position family on the windowed line", () => {
  const steps: ReadonlyArray<{
    readonly name: string;
    readonly act: (page: Page) => Promise<void>;
  }> = [
    {
      name: "hide intact → show",
      act: async (page) => {
        await page.evaluate(() => window.__chatScrollProbe.hide("intact"));
        await nextFrames(page, 10);
        await page.evaluate(() => window.__chatScrollProbe.show());
      },
    },
    {
      name: "hide collapse → show",
      act: async (page) => {
        await page.evaluate(() => window.__chatScrollProbe.hide("collapse"));
        await nextFrames(page, 10);
        await page.evaluate(() => window.__chatScrollProbe.show());
      },
    },
    {
      name: "remountLater(true)",
      act: (page) => remountVia(page, "remountLater"),
    },
    { name: "remountMoved()", act: (page) => remountVia(page, "remountMoved") },
  ];
  for (const step of steps) {
    test(`${step.name} keeps the position`, async ({ page }) => {
      await openAtRest(page, "");
      const parked = await parkInCold(page, 40);
      await withTimeline(page, async () => {
        await step.act(page);
        await page.waitForTimeout(500);
        await expectPositionKept(page, parked, `W5 ${step.name}`);
      });
    });
  }
});

test.describe("W6: a send at the bottom with the dock changing and a wheel-down burst", () => {
  for (const delayMs of [16, 100, 200]) {
    test(`burst ${String(delayMs)}ms after Enter: still following at rest`, async ({
      page,
    }) => {
      await openAtRest(page, "");
      await page.evaluate(() => window.__chatScrollProbe.typeDraft(8));
      await expectAtRest(page, { kind: "tail" }, "W6 the draft grew the dock");
      await pointAtTranscript(page);
      await withTimeline(page, async () => {
        // Enter, and the host's answer on its own clock in the page.
        await page.evaluate(() => {
          const probe = window.__chatScrollProbe;
          probe.send("A new prompt\n\nwith a second paragraph");
          window.setTimeout(() => probe.hostAccept(), 150);
          window.setTimeout(() => probe.assistantStarts(), 300);
          window.setTimeout(() => probe.startParagraphStream(100), 400);
          window.setTimeout(() => probe.stopStream(), 2_400);
        });
        const sentAt = Date.now();
        await page.waitForTimeout(delayMs);
        await wheelDownBurst(page);
        await page.waitForTimeout(Math.max(0, 2_600 - (Date.now() - sentAt)));
        const view = await readView(page);
        await expectAtRest(
          page,
          { kind: "tail" },
          `W6 burst ${String(delayMs)}ms after Enter (mode at stream end: ${String(view.mode)})`,
        );
      });
    });
  }
});

test.describe("W6 control: the same burst into a stream, with no send", () => {
  test("burst into a growing reply: still following at rest", async ({
    page,
  }) => {
    await openAtRest(page, "");
    await pointAtTranscript(page);
    await withTimeline(page, async () => {
      await page.evaluate(() => {
        const probe = window.__chatScrollProbe;
        probe.startParagraphStream(100);
        window.setTimeout(() => probe.stopStream(), 2_000);
      });
      const startedAt = Date.now();
      await page.waitForTimeout(16);
      await wheelDownBurst(page);
      await page.waitForTimeout(Math.max(0, 2_200 - (Date.now() - startedAt)));
      await expectAtRest(
        page,
        { kind: "tail" },
        "W6 control: burst into a stream, no send",
      );
    });
  });
});

test.describe("W7: a following reader at the tail while the skeleton streams in", () => {
  for (const chunkMs of [0, 100]) {
    test(`skeleton chunks ${String(chunkMs)}ms apart: the tail is held for 5s`, async ({
      page,
    }) => {
      await open(page, `&skeletonChunkMs=${String(chunkMs)}`);
      await withTimeline(page, async () => {
        const flips = await page.evaluate(
          () =>
            new Promise<string[]>((resolve) => {
              const seen: string[] = [];
              const startedAt = performance.now();
              const tick = (): void => {
                const probe = window.__chatScrollProbe;
                const g = probe.geometry();
                const mode = probe.mode();
                if (g !== null && mode !== "following-end") {
                  const fromEnd = g.scrollHeight - g.clientHeight - g.scrollTop;
                  seen.push(
                    `${(performance.now() - startedAt).toFixed(0)}ms mode=${String(mode)} fromEnd=${fromEnd.toFixed(0)}`,
                  );
                }
                if (performance.now() - startedAt < 5_000)
                  requestAnimationFrame(tick);
                else resolve(seen);
              };
              requestAnimationFrame(tick);
            }),
        );
        const view = await expectAtRest(
          page,
          { kind: "tail" },
          `W7 chunks ${String(chunkMs)}ms`,
        );
        expect(
          flips,
          `W7 the follow mode flipped while at the tail (fromEnd at rest ${view.fromEnd.toFixed(1)})`,
        ).toEqual([]);
      });
    });
  }
});
