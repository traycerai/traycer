import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames, wheelsDelivered } from "./support/fixtures";
import {
  expectAtRest,
  intentOf,
  readView,
  settle,
  startTimeline,
  type ReaderIntent,
} from "./support/chat-scroll-oracle";

/**
 * The NAVIGATION family of the chat-scroll scenario matrix: turn picks (the
 * turn rail, the phone's Messages list), the scroll-to-end pill and the
 * keyboard, against `src/__tests__/browser/chat-scroll-model.tsx`. Every
 * scenario stops any stream and asks the oracle's at-rest questions after
 * each step; the first block below is the streaming pick (C2), which also
 * asserts the row holds the reading line WHILE the stream runs.
 */

const READING_LINE_PX = 48;
const TOLERANCE_PX = 8;
const LAND_WITHIN_MS = 2000;
const HOLD_MS = 2000;

interface Sample {
  readonly t: number;
  readonly scrollTop: number;
  readonly distanceFromEnd: number;
  readonly mode: string | null;
  readonly rowTop: number | null;
}

declare global {
  interface Window {
    __samples?: Sample[];
    __stopSampling?: () => void;
  }
}

/** Page-side sampler, one row every 4 frames, started at the pick. */
async function startSampling(page: Page, messageId: string): Promise<void> {
  await page.evaluate((id) => {
    const samples: Sample[] = [];
    const t0 = performance.now();
    let frame = 0;
    let running = true;
    const tick = (): void => {
      if (!running) return;
      frame += 1;
      if (frame % 4 === 0) {
        const probe = window.__chatScrollProbe;
        const g = probe.geometry();
        samples.push({
          t: Math.round(performance.now() - t0),
          scrollTop: Math.round(g?.scrollTop ?? -1),
          distanceFromEnd: Math.round(
            g === null ? -1 : g.scrollHeight - g.scrollTop - g.clientHeight,
          ),
          mode: probe.mode(),
          rowTop: ((v) => (v === null ? null : Math.round(v)))(
            probe.rowTop(id),
          ),
        });
      }
      requestAnimationFrame(tick);
    };
    window.__samples = samples;
    window.__stopSampling = () => {
      running = false;
    };
    requestAnimationFrame(tick);
  }, messageId);
}

function timeline(samples: readonly Sample[]): string {
  return samples
    .map(
      (s) =>
        `t=${String(s.t).padStart(5)}ms top=${String(s.scrollTop).padStart(5)} fromEnd=${String(s.distanceFromEnd).padStart(5)} mode=${s.mode ?? "null"} rowTop=${s.rowTop === null ? "unmounted" : String(s.rowTop)}`,
    )
    .join("\n");
}

test.use({ viewport: { width: 390, height: 700 } });

for (const intervalMs of [40, 16, 100]) {
  test(`a turn pick while a reply streams at ${String(intervalMs)}ms lands on the turn and stays`, async ({
    page,
  }) => {
    await page.goto(fixture("chat-scroll-model"));
    await nextFrames(page, 30);
    await expect
      .poll(() => page.evaluate(() => window.__chatScrollProbe.mode()))
      .toBe("following-end");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const g = window.__chatScrollProbe.geometry();
          return g === null
            ? 999
            : g.scrollHeight - g.scrollTop - g.clientHeight;
        }),
      )
      .toBeLessThanOrEqual(1);

    const items = await page.evaluate(() =>
      window.__chatScrollProbe.pickItems(),
    );
    const pickIndex = 2;
    const target = items.at(pickIndex);
    if (target === undefined) throw new Error("outline has fewer than 3 turns");

    await page.evaluate(
      (ms) => window.__chatScrollProbe.startStream(ms),
      intervalMs,
    );
    await page.waitForTimeout(500);

    await startSampling(page, target);
    await page.evaluate((i) => window.__chatScrollProbe.pick(i), pickIndex);

    // Landing: the picked row reaches the reading line within 2s.
    const landed = await page
      .waitForFunction(
        ([id, line, tol]) => {
          const top = window.__chatScrollProbe.rowTop(id);
          return (
            top !== null && Math.abs(top - (line as number)) <= (tol as number)
          );
        },
        [target, READING_LINE_PX, TOLERANCE_PX] as const,
        { timeout: LAND_WITHIN_MS, polling: "raf" },
      )
      .then(
        () => true,
        () => false,
      );

    // Hold: it stays there while the stream continues.
    await page.waitForTimeout(HOLD_MS);

    const final = await page.evaluate((id) => {
      window.__stopSampling?.();
      const probe = window.__chatScrollProbe;
      probe.stopStream();
      return {
        samples: window.__samples ?? [],
        rowTop: probe.rowTop(id),
        mode: probe.mode(),
        pill: probe.pillShown(),
      };
    }, target);

    const report = `landed=${String(landed)} finalRowTop=${String(final.rowTop)} mode=${final.mode ?? "null"} pill=${String(final.pill)}\n${timeline(final.samples)}`;

    expect(landed, `never reached the reading line\n${report}`).toBe(true);
    expect(final.rowTop, `left the reading line\n${report}`).not.toBeNull();
    expect(
      Math.abs((final.rowTop ?? 9999) - READING_LINE_PX),
      `left the reading line\n${report}`,
    ).toBeLessThanOrEqual(TOLERANCE_PX);
    const drifted = final.samples.filter(
      (s) =>
        s.t > 0 &&
        (s.rowTop === null ||
          Math.abs(s.rowTop - READING_LINE_PX) > TOLERANCE_PX) &&
        s.t > LAND_WITHIN_MS,
    );
    expect(drifted, `drifted off the line after landing\n${report}`).toEqual(
      [],
    );
    expect(final.mode, `mode\n${report}`).toBe("free-scrolling");
    expect(final.pill, `pill\n${report}`).toBe(true);
  });
}

/**
 * The pick lands right after a commit that changes the sequence of row keys
 * (a new turn), which is what puts LegendList in "settling after a data
 * change" and defers `scrollToIndex`. The stream keeps changing sizes under
 * that window.
 */
const STREAM_MODES = [
  { name: "text", start: "startStream", intervalMs: 40, turnEveryMs: null },
  {
    name: "paragraphs + a turn every 400ms",
    start: "startParagraphStream",
    intervalMs: 100,
    turnEveryMs: 400,
  },
] as const;

for (const mode of STREAM_MODES) {
  for (const delayMs of [0, 100, 300]) {
    test(`a turn pick ${String(delayMs)}ms after a new turn (${mode.name}) lands on the turn and stays`, async ({
      page,
    }) => {
      await page.goto(fixture("chat-scroll-model"));
      await nextFrames(page, 30);
      await expect
        .poll(() => page.evaluate(() => window.__chatScrollProbe.mode()))
        .toBe("following-end");

      const target = (
        await page.evaluate(() => window.__chatScrollProbe.pickItems())
      ).at(2);
      if (target === undefined)
        throw new Error("outline has fewer than 3 turns");

      await page.evaluate(
        ([start, ms, turnEveryMs]) => {
          const probe = window.__chatScrollProbe;
          if (start === "startStream") probe.startStream(ms);
          else probe.startParagraphStream(ms);
          if (turnEveryMs !== null) {
            window.setInterval(() => probe.appendTurn(), turnEveryMs);
          }
        },
        [mode.start, mode.intervalMs, mode.turnEveryMs] as const,
      );
      await page.waitForTimeout(500);

      await page.evaluate(() => window.__chatScrollProbe.appendTurn());
      await page.waitForTimeout(delayMs);
      await startSampling(page, target);
      await page.evaluate(() => window.__chatScrollProbe.pick(2));

      const landed = await page
        .waitForFunction(
          ([id, line, tol]) => {
            const top = window.__chatScrollProbe.rowTop(id);
            return (
              top !== null &&
              Math.abs(top - (line as number)) <= (tol as number)
            );
          },
          [target, READING_LINE_PX, TOLERANCE_PX] as const,
          { timeout: LAND_WITHIN_MS, polling: "raf" },
        )
        .then(
          () => true,
          () => false,
        );
      await page.waitForTimeout(HOLD_MS);

      const final = await page.evaluate((id) => {
        window.__stopSampling?.();
        const probe = window.__chatScrollProbe;
        probe.stopStream();
        return {
          samples: window.__samples ?? [],
          rowTop: probe.rowTop(id),
          mode: probe.mode(),
          pill: probe.pillShown(),
        };
      }, target);

      const report = `landed=${String(landed)} finalRowTop=${String(final.rowTop)} mode=${final.mode ?? "null"} pill=${String(final.pill)}\n${timeline(final.samples)}`;
      expect(landed, `never reached the reading line\n${report}`).toBe(true);
      expect(final.rowTop, `left the reading line\n${report}`).not.toBeNull();
      expect(
        Math.abs((final.rowTop ?? 9999) - READING_LINE_PX),
        `left the reading line\n${report}`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(final.mode, `mode\n${report}`).toBe("free-scrolling");
      expect(final.pill, `pill\n${report}`).toBe(true);
    });
  }
}

// ---------------------------------------------------------------------------
// The rest of the family: each step ends in the oracle's at-rest questions.
// ---------------------------------------------------------------------------

const STREAM_MS = 40;

async function load(page: Page): Promise<void> {
  await page.goto(fixture("chat-scroll-model"));
  await nextFrames(page, 30);
  await expect
    .poll(() => page.evaluate(() => window.__chatScrollProbe.mode()))
    .toBe("following-end");
  await expectAtRest(page, { kind: "tail" }, "initial");
}

/** A scenario: loads the fixture, records a frame timeline, and appends its
 *  tail to a failure. */
function scenario(name: string, run: (page: Page) => Promise<void>): void {
  test(name, async ({ page }) => {
    await load(page);
    const stop = await startTimeline(page);
    try {
      await run(page);
    } catch (error) {
      const timeline = (await stop()).split("\n").slice(-70).join("\n");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n--- frame timeline (last 70 changes) ---\n${timeline}`,
      );
    }
  });
}

const stopStream = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.__chatScrollProbe.stopStream();
  });
const startStream = (page: Page): Promise<void> =>
  page.evaluate((ms) => {
    window.__chatScrollProbe.startStream(ms);
  }, STREAM_MS);
const appendTurn = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.__chatScrollProbe.appendTurn();
  });
const pickItems = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__chatScrollProbe.pickItems());
const pick = (page: Page, index: number): Promise<void> =>
  page.evaluate((i) => {
    window.__chatScrollProbe.pick(i);
  }, index);

async function idOf(page: Page, index: number): Promise<string> {
  const id = (await pickItems(page)).at(index);
  if (id === undefined) throw new Error(`outline has no turn ${String(index)}`);
  return id;
}

/** Streams for `ms`, then stops: the step that proves a position is held. */
async function streamFor(page: Page, ms: number): Promise<void> {
  await startStream(page);
  await page.waitForTimeout(ms);
  await stopStream(page);
}

/** Wheels by `dy` in 600px notches two frames apart, and returns once the
 *  page has received them all. */
async function wheel(page: Page, dy: number): Promise<void> {
  await page.mouse.move(195, 350);
  const step = Math.sign(dy) * 600;
  await wheelsDelivered(
    page,
    Array.from({ length: Math.ceil(Math.abs(dy) / 600) }, () => ({
      deltaX: 0,
      deltaY: step,
    })),
    2,
  );
  await nextFrames(page, 2);
}

/** Wheels up from the tail until mid-transcript and returns the reader's
 *  intent there. */
async function detachMidTranscript(page: Page): Promise<ReaderIntent> {
  await wheel(page, -7200);
  const view = await settle(page, 12);
  const intent = intentOf(view);
  await expectAtRest(page, intent, "after the wheel up");
  return intent;
}

const pillClick = async (page: Page): Promise<void> => {
  await expect
    .poll(() => page.evaluate(() => window.__chatScrollProbe.pillShown()))
    .toBe(true);
  await page.locator('[aria-label="Scroll to end"]').click();
};

test.describe("C1: following, idle", () => {
  scenario("pick a far turn, then stream", async (page) => {
    const id = await idOf(page, 2);
    await pick(page, 2);
    const picked: ReaderIntent = { kind: "picked", messageId: id };
    await expectAtRest(page, picked, "after the pick");
    await streamFor(page, 2000);
    await expectAtRest(page, picked, "after 2s of stream");
  });
});

test.describe("C3: detached first", () => {
  scenario("pick a turn above", async (page) => {
    await detachMidTranscript(page);
    const id = await idOf(page, 2);
    await pick(page, 2);
    await expectAtRest(
      page,
      { kind: "picked", messageId: id },
      "after the pick above",
    );
  });
  scenario("pick a turn below", async (page) => {
    await detachMidTranscript(page);
    const index = (await pickItems(page)).length - 3;
    const id = await idOf(page, index);
    await pick(page, index);
    await expectAtRest(
      page,
      { kind: "picked", messageId: id },
      "after the pick below",
    );
  });
});

test.describe("C4: the last turn", () => {
  // The fixture's last reply is taller than the viewport, so the last turn
  // cannot be lifted to the reading line without leaving the tail: it lands
  // at 48, free. A short last reply (a fresh turn) is what lands at the tail.
  scenario(
    "a tall last reply lands at the reading line, free",
    async (page) => {
      const index = (await pickItems(page)).length - 1;
      const id = await idOf(page, index);
      await pick(page, index);
      await expectAtRest(
        page,
        { kind: "picked", messageId: id },
        "after picking the last turn",
      );
    },
  );
  scenario(
    "a short last reply lands at the tail and keeps following",
    async (page) => {
      await appendTurn(page);
      await expectAtRest(page, { kind: "tail" }, "after the new turn");
      await pick(page, (await pickItems(page)).length - 1);
      await expectAtRest(page, { kind: "tail" }, "after picking the last turn");
      await streamFor(page, 2000);
      await expectAtRest(page, { kind: "tail" }, "after 2s of stream");
    },
  );
  scenario("a short last reply, from detached", async (page) => {
    await appendTurn(page);
    await detachMidTranscript(page);
    await pick(page, (await pickItems(page)).length - 1);
    await expectAtRest(page, { kind: "tail" }, "after picking the last turn");
    await streamFor(page, 2000);
    await expectAtRest(page, { kind: "tail" }, "after 2s of stream");
  });
});

test.describe("C5: the first turn (clamped at the top)", () => {
  scenario("idle", async (page) => {
    const id = await idOf(page, 0);
    await pick(page, 0);
    await expectAtRest(
      page,
      { kind: "picked", messageId: id },
      "after picking the first turn",
    );
  });
  scenario("while streaming", async (page) => {
    const id = await idOf(page, 0);
    await startStream(page);
    await page.waitForTimeout(500);
    await pick(page, 0);
    await page.waitForTimeout(1500);
    await stopStream(page);
    await expectAtRest(
      page,
      { kind: "picked", messageId: id },
      "after picking the first turn",
    );
  });
});

test.describe("C6: two picks in quick succession", () => {
  for (const streaming of [false, true]) {
    for (const gapMs of [0, 50, 200]) {
      scenario(
        `the second wins (${String(gapMs)}ms apart, ${streaming ? "streaming" : "idle"})`,
        async (page) => {
          const second = await idOf(page, 6);
          if (streaming) {
            await startStream(page);
            await page.waitForTimeout(500);
          }
          await pick(page, 2);
          await page.waitForTimeout(gapMs);
          await pick(page, 6);
          await page.waitForTimeout(1500);
          await stopStream(page);
          await expectAtRest(
            page,
            { kind: "picked", messageId: second },
            "after both picks",
          );
        },
      );
    }
  }
});

test.describe("C7: a pick, then the reader's wheel", () => {
  for (const gapMs of [0, 50, 200]) {
    scenario(
      `the wheel wins (${String(gapMs)}ms after the pick)`,
      async (page) => {
        const id = await idOf(page, 2);
        await pick(page, 2);
        await page.waitForTimeout(gapMs);
        await wheel(page, -600);
        const left = await settle(page, 12);
        const intent = intentOf(left);
        await expectAtRest(page, intent, "just after the wheel");
        // Nothing the pick left in flight may move the reader afterwards.
        await page.waitForTimeout(1500);
        await expectAtRest(page, intent, "1.5s after the wheel");
        const top = await page.evaluate(
          (row) => window.__chatScrollProbe.rowTop(row),
          id,
        );
        expect(
          top === null || Math.abs(top - READING_LINE_PX) > 20,
          `the picked turn is back at the reading line (rowTop=${String(top)}): the pick overrode the wheel`,
        ).toBe(true);
      },
    );
  }
});

test.describe("C8: the pill", () => {
  scenario("while detached and idle", async (page) => {
    await detachMidTranscript(page);
    await pillClick(page);
    await expectAtRest(page, { kind: "tail" }, "after the pill");
    await streamFor(page, 2000);
    await expectAtRest(page, { kind: "tail" }, "after 2s of stream");
  });
  scenario("while streaming", async (page) => {
    await startStream(page);
    await page.waitForTimeout(300);
    await wheel(page, -3000);
    await pillClick(page);
    await page.waitForTimeout(2000);
    await stopStream(page);
    await expectAtRest(
      page,
      { kind: "tail" },
      "after the pill and 2s of stream",
    );
  });
  scenario("right after a new turn", async (page) => {
    await detachMidTranscript(page);
    await appendTurn(page);
    await pillClick(page);
    await expectAtRest(page, { kind: "tail" }, "after the pill");
    await streamFor(page, 2000);
    await expectAtRest(page, { kind: "tail" }, "after 2s of stream");
  });
  scenario("right after a new turn, while streaming", async (page) => {
    await detachMidTranscript(page);
    await startStream(page);
    await appendTurn(page);
    await pillClick(page);
    await page.waitForTimeout(2000);
    await stopStream(page);
    await expectAtRest(
      page,
      { kind: "tail" },
      "after the pill and 2s of stream",
    );
  });
});

test.describe("C9: a pick, then new content", () => {
  scenario("a new turn and a stream", async (page) => {
    const id = await idOf(page, 2);
    await pick(page, 2);
    const picked: ReaderIntent = { kind: "picked", messageId: id };
    await expectAtRest(page, picked, "after the pick");
    await appendTurn(page);
    await streamFor(page, 2000);
    await expectAtRest(page, picked, "after a new turn and 2s of stream");
  });
});

test.describe("C10: keyboard", () => {
  const KEYS = ["End", "Home", "PageUp", "PageDown"] as const;
  for (const streaming of [false, true]) {
    for (const key of KEYS) {
      scenario(
        `${key} while following, ${streaming ? "streaming" : "idle"}`,
        async (page) => {
          if (streaming) {
            await startStream(page);
            await page.waitForTimeout(300);
          }
          const before = await readView(page);
          await page.keyboard.press(key);
          await nextFrames(page, 3);
          const after = streaming
            ? await readView(page)
            : await settle(page, 12);
          if (key === "Home")
            expect(after.scrollTop, "Home goes to the top").toBeLessThanOrEqual(
              1,
            );
          if (key === "PageUp" && !streaming) {
            expect(
              Math.abs(
                after.scrollTop - (before.scrollTop - before.clientHeight),
              ),
              `PageUp moves one page (from ${String(before.scrollTop)} to ${String(after.scrollTop)})`,
            ).toBeLessThanOrEqual(2);
          }
          // A key that cannot leave the tail (PageDown there) keeps the tail, and
          // a mid-stream reading is a transient the stream is still growing.
          const intent: ReaderIntent =
            key === "End" || (key === "PageDown" && before.fromEnd <= 1)
              ? { kind: "tail" }
              : intentOf(after);
          if (streaming) {
            await page.waitForTimeout(1500);
            await stopStream(page);
          }
          await expectAtRest(page, intent, `after ${key}`);
        },
      );
    }
    scenario(
      `PageUp then PageDown, ${streaming ? "streaming" : "idle"}`,
      async (page) => {
        if (streaming) {
          await startStream(page);
          await page.waitForTimeout(300);
        }
        await page.keyboard.press("PageUp");
        await nextFrames(page, 3);
        await page.keyboard.press("PageDown");
        await nextFrames(page, 3);
        const after = streaming ? await readView(page) : await settle(page, 12);
        const intent = intentOf(after);
        if (streaming) {
          await page.waitForTimeout(1500);
          await stopStream(page);
        }
        await expectAtRest(page, intent, "after PageUp, PageDown");
      },
    );
  }
});
