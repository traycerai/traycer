import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

// The reader is at the bottom of a long chat and sends a prompt. The
// transcript must keep following the bottom: the prompt stays in view, the
// reply appears below it, and the view follows as the reply streams. The
// fixture (`src/__tests__/browser/chat-send-follow.tsx`) plays the host over
// the real chat session store, dock and messages surface; this file presses
// Enter, drives the host frames and measures the scroll node frame by frame.

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

type ScenarioKind = "idle" | "background-only" | "activating" | "running";

const SINGLE = "PROBE-PROMPT one line PROBE-END";
const MULTI = [
  "PROBE-PROMPT first",
  "second line",
  "third line",
  "PROBE-END fourth",
];

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
  // Settle at the bottom like a reader who has arrived there.
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
    let running = true;
    window.__followStop = () => {
      running = false;
    };
    const t0 = performance.now();
    // The frame record is the reading taken in a message task posted from the
    // rAF callback: it runs after the rendering update, so it is what was
    // painted. The rAF-start reading (distanceA) still sees pre-render state.
    const channel = new MessageChannel();
    const pending: { t: number; step: string; distanceA: number }[] = [];
    channel.port1.onmessage = (): void => {
      const early = pending.shift();
      if (early === undefined || window.__followDriver === undefined) return;
      frames.push({
        ...window.__followDriver.probe(),
        t: early.t,
        step: early.step,
        wheel: 0,
        distanceA: early.distanceA,
      });
    };
    const tick = (): void => {
      if (!running) return;
      if (window.__followDriver !== undefined) {
        pending.push({
          t: Math.round(performance.now() - t0),
          step: window.__followStep ?? "",
          distanceA: window.__followDriver.probe().distance,
        });
        channel.port2.postMessage(0);
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

async function stopWatching(page: Page): Promise<ChatFollowFrame[]> {
  await nextFrames(page, 3);
  return page.evaluate(() => {
    window.__followStop?.();
    return [...(window.__followFrames ?? [])];
  });
}

async function typePrompt(page: Page, lines: readonly string[]): Promise<void> {
  await page.getByRole("textbox").click();
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(line);
  }
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

function frameChanged(f: ChatFollowFrame, prev: ChatFollowFrame): boolean {
  return (
    f.scrollHeight !== prev.scrollHeight ||
    f.clientHeight !== prev.clientHeight ||
    f.dockHeight !== prev.dockHeight ||
    f.mode !== prev.mode ||
    f.pill !== prev.pill ||
    f.rows !== prev.rows ||
    f.lastRowKey !== prev.lastRowKey ||
    f.distance > 1 !== prev.distance > 1 ||
    f.step !== prev.step
  );
}

function timeline(frames: readonly ChatFollowFrame[]): string {
  const first = frames.findIndex((f) => f.distance > 1);
  const flip = frames.findIndex((f) => f.mode !== "following-end");
  const steps = [...new Set(frames.map((f) => f.step))].map((step) => {
    const inStep = frames.filter((f) => f.step === step);
    const worst = Math.max(...inStep.map((f) => f.distance));
    const runs = offEndRuns(inStep);
    return `${step}: ${String(inStep.length)} frames, max dist ${worst.toFixed(1)}, painted off-end frames ${String(inStep.filter((f) => f.distance > 1).length)} (rAF-start reading, diagnostic: ${String(inStep.filter((f) => (f.distanceA ?? 0) > 1).length)}), longest off-end run ${String(runs.longestMs)}ms over ${String(runs.longestFrames)} frames, longest frame gap ${String(runs.maxGapMs)}ms, non-following ${String(inStep.filter((f) => f.mode !== "following-end").length)}`;
  });
  // Only the frames where something changed, with the frame before each.
  const rows: string[] = [];
  let shown = 0;
  frames.forEach((f, index) => {
    const prev = index === 0 ? null : frames[index - 1];
    const changed = prev === null || frameChanged(f, prev);
    if (!changed || shown >= 70) return;
    shown += 1;
    rows.push(
      `t=${String(f.t).padStart(5)} ${f.step.padEnd(7)} dist=${f.distance.toFixed(1).padStart(7)} top=${f.scrollTop.toFixed(0)} sh=${String(f.scrollHeight)} ch=${String(f.clientHeight)} dock=${f.dockHeight.toFixed(0)} mode=${f.mode} pill=${String(f.pill)} prompt=${f.promptTop?.toFixed(0) ?? "-"}..${f.promptBottom?.toFixed(0) ?? "-"} rows=${String(f.rows)} last=${f.lastRowKey}`,
    );
  });
  return [
    `first dist>1 at frame ${String(first)}${first >= 0 ? ` t=${String(frames[first].t)} (${frames[first].step}) sh=${String(frames[first].scrollHeight)} dock=${String(frames[first].dockHeight)}` : ""}`,
    `first mode flip at frame ${String(flip)}${flip >= 0 ? ` t=${String(frames[flip].t)}` : ""}`,
    ...steps,
    ...rows,
  ].join("\n");
}

/** Longest run of consecutive frames (in ms) farther than 1px from the end. */
function longestOffEndMs(frames: readonly ChatFollowFrame[]): number {
  return offEndRuns(frames).longestMs;
}

function offEndRuns(frames: readonly ChatFollowFrame[]): {
  longestMs: number;
  longestFrames: number;
  maxGapMs: number;
} {
  let longestMs = 0;
  let longestFrames = 0;
  let maxGapMs = 0;
  let start: number | null = null;
  let count = 0;
  frames.forEach((f, index) => {
    if (index > 0) maxGapMs = Math.max(maxGapMs, f.t - frames[index - 1].t);
    if (f.distance > 1) {
      start ??= f.t;
      count += 1;
      if (f.t - start > longestMs) {
        longestMs = f.t - start;
        longestFrames = count;
      }
    } else {
      start = null;
      count = 0;
    }
  });
  return { longestMs, longestFrames, maxGapMs };
}

const MANY = [
  "PROBE-PROMPT first",
  "line 2",
  "line 3",
  "line 4",
  "line 5",
  "line 6",
  "line 7",
  "PROBE-END line 8",
];

type Reply = "text" | "rich";

interface Case {
  readonly kind: ScenarioKind;
  readonly lines: readonly string[];
  readonly label: string;
  readonly reply: Reply;
  /** The earlier turn is streaming rich content when the send happens. */
  readonly earlierStreaming: boolean;
}

const CASES: readonly Case[] = [
  ...(["idle", "background-only", "activating", "running"] as const).flatMap(
    (kind): Case[] => [
      {
        kind,
        lines: [SINGLE],
        label: "one-line",
        reply: "text",
        earlierStreaming: false,
      },
      {
        kind,
        lines: MULTI,
        label: "multi-line",
        reply: "text",
        earlierStreaming: false,
      },
    ],
  ),
  ...(["idle", "running"] as const).flatMap((kind): Case[] => [
    {
      kind,
      lines: MANY,
      label: "8-line composer",
      reply: "text",
      earlierStreaming: false,
    },
    {
      kind,
      lines: [SINGLE],
      label: "one-line, rich reply",
      reply: "rich",
      earlierStreaming: false,
    },
    {
      kind,
      lines: MANY,
      label: "8-line composer, rich reply",
      reply: "rich",
      earlierStreaming: false,
    },
  ]),
  {
    kind: "running",
    lines: [SINGLE],
    label: "earlier reply still streaming",
    reply: "rich",
    earlierStreaming: true,
  },
  {
    kind: "running",
    lines: MANY,
    label: "8-line composer, earlier reply still streaming",
    reply: "rich",
    earlierStreaming: true,
  },
];

for (const c of CASES) {
  test(`${c.kind} / ${c.label}: sending at the bottom keeps following the prompt and the streaming reply`, async ({
    page,
  }) => {
    await openScenario(page, c.kind);
    if (c.earlierStreaming) {
      await page.evaluate(() => {
        window.__followDriver?.host.streamRich("earlier", 8, 40);
      });
      await page.waitForTimeout(600);
    }
    const dockBefore = (await probe(page)).dockHeight;
    await typePrompt(page, c.lines);
    await nextFrames(page, 5);
    const dockTyped = (await probe(page)).dockHeight;
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
    await nextFrames(page, 20);

    if (c.kind === "activating" || c.kind === "running") {
      await mark(page, "queued");
      await host(page, { kind: "queueAdded", messageId });
      await nextFrames(page, 10);
      await mark(page, "drain");
      await page.evaluate(() => {
        window.__followDriver?.host.stopReply();
      });
      await host(page, { kind: "earlierTurnEnded" });
      await host(page, { kind: "queueRemoved" });
    }
    await mark(page, "accept");
    await host(page, { kind: "accept", messageId });
    await nextFrames(page, 20);
    await mark(page, "turn");
    await host(page, { kind: "turnStarted", messageId });
    await nextFrames(page, 20);
    await mark(page, "stream");
    await page.evaluate((reply) => {
      if (reply === "rich")
        window.__followDriver?.host.streamRich("reply", 5, 40);
      else window.__followDriver?.host.streamReply(100, 40);
    }, c.reply);
    await page.waitForTimeout(c.reply === "rich" ? 6000 : 2000);
    await mark(page, "after");
    await page.evaluate(() => {
      window.__followDriver?.host.stopReply();
    });
    await nextFrames(page, 20);
    const frames = await stopWatching(page);
    const report = `dock: before typing ${String(dockBefore)}, typed ${String(dockTyped)}\n${timeline(frames)}`;

    const last = frames.at(-1);
    expect.soft(last?.distance, `at rest\n${report}`).toBeLessThanOrEqual(1);
    expect.soft(last?.mode, `mode at rest\n${report}`).toBe("following-end");
    expect.soft(last?.pill, `pill at rest\n${report}`).toBe(false);

    const drawn = frames.filter((f) => f.promptTop !== null);
    expect
      .soft(drawn.length, `the prompt is drawn in the transcript\n${report}`)
      .toBeGreaterThan(0);
    const hidden = drawn.filter(
      (f) =>
        f.promptBottom !== null &&
        f.promptBottom > f.clientHeight - f.dockHeight + 1,
    );
    expect
      .soft(
        hidden.length,
        `painted frames with the sent prompt under the dock (first at t=${String(hidden[0]?.t)})\n${report}`,
      )
      .toBe(0);

    const streaming = frames.filter((f) => f.step === "stream");
    expect
      .soft(
        streaming.filter((f) => f.distance > 1).length,
        `painted frames off the end while the reply streams\n${report}`,
      )
      .toBe(0);
    expect
      .soft(
        longestOffEndMs(streaming),
        `never more than ~300ms off the end while streaming\n${report}`,
      )
      .toBeLessThanOrEqual(300);
    expect
      .soft(
        streaming.filter((f) => f.mode !== "following-end").length,
        `mode stays following-end\n${report}`,
      )
      .toBe(0);
    expect
      .soft(
        frames.some((f) => f.pill),
        `pill never shows\n${report}`,
      )
      .toBe(false);
  });
}
