import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

// A2 of the snappy-send plan: what a person sees from Enter, in each state the
// chat can be in. The fixture (`src/__tests__/browser/chat-send-owns-turn.tsx`)
// plays the host over the real chat session store, rendered messages, the
// tile's messages surface and the real dock; this file only presses Enter,
// plays frames, and measures the DOM frame by frame.
//
// Claims only a real layout engine can decide live here: that the row is
// drawn on the first painted frame, that its verb, timer, icon and geometry do
// not move when the host's turn arrives, and that the prompt is on screen in
// every painted frame of a queue drain. Where a send goes and what a
// `pendingTurn` holds are Vitest cases next to the store.

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

type ScenarioKind = "idle" | "background-only" | "activating" | "running";

interface DriverProbe {
  readonly ready: boolean;
  readonly open: (kind: ScenarioKind) => void;
  readonly send: (text: string, options: { image: boolean }) => string;
  readonly lastMessageId: () => string | null;
  readonly host: {
    readonly accept: (messageId: string) => void;
    readonly turnStarted: (messageId: string) => void;
    readonly queueAdded: (messageId: string) => void;
    readonly queueRemoved: () => void;
    readonly earlierTurnEnded: () => void;
    readonly setupCreating: (messageId: string) => void;
  };
}

interface Frame {
  /** Text nodes equal to the prompt outside the composer's own editor. */
  readonly promptDrawn: number;
  /** The transcript copy's top, or `null` while only the dock draws it. */
  readonly promptTop: number | null;
  readonly now: number;
  readonly working: {
    readonly verb: string;
    readonly timerSeconds: number;
    readonly icon: string;
    readonly top: number;
    readonly height: number;
    /** The shimmer's sweep position, 0 to 1, from its inline background. */
    readonly shimmerPhase: number | null;
  } | null;
}

declare global {
  interface Window {
    __send?: DriverProbe;
    __frames?: Frame[];
    __stopWatching?: () => void;
  }
}

const PROMPT = "Please refactor the parser";

async function openScenario(page: Page, kind: ScenarioKind): Promise<void> {
  await page.goto(fixture("chat-send-owns-turn"));
  await page.waitForFunction(() => window.__send?.ready === true);
  await page.evaluate((scenario) => {
    window.__send?.open(scenario);
  }, kind);
  await nextFrames(page, 2);
}

/**
 * Starts recording one reading per painted frame until `stopWatching`. The
 * reading is taken in the frame's own callback, so it is exactly what was
 * about to be painted.
 */
async function startWatching(page: Page, prompt: string): Promise<void> {
  await page.evaluate((text) => {
    const frames: Frame[] = [];
    window.__frames = frames;
    let running = true;
    window.__stopWatching = () => {
      running = false;
    };
    const parseSeconds = (raw: string): number => {
      const minutes = /(\d+)m/.exec(raw);
      const seconds = /(\d+)s/.exec(raw);
      return Number(minutes?.[1] ?? 0) * 60 + Number(seconds?.[1] ?? 0);
    };
    const readPrompt = (): Pick<Frame, "promptDrawn" | "promptTop"> => {
      let promptDrawn = 0;
      let promptTop: number | null = null;
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() !== text) continue;
        const parent = node.parentElement;
        if (parent === null || parent.closest('[contenteditable="true"]')) {
          continue;
        }
        promptDrawn += 1;
        if (parent.closest('[data-testid="chat-messages-scroll"]') !== null) {
          promptTop = parent.getBoundingClientRect().top;
        }
      }
      return { promptDrawn, promptTop };
    };
    const read = (): Frame => {
      const { promptDrawn, promptTop } = readPrompt();
      const indicator = document.querySelector(
        '[data-testid="assistant-run-indicator"]',
      );
      const now = Date.now();
      if (indicator === null) {
        return { promptDrawn, promptTop, now, working: null };
      }
      const shimmer = indicator.querySelector<HTMLElement>(
        ".working-text-shimmer",
      );
      const sweep = /(-?[\d.]+)%/.exec(shimmer?.style.backgroundPosition ?? "");
      const rect = indicator.getBoundingClientRect();
      const words = indicator.querySelector("span")?.textContent ?? "";
      const timer = /\(([^)]*)\)/.exec(indicator.textContent);
      return {
        promptDrawn,
        promptTop,
        now,
        working: {
          verb: words.replace(/[.…]+$/, "").trim(),
          timerSeconds: parseSeconds(timer?.[1] ?? ""),
          icon: indicator.querySelector("svg, img")?.outerHTML ?? "",
          top: rect.top,
          height: rect.height,
          shimmerPhase: sweep === null ? null : (150 - Number(sweep[1])) / 200,
        },
      };
    };
    const tick = (): void => {
      if (!running) return;
      frames.push(read());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, prompt);
}

async function stopWatching(page: Page): Promise<Frame[]> {
  await nextFrames(page, 3);
  return page.evaluate(() => {
    window.__stopWatching?.();
    return [...(window.__frames ?? [])];
  });
}

/** Types the prompt into the real composer and presses Enter. */
async function typeAndPressEnter(page: Page): Promise<string> {
  await page.getByRole("textbox").click();
  await page.keyboard.type(PROMPT);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__send?.lastMessageId() !== null);
  const messageId = await page.evaluate(
    () => window.__send?.lastMessageId() ?? null,
  );
  if (messageId === null) throw new Error("the composer sent nothing");
  return messageId;
}

/** An image send goes straight to the store: there is no way to paste one here. */
async function sendImage(page: Page): Promise<string> {
  return page.evaluate((text) => {
    const sent = window.__send;
    if (sent === undefined) throw new Error("no driver");
    return sent.send(text, { image: true });
  }, PROMPT);
}

async function host(
  page: Page,
  frame:
    | {
        readonly kind:
          | "accept"
          | "turnStarted"
          | "setupCreating"
          | "queueAdded";
        readonly messageId: string;
      }
    | { readonly kind: "queueRemoved" | "earlierTurnEnded" },
): Promise<void> {
  await page.evaluate((input) => {
    const driver = window.__send;
    if (driver === undefined) throw new Error("no driver");
    if ("messageId" in input) driver.host[input.kind](input.messageId);
    else if (input.kind === "queueRemoved") driver.host.queueRemoved();
    else driver.host.earlierTurnEnded();
  }, frame);
  await nextFrames(page, 1);
}

async function runState(page: Page): Promise<string | null> {
  return page.getByTestId("probe-run-state").textContent();
}

async function firstFrameAfterEnter(
  page: Page,
  options: { readonly image: boolean },
): Promise<{ messageId: string; frames: Frame[] }> {
  if (options.image) {
    await startWatching(page, PROMPT);
    const messageId = await sendImage(page);
    return { messageId, frames: await stopWatching(page) };
  }
  await page.getByRole("textbox").click();
  await page.keyboard.type(PROMPT);
  await startWatching(page, PROMPT);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__send?.lastMessageId() !== null);
  const messageId = await page.evaluate(
    () => window.__send?.lastMessageId() ?? null,
  );
  if (messageId === null) throw new Error("the composer sent nothing");
  return { messageId, frames: await stopWatching(page) };
}

/** From the first frame that draws the prompt, no frame may lose it. */
function expectNeverUndrawn(frames: ReadonlyArray<Frame>): void {
  const start = frames.findIndex((frame) => frame.promptDrawn >= 1);
  expect(start, "the prompt is drawn at some point").toBeGreaterThanOrEqual(0);
  expect(frames.slice(start).map((frame) => frame.promptDrawn)).not.toContain(
    0,
  );
}

function expectDrawnWithWorkingRow(frames: ReadonlyArray<Frame>): void {
  const first = frames.find((frame) => frame.promptDrawn > 0);
  expect(first, "the prompt is drawn").toBeDefined();
  expect(
    first?.working,
    "with its working row on the same frame",
  ).not.toBeNull();
  expect(first?.working?.icon).not.toBe("");
  expect(first?.working?.verb.length).toBeGreaterThan(0);
  expect(first?.working?.timerSeconds).toBe(0);
}

for (const kind of ["idle", "background-only"] as const) {
  test(`${kind}: the first painted frame after Enter shows the prompt and a fully populated working row`, async ({
    page,
  }) => {
    await openScenario(page, kind);

    const { frames } = await firstFrameAfterEnter(page, { image: false });

    expectDrawnWithWorkingRow(frames);
    expect(await runState(page)).toBe("running");
  });
}

test("an image send draws the prompt, with its picture, and the working row on the first frame", async ({
  page,
}) => {
  await openScenario(page, "idle");

  const { frames } = await firstFrameAfterEnter(page, { image: true });

  expectDrawnWithWorkingRow(frames);
  await expect(
    page.locator(
      '[data-testid="chat-messages-scroll"] [data-composer-chip="image-attachment"]',
    ),
  ).toHaveCount(1);
});

test("a worktree-creating send keeps its setup card above the prompt and the working row below it", async ({
  page,
}) => {
  await openScenario(page, "idle");
  const messageId = await typeAndPressEnter(page);
  await host(page, { kind: "setupCreating", messageId });

  const order = await page.evaluate((text) => {
    const card = document.querySelector('[data-testid="setup-card"]');
    const indicator = document.querySelector(
      '[data-testid="assistant-run-indicator"]',
    );
    const prompt = [...document.querySelectorAll("*")].find(
      (element) =>
        element.children.length === 0 && element.textContent.trim() === text,
    );
    return {
      card: card?.getBoundingClientRect().top ?? null,
      prompt: prompt?.getBoundingClientRect().top ?? null,
      indicator: indicator?.getBoundingClientRect().top ?? null,
    };
  }, PROMPT);

  expect(order.card).not.toBeNull();
  expect(order.prompt).not.toBeNull();
  expect(order.card ?? 0).toBeLessThan(order.prompt ?? 0);
  expect(
    order.indicator === null || order.indicator > (order.prompt ?? 0),
  ).toBe(true);
});

for (const arrival of ["accept first", "turn first"] as const) {
  test(`idle: verb, timer origin, icon and geometry are unchanged when the host's turn arrives (${arrival})`, async ({
    page,
  }) => {
    await openScenario(page, "idle");
    const messageId = await typeAndPressEnter(page);
    await expect
      .poll(async () => {
        const row = await page.evaluate(
          () =>
            /\((\d+)s\)/.exec(
              document.querySelector('[data-testid="assistant-run-indicator"]')
                ?.textContent ?? "",
            )?.[1] ?? null,
        );
        return row === null ? 0 : Number(row);
      })
      .toBeGreaterThanOrEqual(1);
    // Land the arrival mid-sweep, so a restarted animation would visibly jump.
    await page.waitForFunction(() => {
      const shimmer = document.querySelector<HTMLElement>(
        '[data-testid="assistant-run-indicator"] .working-text-shimmer',
      );
      const sweep = /(-?[\d.]+)%/.exec(shimmer?.style.backgroundPosition ?? "");
      if (sweep === null) return false;
      const phase = (150 - Number(sweep[1])) / 200;
      return phase > 0.3 && phase < 0.6;
    });
    await startWatching(page, PROMPT);

    if (arrival === "accept first") {
      await host(page, { kind: "accept", messageId });
      await host(page, { kind: "turnStarted", messageId });
    } else {
      await host(page, { kind: "turnStarted", messageId });
      await host(page, { kind: "accept", messageId });
    }
    const frames = await stopWatching(page);

    const workingFrames = frames.flatMap((frame) =>
      frame.working === null ? [] : [frame.working],
    );
    expect(workingFrames.length, "a working row in every frame").toBe(
      frames.length,
    );
    const first = frames[0];
    for (const frame of frames) {
      const working = frame.working;
      if (working === null || first.working === null) continue;
      expect(working.verb).toBe(first.working.verb);
      expect(working.icon).toBe(first.working.icon);
      expect(working.timerSeconds).toBeGreaterThanOrEqual(1);
      expect(Math.abs(working.height - first.working.height)).toBeLessThan(0.5);
      if (frame.promptTop !== null && first.promptTop !== null) {
        // Below its own prompt by the same distance, whichever row key draws it.
        expect(
          Math.abs(
            working.top -
              frame.promptTop -
              (first.working.top - first.promptTop),
          ),
        ).toBeLessThan(0.5);
      }
    }
    // The sweep carries on through the remount: between two frames it moves
    // by the time elapsed, never back to a fresh start.
    for (let index = 1; index < frames.length; index += 1) {
      const before = frames[index - 1].working?.shimmerPhase;
      const after = frames[index].working?.shimmerPhase;
      if (typeof before !== "number" || typeof after !== "number") continue;
      const elapsed = (frames[index].now - frames[index - 1].now) / 2200;
      const moved = (((after - before) % 1) + 1) % 1;
      const drift = Math.abs(((moved - elapsed + 1.5) % 1) - 0.5);
      expect(drift).toBeLessThan(0.1);
    }
    expectNeverUndrawn(frames);
  });
}

for (const kind of ["activating", "running"] as const) {
  test(`${kind}: the prompt waits in the dock and the transcript has no copy of it yet, then a drain with the queue item leaving first never leaves it undrawn`, async ({
    page,
  }) => {
    await openScenario(page, kind);
    const messageId = await typeAndPressEnter(page);
    await startWatching(page, PROMPT);
    await host(page, { kind: "queueAdded", messageId });
    await nextFrames(page, 2);

    const waiting = await page.evaluate(() => [...(window.__frames ?? [])]);
    expect(waiting.at(-1)?.promptDrawn).toBe(1);
    // Only the dock draws it; the transcript has no copy and no row of its own.
    expect(waiting.at(-1)?.promptTop).toBeNull();
    expect(await runState(page)).toBe("running");

    await host(page, { kind: "earlierTurnEnded" });
    await host(page, { kind: "queueRemoved" });
    await host(page, { kind: "accept", messageId });
    await host(page, { kind: "turnStarted", messageId });
    const frames = await stopWatching(page);

    expectNeverUndrawn(frames);
    expect(frames.at(-1)?.working).not.toBeNull();
  });

  test(`${kind}: a drain where the saved row lands before the queue item leaves never leaves the prompt undrawn`, async ({
    page,
  }) => {
    await openScenario(page, kind);
    const messageId = await typeAndPressEnter(page);
    await startWatching(page, PROMPT);
    await host(page, { kind: "queueAdded", messageId });

    await host(page, { kind: "earlierTurnEnded" });
    await host(page, { kind: "accept", messageId });
    await host(page, { kind: "queueRemoved" });
    await host(page, { kind: "turnStarted", messageId });
    const frames = await stopWatching(page);

    expectNeverUndrawn(frames);
    expect(frames.at(-1)?.working).not.toBeNull();
  });
}
