import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures";
import { expectAtRest, startTimeline } from "./support/chat-scroll-oracle";

/**
 * The "Scroll to end" pill clicked while detached about 1500px above the
 * tail, with and without a stream running. After the stream stops the reader
 * must be at the tail, following, with no pill. Each test also records one
 * reading per frame from the click on and reports whether any frame showed
 * the reader free with the pill while scrollTop was still moving toward the
 * end (a pill completion that gave up before its scroll landed).
 */

interface Frame {
  readonly t: number;
  readonly scrollTop: number;
  readonly fromEnd: number;
  readonly mode: string | null;
  readonly pill: boolean;
}

declare global {
  interface Window {
    __pillFrames?: Frame[];
    __pillStop?: () => void;
  }
}

const STREAMS = [
  { name: "a: startStream(16)", start: "startStream", intervalMs: 16 },
  {
    name: "b: startParagraphStream(16)",
    start: "startParagraphStream",
    intervalMs: 16,
  },
  {
    name: "c: startStream(100) control",
    start: "startStream",
    intervalMs: 100,
  },
  { name: "d: no stream control", start: null, intervalMs: 0 },
] as const;

async function startFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    const t0 = performance.now();
    let running = true;
    const tick = (): void => {
      if (!running) return;
      const probe = window.__chatScrollProbe;
      const g = probe.geometry();
      if (g !== null) {
        frames.push({
          t: Math.round(performance.now() - t0),
          scrollTop: Math.round(g.scrollTop),
          fromEnd: Math.round(g.scrollHeight - g.clientHeight - g.scrollTop),
          mode: probe.mode(),
          pill: probe.pillShown(),
        });
      }
      requestAnimationFrame(tick);
    };
    window.__pillFrames = frames;
    window.__pillStop = () => {
      running = false;
    };
    requestAnimationFrame(tick);
  });
}

/** Index of the first frame that is free with the pill while scrollTop rose
 *  since the previous frame (still travelling to the end), or -1. */
function firstGaveUpWhileMoving(frames: readonly Frame[]): number {
  return frames.findIndex((f, i) => {
    const previous = frames.at(i - 1);
    return (
      i > 0 &&
      previous !== undefined &&
      f.mode === "free-scrolling" &&
      f.pill &&
      f.scrollTop > previous.scrollTop
    );
  });
}

function formatFrames(
  frames: readonly Frame[],
  from: number,
  count: number,
): string {
  return frames
    .slice(Math.max(0, from), from + count)
    .map(
      (f) =>
        `${String(f.t).padStart(5)}ms top=${String(f.scrollTop)} fromEnd=${String(f.fromEnd)} ${String(f.mode)} pill=${String(f.pill)}`,
    )
    .join("\n");
}

for (const stream of STREAMS) {
  test(`the pill while detached 1500px up: ${stream.name}`, async ({
    page,
  }) => {
    await page.goto(fixture("chat-scroll-model"));
    await nextFrames(page, 30);
    await expect
      .poll(() => page.evaluate(() => window.__chatScrollProbe.mode()))
      .toBe("following-end");
    const stopTimeline = await startTimeline(page);

    if (stream.start !== null) {
      await page.evaluate(
        ([kind, ms]) => {
          const probe = window.__chatScrollProbe;
          if (kind === "startStream") probe.startStream(ms);
          else probe.startParagraphStream(ms);
        },
        [stream.start, stream.intervalMs] as const,
      );
      await page.waitForTimeout(300);
    }
    await page.mouse.move(195, 350);
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, -500);
      await nextFrames(page, 2);
    }
    await page.waitForTimeout(300);
    await expect
      .poll(() => page.evaluate(() => window.__chatScrollProbe.pillShown()))
      .toBe(true);

    await startFrames(page);
    await page.locator('[aria-label="Scroll to end"]').click();
    await page.waitForTimeout(stream.start === null ? 1500 : 3000);
    await page.evaluate(() => {
      window.__chatScrollProbe.stopStream();
    });

    const frames = await page.evaluate(() => {
      window.__pillStop?.();
      return window.__pillFrames ?? [];
    });
    const gaveUp = firstGaveUpWhileMoving(frames);
    process.stdout.write(
      `PILLFLAG ${stream.name}: ${gaveUp === -1 ? "no frame free+pill while moving" : `free+pill while moving at frame ${String(gaveUp)} (${String(frames[gaveUp]?.t)}ms)`}\n`,
    );
    try {
      await expectAtRest(
        page,
        { kind: "tail" },
        "after the pill and the stream stopped",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const firstFree = frames.findIndex(
        (f) => f.mode === "free-scrolling" && f.pill && f.t > 0,
      );
      const anchor = gaveUp === -1 ? firstFree : gaveUp;
      const timeline = (await stopTimeline()).split("\n").slice(-40).join("\n");
      throw new Error(
        `${message}\n--- frames around the first free+pill frame after the click (index ${String(anchor)}) ---\n${formatFrames(frames, anchor - 6, 30)}\n--- last 40 timeline changes ---\n${timeline}`,
      );
    }
  });
}
