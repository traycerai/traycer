import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";

import { fixture, nextFrames } from "./fixtures.ts";

/**
 * Shared plumbing for the specs that measure the real app column on
 * `layout-editor-canvas.html`: the sheet join's arcs and Settings > Layout.
 *
 * ONE PAGE PER CONFIGURATION, NOT ONE PER TEST. That fixture boots most of the
 * app from unbundled modules, so a load costs seconds, and a window's variant
 * (which edge the tabs sit on, which side the sidebar takes, the theme, the
 * device pixel ratio, the viewport) is switchable live through
 * `window.__layoutCanvasProbe`. So each configuration below is a WORKER-scoped
 * fixture: a worker loads it the first time a test asks and every later test
 * on that worker reuses the page. Tests stay independent by setting up what
 * they measure (see `prepareCanvas`) instead of inheriting it, so Playwright
 * still shards and parallelises by test.
 *
 * A failing test makes Playwright retire its worker, so a failure never leaks
 * a half-mutated page into the next test.
 */

const CANVAS_FIXTURE = "layout-editor-canvas";

/** The top placement's window: the real header and tab strip, a task's sheet. */
const TOP_QUERY = "tabs=top&header=app&surface=epic";
/** A side placement's window; the sides are switched live from here. */
const SIDES_QUERY = "tabs=left&sidebar=left&header=app&surface=epic";
/** Settings > Layout alone in the window, so a width is the panel's own. */
const SETTINGS_PAGE_QUERY =
  "settings=1&pane=full&panel=layout&account=1&hosts=1&readings=both";
/** Settings > Layout beside the live app column with its readings and status bar. */
const SETTINGS_APP_QUERY =
  "settings=1&surface=sample&header=app&readings=both&account=1&hosts=1";

/** The desktop window every geometry check starts from. */
export const DESKTOP_WINDOW = { width: 1400, height: 860 } as const;

export interface CanvasPage {
  readonly page: Page;
  readonly cdp: CDPSession;
  /**
   * The uncaught errors and unhandled rejections the page raised while it
   * booted, before any test ran on it. A test's own errors are enforced by the
   * fixture; these are the load's, which the first test on a worker would
   * otherwise clear unread.
   */
  readonly bootErrors: ReadonlyArray<string>;
  /**
   * Resizes the window and sets its device pixel ratio together, through
   * DevTools (a locator API has no device pixel ratio switch), then waits for
   * the frames that lay it out and paint it.
   */
  readonly setWindow: (
    width: number,
    height: number,
    devicePixelRatio: number,
  ) => Promise<void>;
}

interface OpenCanvas {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly errors: string[];
  readonly bootErrors: ReadonlyArray<string>;
}

async function openCanvas(
  browser: Browser,
  baseURL: string | undefined,
  query: string,
): Promise<OpenCanvas> {
  const context = await browser.newContext({
    baseURL,
    viewport: DESKTOP_WINDOW,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  const cdp = await context.newCDPSession(page);
  await page.goto(`${fixture(CANVAS_FIXTURE)}?${query}`);
  await page.waitForFunction("window.__layoutCanvasProbe?.ready === true");
  await nextFrames(page, 2);
  const bootErrors = [...errors];
  return { context, page, cdp, errors, bootErrors };
}

/**
 * What one test hands to its body: the page and, when asked, a failure for any
 * uncaught page error or unhandled rejection raised during the test.
 *
 * Nothing here traces: Playwright Test starts a trace chunk on EVERY browser
 * context alive when a test begins, a worker's shared one included, and keeps
 * it for a failure (`trace: "retain-on-failure"`), so a failed test still
 * uploads the trace of the page it measured.
 */
async function serveTest(
  opened: OpenCanvas,
  failOnPageErrors: boolean,
  provide: (canvas: CanvasPage) => Promise<void>,
): Promise<void> {
  opened.errors.length = 0;
  await provide({
    page: opened.page,
    cdp: opened.cdp,
    bootErrors: opened.bootErrors,
    setWindow: async (width, height, devicePixelRatio) => {
      await opened.cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: devicePixelRatio,
        mobile: false,
      });
      await nextFrames(opened.page, 2);
    },
  });
  if (failOnPageErrors) {
    expect(
      opened.errors,
      "the page raised an uncaught error or an unhandled rejection during the test",
    ).toEqual([]);
  }
}

interface CanvasFixtures {
  readonly topCanvas: CanvasPage;
  readonly sidesCanvas: CanvasPage;
  readonly settingsPage: CanvasPage;
  readonly settingsApp: CanvasPage;
}

interface CanvasWorkerFixtures {
  readonly topOpen: OpenCanvas;
  readonly sidesOpen: OpenCanvas;
  readonly settingsPageOpen: OpenCanvas;
  readonly settingsAppOpen: OpenCanvas;
}

export const test = base.extend<CanvasFixtures, CanvasWorkerFixtures>({
  topOpen: [
    async ({ browser }, provide, workerInfo) => {
      const opened = await openCanvas(
        browser,
        workerInfo.project.use.baseURL,
        TOP_QUERY,
      );
      await provide(opened);
      await opened.context.close();
    },
    { scope: "worker" },
  ],
  sidesOpen: [
    async ({ browser }, provide, workerInfo) => {
      const opened = await openCanvas(
        browser,
        workerInfo.project.use.baseURL,
        SIDES_QUERY,
      );
      await provide(opened);
      await opened.context.close();
    },
    { scope: "worker" },
  ],
  settingsPageOpen: [
    async ({ browser }, provide, workerInfo) => {
      const opened = await openCanvas(
        browser,
        workerInfo.project.use.baseURL,
        SETTINGS_PAGE_QUERY,
      );
      await provide(opened);
      await opened.context.close();
    },
    { scope: "worker" },
  ],
  settingsAppOpen: [
    async ({ browser }, provide, workerInfo) => {
      const opened = await openCanvas(
        browser,
        workerInfo.project.use.baseURL,
        SETTINGS_APP_QUERY,
      );
      await provide(opened);
      await opened.context.close();
    },
    { scope: "worker" },
  ],
  topCanvas: async ({ topOpen }, provide) => {
    await serveTest(topOpen, false, provide);
  },
  sidesCanvas: async ({ sidesOpen }, provide) => {
    await serveTest(sidesOpen, false, provide);
  },
  settingsPage: async ({ settingsPageOpen }, provide) => {
    await serveTest(settingsPageOpen, true, provide);
  },
  settingsApp: async ({ settingsAppOpen }, provide) => {
    await serveTest(settingsAppOpen, true, provide);
  },
});

export { expect } from "@playwright/test";

// ── Waiting ─────────────────────────────────────────────────────────────────

// ── The probe and the stores behind the fixture ─────────────────────────────

/** The fixture's live setters, `window.__layoutCanvasProbe`, by expression. */
export async function probe(page: Page, expression: string): Promise<unknown> {
  return page.evaluate(`window.__layoutCanvasProbe.${expression}`);
}

export type TabPlacement = "top" | "left" | "right";
export type EdgeSide = "left" | "right";

/**
 * Back to the shipped layout with the tabs at `placement` and the sidebar on
 * `sidebar`, the strip and the panel expanded, the seeded tabs as the load
 * left them (their order and the active tab) and no leftover token override.
 * Each geometry test starts here so it never depends on the test that ran
 * before it on the same page.
 */
export async function prepareCanvas(
  page: Page,
  placement: TabPlacement,
  sidebar: EdgeSide,
): Promise<void> {
  await removeTokenOverride(page);
  await probe(page, "reset()");
  await probe(page, `setTabPlacement(${JSON.stringify(placement)})`);
  await probe(page, `setSidebarSide(${JSON.stringify(sidebar)})`);
  await probe(page, "setCollapsed(false)");
  await probe(page, "setPanelCollapsed(false)");
  await probe(page, "restoreTabs()");
}

export async function setHomeShown(page: Page, shown: boolean): Promise<void> {
  await page.evaluate(
    `import('/src/stores/layout/layout-store.ts').then((m) => m.useLayoutStore.getState().setRegionValues('homeTab', { shown: ${JSON.stringify(shown ? "shown" : "hidden")} }))`,
  );
}

/** Moves one strip item to the head of the strip, so it is the first tab or row. */
export async function moveItemFirst(page: Page, itemId: string): Promise<void> {
  await page.evaluate(
    `import('/src/stores/tabs/store.ts').then((m) => {
       m.useTabsStore.setState((state) => {
         const idx = state.items.findIndex((item) => item.id === ${JSON.stringify(itemId)});
         if (idx <= 0) return {};
         const item = state.items[idx];
         const without = state.items.filter((_entry, i) => i !== idx);
         return { items: [item, ...without], groups: {}, customizations: {} };
       });
     })`,
  );
}

// The strip items the fixture seeds (`side-tab-strip-seed.ts`), by the id the
// tabs store and the probe know them by.
const ALPHA_ITEM = "tab:epic:fixture-alpha";
const SPLIT_ITEM = "fixture-split";

/** Epsilon, the seeded active task: a middle tab, clear of both ends of the strip. */
export async function activateEpsilon(page: Page): Promise<void> {
  await probe(page, "activateEpicTab('fixture-epsilon')");
}

/** The seeded split pair, wherever it sits in the strip. */
export async function activateSplit(page: Page): Promise<void> {
  await probe(page, `activateStripItem(${JSON.stringify(SPLIT_ITEM)})`);
}

/** The last seeded task, which a scrolled strip puts at its far end. */
export async function activateLastTab(page: Page): Promise<void> {
  await probe(page, "activateEpicTab('fixture-zeta')");
}

/**
 * Home, the strip's first tab. It is hidden by default at the top, and a
 * hidden Home leaves no joined element at all, so a check that skipped this
 * would find nothing to measure and quietly assert nothing.
 */
export async function activateHome(page: Page): Promise<void> {
  await setHomeShown(page, true);
  await probe(page, "activateStripItem(null)");
}

/** A lone task tab made the first item in the strip, and active. */
export async function activateFirstSingle(page: Page): Promise<void> {
  await setHomeShown(page, false);
  await moveItemFirst(page, ALPHA_ITEM);
  await probe(page, "activateEpicTab('fixture-alpha')");
}

/** The split pair made the first item in the strip, and active. */
export async function activateFirstSplit(page: Page): Promise<void> {
  await setHomeShown(page, false);
  await moveItemFirst(page, SPLIT_ITEM);
  await activateSplit(page);
}

const TOKEN_OVERRIDE_STYLE_ID = "canvas-geometry-token-override";
/** The join's own radius, the shell gap and the sheet radius, all made larger. */
const TOKEN_OVERRIDE_CSS =
  ":root { --shell-gap: 10px; --radius-xl: 16px; --radius-lg: 12px; }";

/** Runs `measure` with the join radius (`--radius-lg`) and its neighbours enlarged. */
export async function withEnlargedTokens<T>(
  page: Page,
  measure: () => Promise<T>,
): Promise<T> {
  await page.evaluate(
    `{
       const el = document.createElement("style");
       el.id = ${JSON.stringify(TOKEN_OVERRIDE_STYLE_ID)};
       el.textContent = ${JSON.stringify(TOKEN_OVERRIDE_CSS)};
       document.head.append(el);
     }`,
  );
  try {
    await nextFrames(page, 2);
    return await measure();
  } finally {
    await removeTokenOverride(page);
  }
}

async function removeTokenOverride(page: Page): Promise<void> {
  await page.evaluate(
    `document.getElementById(${JSON.stringify(TOKEN_OVERRIDE_STYLE_ID)})?.remove()`,
  );
}

// ── The sheet join's geometry ───────────────────────────────────────────────

/** Which bridge: the header tab's (`top`), or a side strip's edge. */
export type JoinSide = "top" | "left" | "right";

/** A box's four edges in page pixels. */
export interface Edges {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * One join, read in the page: the bridge's own padding box (an absolutely
 * positioned pseudo's containing block), the surface frame, and where each
 * arc's box really lands. Chrome reports a positioned pseudo's offsets as
 * used-value px, never the raw `calc()`/percentage, which is what makes them
 * readable at all; they are resolved against the padding box here, in real
 * floats, rather than shipping rects out and redoing the box math in Node.
 */
export interface SheetJoinRead {
  /** The bridge's outer box, and the joined element's box it is anchored to. */
  readonly bridge: Edges;
  readonly anchor: Edges;
  readonly padding: Edges;
  /** The surface frame (`[data-tab-edge]`), or `null` when it has no box. */
  readonly frame: Edges | null;
  readonly before: Edges;
  readonly after: Edges;
  /** The bridge's own fill, which the arcs' shadows run onto. */
  readonly fill: string;
}

/**
 * The join on `side`, or `null` while there is not one with real size: a
 * joined element and its bridge, both laid out. `null` is what "not joined"
 * reads as, so a test that means to measure a join asserts it is not `null`
 * FIRST, or it would measure nothing and pass.
 */
export async function readSheetJoin(
  page: Page,
  side: JoinSide,
): Promise<SheetJoinRead | null> {
  return page.evaluate((joinSide) => {
    const bridge = document.querySelector(
      `[data-sheet-join-bridge="${joinSide}"]`,
    );
    const joined = document.querySelector(`[data-sheet-joined="${joinSide}"]`);
    if (bridge === null || joined === null) return null;
    const bridgeBox = bridge.getBoundingClientRect();
    const joinedBox = joined.getBoundingClientRect();
    if (
      bridgeBox.width === 0 ||
      bridgeBox.height === 0 ||
      joinedBox.width === 0 ||
      joinedBox.height === 0
    ) {
      return null;
    }
    const bridgeStyle = getComputedStyle(bridge);
    const padding = {
      left: bridgeBox.left + parseFloat(bridgeStyle.borderLeftWidth),
      top: bridgeBox.top + parseFloat(bridgeStyle.borderTopWidth),
      right: bridgeBox.right - parseFloat(bridgeStyle.borderRightWidth),
      bottom: bridgeBox.bottom - parseFloat(bridgeStyle.borderBottomWidth),
    };
    const offset = (raw: string): number | null => {
      if (raw === "auto") return null;
      const value = parseFloat(raw);
      return Number.isFinite(value) ? value : null;
    };
    const resolveAxis = (axis: {
      readonly startRaw: string;
      readonly endRaw: string;
      readonly size: number;
      readonly containerStart: number;
      readonly containerEnd: number;
    }): { readonly start: number; readonly end: number } => {
      const { size, containerStart, containerEnd } = axis;
      const start = offset(axis.startRaw);
      const end = offset(axis.endRaw);
      if (start !== null && end !== null) {
        return { start: containerStart + start, end: containerEnd - end };
      }
      if (start !== null) {
        return {
          start: containerStart + start,
          end: containerStart + start + size,
        };
      }
      if (end !== null) {
        return { start: containerEnd - end - size, end: containerEnd - end };
      }
      return { start: containerStart, end: containerStart + size };
    };
    const arc = (pseudo: "::before" | "::after") => {
      const style = getComputedStyle(bridge, pseudo);
      const x = resolveAxis({
        startRaw: style.left,
        endRaw: style.right,
        size: parseFloat(style.width),
        containerStart: padding.left,
        containerEnd: padding.right,
      });
      const y = resolveAxis({
        startRaw: style.top,
        endRaw: style.bottom,
        size: parseFloat(style.height),
        containerStart: padding.top,
        containerEnd: padding.bottom,
      });
      return { left: x.start, right: x.end, top: y.start, bottom: y.end };
    };
    const frameElement = document.querySelector("[data-tab-edge]");
    const frameBox =
      frameElement === null ? null : frameElement.getBoundingClientRect();
    const edgesOf = (box: DOMRect) => ({
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
    });
    return {
      bridge: edgesOf(bridgeBox),
      anchor: edgesOf(joinedBox),
      padding,
      frame:
        frameBox === null || frameBox.width === 0 || frameBox.height === 0
          ? null
          : {
              left: frameBox.left,
              right: frameBox.right,
              top: frameBox.top,
              bottom: frameBox.bottom,
            },
      before: arc("::before"),
      after: arc("::after"),
      fill: bridgeStyle.backgroundColor,
    };
  }, side);
}

/**
 * Whether the bridge has caught up with the joined element it is anchored to:
 * along the strip's own axis (across a top tab, down a side row) the two boxes
 * coincide. Anchor positioning resolves a frame or more after the layout change
 * that moved the anchor, and until then the bridge sits where the anchor WAS,
 * so a read taken before this is a read of stale geometry.
 */
function bridgeFollowsAnchor(read: SheetJoinRead, side: JoinSide): boolean {
  const edges: ReadonlyArray<keyof Edges> =
    side === "top" ? ["left", "right"] : ["top", "bottom"];
  return edges.every(
    (edge) => Math.abs(read.bridge[edge] - read.anchor[edge]) <= 1.5,
  );
}

/**
 * Waits for the join on `side` to exist with real size AND to hold still, then
 * returns its geometry. A join that never rendered is a failure of its own,
 * never a measurement of nothing.
 *
 * Being on its anchor and holding still both matter: the bridge is
 * anchor-positioned, and Chrome resolves an anchored box a frame or more after
 * the layout change that moves its anchor (a scrolled strip, a resized window).
 * Read at once, it is where the anchor WAS - 36px off after a scroll here, and
 * past the surface frame under load - so a read is taken only once the bridge
 * is on its anchor and two reads frames apart agree (two inside one frame
 * would agree while it is still moving).
 */
export async function readRenderedJoin(
  page: Page,
  side: JoinSide,
  label: string,
): Promise<SheetJoinRead> {
  await expect
    .poll(
      async () => {
        const read = await readSheetJoin(page, side);
        return read !== null && bridgeFollowsAnchor(read, side);
      },
      {
        message: `${label}: a joined element and its ${side} bridge, both with real size and the bridge on its anchor`,
      },
    )
    .toBe(true);
  let previous = JSON.stringify(await readSheetJoin(page, side));
  await expect
    .poll(
      async () => {
        await nextFrames(page, 2);
        const next = JSON.stringify(await readSheetJoin(page, side));
        const settled = next === previous;
        previous = next;
        return settled;
      },
      {
        intervals: [50],
        message: `${label}: the ${side} bridge never stopped moving`,
      },
    )
    .toBe(true);
  const read = await readSheetJoin(page, side);
  if (read === null) {
    throw new Error(`${label}: the ${side} join disappeared while it was read`);
  }
  return read;
}

/** A bridge tolerates legitimate sub-pixel rounding, and nothing near a whole pixel. */
export const EPSILON = 0.025;

export interface OffsetDelta {
  /** The sentence a failure reads: which edge, against which. */
  readonly what: string;
  /** Positive when the arc's inner edge is past the padding-box edge. */
  readonly delta: number;
}

/**
 * Each arc's INNER edge against the padding-box edge it must coincide with.
 * The bridge carries a 1px border and an absolute pseudo's offsets resolve
 * against its host's padding box, so `calc(100% - 1px)` (the bug) lands the
 * arc 1px inside the bridge, short of the true edge; a plain `100%` is right.
 */
export function offsetDeltas(
  read: SheetJoinRead,
  side: JoinSide,
): ReadonlyArray<OffsetDelta> {
  if (side === "top") {
    return [
      {
        what: "::before's right edge is off the bridge's inner left edge (bridge.left + borderLeftWidth)",
        delta: read.before.right - read.padding.left,
      },
      {
        what: "::after's left edge is off the bridge's inner right edge (bridge.right - borderRightWidth)",
        delta: read.after.left - read.padding.right,
      },
    ];
  }
  return [
    {
      what: "::before's bottom edge is off the bridge's inner top edge (bridge.top + borderTopWidth)",
      delta: read.before.bottom - read.padding.top,
    },
    {
      what: "::after's top edge is off the bridge's inner bottom edge (bridge.bottom - borderBottomWidth)",
      delta: read.after.top - read.padding.bottom,
    },
  ];
}

export interface FrameOverrun {
  readonly what: string;
  /** How far the arc's OUTER edge is past the surface frame; positive is past. */
  readonly past: number;
}

/**
 * Each arc's OUTER edge (the end away from the bridge) against the surface
 * frame's own bounds on the axis it flares along. The frame draws one straight
 * seam line with no corner radius left to carve, so an arc that overshoots it
 * has overshot the surface it is meant to land on. `null` frame means there
 * was no surface to bound the arcs, which the caller reports as a failure.
 */
export function frameOverruns(
  read: SheetJoinRead,
  side: JoinSide,
): ReadonlyArray<FrameOverrun> | null {
  const { frame } = read;
  if (frame === null) return null;
  if (side === "top") {
    return [
      {
        what: "the left arc's outer edge, past the surface frame's left edge - the seam has no corner to flare past",
        past: frame.left - read.before.left,
      },
      {
        what: "the right arc's outer edge, past the surface frame's right edge",
        past: read.after.right - frame.right,
      },
    ];
  }
  return [
    {
      what: "the top arc's outer edge, past the surface frame's top edge",
      past: frame.top - read.before.top,
    },
    {
      what: "the bottom arc's outer edge, past the surface frame's bottom edge",
      past: read.after.bottom - frame.bottom,
    },
  ];
}

/** Whether ANY joined element or bridge is drawn, whichever side it is on. */
export async function joinState(
  page: Page,
): Promise<{ readonly joined: boolean; readonly bridgeVisible: boolean }> {
  return page.evaluate(() => {
    const joined = document.querySelector("[data-sheet-joined]");
    const bridge = document.querySelector("[data-sheet-join-bridge]");
    return {
      joined: joined !== null,
      bridgeVisible:
        bridge !== null && bridge.getBoundingClientRect().width > 0,
    };
  });
}

// ── The arcs' anti-aliasing, read off a screenshot ──────────────────────────

/** Where each arc's centre sits in its box, per bridge (`index.css`). */
const ARC_CENTRES: Readonly<
  Record<
    JoinSide,
    Readonly<Record<"before" | "after", { right: boolean; bottom: boolean }>>
  >
> = {
  top: {
    before: { right: false, bottom: false },
    after: { right: true, bottom: false },
  },
  left: {
    before: { right: false, bottom: false },
    after: { right: false, bottom: true },
  },
  right: {
    before: { right: true, bottom: false },
    after: { right: true, bottom: true },
  },
};

type Rgb = readonly [number, number, number];

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA, row by row. */
  readonly data: ReadonlyArray<number>;
}

/** A base64 PNG's pixels: decoded by the page's own image pipeline, no dependency. */
async function decodePng(page: Page, base64: string): Promise<DecodedPng> {
  return page.evaluate(async (data) => {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => {
        resolve();
      });
      image.addEventListener("error", () => {
        reject(new Error("decode failed"));
      });
      image.src = `data:image/png;base64,${data}`;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: pixels.width,
      height: pixels.height,
      data: Array.from(pixels.data),
    };
  }, base64);
}

function pixelAt(png: DecodedPng, x: number, y: number): Rgb {
  const index = (y * png.width + x) * 4;
  return [png.data[index], png.data[index + 1], png.data[index + 2]];
}

interface ScreenshotClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A clip of the page at the DEVICE's own resolution (`scale: 1` on the clip),
 * through DevTools rather than `page.screenshot`: the clip is handed to the
 * compositor as given, so a box snapped to whole device pixels is not
 * resampled, which is the whole point of measuring blended pixels.
 */
async function captureClip(
  cdp: CDPSession,
  clip: ScreenshotClip,
): Promise<string> {
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: 1 },
    captureBeyondViewport: false,
  });
  return shot.data;
}

/** A colour as a screenshot paints it, off a swatch laid over the page. */
async function swatchPixel(canvas: CanvasPage, cssColor: string): Promise<Rgb> {
  const { page, cdp } = canvas;
  await page.evaluate(
    `{
       const node = document.createElement("div");
       node.id = "canvas-geometry-swatch";
       Object.assign(node.style, { position: "fixed", left: "0px", top: "0px", width: "8px", height: "8px", zIndex: "2147483000", background: ${JSON.stringify(cssColor)} });
       document.body.append(node);
     }`,
  );
  try {
    await nextFrames(page, 2);
    const png = await decodePng(
      page,
      await captureClip(cdp, { x: 2, y: 2, width: 4, height: 4 }),
    );
    return pixelAt(png, 1, 1);
  } finally {
    await page.evaluate(
      `document.getElementById("canvas-geometry-swatch")?.remove()`,
    );
  }
}

export interface ArcAntialias {
  readonly pseudo: "::before" | "::after";
  /** Device pixels that are none of the arc's three flat colours. */
  readonly blended: number;
  /** The floor: half a device pixel per CSS px of the arc's width. */
  readonly needed: number;
}

/**
 * The arcs are anti-aliased: each concave corner's box, read off a screenshot
 * at the device's own resolution, holds a band of blended pixels along both
 * edges of its outline ring, as every convex corner does. Each pixel is either
 * one of the three flat colours the corner is drawn from (what shows through
 * it, the outline, the fill) or a blend of them. A hard-stop gradient (the
 * bug) paints only flat colours, so its arc stair-steps: not one blended pixel
 * at DPR 1 or 2 (at 1.5 the gradient is resampled, which blurs rather than
 * anti-aliases it, so 1.5 cannot tell the two apart and is not measured).
 * A rounded box blends the ring's two edges; half a pixel per CSS px of
 * radius is a floor the light theme, whose three colours sit within 27 levels,
 * still clears. The outermost device pixel on each side is skipped: the box's
 * own edge is not the arc.
 */
export async function measureArcAntialias(
  canvas: CanvasPage,
  side: JoinSide,
  read: SheetJoinRead,
  devicePixelRatio: number,
): Promise<ReadonlyArray<ArcAntialias>> {
  const outline = await swatchPixel(canvas, "var(--canvas-border)");
  const fill = await swatchPixel(canvas, read.fill);
  const results: ArcAntialias[] = [];
  for (const pseudo of ["before", "after"] as const) {
    const arc = read[pseudo];
    const corner = ARC_CENTRES[side][pseudo];
    // The box widened to whole device pixels, so the capture is not resampled.
    const snap = (value: number, round: (value: number) => number): number =>
      round(value * devicePixelRatio) / devicePixelRatio;
    const x = snap(arc.left, Math.floor);
    const y = snap(arc.top, Math.floor);
    const png = await decodePng(
      canvas.page,
      await captureClip(canvas.cdp, {
        x,
        y,
        width: snap(arc.right, Math.ceil) - x,
        height: snap(arc.bottom, Math.ceil) - y,
      }),
    );
    // The backdrop is read just inside the arc's centre corner.
    const backdrop = pixelAt(
      png,
      corner.right ? png.width - 2 : 1,
      corner.bottom ? png.height - 2 : 1,
    );
    const flats: ReadonlyArray<Rgb> = [backdrop, outline, fill];
    const isFlat = (pixel: Rgb): boolean =>
      flats.some(
        (flat) =>
          Math.max(
            Math.abs(flat[0] - pixel[0]),
            Math.abs(flat[1] - pixel[1]),
            Math.abs(flat[2] - pixel[2]),
          ) <= 1,
      );
    let blended = 0;
    for (let row = 1; row < png.height - 1; row += 1) {
      for (let column = 1; column < png.width - 1; column += 1) {
        if (!isFlat(pixelAt(png, column, row))) blended += 1;
      }
    }
    results.push({
      pseudo: pseudo === "before" ? "::before" : "::after",
      blended,
      needed: Math.floor(((arc.right - arc.left) * devicePixelRatio) / 2),
    });
  }
  return results;
}
