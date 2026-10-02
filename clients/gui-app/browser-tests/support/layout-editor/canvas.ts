import type { Page } from "@playwright/test";

import { releasePointer } from "./input.ts";
import { LAYOUT_EDITOR_VIEWPORT, type PageLoad } from "./pages.ts";
import { waitForFiniteAnimations, waitUntil } from "./waits.ts";
import { nextFrames } from "../fixtures.ts";

/**
 * Access to `layout-editor-canvas.html`, the fixture behind almost every
 * layout editor check: the real app column, the real sample scene or a task's
 * sheets inside it, and the real editor beside it, with a probe
 * (`window.__layoutCanvasProbe`) that switches nearly everything LIVE.
 *
 * Only what the document reads once at mount is a load: `wco`, `surface`,
 * `account`, `hosts`, `header`, `readings` (and `solo`, `warm`, `settings`,
 * which no check here uses). A group of tests that shares those shares one
 * page, and `configureCanvas` puts the rest where each test wants it.
 */

export const CANVAS_PATH = "/src/__tests__/browser/layout-editor-canvas.html";

export type QueryValue = string | number;

/** The document's ready gate, plus whatever else the group needs on screen. */
export function canvasLoad(
  query: Readonly<Record<string, QueryValue>>,
  alsoReady: string | null,
): PageLoad {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    search.set(key, String(value));
  }
  return {
    path: `${CANVAS_PATH}?${search.toString()}`,
    ready: `window.__layoutCanvasProbe?.ready === true${alsoReady === null ? "" : ` && ${alsoReady}`}`,
    errorsGlobal: "__layoutCanvasErrors",
  };
}

export type Placement = "top" | "left" | "right";
export type DockMode = "right" | "left" | "float";

/** Runs `window.__layoutCanvasProbe.<call>` and returns whatever it returns. */
export function probe(page: Page, call: string): Promise<unknown> {
  return page.evaluate(`window.__layoutCanvasProbe.${call}`);
}

/** Runs a probe call whose answer the test reads. */
export function probeValue<T>(page: Page, call: string): Promise<T> {
  return page.evaluate<T>(`window.__layoutCanvasProbe.${call}`);
}

export function historyDepth(page: Page): Promise<number> {
  return probeValue<number>(page, "historyDepth()");
}

/** The production constants the probe re-exports (`tokens` in the fixture). */
export interface StripTokens {
  readonly stripRailWidthPx: number;
  readonly stripMinWidthPx: number;
  readonly stripDefaultWidthPx: number;
  readonly stripSnapToRailBelowPx: number;
}

export function stripTokens(page: Page): Promise<StripTokens> {
  return probeValue<StripTokens>(page, "tokens");
}

export interface CanvasConfig {
  readonly tabs: Placement;
  readonly collapsed: boolean;
  readonly dock: DockMode;
  /** Whether a layout session is open (the inspector, the editing frame). */
  readonly session: boolean;
}

/**
 * Puts the loaded document in `config`, from whatever the previous test left:
 * back to the load's own layout first (`restoreLoadState`, which also ends any
 * session and drops the theme, indicators and activity a test fed in), then
 * the three live settings, then a session if asked. Resolves once the shell
 * has landed there, which is a wait on the document, not on a timer.
 *
 * The pointer is released and parked at (1, 1), the corner every check that
 * needs "no hover" leaves it in.
 */
export async function configureCanvas(
  page: Page,
  config: CanvasConfig,
): Promise<void> {
  await releasePointer(page);
  await page.mouse.move(1, 1);
  // What a previous test may have changed outside the document: the window's
  // height (the scrolled-out and clipped-pulse cases) and the motion preference.
  const size = page.viewportSize();
  if (
    size === null ||
    size.width !== LAYOUT_EDITOR_VIEWPORT.width ||
    size.height !== LAYOUT_EDITOR_VIEWPORT.height
  ) {
    await page.setViewportSize(LAYOUT_EDITOR_VIEWPORT);
  }
  await page.emulateMedia({ reducedMotion: null });
  await probe(page, "restoreLoadState()");
  await probe(page, `setTabPlacement(${JSON.stringify(config.tabs)})`);
  await probe(page, `setCollapsed(${String(config.collapsed)})`);
  await probe(page, `setDockMode(${JSON.stringify(config.dock)})`);
  if (config.session) await probe(page, "beginSession()");
  await waitForShell(page, config);
}

/** Resolves once the column, the strip and the inspector are as `config` says. */
export async function waitForShell(
  page: Page,
  config: CanvasConfig,
): Promise<void> {
  await waitUntil(
    page,
    `(() => {
      const column = document.querySelector("[data-layout-column]");
      if (column === null) return false;
      if (column.getAttribute("data-tab-strip-placement") !== ${JSON.stringify(config.tabs)}) return false;
      const strip = document.querySelector('[data-testid="side-tab-strip"]');
      if (${JSON.stringify(config.tabs)} === "top") {
        if (strip !== null) return false;
      } else if (
        strip === null ||
        strip.getAttribute("data-edge") !== ${JSON.stringify(config.tabs)} ||
        strip.getAttribute("data-collapsed") !== ${JSON.stringify(String(config.collapsed))}
      ) {
        return false;
      }
      const inspector = document.querySelector("[data-layout-inspector]");
      if (${String(config.session)}) {
        return inspector !== null && inspector.getAttribute("data-dock-mode") === ${JSON.stringify(config.dock)};
      }
      return inspector === null;
    })()`,
  );
  await waitForFiniteAnimations(page);
  await nextFrames(page, 2);
}

export type ThemeName = "light" | "dark";

/**
 * Sets the stored theme and resolves once `<html>` wears it and the frames
 * after the switch have been presented (`restoreLoadState` puts it back to
 * "system", which is what every test starts from).
 */
export async function setThemeAndWait(
  page: Page,
  theme: ThemeName,
): Promise<void> {
  await probe(page, `setTheme(${JSON.stringify(theme)})`);
  await waitUntil(
    page,
    `document.documentElement.classList.contains(${JSON.stringify(theme)})`,
  );
  await waitForFiniteAnimations(page);
}

/**
 * Makes one seeded epic tab the active item and resolves once `activeWhen`, a
 * page-side expression naming what the switch changes (the tile or row that
 * now reads `data-active`), is true. A wait on "some tile is active" would
 * pass before the switch happened, since the previous one still is.
 */
export async function activateEpicAndWait(
  page: Page,
  epicId: string,
  activeWhen: string,
): Promise<void> {
  await probe(page, `activateEpicTab(${JSON.stringify(epicId)})`);
  await waitUntil(page, activeWhen);
  await waitForFiniteAnimations(page);
}
