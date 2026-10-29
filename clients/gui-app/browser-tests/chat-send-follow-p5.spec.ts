import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

// P5: a free reader reaches the strict bottom while the structural commit of a
// new reply row is still unsettled (the reply streams in bursts, so the
// "two frames of unchanged scrollHeight" settle may not come until the stream
// pauses). The reader must end up following, with no pill, at the bottom.
//
// P5a reaches the bottom with the wheel. P5b with programmatic scrollTop
// assignments on the scroll node: headless Chrome here hides scrollbars, so a
// real drag is not possible; a scrollbar drag raises scroll events with no
// wheel, key or touch gesture, which is what an assignment does too.
// P5c is the control: the wheel arrives after the stream paused for 500ms.

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

type Variant = "P5a wheel" | "P5b drag" | "P5c paused-wheel";

// coverage: the old code's failure here was occasional, not deterministic;
// the fix's deterministic proof lives in the vitest files. One run per
// variant is enough to keep this reachability path exercised.
const RUNS: ReadonlyArray<{
  readonly variant: Variant;
  readonly runs: number;
}> = [
  { variant: "P5a wheel", runs: 1 },
  { variant: "P5b drag", runs: 1 },
  { variant: "P5c paused-wheel", runs: 1 },
];

async function probe(page: Page): Promise<ChatFollowReading> {
  return page.evaluate(() => {
    if (window.__followDriver === undefined) throw new Error("no driver");
    return window.__followDriver.probe();
  });
}

async function startWatching(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: ChatFollowFrame[] = [];
    window.__followFrames = frames;
    window.__followStep = "start";
    window.__followWheelAcc = 0;
    document.addEventListener(
      "wheel",
      (event) => {
        window.__followWheelAcc = (window.__followWheelAcc ?? 0) + event.deltaY;
      },
      { capture: true, passive: true },
    );
    let running = true;
    window.__followStop = () => {
      running = false;
    };
    const t0 = performance.now();
    const tick = (): void => {
      if (!running) return;
      if (window.__followDriver !== undefined) {
        frames.push({
          ...window.__followDriver.probe(),
          t: Math.round(performance.now() - t0),
          step: window.__followStep ?? "",
          wheel: window.__followWheelAcc ?? 0,
        });
        window.__followWheelAcc = 0;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function mark(page: Page, step: string): Promise<void> {
  await page.evaluate((s) => {
    window.__followStep = s;
  }, step);
}

/** Wheel down, one notch per frame, until the strict bottom or the cap. */
async function wheelToBottom(page: Page): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await page.mouse.wheel(0, 120);
    await nextFrames(page, 1);
    if ((await probe(page)).distance <= 0.5) return;
  }
}

/** Assign scrollTop to the maximum on consecutive frames, as a held drag. */
async function dragToBottom(page: Page): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>(
        '[data-testid="chat-messages-scroll"]',
      );
      if (node !== null) node.scrollTop = node.scrollHeight;
    });
    await nextFrames(page, 1);
    if ((await probe(page)).distance <= 0.5) return;
  }
}

function raw(f: ChatFollowFrame, still: boolean): string {
  return `t=${String(f.t).padStart(5)} ${f.step.padEnd(8)} wheel=${String(f.wheel).padStart(4)} dist=${f.distance.toFixed(1).padStart(7)} top=${f.scrollTop.toFixed(0)} sh=${String(f.scrollHeight)} mode=${f.mode} pill=${String(f.pill)} sh-still-2f=${String(still)} last=${f.lastRowKey}`;
}

/** Change-point frames from the first frame of the reader's move on. */
function trace(frames: readonly ChatFollowFrame[]): string {
  const from = Math.max(0, frames.findIndex((f) => f.step === "reach") - 3);
  const rows: string[] = [];
  let prev: ChatFollowFrame | null = null;
  let prevStill = false;
  frames.forEach((f, i) => {
    const still =
      i >= 2 &&
      f.scrollHeight === frames[i - 1].scrollHeight &&
      f.scrollHeight === frames[i - 2].scrollHeight;
    const changed =
      prev === null ||
      f.scrollHeight !== prev.scrollHeight ||
      f.mode !== prev.mode ||
      f.pill !== prev.pill ||
      f.wheel !== 0 ||
      prev.wheel !== 0 ||
      f.distance > 1 !== prev.distance > 1 ||
      f.step !== prev.step ||
      still !== prevStill;
    if (i >= from && changed && rows.length < 70) rows.push(raw(f, still));
    prev = f;
    prevStill = still;
  });
  return rows.join("\n");
}

for (const { variant, runs } of RUNS) {
  for (let run = 1; run <= runs; run += 1) {
    test(`${variant}: a free reader reaching the bottom during a streaming reply follows it`, async ({
      page,
    }) => {
      await page.goto(fixture("chat-send-follow"));
      await page.waitForFunction(() => window.__followDriver?.ready === true);
      await page.evaluate(() => {
        window.__followDriver?.open("idle");
      });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="chat-messages-scroll"]') !==
          null,
      );
      await page.evaluate(() => {
        const node = document.querySelector<HTMLElement>(
          '[data-testid="chat-messages-scroll"]',
        );
        node?.scrollTo({ top: node.scrollHeight });
      });
      await expect
        .poll(async () => {
          const r = await probe(page);
          return r.mode === "following-end" && r.distance <= 1;
        })
        .toBe(true);
      await nextFrames(page, 10);

      // A send, so a turn is running and its reply row is yet to appear.
      await page.getByRole("textbox").click();
      await page.keyboard.type("PROBE-PROMPT please continue PROBE-END");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => window.__followDriver?.lastMessageId() !== null,
      );
      const messageId = await page.evaluate(
        () => window.__followDriver?.lastMessageId() ?? null,
      );
      if (messageId === null) throw new Error("the composer sent nothing");
      await nextFrames(page, 20);
      await page.evaluate((id) => {
        window.__followDriver?.host.accept(id);
      }, messageId);
      await nextFrames(page, 20);
      await page.evaluate((id) => {
        window.__followDriver?.host.turnStarted(id);
      }, messageId);
      await nextFrames(page, 30);

      // The reader leaves the tail by about 300px.
      const box = await page.getByTestId("chat-messages-scroll").boundingBox();
      if (box === null) throw new Error("no scroller box");
      await page.mouse.move(box.x + box.width / 2, box.y + 150);
      await page.mouse.wheel(0, -300);
      await nextFrames(page, 30);
      const parked = await probe(page);
      expect(parked.mode, "the reader is free before the reply").toBe(
        "free-scrolling",
      );

      await startWatching(page);
      await mark(page, "park");
      await nextFrames(page, 3);
      const heightBefore = (await probe(page)).scrollHeight;
      await mark(page, "stream");
      await page.evaluate(() => {
        window.__followDriver?.host.streamBursty(70, "p5-reply");
      });

      if (variant === "P5c paused-wheel") {
        // Let the reply row appear and some text stream, pause 500ms, then reach.
        await page.waitForTimeout(700);
        await page.evaluate(() => {
          window.__followDriver?.host.stopReply();
        });
        await mark(page, "pause");
        await page.waitForTimeout(500);
        await mark(page, "reach");
        await wheelToBottom(page);
        await mark(page, "resume");
        await page.evaluate(() => {
          window.__followDriver?.host.streamBursty(40, "p5-reply-2");
        });
      } else {
        // Wait for the reply's first text to land (the tail grows), then reach inside 300ms.
        for (let i = 0; i < 120; i += 1) {
          await nextFrames(page, 1);
          if ((await probe(page)).scrollHeight > heightBefore) break;
        }
        await nextFrames(page, 2);
        await mark(page, "reach");
        if (variant === "P5a wheel") await wheelToBottom(page);
        else await dragToBottom(page);
        await mark(page, "after");
      }
      await page.waitForTimeout(4500);
      await page.evaluate(() => {
        window.__followDriver?.host.stopReply();
      });
      await nextFrames(page, 30);
      await page.waitForTimeout(400);
      const frames: ChatFollowFrame[] = await page.evaluate(() => {
        window.__followStop?.();
        return [...(window.__followFrames ?? [])];
      });
      const reachIdx = frames.findIndex((f) => f.step === "reach");
      const rowIdx = frames.findIndex(
        (f) => f.step === "stream" && f.scrollHeight > heightBefore,
      );
      const reachFrame = frames[reachIdx];
      const reachFrames = frames.filter((f) => f.step === "reach");
      console.warn(
        `PRECOND ${variant} run ${String(run)}: parked dist ${parked.distance.toFixed(0)} mode ${String(parked.mode)}; reply grows the tail at t=${String(frames[rowIdx]?.t)}, reach starts t=${String(reachFrame.t)} (+${String(reachFrame.t - (frames[rowIdx]?.t ?? reachFrame.t))}ms), mode then ${String(frames[Math.max(0, reachIdx - 1)].mode)}, min dist during reach ${String(Math.min(...reachFrames.map((f) => f.distance)).toFixed(1))}`,
      );
      const last = frames.at(-1);
      const text = `at rest: mode=${String(last?.mode)} pill=${String(last?.pill)} dist=${String(last?.distance)}\n${trace(frames)}`;
      expect
        .soft(last?.mode, `following at rest\n${text}`)
        .toBe("following-end");
      expect.soft(last?.pill, `no pill at rest\n${text}`).toBe(false);
      expect
        .soft(last?.distance, `at the bottom at rest\n${text}`)
        .toBeLessThanOrEqual(1);
    });
  }
}
