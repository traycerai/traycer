import type { Page } from "@playwright/test";

import { probe } from "./canvas.ts";
import type { Box, Rect } from "./dom.ts";
import { moveInSteps, pressAt, releasePointer } from "./input.ts";
import { waitUntil } from "./waits.ts";
import { nextFrames } from "../fixtures.ts";

/**
 * What the epic-surface specs share: the seeded tasks' indicators and live
 * agents, the reads of the sheets, the strip and the joined row, and the
 * gestures on a row and on a handle.
 */

/** The box the frame's margin and the sheets live in (`AppColumnFrame`). */
export const SURFACE_FRAME = "[data-layout-column] main > div";

/** The strip's row list, the one a scrolled-out row is cut by. */
export const STRIP_LIST =
  '[data-testid="side-tab-strip"] [data-strip-axis="y"]';

const NO_INDICATOR = {
  unreadFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

export type Indicator = typeof NO_INDICATOR;

/** One badge per kind (Alpha waits on an approval, Beta on a reply, Gamma is unread). */
export const RAIL_INDICATORS: Readonly<Record<string, Indicator>> = {
  "fixture-alpha": { ...NO_INDICATOR, pendingApproval: true },
  "fixture-beta": { ...NO_INDICATOR, pendingInterview: true },
  "fixture-gamma": { ...NO_INDICATOR, unreadDone: true },
};

/** Zeta waiting on an approval, on top of {@link RAIL_INDICATORS}. */
export const RAIL_INDICATORS_WITH_ZETA_WAITING: Readonly<
  Record<string, Indicator>
> = {
  ...RAIL_INDICATORS,
  "fixture-zeta": { ...NO_INDICATOR, pendingApproval: true },
};

/** The live agents the activity plane answers per task (Alpha, Zeta, Epsilon). */
export const RAIL_ACTIVITY = {
  "fixture-alpha": { working: ["a1"], turn: ["a1"] },
  "fixture-zeta": {
    working: ["z1", "z2", "z3", "z4", "z5"],
    turn: ["z1", "z2"],
  },
  "fixture-epsilon": {
    working: [
      "fixture-agent-plan",
      "fixture-agent-tests",
      "fixture-agent-index",
    ],
    turn: ["fixture-agent-plan", "fixture-agent-tests"],
  },
} as const;

export async function setIndicators(
  page: Page,
  epics: Readonly<Record<string, Indicator>>,
): Promise<void> {
  await probe(page, `setIndicators(${JSON.stringify(epics)}, {})`);
}

export async function setActivity(page: Page): Promise<void> {
  await probe(page, `setActivity(${JSON.stringify(RAIL_ACTIVITY)})`);
}

/**
 * The row of one tab (`epic:<id>`), by its close button's test id.
 * `null` when the strip has no such row.
 */
export function rowRectOrNull(page: Page, key: string): Promise<Box | null> {
  const [kind, id] = key.split(":");
  return page.evaluate<Box | null>(`(() => {
    const close = document.querySelector('[data-testid="tab-close-${kind}-${id}"]');
    const row = close === null ? null : close.closest("[data-side-tab]");
    if (row === null) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  })()`);
}

export async function rowRect(page: Page, key: string): Promise<Box> {
  const box = await rowRectOrNull(page, key);
  if (box === null) throw new Error(`no row for ${key} in the strip`);
  return box;
}

/** The window's height for a case that needs the strip's list to overflow or clip. */
export async function setWindowHeight(
  page: Page,
  height: number,
): Promise<void> {
  const size = page.viewportSize();
  if (size === null) throw new Error("the page has no viewport");
  await page.setViewportSize({ width: size.width, height });
  await nextFrames(page, 3);
}

// --- the flip, sheets and moves reads ---------------------------------------

export interface ShellBoxes {
  readonly panel: FlipBox | null;
  readonly content: FlipBox | null;
  readonly slot: FlipBox | null;
  readonly body: FlipBox | null;
  readonly stripHandle: FlipBox | null;
  readonly placement: string | null;
  readonly strip: {
    readonly edge: string | null;
    readonly collapsed: string | null;
    readonly rect: FlipBox;
  } | null;
  readonly rail: FlipBox | null;
  readonly panelWidth: number | null;
}

export interface FlipBox extends Rect {
  readonly right: number;
  readonly bottom: number;
}

const SHELL_PROBE = `(() => {
  const box = (node) => {
    if (node === null || node === undefined) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const q = (selector) => document.querySelector(selector);
  // Whichever pane currently occupies the sidebar's screen position: the
  // real panel when expanded, or its collapsed rail (a separate element)
  // when not - the panel itself stays mounted at zero width while hidden.
  const sidebarPane = [
    q('[data-epic-sidebar-panel]'),
    q('[data-fixture-collapsed-rail]'),
  ].find((node) => node !== null && node.getBoundingClientRect().width > 0) ?? null;
  return {
    panel: box(sidebarPane),
    content: box(q('[data-epic-canvas-frame]')),
    slot: box(q('[data-testid="tile-surface-slot"]')),
    body: box(q("[data-fixture-hosted-body]")),
    stripHandle: box(q('[data-testid="side-tab-strip-resize-handle"]')),
    placement: q("[data-tab-strip-placement]")?.getAttribute("data-tab-strip-placement") ?? null,
    strip: (() => {
      const strip = q('[data-testid="side-tab-strip"]');
      if (strip === null) return null;
      return { edge: strip.getAttribute("data-edge"), collapsed: strip.getAttribute("data-collapsed"), rect: box(strip) };
    })(),
    rail: box(q("[data-fixture-collapsed-rail]")),
    panelWidth: q("[data-fixture-panel]")?.getBoundingClientRect().width ?? null,
  };
})()`;

export function readShell(page: Page): Promise<ShellBoxes> {
  return page.evaluate<ShellBoxes>(SHELL_PROBE);
}

// --- gestures ----------------------------------------------------------------

/**
 * A real press on a strip row, dragged to `to` and released, with the frames
 * the release needs to land. Returns nothing: what a drag did is read off the
 * document by the caller, which waits on the result rather than on this.
 */
export async function dragRowTo(
  page: Page,
  from: Box,
  to: { readonly x: number; readonly y: number },
  holdFrames: number,
): Promise<void> {
  await pressAt(page, from.cx, from.cy);
  await moveInSteps(page, to);
  await nextFrames(page, holdFrames);
  await releasePointer(page);
}

/** Resolves once no drag overlay or sibling transform is left from a gesture. */
export async function waitForStripSettled(page: Page): Promise<void> {
  await waitUntil(
    page,
    `document.querySelector('[data-testid="header-tab-drag-overlay"]') === null`,
  );
  await nextFrames(page, 2);
}
