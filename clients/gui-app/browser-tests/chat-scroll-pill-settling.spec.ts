import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures";
import { expectAtRest, startTimeline } from "./support/chat-scroll-oracle";

/**
 * The "Scroll to end" pill clicked while LegendList is kept "settling" by
 * key-sequence commits (a new turn every 250/400ms) under a 16ms paragraph
 * stream. Before the click it logs whether the list is settling (read off the
 * list's state through the React fiber); after it, how long scrollTop took to
 * move and how many scrollToEnd commands the list received.
 */

interface ListState {
  didDataChange: boolean;
  scheduledWork: { has: (key: string) => boolean };
  ignoreScrollFromMVCP: unknown;
  pendingScrollToEnd: unknown;
}

interface Frame {
  readonly t: number;
  readonly scrollTop: number;
  readonly fromEnd: number;
  readonly mode: string | null;
  readonly pill: boolean;
  readonly settling: boolean;
}

interface Hook {
  /** `scrollend` times on the scroll node, `performance.now()`. */
  scrollEnds: number[];
  /** Every change of `data-scroll-mode`, `performance.now()`. */
  flips: { at: number; mode: string | null }[];
  settling: () => boolean;
  commands: () => number;
  clickAt: () => number | null;
  frames: Frame[];
  stop: () => void;
}

declare global {
  interface Window {
    __pillHook?: Hook;
    __pillTurnTimer?: number;
  }
}

/** Finds the list's state through the fiber of the scroll node and counts
 *  each assignment of `state.pendingScrollToEnd` (one per scrollToEnd). */
async function installHook(page: Page): Promise<void> {
  await page.evaluate(() => {
    const node = document.querySelector('[data-testid="chat-messages-scroll"]');
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

    let commandCount = 0;
    let current = listState.pendingScrollToEnd;
    Object.defineProperty(listState, "pendingScrollToEnd", {
      configurable: true,
      get: () => current,
      set: (next: unknown) => {
        if (next !== undefined && next !== null) commandCount += 1;
        current = next;
      },
    });
    const settling = (): boolean =>
      listState.didDataChange ||
      listState.scheduledWork.has("mvcpRecalculate") ||
      listState.ignoreScrollFromMVCP !== undefined;

    const click: { at: number | null } = { at: null };
    document.addEventListener(
      "click",
      () => {
        click.at ??= performance.now();
      },
      true,
    );
    const scrollEnds: number[] = [];
    node.addEventListener("scrollend", () => {
      scrollEnds.push(performance.now());
    });
    const flips: { at: number; mode: string | null }[] = [];
    new MutationObserver(() => {
      flips.push({
        at: performance.now(),
        mode: node.getAttribute("data-scroll-mode"),
      });
    }).observe(node, {
      attributes: true,
      attributeFilter: ["data-scroll-mode"],
    });
    const frames: Frame[] = [];
    let running = true;
    const tick = (): void => {
      if (!running) return;
      const probe = window.__chatScrollProbe;
      const g = probe.geometry();
      if (g !== null) {
        frames.push({
          t: Math.round(performance.now()),
          scrollTop: Math.round(g.scrollTop),
          fromEnd: Math.round(g.scrollHeight - g.clientHeight - g.scrollTop),
          mode: probe.mode(),
          pill: probe.pillShown(),
          settling: settling(),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__pillHook = {
      scrollEnds,
      flips,
      settling,
      commands: () => commandCount,
      clickAt: () => click.at,
      frames,
      stop: () => {
        running = false;
      },
    };
  });
}

const CASES = [
  {
    name: "a: turn every 250ms, 1500px",
    turnMs: 250,
    upPx: 1500,
    stopMs: 3000,
  },
  {
    name: "b: turn every 400ms, 1500px",
    turnMs: 400,
    upPx: 1500,
    stopMs: 3000,
  },
  { name: "c: turn every 250ms, 300px", turnMs: 250, upPx: 300, stopMs: 3000 },
  {
    name: "d: as a, stream stops 50ms after the click",
    turnMs: 250,
    upPx: 1500,
    stopMs: 50,
  },
] as const;

for (const c of CASES) {
  test(`the pill while the list keeps settling: ${c.name}`, async ({
    page,
  }) => {
    await page.goto(fixture("chat-scroll-model"));
    await nextFrames(page, 30);
    await expect
      .poll(() => page.evaluate(() => window.__chatScrollProbe.mode()))
      .toBe("following-end");
    const stopTimeline = await startTimeline(page);
    await installHook(page);

    await page.evaluate((turnMs) => {
      const probe = window.__chatScrollProbe;
      probe.startParagraphStream(16);
      window.__pillTurnTimer = window.setInterval(
        () => probe.appendTurn(),
        turnMs,
      );
    }, c.turnMs);
    await page.waitForTimeout(600);
    await page.mouse.move(195, 350);
    const steps = Math.ceil(c.upPx / 500);
    for (let i = 0; i < steps; i += 1) {
      await page.mouse.wheel(0, -Math.min(500, c.upPx - i * 500));
      await nextFrames(page, 2);
    }
    await page.waitForTimeout(400);
    await expect
      .poll(() => page.evaluate(() => window.__chatScrollProbe.pillShown()))
      .toBe(true);

    const before = await page.evaluate(() => {
      const hook = window.__pillHook;
      if (hook === undefined) throw new Error("hook missing");
      const recent = hook.frames.slice(-30);
      return {
        settlingNow: hook.settling(),
        settlingFrames: recent.filter((f) => f.settling).length,
        recentFrames: recent.length,
        commands: hook.commands(),
      };
    });
    await page.locator('[aria-label="Scroll to end"]').click();
    await page.waitForTimeout(c.stopMs);
    await page.evaluate(() => {
      window.__chatScrollProbe.stopStream();
      window.clearInterval(window.__pillTurnTimer);
    });
    // The stream is off: let any pill work in flight finish before reading.
    await page.waitForTimeout(c.stopMs === 3000 ? 0 : 2000);
    const result = await page.evaluate(() => {
      const hook = window.__pillHook;
      if (hook === undefined) throw new Error("hook missing");
      hook.stop();
      return {
        frames: hook.frames,
        clickAt: hook.clickAt(),
        commands: hook.commands(),
        scrollEnds: hook.scrollEnds,
        flips: hook.flips,
      };
    });

    const clickAt = result.clickAt ?? Number.POSITIVE_INFINITY;
    const after = result.frames.filter((f) => f.t >= clickAt);
    const atClick = after.at(0);
    const moved =
      atClick === undefined
        ? undefined
        : after.find((f) => Math.abs(f.scrollTop - atClick.scrollTop) > 2);
    const gaveUp = after.findIndex((f, i) => {
      const previous = after.at(i - 1);
      return (
        i > 0 &&
        previous !== undefined &&
        f.mode === "free-scrolling" &&
        f.pill &&
        f.scrollTop > previous.scrollTop
      );
    });
    const rel = (at: number): number => Math.round(at - clickAt);
    const endsAfter = result.scrollEnds.filter((t) => t >= clickAt).map(rel);
    const flipsAfter = result.flips
      .filter((f) => f.at >= clickAt)
      .map((f) => ({ at: rel(f.at), mode: f.mode }));
    const firstFree = flipsAfter.find((f) => f.mode === "free-scrolling");
    const fourth = endsAfter.at(3);
    process.stdout.write(
      `PILLTIMING ${c.name}: scrollends(ms after click)=[${endsAfter.slice(0, 8).join(",")}] ` +
        `flips=[${flipsAfter
          .slice(0, 6)
          .map((f) => `${String(f.mode)}@${String(f.at)}`)
          .join(",")}] ` +
        `firstFreeFlip=${firstFree === undefined ? "none" : String(firstFree.at)} fourthScrollend=${fourth === undefined ? "none" : String(fourth)}\n`,
    );
    process.stdout.write(
      `PILLSETTLE ${c.name}: settlingBefore=${String(before.settlingNow)} (${String(before.settlingFrames)}/${String(before.recentFrames)} frames) ` +
        `commandsBefore=${String(before.commands)} commandsAfter=${String(result.commands - before.commands)} ` +
        `clickToFirstMoveMs=${moved === undefined ? "never" : String(moved.t - clickAt)} ` +
        `freePillWhileMoving=${gaveUp === -1 ? "no" : "YES"}\n`,
    );
    try {
      await expectAtRest(
        page,
        { kind: "tail" },
        "after the pill and the stream stopped",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const anchor =
        gaveUp === -1
          ? after.findIndex((f) => f.mode === "free-scrolling")
          : gaveUp;
      const window_ = after
        .slice(Math.max(0, anchor - 6), anchor + 24)
        .map(
          (f) =>
            `${String(Math.round(f.t - clickAt))}ms top=${String(f.scrollTop)} fromEnd=${String(f.fromEnd)} ${String(f.mode)} pill=${String(f.pill)} settling=${String(f.settling)}`,
        )
        .join("\n");
      const timeline = (await stopTimeline()).split("\n").slice(-30).join("\n");
      throw new Error(
        `${message}\n--- frames around the first free frame after the click (index ${String(anchor)}) ---\n${window_}\n--- last 30 timeline changes ---\n${timeline}`,
      );
    }
  });
}
