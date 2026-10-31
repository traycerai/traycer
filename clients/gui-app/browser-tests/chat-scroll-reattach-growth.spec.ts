import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames, wheelsDelivered } from "./support/fixtures";
import {
  readView,
  settle,
  type ChatScrollView,
} from "./support/chat-scroll-oracle";

/**
 * A reader stops a little short of
 * the end with a toward-end wheel (which records a reattach candidate at the
 * end as it was then), and with no further input a row FULLY ABOVE the
 * viewport grows: the list's MVCP compensation raises scrollTop by the growth,
 * so the reader crosses the old candidate target without moving. They must
 * stay where they were: free, with the pill, same distance from the end, same
 * reading row. The control stops the reader further from the end than the
 * growth, so the old target is out of reach.
 */

const SCROLL = '[data-testid="chat-messages-scroll"]';
/** The only reasoning card in the fixture is the one `appendTallCardTurn`
 *  adds. Its activity-group header reads "Thought for Ns": the legacy line
 *  seeds a fixed 4000ms duration, the windowed line derives a different one
 *  from its own timestamps, so match the label's content, not a duration. */
const CARD = 'button[aria-label^="Thought for "]';

interface ListState {
  scheduledWork: { has: (key: string) => boolean };
  pendingScrollToEnd: unknown;
}

interface Frame {
  readonly t: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly fromEnd: number;
  readonly mode: string | null;
  readonly pill: boolean;
  readonly reading: string;
}

interface Hook {
  commands: () => number;
  commandTimes: number[];
  frames: Frame[];
  stop: () => void;
}

declare global {
  interface Window {
    __growthHook?: Hook;
  }
}

async function open(page: Page, line: "legacy" | "windowed"): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(
    `${fixture("chat-scroll-model")}${line === "windowed" ? "?line=windowed" : ""}`,
  );
  await nextFrames(page, 30);
}

/** Counts each `scrollToEnd` the list receives (the assignment of
 *  `state.pendingScrollToEnd`) and records one reading per frame. */
async function installHook(page: Page): Promise<void> {
  await page.evaluate((scroll) => {
    const node = document.querySelector(scroll);
    if (node === null) throw new Error("no scroll node");
    const fiberKey = Object.keys(node).find((key) =>
      key.startsWith("__reactFiber$"),
    );
    if (fiberKey === undefined) throw new Error("no fiber on the scroll node");
    interface FiberLike {
      return: FiberLike | null;
      memoizedProps?: { value?: { state?: ListState } };
    }
    const isFiber = (value: unknown): value is FiberLike =>
      typeof value === "object" && value !== null && "return" in value;
    const raw: unknown = Reflect.get(node, fiberKey);
    let fiber: FiberLike | null = isFiber(raw) ? raw : null;
    let state: ListState | undefined;
    while (fiber !== null && state === undefined) {
      const value = fiber.memoizedProps?.value;
      if (value?.state?.scheduledWork !== undefined) state = value.state;
      fiber = fiber.return;
    }
    if (state === undefined)
      throw new Error("no list state found through the fiber");
    const listState = state;
    let count = 0;
    const commandTimes: number[] = [];
    let current = listState.pendingScrollToEnd;
    Object.defineProperty(listState, "pendingScrollToEnd", {
      configurable: true,
      get: () => current,
      set: (next: unknown) => {
        if (next !== undefined && next !== null) {
          count += 1;
          commandTimes.push(performance.now());
        }
        current = next;
      },
    });
    const frames: Frame[] = [];
    const t0 = performance.now();
    let running = true;
    const tick = (): void => {
      if (!running) return;
      const probe = window.__chatScrollProbe;
      const g = probe.geometry();
      if (g !== null) {
        const reading = probe.readingRow();
        frames.push({
          t: Math.round(performance.now() - t0),
          scrollTop: Math.round(g.scrollTop),
          scrollHeight: Math.round(g.scrollHeight),
          fromEnd: Math.round(g.scrollHeight - g.clientHeight - g.scrollTop),
          mode: probe.mode(),
          pill: probe.pillShown(),
          reading: `${String(reading?.messageId)}@${(reading?.offset ?? 0).toFixed(0)}`,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__growthHook = {
      commands: () => count,
      commandTimes,
      frames,
      stop: () => {
        running = false;
      },
    };
  }, SCROLL);
}

/** `messageId@offset` for a reading row, or `null@0` when there is none. */
function readingLabel(reading: ChatScrollView["reading"]): string {
  return `${String(reading?.messageId)}@${(reading?.offset ?? 0).toFixed(0)}`;
}

function changes(frames: readonly Frame[]): string {
  const lines: string[] = [];
  let previous = "";
  for (const f of frames) {
    const key = `${String(f.scrollTop)}|${String(f.scrollHeight)}|${String(f.mode)}|${String(f.pill)}|${f.reading}`;
    if (key === previous) continue;
    previous = key;
    lines.push(
      `${String(f.t).padStart(5)}ms top=${String(f.scrollTop)} h=${String(f.scrollHeight)} fromEnd=${String(f.fromEnd)} ${String(f.mode)} pill=${String(f.pill)} reading=${f.reading}`,
    );
  }
  return lines.slice(0, 60).join("\n");
}

/** Row geometry relative to the scroll node: bottom of the card's row and the
 *  row's height, or null when the row is not mounted. */
async function rowBox(
  page: Page,
): Promise<{ bottom: number; height: number } | null> {
  return page.evaluate(
    ([scroll, card]) => {
      const node = document.querySelector(scroll);
      const el = document.querySelector(card)?.closest("[data-message-id]");
      if (node === null || el === null || el === undefined) return null;
      const n = node.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { bottom: r.bottom - n.top, height: r.height };
    },
    [SCROLL, CARD] as const,
  );
}

const CASES = [
  {
    kind: "R5 (stops 200px short)",
    shortPx: 200,
    turns: Number(process.env.R5_TURNS ?? 4),
  },
  {
    kind: "control (stops 1000px short)",
    shortPx: 1000,
    turns: Number(process.env.CTRL_TURNS ?? 7),
  },
] as const;

/** Opens the chat, mounts the card turn with `turns` short turns below it, and
 *  walks the reader up and back down so a toward-end wheel leaves them
 *  `shortPx` short of the end. Returns the settled view. */
async function standShort(
  page: Page,
  line: "legacy" | "windowed",
  turns: number,
  shortPx: number,
): Promise<ChatScrollView> {
  await open(page, line);
  await page.evaluate((count) => {
    window.__chatScrollProbe.appendTallCardTurn();
    for (let i = 0; i < count; i += 1) window.__chatScrollProbe.appendTurn();
  }, turns);
  await nextFrames(page, 60);
  await settle(page, 12);
  const box = await page.locator(SCROLL).boundingBox();
  if (box === null) throw new Error("no scroll box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await wheelsDelivered(
    page,
    Array.from({ length: 3 }, () => ({ deltaX: 0, deltaY: -500 })),
    10,
  );
  await nextFrames(page, 10);
  await settle(page, 12);
  for (let i = 0; i < 12; i += 1) {
    const view = await readView(page);
    const remaining = view.fromEnd - shortPx;
    if (remaining <= 12) break;
    await wheelsDelivered(
      page,
      [{ deltaX: 0, deltaY: Math.min(remaining, 300) }],
      0,
    );
    await nextFrames(page, 10);
  }
  return settle(page, 12);
}

for (const line of ["legacy", "windowed"] as const) {
  for (const c of CASES) {
    test(`${line}: growth above the viewport after a toward-end wheel, ${c.kind}`, async ({
      page,
    }) => {
      const before = await standShort(page, line, c.turns, c.shortPx);
      const setup = `setup: fromEnd=${before.fromEnd.toFixed(0)} mode=${String(before.mode)} pill=${String(before.pill)} reading=${readingLabel(before.reading)}`;
      expect(
        [before.mode, before.pill, Math.abs(before.fromEnd - c.shortPx) <= 40],
        `${setup}: the reader should be free, with the pill, ${String(c.shortPx)}px short`,
      ).toEqual(["free-scrolling", true, true]);
      const rowBefore = await rowBox(page);
      expect(
        rowBefore,
        `${setup}: the card's row is not mounted`,
      ).not.toBeNull();
      expect(
        rowBefore?.bottom ?? 0,
        `${setup}: the card's row is not fully above the viewport`,
      ).toBeLessThanOrEqual(0);

      await installHook(page);
      const commandsBefore = await page.evaluate(
        () => window.__growthHook?.commands() ?? 0,
      );
      await page.evaluate((card) => {
        const button = document.querySelector<HTMLElement>(card);
        if (button === null) throw new Error("card button missing");
        button.click();
      }, CARD);
      await page.waitForTimeout(1000);
      const result = await page.evaluate(() => {
        const hook = window.__growthHook;
        if (hook === undefined) throw new Error("hook missing");
        hook.stop();
        return { frames: hook.frames, commands: hook.commands() };
      });
      const after = await readView(page);
      const rowAfter = await rowBox(page);
      const growth =
        rowBefore !== null && rowAfter !== null
          ? rowAfter.height - rowBefore.height
          : Number.NaN;
      const report = `${setup}; row grew by ${growth.toFixed(0)}px; after: fromEnd=${after.fromEnd.toFixed(0)} mode=${String(after.mode)} pill=${String(after.pill)} reading=${readingLabel(after.reading)}; scrollToEnd calls=${String(result.commands - commandsBefore)}`;
      process.stdout.write(`REATTACH ${line} ${c.kind}: ${report}\n`);
      const message = `${report}\n--- frame changes from the click ---\n${changes(result.frames)}`;

      expect(growth, `the card did not grow\n${message}`).toBeGreaterThan(100);
      expect(after.mode, `mode\n${message}`).toBe("free-scrolling");
      expect(after.pill, `pill\n${message}`).toBe(true);
      expect(
        Math.abs(after.fromEnd - before.fromEnd),
        `fromEnd moved\n${message}`,
      ).toBeLessThanOrEqual(3);
      if (before.reading === null || after.reading === null)
        throw new Error(`no reading row to compare\n${message}`);
      expect(after.reading.messageId, `reading row\n${message}`).toBe(
        before.reading.messageId,
      );
      expect(
        Math.abs(after.reading.offset - before.reading.offset),
        `reading offset\n${message}`,
      ).toBeLessThanOrEqual(2);
    });
  }
}

/** A reader who really reaches the end must still reattach: the shift the
 *  list put on them must not stop the genuine arrival from counting. */
for (const line of ["legacy", "windowed"] as const) {
  test(`${line}: a wheel the rest of the way to the end reattaches (no growth)`, async ({
    page,
  }) => {
    const before = await standShort(page, line, 4, 200);
    expect(before.mode, `fromEnd=${before.fromEnd.toFixed(0)}`).toBe(
      "free-scrolling",
    );
    await wheelsDelivered(
      page,
      [{ deltaX: 0, deltaY: Math.round(before.fromEnd) }],
      0,
    );
    await nextFrames(page, 10);
    const after = await settle(page, 12);
    const report = `reach: from ${before.fromEnd.toFixed(0)} short -> fromEnd=${after.fromEnd.toFixed(0)} mode=${String(after.mode)} pill=${String(after.pill)}`;
    process.stdout.write(`REATTACH ${line} ${report}\n`);
    expect([after.mode, after.pill, after.fromEnd <= 1], report).toEqual([
      "following-end",
      false,
      true,
    ]);
  });

  test(`${line}: a wheel to the end after growth above reattaches`, async ({
    page,
  }) => {
    const before = await standShort(page, line, 4, 200);
    await page.evaluate((card) => {
      document.querySelector<HTMLElement>(card)?.click();
    }, CARD);
    await page.waitForTimeout(1000);
    const grown = await readView(page);
    // On the fixed tree the reader is still free here; on the unfixed tree
    // the growth may already have pulled them to the tail.
    const wheeled = grown.mode === "free-scrolling";
    if (wheeled) {
      await wheelsDelivered(
        page,
        [{ deltaX: 0, deltaY: Math.round(grown.fromEnd) }],
        0,
      );
      await nextFrames(page, 10);
    }
    const after = await settle(page, 12);
    const report = `reach after growth: stopped ${before.fromEnd.toFixed(0)} short; after growth fromEnd=${grown.fromEnd.toFixed(0)} mode=${String(grown.mode)} (wheeled=${String(wheeled)}) -> fromEnd=${after.fromEnd.toFixed(0)} mode=${String(after.mode)} pill=${String(after.pill)}`;
    process.stdout.write(`REATTACH ${line} ${report}\n`);
    expect([after.mode, after.pill, after.fromEnd <= 1], report).toEqual([
      "following-end",
      false,
      true,
    ]);
  });
}
