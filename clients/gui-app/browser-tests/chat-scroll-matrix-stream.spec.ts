import { expect, test, type Page } from "@playwright/test";
import {
  expectAtRest,
  intentOf,
  readView,
  settle,
  startTimeline,
  type ReaderIntent,
} from "./support/chat-scroll-oracle";
import { fixture, nextFrames } from "./support/fixtures";

/**
 * STREAM + READER-SCROLL family of the scroll scenario matrix: a reply grows
 * while the reader follows, wheels, drags the scrollbar, clicks a card or
 * resizes the window. Each scenario stops any stream and asks the model's
 * at-rest questions after every step (`expectAtRest`); a failure carries the
 * frame timeline. The F2 cells at the bottom are the stream-wheel
 * counterexample of `formal/ChatScroll.tla`: a wheel superseding a pending
 * end correction must not write the pre-wheel scrollTop back.
 */

declare global {
  interface Window {
    /** Written by `monitorFromEnd`. */
    __fromEndMonitorStop?: () => number;
    /** Written by `watchModeFlips`. */
    __modeFlipsStop?: () => string[];
  }
}

const TIMELINE_TAIL_LINES = 60;
/** The reasoning card `appendCardTurn` adds. Its id and the activity-group
 *  header's duration text ("Thought for Ns") are both specific to the legacy
 *  line's seeded history and timestamps, so B4 matches the header by content
 *  instead: the fixture has only this one reasoning card at that point. */
const CARD = 'button[aria-label^="Thought for "]';
const SCROLL = '[data-testid="chat-messages-scroll"]';

/** The line the current describe block runs against. */
let currentLine: "legacy" | "windowed" = "legacy";

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(
    `${fixture("chat-scroll-model")}${currentLine === "windowed" ? "?line=windowed" : ""}`,
  );
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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\n  TIMELINE (last ${String(lines.length)} changes)\n${lines.join("\n")}`,
    );
  }
}

async function scrollBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(SCROLL).boundingBox();
  if (box === null) throw new Error("no scroll node");
  return box;
}

async function wheel(page: Page, deltaY: number): Promise<void> {
  const box = await scrollBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

const stopStream = (page: Page): Promise<void> =>
  page.evaluate(() => window.__chatScrollProbe.stopStream());

/** Longest stretch, in ms, the view stayed more than 1px above the end. */
async function monitorFromEnd(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    let running = true;
    let since: number | null = null;
    let longest = 0;
    const tick = (): void => {
      if (!running) return;
      const g = window.__chatScrollProbe.geometry();
      const now = performance.now();
      if (g !== null) {
        const away = g.scrollHeight - g.clientHeight - g.scrollTop > 1;
        if (away) {
          since ??= now;
          longest = Math.max(longest, now - since);
        } else {
          since = null;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__fromEndMonitorStop = () => {
      running = false;
      return longest;
    };
  });
  return () => page.evaluate(() => window.__fromEndMonitorStop?.() ?? -1);
}

/** Every change of the controller's mode, one line per flip, per frame. */
async function watchModeFlips(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const flips: string[] = [];
    const startedAt = performance.now();
    let running = true;
    let last: string | null = null;
    const tick = (): void => {
      if (!running) return;
      const probe = window.__chatScrollProbe;
      const g = probe.geometry();
      const mode = probe.mode();
      if (g !== null && mode !== last) {
        const fromEnd = g.scrollHeight - g.clientHeight - g.scrollTop;
        flips.push(
          `${(performance.now() - startedAt).toFixed(0)}ms ${String(last)} -> ${String(mode)} (fromEnd=${fromEnd.toFixed(0)}px top=${g.scrollTop.toFixed(0)} h=${String(g.scrollHeight)})`,
        );
        last = mode;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__modeFlipsStop = () => {
      running = false;
      return flips;
    };
  });
  return () => page.evaluate(() => window.__modeFlipsStop?.() ?? []);
}

/** The deepest block crossing the scroller's top edge (display:contents
 *  wrappers looked through), as its tag, leading text and top. */
async function markEdgeElement(
  page: Page,
): Promise<{ tag: string; text: string; top: number }> {
  return page.evaluate(() => {
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-messages-scroll"]',
    );
    if (node === null) throw new Error("no scroll node");
    const nodeRect = node.getBoundingClientRect();
    const y = nodeRect.top + 2;
    let hit = document.elementFromPoint(
      nodeRect.left + nodeRect.width / 2,
      y,
    ) as HTMLElement | null;
    while (
      hit &&
      hit !== node &&
      getComputedStyle(hit).display.startsWith("inline")
    ) {
      hit = hit.parentElement;
    }
    if (!hit || hit === node) throw new Error("no element at the top edge");
    /** The visible (non-`display:contents`, non-zero-height) element
     *  children of `el`, with a `display:contents` child's own children
     *  substituted in its place. */
    function visibleChildren(el: Element): HTMLElement[] {
      const result: HTMLElement[] = [];
      for (const child of Array.from(el.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (getComputedStyle(child).display === "contents") {
          result.push(...visibleChildren(child));
          continue;
        }
        if (child.getBoundingClientRect().height > 0) result.push(child);
      }
      return result;
    }
    for (;;) {
      const kids = visibleChildren(hit);
      const next =
        kids.find(
          (c) =>
            c.getBoundingClientRect().top <= y &&
            c.getBoundingClientRect().bottom > y,
        ) ?? kids.find((c) => c.getBoundingClientRect().top > y);
      if (!next || getComputedStyle(next).display.startsWith("inline")) break;
      hit = next;
    }
    return {
      tag: hit.tagName,
      text: hit.textContent.slice(0, 60),
      top: hit.getBoundingClientRect().top - nodeRect.top,
    };
  });
}

/** The marked element's top now, found again by tag and leading text. */
async function edgeElementTop(
  page: Page,
  edge: { tag: string; text: string },
): Promise<number | null> {
  return page.evaluate(({ tag, text }) => {
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-messages-scroll"]',
    );
    if (node === null) throw new Error("no scroll node");
    const found = Array.from(node.querySelectorAll(tag)).find((candidate) =>
      candidate.textContent.startsWith(text),
    );
    return found
      ? found.getBoundingClientRect().top - node.getBoundingClientRect().top
      : null;
  }, edge);
}

const TAIL: ReaderIntent = { kind: "tail" };

/** The reader wheels up from where they are and rests there; no stream. */
async function detach(page: Page, deltaY: number): Promise<ReaderIntent> {
  await wheel(page, deltaY);
  const view = await settle(page, 12);
  expect(view.mode, "detached by the wheel").toBe("free-scrolling");
  return intentOf(view);
}

for (const line of ["legacy", "windowed"] as const) {
  test.describe(line, () => {
    test.beforeEach(() => {
      currentLine = line;
    });

    for (const flavour of ["plain", "paragraphs"] as const) {
      test(`A1 following, idle, then a ${flavour} stream for 5s: stays at the tail`, async ({
        page,
      }) => {
        await open(page);
        await withTimeline(page, async () => {
          await expectAtRest(page, TAIL, "idle, following");
          const longest = await monitorFromEnd(page);
          await page.evaluate((f) => {
            if (f === "plain") window.__chatScrollProbe.startStream(40);
            else window.__chatScrollProbe.startParagraphStream(200);
          }, flavour);
          await page.waitForTimeout(5000);
          const stretch = await longest();
          await stopStream(page);
          expect(
            stretch,
            "longest stretch more than 1px above the end (ms)",
          ).toBeLessThanOrEqual(300);
          await expectAtRest(page, TAIL, "after the stream");
        });
      });
    }

    test("A2 following with a stream running, three new turns: follows", async ({
      page,
    }) => {
      await open(page);
      await withTimeline(page, async () => {
        await page.evaluate(() => window.__chatScrollProbe.startStream(40));
        await page.waitForTimeout(400);
        for (let i = 0; i < 3; i += 1) {
          await page.evaluate(() => window.__chatScrollProbe.appendTurn());
          await page.waitForTimeout(500);
        }
        await stopStream(page);
        await expectAtRest(page, TAIL, "after three turns");
      });
    });

    for (const afterAppendMs of [null, 0, 50, 150]) {
      test(`B1 wheel up during the stream${afterAppendMs === null ? "" : `, ${String(afterAppendMs)}ms after a new turn`}: held`, async ({
        page,
      }) => {
        await open(page);
        await withTimeline(page, async () => {
          await page.evaluate(() => window.__chatScrollProbe.startStream(40));
          await page.waitForTimeout(500);
          if (afterAppendMs !== null) {
            await page.evaluate(() => window.__chatScrollProbe.appendTurn());
            if (afterAppendMs > 0) await page.waitForTimeout(afterAppendMs);
          }
          const box = await scrollBox(page);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          for (let i = 0; i < 4; i += 1) {
            await page.mouse.wheel(0, -120);
            await nextFrames(page, 2);
          }
          const intent = intentOf(await readView(page));
          expect(intent.kind, "the wheel left the tail").toBe("at");
          await page.waitForTimeout(1500);
          await stopStream(page);
          await expectAtRest(page, intent, "after the stream");
        });
      });
    }

    test("B2 detached, wheel back to the bottom: following again, then the stream follows", async ({
      page,
    }) => {
      await open(page);
      await withTimeline(page, async () => {
        const intent = await detach(page, -1500);
        await expectAtRest(page, intent, "detached");
        await wheel(page, 20000);
        await expectAtRest(page, TAIL, "wheeled back to the bottom");
        await page.evaluate(() => window.__chatScrollProbe.startStream(40));
        await page.waitForTimeout(2000);
        await stopStream(page);
        await expectAtRest(page, TAIL, "after the stream");
      });
    });

    test("B4 a card that changes height: following stays following", async ({
      page,
    }) => {
      await open(page);
      await withTimeline(page, async () => {
        await page.evaluate(() => {
          window.__chatScrollProbe.appendCardTurn();
          window.__chatScrollProbe.appendTurn();
        });
        await expectAtRest(page, TAIL, "after the card turn");
        const card = page.locator(CARD);
        await card.click();
        await expectAtRest(page, TAIL, "after opening the card");
        await card.click();
        await expectAtRest(page, TAIL, "after closing the card");
      });
    });

    test("B4 a card that changes height: detached stays held", async ({
      page,
    }) => {
      await open(page);
      await withTimeline(page, async () => {
        await page.evaluate(() => {
          window.__chatScrollProbe.appendCardTurn();
          window.__chatScrollProbe.appendTurn();
        });
        await expectAtRest(page, TAIL, "after the card turn");
        const intent = await detach(page, -200);
        await expectAtRest(page, intent, "detached with the card in view");
        const card = page.locator(CARD);
        await card.click();
        await expectAtRest(page, intent, "after opening the card");
        await card.click();
        await expectAtRest(page, intent, "after closing the card");
      });
    });

    test("B5 one wheel notch up from the tail during the stream: held", async ({
      page,
    }) => {
      await open(page);
      await withTimeline(page, async () => {
        await page.evaluate(() => window.__chatScrollProbe.startStream(40));
        await page.waitForTimeout(500);
        await wheel(page, -100);
        await nextFrames(page, 2);
        const intent = intentOf(await readView(page));
        expect(intent.kind, "the notch left the tail").toBe("at");
        await page.waitForTimeout(1500);
        await stopStream(page);
        await expectAtRest(page, intent, "after the stream");
      });
    });

    for (const [name, size] of [
      ["shorter", { width: 900, height: 500 }],
      ["narrower", { width: 600, height: 700 }],
    ] as const) {
      test(`B6 width change, resize (${name}) while following: following`, async ({
        page,
      }) => {
        await open(page);
        await withTimeline(page, async () => {
          await page.setViewportSize(size);
          await expectAtRest(page, TAIL, "after the resize");
          await page.setViewportSize({ width: 900, height: 700 });
          await expectAtRest(page, TAIL, "after resizing back");
        });
      });

      test(`B6 width change, resize (${name}) while detached: the element at the top edge is held`, async ({
        page,
      }) => {
        await open(page);
        await withTimeline(page, async () => {
          const intent = await detach(page, -1500);
          await expectAtRest(page, intent, "detached");
          const edge = await markEdgeElement(page);
          await page.setViewportSize(size);
          const view = await settle(page, 12);
          const after = await edgeElementTop(page, edge);
          expect(view.mode, "still detached").toBe("free-scrolling");
          expect(view.pill, "pill shown while detached").toBe(true);
          expect(
            after,
            `the ${edge.tag} "${edge.text.slice(0, 24)}" at the edge was re-found`,
          ).not.toBeNull();
          expect(
            Math.abs((after ?? 0) - edge.top),
            `the ${edge.tag} at the edge moved ${edge.top.toFixed(1)} -> ${String(after)}`,
          ).toBeLessThanOrEqual(1);
        });
      });
    }

    // ---- B7: the reader moves TOWARD the end while content grows ----

    type ReaderMotion = "wheel";

    /** ~2s of a trackpad: small steps per frame, notches, a momentum tail. */
    async function wheelDownLikeATrackpad(page: Page): Promise<void> {
      const box = await scrollBox(page);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 40; i += 1) {
        await page.mouse.wheel(0, 40);
        await nextFrames(page, 1);
      }
      for (let i = 0; i < 5; i += 1) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(100);
      }
      for (let delta = 60; delta >= 5; delta -= 5) {
        await page.mouse.wheel(0, delta);
        await nextFrames(page, 2);
      }
    }

    const B7_STREAMS = [
      {
        name: "paragraphs 100ms",
        start: (page: Page) =>
          page.evaluate(() =>
            window.__chatScrollProbe.startParagraphStream(100),
          ),
      },
      {
        name: "plain 16ms",
        start: (page: Page) =>
          page.evaluate(() => window.__chatScrollProbe.startStream(16)),
      },
    ];

    for (const motion of ["wheel"] as const satisfies readonly ReaderMotion[]) {
      for (const stream of B7_STREAMS) {
        for (const afterAppendMs of [null, 0, 16, 50, 100, 200]) {
          const when =
            afterAppendMs === null
              ? ""
              : `, ${String(afterAppendMs)}ms after a send`;
          test(`B7 ${motion} toward the end while ${stream.name} streams${when}: still following`, async ({
            page,
          }, testInfo) => {
            await open(page);
            const stopFlips = await watchModeFlips(page);
            try {
              await withTimeline(page, async () => {
                await stream.start(page);
                await page.waitForTimeout(300);
                if (afterAppendMs !== null) {
                  await page.evaluate(() =>
                    window.__chatScrollProbe.appendTurn(),
                  );
                  if (afterAppendMs > 0)
                    await page.waitForTimeout(afterAppendMs);
                }
                await wheelDownLikeATrackpad(page);
                await page.waitForTimeout(2000);
                await stopStream(page);
                await expectAtRest(
                  page,
                  TAIL,
                  "after the reader stopped and the stream ended",
                );
                await stream.start(page);
                await page.waitForTimeout(1000);
                await stopStream(page);
                await expectAtRest(page, TAIL, "after a second stream");
              });
            } catch (error) {
              const flips = (await stopFlips()).join("\n");
              const message =
                error instanceof Error ? error.message : String(error);
              throw new Error(`${message}\n  MODE FLIPS\n${flips}`);
            }
            const flips = await stopFlips();
            testInfo.annotations.push({
              type: "mode flips",
              description: flips.join(" | "),
            });
          });
        }
      }
    }

    test("B8 detached in the middle while a paragraph stream makes the last reply huge: the reading row is held", async ({
      page,
    }) => {
      await open(page);
      await withTimeline(page, async () => {
        const intent = await detach(page, -1500);
        await expectAtRest(page, intent, "detached");
        await page.evaluate(() =>
          window.__chatScrollProbe.startParagraphStream(100),
        );
        await page.waitForTimeout(9000);
        await stopStream(page);
        await expectAtRest(
          page,
          intent,
          "after the reply grew by thousands of pixels",
        );
      });
    });

    // ---- F2: wheel superseding a pending end correction while streaming ----

    interface Sample {
      readonly t: number;
      readonly scrollTop: number;
      readonly row: string | null;
      readonly offset: number | null;
      readonly mode: string | null;
    }

    async function sample(page: Page, startedAt: number): Promise<Sample> {
      const taken = await page.evaluate(() => {
        const probe = window.__chatScrollProbe;
        const row = probe.readingRow();
        return {
          scrollTop: probe.geometry()?.scrollTop ?? Number.NaN,
          row: row?.messageId ?? null,
          offset: row?.offset ?? null,
          mode: probe.mode(),
        };
      });
      return { t: (Date.now() - startedAt) / 1000, ...taken };
    }

    function describeTimeline(
      samples: readonly Sample[],
      reader: Sample,
    ): string {
      const lines: string[] = [
        `reader: scrollTop=${reader.scrollTop} row=${reader.row} offset=${reader.offset} mode=${reader.mode}`,
      ];
      let previous = reader;
      for (const s of samples) {
        const moved = Math.abs(s.scrollTop - previous.scrollTop) > 2;
        const flagged =
          moved ||
          s.mode !== previous.mode ||
          s.row !== previous.row ||
          Math.abs((s.offset ?? 0) - (previous.offset ?? 0)) > 2;
        if (flagged) {
          lines.push(
            `t=${s.t.toFixed(2)}s scrollTop ${previous.scrollTop} → ${s.scrollTop}, row ${s.row} offset ${s.offset}, mode ${s.mode}`,
          );
        }
        previous = s;
      }
      return lines.join("\n");
    }

    interface Scenario {
      readonly streamMs: number;
      readonly ticks: number;
      readonly gapFrames: number;
      readonly delta: number;
      /** Wheel burst starts this long after `appendTurn()`; null: no new turn. */
      readonly afterAppendMs: number | null;
    }

    async function readerKeepsPosition(
      page: Page,
      { streamMs, ticks, gapFrames, delta, afterAppendMs }: Scenario,
    ): Promise<void> {
      await open(page);

      await page.evaluate(
        (ms) => window.__chatScrollProbe.startStream(ms),
        streamMs,
      );
      await page.waitForTimeout(500);

      const box = await page
        .locator('[data-testid="chat-messages-scroll"]')
        .boundingBox();
      if (box === null) throw new Error("no scroll node");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

      if (afterAppendMs !== null) {
        await page.evaluate(() => window.__chatScrollProbe.appendTurn());
        if (afterAppendMs > 0) await page.waitForTimeout(afterAppendMs);
      }
      const preWheel = await sample(page, Date.now());
      for (let i = 0; i < ticks; i += 1) {
        await page.mouse.wheel(0, -delta);
        if (gapFrames > 0) await nextFrames(page, gapFrames);
      }
      await nextFrames(page, 2);
      const startedAt = Date.now();
      const reader = await sample(page, startedAt);

      const samples: Sample[] = [];
      while (Date.now() - startedAt < 2000) {
        samples.push(await sample(page, startedAt));
        await nextFrames(page, 3);
      }
      await page.evaluate(() => window.__chatScrollProbe.stopStream());

      const timeline = describeTimeline(samples, reader);
      // The reader's own position, or anything back toward the pre-wheel one.
      const violations = samples.filter(
        (s) =>
          s.scrollTop > preWheel.scrollTop - delta / 2 ||
          Math.abs(s.scrollTop - reader.scrollTop) > 2 ||
          s.row !== reader.row ||
          Math.abs((s.offset ?? 0) - (reader.offset ?? 0)) > 2,
      );
      expect(
        violations,
        `the reader's position moved after the wheel:\n${timeline}`,
      ).toEqual([]);
      expect(
        samples.filter((s) => s.mode !== "free-scrolling"),
        `follow was not released:\n${timeline}`,
      ).toEqual([]);
    }

    const CADENCES = [
      { ticks: 4, gapFrames: 2, delta: 120 },
      { ticks: 3, gapFrames: 1, delta: 300 },
    ];

    for (const streamMs of [16, 100]) {
      for (const cadence of CADENCES) {
        test(`a wheel scroll up while a reply streams every ${String(streamMs)}ms keeps the reading position (${String(cadence.ticks)} x ${String(cadence.delta)}px, ${String(cadence.gapFrames)} frames apart)`, async ({
          page,
        }) => {
          await readerKeepsPosition(page, {
            streamMs,
            ...cadence,
            afterAppendMs: null,
          });
        });
      }
    }

    for (const streamMs of [16, 40]) {
      for (const afterAppendMs of [0, 300]) {
        test(`a wheel scroll up ${String(afterAppendMs)}ms after a new turn lands, streaming every ${String(streamMs)}ms, keeps the reading position`, async ({
          page,
        }) => {
          await readerKeepsPosition(page, {
            streamMs,
            ticks: 4,
            gapFrames: 2,
            delta: 120,
            afterAppendMs,
          });
        });
      }
    }
  });
}
