import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

// A wheel UP right after a send: the reader must stay where the wheel left
// them. The owner's "stuck after send", against the fixture in
// `src/__tests__/browser/chat-send-follow.tsx`: the reader nudges the wheel
// DOWN right after Enter, or mid-stream, while rich content streams in. The
// reader must stay on the follow line: no mode flip, no pill, and the view at
// the bottom once the stream stops.

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

type ScenarioKind = "idle" | "running";

type Shape = "notch" | "burst";
type Setup = "send" | "idle-control" | "stream-control";

interface Case {
  readonly name: string;
  readonly setup: Setup;
  readonly shape: Shape;
  readonly delayMs: number;
}

const CASES: readonly Case[] = [
  ...[16, 250].map((delayMs): Case => ({
    name: `send / one notch up ${String(delayMs)}ms after Enter`,
    setup: "send",
    shape: "notch",
    delayMs,
  })),
  ...[16, 100].map((delayMs): Case => ({
    name: `send / trackpad burst up ${String(delayMs)}ms after Enter`,
    setup: "send",
    shape: "burst",
    delayMs,
  })),
  {
    name: "control / burst up into an idle transcript",
    setup: "idle-control",
    shape: "burst",
    delayMs: 0,
  },
  {
    name: "control / burst up into a streaming reply",
    setup: "stream-control",
    shape: "burst",
    delayMs: 0,
  },
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

async function nudge(page: Page, shape: Shape): Promise<void> {
  if (shape === "notch") {
    await page.mouse.wheel(0, -120);
    return;
  }
  for (let i = 0; i < 18; i += 1) {
    await page.mouse.wheel(0, -40);
    await nextFrames(page, 1);
  }
  for (const d of [30, 20, 12, 6, 3, 2, 1]) {
    await page.mouse.wheel(0, -d);
    await nextFrames(page, 1);
  }
}

async function host(
  page: Page,
  frame:
    | { readonly kind: "accept" | "turnStarted"; readonly messageId: string }
    | { readonly kind: "none" },
): Promise<void> {
  await page.evaluate((input) => {
    const driver = window.__followDriver;
    if (driver === undefined) throw new Error("no driver");
    if (input.kind !== "none") driver.host[input.kind](input.messageId);
  }, frame);
  await nextFrames(page, 1);
}

function raw(f: ChatFollowFrame): string {
  return `t=${String(f.t).padStart(5)} ${f.step.padEnd(7)} wheel=${String(f.wheel).padStart(5)} dist=${f.distance.toFixed(1).padStart(7)} top=${f.scrollTop.toFixed(0)} sh=${String(f.scrollHeight)} ch=${String(f.clientHeight)} dock=${f.dockHeight.toFixed(0)} mode=${f.mode} pill=${String(f.pill)} last=${f.lastRowKey}`;
}

interface SnapBack {
  readonly index: number;
  readonly px: number;
}

/** A frame moved the view toward the end with no wheel-down, in free mode. */
function snapBacks(frames: readonly ChatFollowFrame[]): SnapBack[] {
  const out: SnapBack[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const moved = frames[i].scrollTop - frames[i - 1].scrollTop;
    if (
      moved > 1 &&
      frames[i].wheel <= 0 &&
      frames[i].mode === "free-scrolling" &&
      frames[i - 1].mode === "free-scrolling"
    ) {
      out.push({ index: i, px: moved });
    }
  }
  return out;
}

function report(
  frames: readonly ChatFollowFrame[],
  snaps: readonly SnapBack[],
  afterBurstTop: number,
): string {
  const last = frames.at(-1);
  const first = snaps.at(0);
  const window =
    first === undefined
      ? []
      : frames.slice(Math.max(0, first.index - 14), first.index + 4).map(raw);
  return [
    `snap-backs: ${String(snaps.length)}, max ${String(Math.max(0, ...snaps.map((s) => s.px)))}px; scrollTop right after the burst ${afterBurstTop.toFixed(0)}, at rest ${String(last?.scrollTop)} (diff ${String((last?.scrollTop ?? 0) - afterBurstTop)}); at rest mode=${String(last?.mode)} dist=${String(last?.distance)}`,
    `wheel total ${String(frames.reduce((a, f) => a + f.wheel, 0))}`,
    first === undefined ? "" : "frames around the first snap-back:",
    ...window,
  ].join("\n");
}

for (const c of CASES) {
  test(`${c.name}: the reader stays where the wheel left them`, async ({
    page,
  }) => {
    await openScenario(page, c.setup === "stream-control" ? "running" : "idle");
    if (c.setup === "stream-control") {
      await page.evaluate(() => {
        window.__followDriver?.host.streamRich("earlier", 8, 40);
      });
      await page.waitForTimeout(600);
    }
    const scroller = page.getByTestId("chat-messages-scroll");
    const box = await scroller.boundingBox();
    if (box === null) throw new Error("no scroller box");
    if (c.setup === "send") {
      await page.getByRole("textbox").click();
      await page.keyboard.type("PROBE-PROMPT please continue PROBE-END");
    }
    await page.mouse.move(box.x + box.width / 2, box.y + 150);
    await startWatching(page);
    await mark(page, "enter");

    let messageId: string | null = null;
    if (c.setup === "send") {
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => window.__followDriver?.lastMessageId() !== null,
      );
      messageId = await page.evaluate(
        () => window.__followDriver?.lastMessageId() ?? null,
      );
      if (messageId === null) throw new Error("the composer sent nothing");
    }
    const nudged = (async () => {
      if (c.delayMs <= 16) await nextFrames(page, 1);
      else await page.waitForTimeout(c.delayMs);
      await nudge(page, c.shape);
    })();

    if (messageId !== null) {
      await nextFrames(page, 20);
      await mark(page, "accept");
      await host(page, { kind: "accept", messageId });
      await nextFrames(page, 20);
      await mark(page, "turn");
      await host(page, { kind: "turnStarted", messageId });
      await nextFrames(page, 20);
      await mark(page, "stream");
      await page.evaluate(() => {
        window.__followDriver?.host.streamRich("reply", 2, 40);
      });
    }
    await nudged;
    await nextFrames(page, 3);
    const afterBurstTop = (await probe(page)).scrollTop;
    await mark(page, "after");
    await page.waitForTimeout(c.setup === "send" ? 3500 : 2000);
    await page.evaluate(() => {
      window.__followDriver?.host.stopReply();
    });
    await nextFrames(page, 30);
    await page.waitForTimeout(300);
    const frames: ChatFollowFrame[] = await page.evaluate(() => {
      window.__followStop?.();
      return [...(window.__followFrames ?? [])];
    });
    const snaps = snapBacks(frames);
    const text = report(frames, snaps, afterBurstTop);
    const last = frames.at(-1);

    expect.soft(snaps.length, `no snap-back toward the end\n${text}`).toBe(0);
    expect
      .soft(last?.mode, `free-scrolling at rest\n${text}`)
      .toBe("free-scrolling");
    expect
      .soft(
        Math.abs((last?.scrollTop ?? 0) - afterBurstTop),
        `the view is where the last wheel left it\n${text}`,
      )
      .toBeLessThanOrEqual(2);
  });
}
