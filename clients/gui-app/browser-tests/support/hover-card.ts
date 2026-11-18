import type { Locator, Page } from "@playwright/test";

import { centreOf, type Point, nextFrames } from "./fixtures.ts";

/**
 * Page-side probes and windows for the hover card specs.
 *
 * Everything here observes the REAL cards (`components/ui/hover-card.tsx`)
 * from inside the page, in the frame loop, because the two claims left to a
 * browser are about what is PAINTED (never two cards in one frame) and about
 * what real input and focus modality do (a press, a wheel, Tab). Claims that
 * are logic - the delays, the hand-off, the group - are jsdom tests next to
 * the component (`components/ui/__tests__/hover-card.test.tsx`).
 */

/** The card and label-chip content, whichever appearance the caller asked for. */
export const HOVER_CARD = '[data-slot="hover-card-content"]';
/** A card that is open now: a closing one stays mounted, faded, until its exit ends. */
export const OPEN_HOVER_CARD = `${HOVER_CARD}[data-state="open"]`;

/**
 * How long a "nothing happens" window must last to be able to see the thing it
 * rules out. They restate `HOVER_CARD_DELAY` in `hover-card.tsx` (500ms to
 * open, 150ms to close) plus its 100ms exit, with room for a slow frame:
 * `hover-card.test.tsx` (a) fails first when the production delays move, so a
 * window that outlived them cannot go stale unnoticed.
 */
export const NO_REOPEN_WINDOW_MS = 800;
export const STAYS_OPEN_WINDOW_MS = 600;

export interface HoverCardProbe {
  /** Forgets every card seen so far, the painted maximum and the marks. */
  readonly reset: () => void;
  /** The text of every card that opened since `reset`, in order. */
  readonly opened: () => ReadonlyArray<string>;
  /**
   * The most cards PAINTED in any one frame since `reset`: mounted with a
   * computed opacity above zero, so a card fading out still counts.
   */
  readonly maxPainted: () => number;
  /**
   * How many cards opened while another card was still on the page (open, or
   * faded and not yet unmounted): the count of hand-offs the run really made.
   */
  readonly overlappedOpens: () => number;
  /**
   * Milliseconds from the first `wheel` event since `reset` to the first card
   * to close after it, measured in the page (`performance.now()`), or `null`
   * when there was no wheel or no close.
   */
  readonly wheelToClose: () => number | null;
}

declare global {
  interface Window {
    __hoverCardProbe?: HoverCardProbe;
  }
}

/**
 * Installs the probe: a MutationObserver that records every card that mounts or
 * turns `open`, and a per-frame sampler that counts the cards painted right
 * before each frame. Recording every open, not just reading the state at the
 * end, is what lets a test say "no card ever opened": a card that opened and
 * closed again inside the wait would otherwise pass unseen.
 */
export async function installHoverCardProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__hoverCardProbe !== undefined) {
      window.__hoverCardProbe.reset();
      return;
    }
    const selector =
      '[data-slot="hover-card-content"],[data-slot="tooltip-content"]';
    const opened: string[] = [];
    const wasOpen = new WeakSet<Element>();
    let maxPainted = 0;
    let overlappedOpens = 0;
    let wheelAt: number | null = null;
    let closedAfterWheelAt: number | null = null;
    const textOf = (node: Element): string =>
      node.textContent.replace(/\s+/g, " ").trim().slice(0, 64);
    const noteOpen = (node: Element): void => {
      const open =
        node.isConnected && node.getAttribute("data-state") !== "closed";
      if (open && !wasOpen.has(node)) {
        wasOpen.add(node);
        opened.push(textOf(node));
        if (document.querySelectorAll(selector).length > 1) {
          overlappedOpens += 1;
        }
      } else if (!open) {
        if (
          wasOpen.has(node) &&
          wheelAt !== null &&
          closedAfterWheelAt === null
        ) {
          closedAfterWheelAt = performance.now();
        }
        wasOpen.delete(node);
      }
    };
    const cardsIn = (node: Node): Element[] => {
      if (!(node instanceof Element)) return [];
      const own = node.matches(selector) ? [node] : [];
      return [...own, ...node.querySelectorAll(selector)];
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (
            record.target instanceof Element &&
            record.target.matches(selector)
          ) {
            noteOpen(record.target);
          }
          continue;
        }
        for (const added of record.addedNodes) {
          for (const card of cardsIn(added)) noteOpen(card);
        }
        for (const removed of record.removedNodes) {
          for (const card of cardsIn(removed)) noteOpen(card);
        }
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    const sample = (): void => {
      const painted = [...document.querySelectorAll(selector)].filter(
        (node) => Number(getComputedStyle(node).opacity) > 0,
      ).length;
      maxPainted = Math.max(maxPainted, painted);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    document.addEventListener(
      "wheel",
      () => {
        wheelAt ??= performance.now();
      },
      true,
    );
    window.__hoverCardProbe = {
      reset: () => {
        opened.length = 0;
        maxPainted = 0;
        overlappedOpens = 0;
        wheelAt = null;
        closedAfterWheelAt = null;
      },
      opened: () => [...opened],
      maxPainted: () => maxPainted,
      overlappedOpens: () => overlappedOpens,
      wheelToClose: () =>
        wheelAt === null || closedAfterWheelAt === null
          ? null
          : closedAfterWheelAt - wheelAt,
    };
  });
}

export async function resetHoverCardProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__hoverCardProbe?.reset();
  });
}

export async function openedHoverCards(
  page: Page,
): Promise<ReadonlyArray<string>> {
  return page.evaluate(() => window.__hoverCardProbe?.opened() ?? []);
}

export async function maxPaintedHoverCards(page: Page): Promise<number> {
  return page.evaluate(() => window.__hoverCardProbe?.maxPainted() ?? -1);
}

export async function overlappedHoverCardOpens(page: Page): Promise<number> {
  return page.evaluate(() => window.__hoverCardProbe?.overlappedOpens() ?? -1);
}

export async function wheelToHoverCardClose(
  page: Page,
): Promise<number | null> {
  return page.evaluate(() => window.__hoverCardProbe?.wheelToClose() ?? null);
}

/**
 * Watches the page for `windowMs` in its own frame loop and returns how many
 * frames had a number of OPEN cards other than `expected`. For a "stays open"
 * or "stays shut" claim: the window runs in the page, so Playwright's own round
 * trips cannot stretch it or hide a card that came and went.
 */
export async function framesWithOtherThanOpenCards(
  page: Page,
  expected: number,
  windowMs: number,
): Promise<number> {
  return page.evaluate(
    ({ expectedCount, durationMs }) =>
      new Promise<number>((resolve) => {
        const end = performance.now() + durationMs;
        let violations = 0;
        const tick = (): void => {
          const open = document.querySelectorAll(
            '[data-slot="hover-card-content"][data-state="open"]',
          ).length;
          if (open !== expectedCount) violations += 1;
          if (performance.now() < end) {
            requestAnimationFrame(tick);
          } else {
            resolve(violations);
          }
        };
        tick();
      }),
    { expectedCount: expected, durationMs: windowMs },
  );
}

/**
 * A row's centre once it has stopped moving: a resize or a scroll-into-view
 * can still be settling the strip when the page reports ready. Condition, not
 * time: the frames between two readings are the only wait.
 */
export async function settledCentreOf(
  page: Page,
  locator: Locator,
): Promise<Point> {
  let previous = await centreOf(locator);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await nextFrames(page, 2);
    const next = await centreOf(locator);
    if (next.x === previous.x && next.y === previous.y) return next;
    previous = next;
  }
  throw new Error(`${locator.toString()} never stopped moving`);
}
