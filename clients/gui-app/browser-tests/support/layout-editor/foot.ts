import type { Page } from "@playwright/test";

import { type Box, boxText, near, requireRect } from "./dom.ts";
import { clickAt } from "./input.ts";
import { waitForStableBoxes, waitUntil } from "./waits.ts";
import { nextFrames } from "../fixtures.ts";

/**
 * The strip's foot: the readings row (staging round 1, F6) and the account
 * menu's Host section (F5, G4). What each read is, and the problems each finds
 * in it, so a spec can poll them and a header spec can reuse the menu's.
 */

// --- the readings row --------------------------------------------------------

/** The readings row's `gap-2` (the rail's own 8px tile gap), and the foot's `gap-2` above the account row. */
export const READINGS_GAP_PX = 8;
export const FOOT_GAP_PX = 8;
/** A collapsed reading is a rail-wide tile (`size-10`). */
const COLLAPSED_READING_TILE_PX = 40;

/** Which readings the strip's foot holds. */
export type ReadingsSet = "both" | "usage" | "resource";

type ReadingState = "shown" | "hidden" | "cut";

interface ReadingItem {
  readonly text: string;
  readonly state: ReadingState;
}

export interface ReadingsRead {
  readonly row: Box | null;
  readonly usage: Box | null;
  readonly resource: Box | null;
  /**
   * The resource tile's readings: its CPU reading in Compact (the strip's
   * Auto), its metrics in Detailed. The usage tile's Compact glyph is a fixed
   * picture with no text to cut, so it has no list of its own.
   */
  readonly resourceReadings: readonly ReadingItem[] | null;
  readonly resourceFallback: boolean;
  readonly account: Box | null;
  readonly strip: Box | null;
}

const READINGS_PROBE = `(() => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  // A box drawn narrower than its content: the reading or any laid-out
  // descendant (an inline box has no clientWidth to compare). The reading's
  // own rectangle is not enough - a shrinkable wrapper can sit inside the
  // line while the text it holds runs past it (G6 review A).
  const overflows = (node) => [node, ...node.querySelectorAll('*')].some(
    (part) => part.clientWidth > 0 && getComputedStyle(part).display !== 'inline' && part.scrollWidth > part.clientWidth + 0.5,
  );
  // Each tile's readings: shown whole inside its one-row line, hidden on the
  // clipped wrap row or behind the tile's fallback, or cut (the mush this row
  // must avoid).
  const readings = (button, itemSelector) => {
    const tile = document.querySelector('[data-testid="side-strip-readings"] ' + button);
    if (tile === null) return null;
    return [...tile.querySelectorAll(itemSelector)].map((item) => {
      const line = item.parentElement.getBoundingClientRect();
      const r = item.getBoundingClientRect();
      const inside = r.left >= line.left - 0.5 && r.right <= line.right + 0.5 && r.top >= line.top - 0.5 && r.bottom <= line.bottom + 0.5;
      const outside = r.top >= line.bottom - 0.5 || r.right <= line.left + 0.5 || r.left >= line.right - 0.5;
      const state = getComputedStyle(item).visibility === 'hidden' || outside ? "hidden" : inside && !overflows(item) ? "shown" : "cut";
      return { text: item.textContent.trim(), state };
    });
  };
  // A tile whose first reading cannot fit whole draws its fallback instead.
  const fallback = (button) => {
    const node = document.querySelector('[data-testid="side-strip-readings"] ' + button + ' [data-readings-fallback]');
    return node !== null && node.getClientRects().length > 0;
  };
  return {
    row: box('[data-testid="side-strip-readings"]'),
    usage: box('[data-testid="side-strip-readings"] [data-testid="rate-limit-header-button"]'),
    resource: box('[data-testid="side-strip-readings"] [data-testid="resource-monitor-header-button"]'),
    resourceReadings: readings('[data-testid="resource-monitor-header-button"]', '[data-testid^="status-bar-resource-metric-"], [data-testid="resource-cpu-reading"]'),
    resourceFallback: fallback('[data-testid="resource-monitor-header-button"]'),
    account: box('[data-testid="user-menu-trigger"]'),
    strip: box('[data-testid="side-tab-strip"]'),
  };
})()`;

export function readReadings(page: Page): Promise<ReadingsRead> {
  return page.evaluate<ReadingsRead>(READINGS_PROBE);
}

/**
 * The seeded readings land a tick after mount (the resource stream's first
 * snapshot): resolves once every wanted tile is there and, expanded, the
 * resource tile prints its CPU percent. On the rail a tile draws its glyph
 * alone, so being there is all it does.
 */
export async function waitForReadings(
  page: Page,
  readings: ReadingsSet,
  collapsed: boolean,
): Promise<void> {
  const wantsUsage = readings === "both" || readings === "usage";
  const wantsResource = readings === "both" || readings === "resource";
  await waitUntil(
    page,
    `(() => {
      const row = document.querySelector('[data-testid="side-strip-readings"]');
      if (row === null) return false;
      const resource = row.querySelector('[data-testid="resource-monitor-header-button"]');
      const tiles = (row.querySelector('[data-testid="rate-limit-header-button"]') !== null) === ${String(wantsUsage)}
        && (resource !== null) === ${String(wantsResource)};
      if (!tiles || ${String(collapsed)} || resource === null) return tiles;
      return /\\d%/.test(resource.textContent ?? "");
    })()`,
  );
  await nextFrames(page, 2);
}

/** Two readings split the row in equal halves, usage first and resources last. */
function halvesProblems(
  row: Box,
  usage: Box | null,
  resource: Box | null,
): string[] {
  if (usage === null || resource === null) {
    return ["both readings are wanted and one tile is absent"];
  }
  const problems: string[] = [];
  const half = (row.width - READINGS_GAP_PX) / 2;
  for (const tile of [usage, resource]) {
    if (!near(tile.width, half, 0.5)) {
      problems.push(
        `a half is ${tile.width.toFixed(1)}px, expected ${half.toFixed(1)}`,
      );
    }
    if (!near(tile.y, row.y, 0.5) || !near(tile.height, row.height, 0.5)) {
      problems.push(`${boxText(tile)} is not on the row ${boxText(row)}`);
    }
  }
  if (
    !near(usage.x, row.x, 0.5) ||
    !near(resource.x + resource.width, row.x + row.width, 0.5)
  ) {
    problems.push("usage is not first and resources last");
  }
  return problems;
}

/**
 * The row as a whole: one row flush with the account row's edges and directly
 * above it; two readings split it in equal halves, usage first and resources
 * last, and one takes all of it. (Which readings are drawn, and that none
 * draws no row, is `side-strip-readings.test.tsx`'s.)
 */
export function readingsRowProblems(
  read: ReadingsRead,
  readings: ReadingsSet,
): string[] {
  const { row, account, usage, resource } = read;
  if (row === null || account === null)
    return ["no readings row or no account row"];
  const problems: string[] = [];
  if (!near(row.x, account.x, 0.5) || !near(row.width, account.width, 0.5)) {
    problems.push(
      `the row ${boxText(row)} does not span the account row ${boxText(account)}`,
    );
  }
  if (!near(account.y - (row.y + row.height), FOOT_GAP_PX, 0.5)) {
    problems.push(
      `the row is not ${String(FOOT_GAP_PX)}px above the account row: ${boxText(row)} / ${boxText(account)}`,
    );
  }
  if (readings === "both") {
    problems.push(...halvesProblems(row, usage, resource));
  } else {
    const drawn = [usage, resource].filter(
      (tile): tile is Box => tile !== null && tile.width > 0,
    );
    if (drawn.length === 1 && !near(drawn[0].width, row.width, 0.5)) {
      problems.push(
        `the one reading is ${drawn[0].width.toFixed(1)}px of ${row.width.toFixed(1)}`,
      );
    }
  }
  return problems;
}

/**
 * The rail's foot: rail-wide tiles stacked 8px apart, centred on the rail,
 * above the avatar, drawing their glyph alone.
 */
export function collapsedReadingsProblems(read: ReadingsRead): string[] {
  const { usage, resource, strip, account } = read;
  if (
    usage === null ||
    resource === null ||
    strip === null ||
    account === null
  ) {
    return ["a collapsed reading tile, the rail or the avatar is missing"];
  }
  const problems: string[] = [];
  for (const tile of [usage, resource]) {
    if (!near(tile.width, COLLAPSED_READING_TILE_PX, 0.5)) {
      problems.push(
        `a tile is ${tile.width.toFixed(1)}px wide, expected ${String(COLLAPSED_READING_TILE_PX)}`,
      );
    }
    if (!near(tile.cx, strip.cx, 1)) {
      problems.push(
        `a tile ${boxText(tile)} is off the rail's centre ${strip.cx.toFixed(1)}`,
      );
    }
  }
  if (!near(resource.y, usage.y + usage.height + READINGS_GAP_PX, 0.5)) {
    problems.push(
      `the tiles are not stacked ${String(READINGS_GAP_PX)}px apart: ${boxText(usage)} / ${boxText(resource)}`,
    );
  }
  if (resource.y + resource.height > account.y) {
    problems.push("the tiles overlap the avatar tile");
  }
  const items = read.resourceReadings;
  if (items !== null && items.length > 0) {
    problems.push(
      `the collapsed resource tile draws readings ${JSON.stringify(items)}`,
    );
  }
  return problems;
}

/**
 * What the resource tile draws: whole readings only - never one cut by the
 * tile's edge - the first always (or, when not even that fits, the tile's
 * fallback). The readings' number is fixture data and not asserted.
 */
export function wholeReadingProblems(read: ReadingsRead): string[] {
  const items = read.resourceReadings;
  if (items === null) return [];
  const problems: string[] = [];
  const cut = items.filter((item) => item.state === "cut");
  if (cut.length > 0)
    problems.push(`the resource tile cuts ${JSON.stringify(cut)}`);
  const shown = items.filter((item) => item.state === "shown");
  const firstWhole = items.length > 0 && items[0].state === "shown";
  const fallbackOnly = read.resourceFallback && shown.length === 0;
  if (!firstWhole && !fallbackOnly) {
    problems.push(
      `the resource tile shows neither its first reading nor its fallback: ${JSON.stringify(items)}`,
    );
  }
  return problems;
}

export type ReadingsKey = "usage" | "resource";

/** The dialog each reading's popover opens as. */
export const READING_DIALOGS: Readonly<Record<ReadingsKey, string>> = {
  usage: "Usage limits",
  resource: "Resources",
};

/** A reading's popover opens toward the content and inside the window. */
export async function readingPopoverProblems(
  page: Page,
  key: ReadingsKey,
  edge: "left" | "right",
): Promise<string[]> {
  const read = await readReadings(page);
  const anchor = read[key];
  if (anchor === null || anchor.width === 0) return [`no ${key} tile to open`];
  const dialog = `[role="dialog"][aria-label="${READING_DIALOGS[key]}"]`;
  await clickAt(page, anchor.cx, anchor.cy, "left");
  await waitUntil(
    page,
    `document.querySelector(${JSON.stringify(dialog)}) !== null`,
  );
  await waitForStableBoxes(page, [dialog], 3);
  const box = await requireRect(page, dialog);
  const viewport = await page.evaluate<{ width: number; height: number }>(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  const problems: string[] = [];
  const toward =
    edge === "left"
      ? box.x >= anchor.x + anchor.width - 0.5
      : box.x + box.width <= anchor.x + 0.5;
  if (!toward) {
    problems.push(
      `the ${key} popover ${boxText(box)} does not open toward the content from ${boxText(anchor)}`,
    );
  }
  if (
    box.x < 0 ||
    box.y < 0 ||
    box.x + box.width > viewport.width ||
    box.y + box.height > viewport.height
  ) {
    problems.push(`the ${key} popover ${boxText(box)} leaves the window`);
  }
  await page.keyboard.press("Escape", { delay: 60 });
  await waitUntil(
    page,
    `document.querySelector(${JSON.stringify(dialog)}) === null`,
  );
  return problems;
}

// --- the account menu's Host section ---------------------------------------

/** The hosts the fixture's registry holds (`hosts=1`), and what each one's name does in the menu. */
export const HOST_ROWS: ReadonlyArray<{
  readonly hostId: string;
  readonly fullName: string | null;
}> = [
  {
    hostId: "fixture-host-builder",
    fullName: "build-vm-01.asia-south2-b.c.example-project.internal (staging)",
  },
  {
    hostId: "fixture-host-mini",
    fullName:
      "gpu-runner-02.us-central1-a.c.example-project.internal (nightly)",
  },
  { hostId: "fixture-host-studio", fullName: null },
];

/** The menu's own cap (`max-w-64`, G4): a host name never widens it. */
const USER_MENU_MAX_WIDTH_PX = 256;

interface HostMenuRow {
  readonly hostId: string;
  readonly truncated: boolean;
  readonly box: Box;
}

const HOST_MENU_PROBE = `(() => {
  const section = document.querySelector('[data-testid="user-menu-host-section"]');
  if (section === null) return null;
  return [...section.querySelectorAll('[data-testid^="user-menu-host-option-"]')].map((row) => ({
    hostId: row.getAttribute("data-testid").slice("user-menu-host-option-".length),
    truncated: (() => { const name = row.querySelector(".truncate"); return name !== null && name.scrollWidth > name.clientWidth + 0.5; })(),
    box: (() => { const r = row.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })(),
  }));
})()`;

export function readHostRows(
  page: Page,
): Promise<readonly HostMenuRow[] | null> {
  return page.evaluate<readonly HostMenuRow[] | null>(HOST_MENU_PROBE);
}

/**
 * One real click on the account trigger opens the menu; the frames after it
 * are the chance a double toggle would have to close it again.
 */
export async function openHostMenu(page: Page): Promise<void> {
  const trigger = await requireRect(page, '[data-testid="user-menu-trigger"]');
  await clickAt(page, trigger.cx, trigger.cy, "left");
  await waitUntil(
    page,
    `document.querySelector('[data-testid="user-menu-host-section"]') !== null`,
  );
  await waitForStableBoxes(page, ['[data-testid="user-menu-content"]'], 12);
}

export type MenuToward = "right" | "left" | "below";

interface MenuGeometry {
  readonly menu: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
    readonly width: number;
  };
  readonly trigger: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly vw: number;
  readonly vh: number;
}

function opensTowardTrigger(toward: MenuToward, geo: MenuGeometry): boolean {
  if (toward === "right") return geo.menu.left >= geo.trigger.right - 0.5;
  if (toward === "left") return geo.menu.right <= geo.trigger.left + 0.5;
  return geo.menu.top >= geo.trigger.bottom - 0.5;
}

/**
 * G4: a menu's width whatever a host is called - no wider than 256px, inside
 * the window, opening toward the content - and the long names truncate while
 * one that fits does not. Call with the menu open.
 */
export async function hostMenuProblems(
  page: Page,
  toward: MenuToward,
): Promise<string[]> {
  const rows = await readHostRows(page);
  if (rows === null) return ["the menu has no Host section"];
  const geo = await page.evaluate<MenuGeometry | null>(`(() => {
    const r = (s) => { const n = document.querySelector(s); if (n === null) return null; const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
    const menu = r('[data-testid="user-menu-content"]');
    const trigger = r('[data-testid="user-menu-trigger"]');
    return menu === null || trigger === null ? null : { menu, trigger, vw: innerWidth, vh: innerHeight };
  })()`);
  if (geo === null) return ["no menu or no trigger to measure"];
  const problems: string[] = [];
  if (geo.menu.width > USER_MENU_MAX_WIDTH_PX + 0.5) {
    problems.push(
      `the menu is ${geo.menu.width.toFixed(1)}px wide, over the ${String(USER_MENU_MAX_WIDTH_PX)}px cap`,
    );
  }
  if (
    geo.menu.left < 0 ||
    geo.menu.top < 0 ||
    geo.menu.right > geo.vw ||
    geo.menu.bottom > geo.vh
  ) {
    problems.push(`the menu ${JSON.stringify(geo.menu)} leaves the window`);
  }
  const opensToward = opensTowardTrigger(toward, geo);
  if (!opensToward) {
    problems.push(
      `the menu ${JSON.stringify(geo.menu)} does not open ${toward} of ${JSON.stringify(geo.trigger)}`,
    );
  }
  for (const { hostId, fullName } of HOST_ROWS) {
    const row = rows.find((entry) => entry.hostId === hostId);
    if (row === undefined) {
      problems.push(`no ${hostId} row`);
    } else if (row.truncated !== (fullName !== null)) {
      problems.push(
        `${hostId}'s name is ${row.truncated ? "" : "not "}truncated`,
      );
    }
  }
  return problems;
}
