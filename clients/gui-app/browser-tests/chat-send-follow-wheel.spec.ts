import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

// The owner's "stuck after send", against the fixture in
// `src/__tests__/browser/chat-send-follow.tsx`: the reader nudges the wheel
// DOWN right after Enter, or mid-stream, while rich content streams in. The
// reader must stay on the follow line: no mode flip, no pill, and the view at
// the bottom once the stream stops.

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

type ScenarioKind = "idle" | "running";

const PROMPT = "PROBE-PROMPT please continue PROBE-END";

type Pattern = "trackpad" | "notches";
type Anchor = "enter" | "turn";

interface Case {
  readonly kind: ScenarioKind;
  readonly pattern: Pattern;
  readonly anchor: Anchor;
  readonly delayMs: number;
}

const CASES: readonly Case[] = [
  ...[0, 400].map((delayMs): Case => ({
    kind: "idle",
    pattern: "trackpad",
    anchor: "enter",
    delayMs,
  })),
  { kind: "idle", pattern: "trackpad", anchor: "turn", delayMs: 200 },
  { kind: "idle", pattern: "notches", anchor: "enter", delayMs: 0 },
  { kind: "running", pattern: "trackpad", anchor: "enter", delayMs: 0 },
  { kind: "running", pattern: "trackpad", anchor: "enter", delayMs: 150 },
  { kind: "running", pattern: "trackpad", anchor: "turn", delayMs: 200 },
  { kind: "running", pattern: "notches", anchor: "enter", delayMs: 0 },
];

async function probe(page: Page): Promise<ChatFollowReading> {
  return page.evaluate(() => {
    if (window.__followDriver === undefined) throw new Error("no driver");
    return window.__followDriver.probe();
  });
}

async function openScenario(page: Page, kind: ScenarioKind): Promise<void> {
  await page.goto(fixture("chat-send-follow"));
  await page.waitForFunction(() => window.__followDriver?.ready === true);
  await page.evaluate((scenario) => {
    window.__followDriver?.open(scenario);
  }, kind);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="chat-messages-scroll"]') !== null,
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
}

async function startWatching(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: ChatFollowFrame[] = [];
    window.__followFrames = frames;
    window.__followStep = "start";
    window.__followWheelAcc = 0;
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

async function wheel(page: Page, deltaY: number): Promise<void> {
  await page.evaluate((d) => {
    window.__followWheelAcc = d;
  }, deltaY);
  await page.mouse.wheel(0, deltaY);
}

async function nudge(page: Page, pattern: Pattern): Promise<void> {
  if (pattern === "trackpad") {
    for (let i = 0; i < 18; i += 1) {
      await wheel(page, 40);
      await nextFrames(page, 1);
    }
    for (const d of [30, 20, 12, 6, 3, 2, 1]) {
      await wheel(page, d);
      await nextFrames(page, 1);
    }
  } else {
    for (let i = 0; i < 10; i += 1) {
      await wheel(page, 120);
      await page.waitForTimeout(100);
    }
  }
  await wheel(page, 0);
}

async function host(
  page: Page,
  frame:
    | {
        readonly kind: "accept" | "turnStarted" | "queueAdded";
        readonly messageId: string;
      }
    | { readonly kind: "queueRemoved" | "earlierTurnEnded" },
): Promise<void> {
  await page.evaluate((input) => {
    const driver = window.__followDriver;
    if (driver === undefined) throw new Error("no driver");
    if ("messageId" in input) driver.host[input.kind](input.messageId);
    else if (input.kind === "queueRemoved") driver.host.queueRemoved();
    else driver.host.earlierTurnEnded();
  }, frame);
  await nextFrames(page, 1);
}

function raw(f: ChatFollowFrame): string {
  return `t=${String(f.t).padStart(5)} ${f.step.padEnd(7)} wheel=${String(f.wheel).padStart(3)} dist=${f.distance.toFixed(1).padStart(7)} top=${f.scrollTop.toFixed(0)} sh=${String(f.scrollHeight)} ch=${String(f.clientHeight)} dock=${f.dockHeight.toFixed(0)} mode=${f.mode} pill=${String(f.pill)} last=${f.lastRowKey}`;
}

function report(frames: readonly ChatFollowFrame[]): string {
  const flip = frames.findIndex((f) => f.mode !== "following-end" || f.pill);
  // The flip that never recovers: the first frame of the final run of
  // non-following frames.
  let stuck = frames.length;
  while (stuck > 0 && frames[stuck - 1].mode !== "following-end") stuck -= 1;
  const stuckAt = stuck < frames.length ? stuck : -1;
  let pivot = 0;
  if (stuckAt >= 0) pivot = stuckAt;
  else if (flip >= 0) pivot = flip;
  else {
    frames.forEach((f, i) => {
      if (f.distance > frames[pivot].distance) pivot = i;
    });
  }
  const around = frames.slice(Math.max(0, pivot - 14), pivot + 8).map(raw);
  const last = frames.at(-1);
  const flips = frames.filter(
    (f, i) =>
      f.mode !== "following-end" &&
      (i === 0 || frames[i - 1].mode === "following-end"),
  ).length;
  return [
    `first flip/pill frame: ${String(flip)}${flip >= 0 ? ` t=${String(frames[flip].t)} (${frames[flip].step})` : ""}; flips into free-scrolling: ${String(flips)}; stuck from frame ${String(stuckAt)}${stuckAt >= 0 ? ` t=${String(frames[stuckAt].t)} (${frames[stuckAt].step})` : ""}`,
    `max dist ${Math.max(...frames.map((f) => f.distance)).toFixed(1)}; at rest: dist=${String(last?.distance)} mode=${String(last?.mode)} pill=${String(last?.pill)}`,
    "frames before the stuck flip (or the first flip / worst distance):",
    ...around,
  ].join("\n");
}

for (const c of CASES) {
  const name = `${c.kind} / ${c.pattern} wheel ${String(c.delayMs)}ms after ${c.anchor === "enter" ? "Enter" : "turn start"}: the reader stays on the follow line`;
  test(name, async ({ page }) => {
    await openScenario(page, c.kind);
    if (c.kind === "running") {
      await page.evaluate(() => {
        window.__followDriver?.host.streamRich("earlier", 8, 40);
      });
      await page.waitForTimeout(600);
    }
    const scroller = page.getByTestId("chat-messages-scroll");
    const box = await scroller.boundingBox();
    if (box === null) throw new Error("no scroller box");
    await page.mouse.move(box.x + box.width / 2, box.y + 150);
    await page.getByRole("textbox").click();
    await page.keyboard.type(PROMPT);
    await page.mouse.move(box.x + box.width / 2, box.y + 150);
    await startWatching(page);
    await mark(page, "enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => window.__followDriver?.lastMessageId() !== null,
    );
    const messageId = await page.evaluate(
      () => window.__followDriver?.lastMessageId() ?? null,
    );
    if (messageId === null) throw new Error("the composer sent nothing");

    const nudges: Promise<void>[] = [];
    const startNudge = (): void => {
      const run = (async () => {
        await page.waitForTimeout(c.delayMs);
        await nudge(page, c.pattern);
      })();
      nudges.push(run);
    };
    if (c.anchor === "enter") startNudge();

    await nextFrames(page, 20);
    if (c.kind === "running") {
      await mark(page, "queued");
      await host(page, { kind: "queueAdded", messageId });
      await nextFrames(page, 10);
      await mark(page, "drain");
      await host(page, { kind: "earlierTurnEnded" });
      await host(page, { kind: "queueRemoved" });
      await page.evaluate(() => {
        window.__followDriver?.host.stopReply();
      });
    }
    await mark(page, "accept");
    await host(page, { kind: "accept", messageId });
    await nextFrames(page, 20);
    await mark(page, "turn");
    await host(page, { kind: "turnStarted", messageId });
    if (c.anchor === "turn") startNudge();
    await nextFrames(page, 20);
    await mark(page, "stream");
    await page.evaluate(() => {
      window.__followDriver?.host.streamRich("reply", 3, 40);
    });
    await page.waitForTimeout(5500);
    await Promise.all(nudges);
    await mark(page, "after");
    await page.evaluate(() => {
      window.__followDriver?.host.stopReply();
    });
    await nextFrames(page, 30);
    await page.waitForTimeout(500);
    const frames: ChatFollowFrame[] = await page.evaluate(() => {
      window.__followStop?.();
      return [...(window.__followFrames ?? [])];
    });
    const text = report(frames);
    const last = frames.at(-1);

    expect
      .soft(
        frames.filter((f) => f.mode !== "following-end").length,
        `mode never leaves following-end\n${text}`,
      )
      .toBe(0);
    expect
      .soft(
        frames.some((f) => f.pill),
        `pill never shows\n${text}`,
      )
      .toBe(false);
    expect
      .soft(last?.distance, `at the bottom once the stream stops\n${text}`)
      .toBeLessThanOrEqual(1);
  });
}
