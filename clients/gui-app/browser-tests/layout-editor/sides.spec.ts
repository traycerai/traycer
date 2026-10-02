import { expect, test, type Page } from "@playwright/test";

import {
  activateEpicAndWait,
  canvasLoad,
  configureCanvas,
  setThemeAndWait,
  stripTokens,
  type CanvasConfig,
  type Placement,
} from "../support/layout-editor/canvas.ts";
import {
  boxText,
  note,
  rectOf,
  requireRect,
  violationLog,
  type Rect,
} from "../support/layout-editor/dom.ts";
import { moveTo } from "../support/layout-editor/input.ts";
import { layoutEditorUse, sharedPage } from "../support/layout-editor/pages.ts";
import {
  contrastRatio,
  inkInside,
  resolveRgb,
  rgbText,
  sampleAmber,
  samplePixelAt,
} from "../support/layout-editor/pixels.ts";
import { waitForStableBoxes } from "../support/layout-editor/waits.ts";

// THE SIDE PLACEMENTS' REGRESSION (A11, A12, A13, L-163, D4, S-04, 6.x).
//
// One load per simulated window chrome (`wco` is read once at mount: none,
// mac, win and mac-fullscreen), each opened at the left placement with the
// placement, the collapsed flag and the inspector's dock then switched LIVE
// through the fixture's probe. That is four loads where the driver made ten.
//
//   A11. Every strip part is the hit target at its own centre: the top
//        block's buttons, Home, a row, the active row's close, every foot
//        control and the resize handle. Nothing (a band, the inspector, the
//        surface's corner, an overlay) sits over the strip where it takes
//        input.
//   A13. What the title band does to the layout, from the chrome it
//        simulates: where it is drawn it is the 40px floor
//        (`--app-title-band-height`) and the strip starts where it ends; the
//        macOS left strip owns the title bar with a 40px row padded by the
//        traffic-light inset; the surface frame is flush under whatever is
//        above it; and a dialog overlay starts under the band, which is a
//        `:has()` rule in CSS that only a browser resolves.
//   A12. The collapsed rail: 60px (never under the 82px inset on macOS with
//        the strip at the left), each monogram tile a centred 40x44 tile
//        holding a 26x22 chip with its letters drawn over the meter's row.
//   D4/D11. The active rail tile paints its own fill in both themes, and the
//        chip its tint.
//   L-163. The session row (the Customizing tab) is a SOLID
//        `--warning-foreground` object with `--background` text.
//   Row kit. The group is ONE tinted block holding its header and every
//        member, the split pair's rows included.
//   S-33. With the inspector docked left, the traffic-light reserve moves to
//        its header and the strip's title row drops to the 12px gutter.
//   6.1. A right strip sits left of a right-docked inspector, never under it.
//
// Not here, because a jsdom test decides it: which chrome draws a band, a
// title row or neither (`app-title-band-kind.test.ts`); the editing frame on
// the column's four edges, which the canvas spec counts in pixels once
// (`canvas.spec.ts`, A9); and the mirrored right-hand rail, whose geometry is
// the left rail's reflected.

test.use(layoutEditorUse());

/**
 * The fixture's window chrome stand-ins, restated from the production CSS so
 * that a drift is a failure. Each names the constant it mirrors.
 *
 * `--app-title-band-height`'s floor: `max(env(titlebar-area-height, 0px), 40px)`
 * (`window-chrome.css`).
 */
const TITLE_BAND_HEIGHT = 40;
/** `env(titlebar-area-x, 82px)`: the fallback the fixture's `.wco` stands on. */
const WCO_LEADING_INSET_FALLBACK = 82;
/** `min(env(titlebar-area-x, 82px), 0.75rem)` while the inspector docks left. */
const LEFT_DOCK_COLUMN_GUTTER = 12;
/**
 * The rail tile and its monogram chip: `SIDE_TAB_TILE_CLASS` (`h-11 w-10`)
 * and `MonogramChip` (`h-[22px] w-[26px]`), in `side-strip-tokens.ts` /
 * `side-tab-row.tsx`. Neither is exported as a number.
 */
const SIDE_TAB_TILE = { width: 40, height: 44 };
const SIDE_TAB_MONOGRAM_CHIP = { width: 26, height: 22 };
/** A pixel is the session fill when every channel is this close to the painted token. */
const SOLID_FILL_TOLERANCE = 12;

/** The strip is up and Home is drawn (a `tabs=left` load shows it after every reset). */
const STRIP_READY =
  "document.querySelector('[data-testid=\"side-tab-strip\"]') !== null";

const AT_REST_LEFT: CanvasConfig = {
  tabs: "left",
  collapsed: false,
  dock: "right",
  session: true,
};

function tabsAt(placement: Placement, session: boolean): CanvasConfig {
  return { tabs: placement, collapsed: false, dock: "right", session };
}

// --- reads shared by the checks ----------------------------------------------

interface SideBase {
  readonly column: Rect;
  readonly strip: Rect;
  readonly edge: string | null;
  readonly fixtureHeader: boolean;
}

async function readBase(page: Page): Promise<SideBase> {
  const base = await page.evaluate<SideBase | null>(`(() => {
    const column = document.querySelector("[data-layout-column]");
    const strip = document.querySelector('[data-testid="side-tab-strip"]');
    if (column === null || strip === null) return null;
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      column: rect(column),
      strip: rect(strip),
      edge: strip.getAttribute("data-edge"),
      fixtureHeader: document.querySelector("[data-fixture-header]") !== null,
    };
  })()`);
  if (base === null) throw new Error("no app column or no side strip");
  return base;
}

/** The strip is the stored edge's, flush with the column's edge, and the specimen header is never used beside it. */
async function assertFlush(page: Page, edge: Placement): Promise<SideBase> {
  const base = await readBase(page);
  note(
    `${edge}: column ${boxText(base.column)}, strip ${boxText(base.strip)} (data-edge=${String(base.edge)})`,
  );
  expect(
    base.edge,
    `the strip carries data-edge=${String(base.edge)}, stored ${edge}`,
  ).toBe(edge);
  const offEdge =
    edge === "left"
      ? Math.abs(base.strip.x - base.column.x)
      : Math.abs(
          base.strip.x + base.strip.width - (base.column.x + base.column.width),
        );
  expect(
    offEdge,
    `the strip at ${boxText(base.strip)} is not on the column's ${edge} edge ${boxText(base.column)}`,
  ).toBeLessThanOrEqual(0.5);
  expect(
    base.fixtureHeader,
    "the fixture's header specimen is mounted beside a side strip",
  ).toBe(false);
  return base;
}

interface PartHit {
  readonly name: string;
  readonly error: string | null;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly ok: boolean;
  readonly disabled: boolean;
  readonly inStrip: boolean;
  readonly hit: string | null;
}

/**
 * A11: every strip part is the hit target at its own centre. A natively
 * disabled button takes no pointer events by design; its tooltip wrapper of
 * the same box is then the target, which is what the product built it for.
 * The history arrows self-gate on the desktop's persistent history: a browser
 * shell has its own back button, so there they must be absent, not skipped.
 */
async function assertStripHits(page: Page, desktop: boolean): Promise<void> {
  const parts = await page.evaluate<readonly PartHit[]>(`(() => {
    const strip = document.querySelector('[data-testid="side-tab-strip"]');
    const q = (selector) => strip.querySelector(selector);
    const arrows = ${String(desktop)}
      ? [
          ["back", q('[data-testid="history-nav-back"]')],
          ["forward", q('[data-testid="history-nav-forward"]')],
        ]
      : [];
    const strayArrows = ${String(desktop)} ? 0 : strip.querySelectorAll('[data-testid^="history-nav-"]').length;
    const named = [
      ...arrows,
      ["new task", q('[data-testid="side-strip-new-task"]')],
      ["collapse", q('[data-testid="side-tab-strip-collapse"]')],
      ["home", q('[data-testid="tab-home"]')],
      ["row", [...strip.querySelectorAll('[data-testid="header-tab-strip-scroll"] [data-side-tab]')].find((row) => row.getAttribute("data-active") !== "true") ?? null],
      ["close", q('[data-revealed="always"] [data-testid^="tab-close-"]')],
      ["handle", q('[data-testid="side-tab-strip-resize-handle"]')],
    ];
    const foot = q('[data-testid="side-strip-foot"]');
    const footControls = foot === null ? [] : [...foot.querySelectorAll("button, a[href], [role='button']")];
    footControls.forEach((node, index) => named.push(["foot " + (node.getAttribute("aria-label") ?? node.getAttribute("data-testid") ?? String(index)), node]));
    if (foot !== null && footControls.length === 0) named.push(["foot (no control)", null]);
    if (strayArrows > 0) named.push(["history arrows in a browser shell", strip.querySelector('[data-testid^="history-nav-"]'), "stray"]);
    return named.map(([name, node, stray]) => {
      if (stray === "stray") return { name, error: "drawn although the shell has no persistent history", width: 0, height: 0, x: 0, y: 0, ok: false, disabled: false, inStrip: false, hit: null };
      if (node === null) return { name, error: "not in the strip", width: 0, height: 0, x: 0, y: 0, ok: false, disabled: false, inStrip: false, hit: null };
      const r = node.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const own = hit !== null && (hit === node || node.contains(hit));
      const wrapper = node.parentElement;
      const w = wrapper === null ? null : wrapper.getBoundingClientRect();
      const disabledWrapper =
        node.disabled === true &&
        hit === wrapper &&
        w !== null &&
        Math.abs(w.width - r.width) < 1 &&
        Math.abs(w.height - r.height) < 1;
      return {
        name,
        error: null,
        width: r.width,
        height: r.height,
        x,
        y,
        ok: own || disabledWrapper,
        disabled: node.disabled === true,
        inStrip: hit !== null && strip.contains(hit),
        hit: hit === null ? null : hit.tagName + "." + String(hit.getAttribute("class") ?? "").slice(0, 70) + (hit.getAttribute("data-testid") ? "#" + hit.getAttribute("data-testid") : ""),
      };
    });
  })()`);
  const violations = violationLog();
  for (const part of parts) {
    if (part.error !== null) {
      violations.add(`${part.name}: ${part.error}`);
      continue;
    }
    if (part.width === 0 || part.height === 0) {
      violations.add(
        `${part.name}: its box is ${String(part.width)}x${String(part.height)}`,
      );
      continue;
    }
    violations.check(
      part.ok,
      `${part.name}: elementFromPoint(${part.x.toFixed(0)}, ${part.y.toFixed(0)}) is ${String(part.hit)} (inside the strip: ${String(part.inStrip)})`,
    );
  }
  note(
    `${String(parts.length)} parts hit-tested: ${parts.map((part) => part.name + (part.disabled ? " (disabled)" : "")).join(", ")}`,
  );
  violations.assertNone(
    "A11: a strip part is not the hit target at its centre",
  );
}

interface BandRead {
  readonly band: { readonly rect: Rect; readonly display: string } | null;
  readonly stripTop: number;
  readonly titleRow: {
    readonly rect: Rect;
    readonly paddingLeft: string;
  } | null;
  readonly surfaceMarginTop: string | null;
  readonly surfaceClass: string | null;
  readonly overlayTop: string;
  readonly wco: boolean;
  readonly bandVariable: string;
}

async function readBand(page: Page): Promise<BandRead> {
  return page.evaluate<BandRead>(`(() => {
    const band = document.querySelector('[data-testid="app-title-band"]');
    const strip = document.querySelector('[data-testid="side-tab-strip"]');
    const titleRow = document.querySelector('[data-testid="side-strip-title-row"]');
    const surface = document.querySelector('[data-layout-column] main > div');
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");
    overlay.style.position = "fixed";
    overlay.style.pointerEvents = "none";
    document.body.append(overlay);
    const overlayTop = getComputedStyle(overlay).top;
    overlay.remove();
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      band: band === null ? null : { rect: rect(band), display: getComputedStyle(band).display },
      stripTop: strip.getBoundingClientRect().top,
      titleRow: titleRow === null ? null : { rect: rect(titleRow), paddingLeft: getComputedStyle(titleRow).paddingLeft },
      surfaceMarginTop: surface === null ? null : getComputedStyle(surface).marginTop,
      surfaceClass: surface === null ? null : surface.getAttribute("class"),
      overlayTop,
      wco: document.documentElement.classList.contains("wco"),
      bandVariable: getComputedStyle(document.documentElement).getPropertyValue("--app-title-band-height").trim(),
    };
  })()`);
}

interface BandExpectation {
  /**
   * What the chrome is documented to draw here (the decision itself is
   * `app-title-band-kind.test.ts`'s): a band shown, in the tree but hidden, or
   * none of it at all. Stated so a geometry check has a positive control and
   * cannot pass on an empty document.
   */
  readonly band: "shown" | "hidden" | "not-drawn";
  /** The strip owns the title bar with its own 40px row (macOS, strip at the left). */
  readonly titleRow: boolean;
}

/**
 * A13 and the surface frame's inset (S-04, 6.2, 6.3, D1): the geometry the
 * band, or its absence, gives the layout.
 */
async function assertTitleBand(
  page: Page,
  base: SideBase,
  expected: BandExpectation,
): Promise<void> {
  const read = await readBand(page);
  const shown = read.band !== null && read.band.display !== "none";
  note(
    `band ${read.band === null ? "absent" : `${read.band.display} ${boxText(read.band.rect)}`}, strip top ${read.stripTop.toFixed(1)}, title row ${read.titleRow === null ? "none" : `${boxText(read.titleRow.rect)} pl=${read.titleRow.paddingLeft}`}, surface margin-top ${String(read.surfaceMarginTop)}, dialog overlay top ${read.overlayTop}, .wco=${String(read.wco)}`,
  );
  const violations = violationLog();
  if (expected.band === "shown") {
    violations.check(
      shown,
      `the band is ${read.band === null ? "absent" : "hidden"} where the native controls need it`,
    );
    if (read.band !== null && shown) {
      violations.check(
        Math.abs(read.band.rect.height - TITLE_BAND_HEIGHT) <= 0.5,
        `the band is ${read.band.rect.height.toFixed(1)}px tall, expected the ${String(TITLE_BAND_HEIGHT)}px floor of --app-title-band-height`,
      );
      const bandBottom = read.band.rect.y + read.band.rect.height;
      violations.check(
        Math.abs(bandBottom - read.stripTop) <= 0.5,
        `the band ends at y=${bandBottom.toFixed(1)} and the strip starts at y=${read.stripTop.toFixed(1)}; the strip must start where the band ends`,
      );
    }
  } else if (expected.band === "hidden") {
    violations.check(
      read.band !== null,
      "no title band in the tree for a frameless right strip",
    );
    violations.check(
      !shown,
      `the band is displayed (${String(read.band?.display)}) with no window-controls overlay`,
    );
  }
  // Flush surface (5c7ba8ea): the frame meets the band, or the window top,
  // with no shell gap of its own.
  violations.check(
    read.surfaceMarginTop === "0px",
    `the surface frame's margin-top is ${String(read.surfaceMarginTop)}, expected 0px: the task surface is flush under the band or the window top (class "${String(read.surfaceClass)}")`,
  );
  if (expected.titleRow) {
    if (read.titleRow === null) {
      violations.add(
        "the strip draws no title row where it owns the title bar",
      );
    } else {
      violations.check(
        Math.abs(read.titleRow.rect.height - TITLE_BAND_HEIGHT) <= 0.5,
        `the strip's title row is ${read.titleRow.rect.height.toFixed(1)}px tall, expected ${String(TITLE_BAND_HEIGHT)}px`,
      );
      violations.check(
        Math.abs(read.titleRow.rect.y - base.column.y) <= 0.5,
        `the strip's title row starts at y=${read.titleRow.rect.y.toFixed(1)}, not at the window top`,
      );
      violations.check(
        read.titleRow.paddingLeft === `${String(WCO_LEADING_INSET_FALLBACK)}px`,
        `the title row pads ${read.titleRow.paddingLeft} at the leading edge, expected the ${String(WCO_LEADING_INSET_FALLBACK)}px traffic-light inset`,
      );
    }
  }
  if (read.wco) {
    const overlayTop = shown ? `${String(TITLE_BAND_HEIGHT)}px` : "0px";
    violations.check(
      read.overlayTop === overlayTop,
      `a dialog overlay starts at top ${read.overlayTop}, expected ${overlayTop} (--app-title-band-height is "${read.bandVariable}")`,
    );
  }
  violations.assertNone("A13: the title band's geometry");
}

/**
 * A11 to A13 in one window: the strip flush on `edge`, every part hit at its
 * centre, and the band's geometry.
 */
async function assertWindow(
  page: Page,
  edge: Placement,
  desktop: boolean,
  expected: BandExpectation,
): Promise<void> {
  const base = await assertFlush(page, edge);
  await assertStripHits(page, desktop);
  await assertTitleBand(page, base, expected);
}

// --- the session row, the row kit, the rail ---------------------------------

/**
 * The session row (L-163): the Customizing tab, active, is a SOLID
 * `--warning-foreground` object with `--background` text. Sampled in pixels at
 * three points of its fill clear of the label and the close button, so a dim,
 * a wash or a translucent fill all read as the defect they are.
 */
async function assertSessionRow(page: Page): Promise<void> {
  const target = await sampleAmber(page);
  const row = await page.evaluate<{
    readonly error: string | null;
    readonly marker: string | null;
    readonly active: string | null;
    readonly rect: Rect;
    readonly titleColor: string | null;
    readonly background: string;
  }>(`(() => {
    const zero = { x: 0, y: 0, width: 0, height: 0 };
    const marker = document.querySelector('[data-testid="side-tab-strip"] [data-layout-session-tab]');
    if (marker === null) return { error: "no session row in the strip", marker: null, active: null, rect: zero, titleColor: null, background: "" };
    const row = marker.closest("[data-side-tab]");
    if (row === null) return { error: "the session marker is outside a row", marker: null, active: null, rect: zero, titleColor: null, background: "" };
    const title = row.querySelector('[data-testid="side-tab-title"]');
    const probe = document.createElement("span");
    probe.style.display = "none";
    row.append(probe);
    probe.style.color = "var(--background)";
    const background = getComputedStyle(probe).color;
    probe.remove();
    const r = row.getBoundingClientRect();
    return {
      error: null,
      marker: marker.getAttribute("data-layout-session-tab"),
      active: row.getAttribute("data-active"),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      titleColor: title === null ? null : getComputedStyle(title).color,
      background,
    };
  })()`);
  expect(row.error, "the session row").toBeNull();
  expect(
    [row.marker, row.active],
    `the session row is ${String(row.marker)} / active=${String(row.active)}, expected the filled, active Customizing tab`,
  ).toEqual(["filled", "true"]);
  expect(
    row.titleColor,
    `the session row's label is ${String(row.titleColor)}, expected the --background colour ${row.background}`,
  ).toBe(row.background);
  const points = [
    {
      name: "leading padding",
      x: row.rect.x + 3,
      y: row.rect.y + row.rect.height / 2,
    },
    {
      name: "top margin",
      x: row.rect.x + row.rect.width * 0.55,
      y: row.rect.y + 3,
    },
    {
      name: "bottom margin",
      x: row.rect.x + row.rect.width * 0.35,
      y: row.rect.y + row.rect.height - 4,
    },
  ];
  const violations = violationLog();
  for (const point of points) {
    const pixel = await samplePixelAt(page, point.x, point.y);
    const off = Math.max(
      ...pixel.map((channel, index) => Math.abs(channel - target[index])),
    );
    note(
      `session row ${point.name} paints ${rgbText(pixel)} against the token ${rgbText(target)}`,
    );
    violations.check(
      off <= SOLID_FILL_TOLERANCE,
      `the session row's ${point.name} at (${point.x.toFixed(0)}, ${point.y.toFixed(0)}) paints ${rgbText(pixel)}, not the solid --warning-foreground ${rgbText(target)} (L-163)`,
    );
  }
  violations.assertNone("L-163: the session row is not a solid object");
}

interface RailTile {
  readonly text: string;
  readonly rect: Rect;
  readonly chip: Rect | null;
  readonly meter: Rect | null;
}

/**
 * A12 and D4: the collapsed rail's width (`floor`, exact unless the macOS
 * traffic lights push it wider), and each monogram tile a centred 40x44 tile
 * holding a 26x22 chip with its letters actually drawn (ink inside the chip
 * that is not the chip's fill) over the meter's row, which every tile mounts
 * so the monogram never moves.
 */
async function assertRail(
  page: Page,
  base: SideBase,
  floor: { readonly px: number; readonly exact: boolean },
): Promise<void> {
  const violations = violationLog();
  note(
    `rail ${base.strip.width.toFixed(1)}px wide (expected ${floor.exact ? "" : "at least "}${String(floor.px)}px)`,
  );
  violations.check(
    floor.exact
      ? Math.abs(base.strip.width - floor.px) <= 0.5
      : base.strip.width >= floor.px - 0.5,
    `the rail is ${base.strip.width.toFixed(1)}px wide, expected ${floor.exact ? "" : "at least "}${String(floor.px)}px (D4, D15)`,
  );
  const tiles = await page.evaluate<readonly RailTile[]>(
    `(() => [...document.querySelectorAll('[data-testid="side-tab-strip"] [data-side-tab="collapsed"][data-tile-kind="monogram"]')].map((tile) => {
      const box = (node) => {
        if (node === null) return null;
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const chip = tile.querySelector('[data-testid="side-tab-monogram-chip"]');
      const meter = tile.querySelector('[data-testid="side-tab-meter"]');
      return {
        text: (chip?.textContent ?? "").trim(),
        rect: box(tile),
        chip: box(chip),
        meter: box(meter),
      };
    }))()`,
  );
  expect(tiles.length, "no monogram tile in the rail").toBeGreaterThan(0);
  const stripCentre = base.strip.x + base.strip.width / 2;
  for (const tile of tiles) {
    violations.check(
      Math.abs(tile.rect.width - SIDE_TAB_TILE.width) <= 0.5 &&
        Math.abs(tile.rect.height - SIDE_TAB_TILE.height) <= 0.5,
      `the "${tile.text}" tile is ${tile.rect.width.toFixed(1)}x${tile.rect.height.toFixed(1)}, expected ${String(SIDE_TAB_TILE.width)}x${String(SIDE_TAB_TILE.height)} (D4)`,
    );
    const tileCentre = tile.rect.x + tile.rect.width / 2;
    violations.check(
      Math.abs(tileCentre - stripCentre) <= 1,
      `the "${tile.text}" tile is centred at x=${tileCentre.toFixed(1)}, the rail at x=${stripCentre.toFixed(1)}`,
    );
    if (tile.chip === null) {
      violations.add(`the "${tile.text}" tile draws no monogram chip`);
      continue;
    }
    violations.check(
      Math.abs(tile.chip.width - SIDE_TAB_MONOGRAM_CHIP.width) <= 0.5 &&
        Math.abs(tile.chip.height - SIDE_TAB_MONOGRAM_CHIP.height) <= 0.5,
      `the "${tile.text}" chip is ${tile.chip.width.toFixed(1)}x${tile.chip.height.toFixed(1)}, expected ${String(SIDE_TAB_MONOGRAM_CHIP.width)}x${String(SIDE_TAB_MONOGRAM_CHIP.height)}`,
    );
    if (tile.meter === null) {
      violations.add(
        `the "${tile.text}" tile mounts no meter, so its monogram moves when one arrives`,
      );
    } else {
      violations.check(
        tile.meter.y >= tile.chip.y + tile.chip.height - 0.5,
        `the "${tile.text}" meter starts at y=${tile.meter.y.toFixed(1)}, inside the chip ending at y=${(tile.chip.y + tile.chip.height).toFixed(1)}`,
      );
    }
    if (tile.text.length === 0) {
      violations.add(`a monogram tile at ${boxText(tile.rect)} has no letters`);
      continue;
    }
    // Ink: pixels in the chip's middle that differ from the fill beside them.
    const ink = await inkInside(page, tile.chip, null);
    violations.check(
      ink >= 4,
      `the "${tile.text}" monogram paints ${String(ink)} ink pixels, so its letters are not drawn`,
    );
  }
  note(
    `${String(tiles.length)} monogram tiles: ${tiles.map((tile) => tile.text).join(" ")}`,
  );
  violations.assertNone("A12: the collapsed rail");
}

interface TileRead {
  readonly rect: Rect;
  readonly chip: Rect | null;
  readonly accent: string | null;
  readonly active: string | null;
}

const TILES_BY_MONOGRAM_PROBE = `(() => {
  const tiles = [...document.querySelectorAll('[data-testid="side-tab-strip"] [data-side-tab="collapsed"][data-tile-kind="monogram"]')];
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return Object.fromEntries(tiles.map((tile) => {
    const chip = tile.querySelector('[data-testid="side-tab-monogram-chip"]');
    return [(chip?.textContent ?? "").trim(), {
      rect: box(tile),
      chip: chip === null ? null : box(chip),
      accent: tile.querySelector('[data-testid="side-tab-accent"]')?.getAttribute("data-accent") ?? null,
      active: tile.getAttribute("data-active"),
    }];
  }));
})()`;

function tilesByMonogram(
  page: Page,
): Promise<Readonly<Record<string, TileRead | undefined>>> {
  return page.evaluate<Readonly<Record<string, TileRead | undefined>>>(
    TILES_BY_MONOGRAM_PROBE,
  );
}

/** A page-side expression that is true once the tile lettered `monogram` reads `data-active`. */
function tileIsActive(monogram: string): string {
  return `[...document.querySelectorAll('[data-testid="side-tab-strip"] [data-side-tab="collapsed"][data-tile-kind="monogram"]')].some((tile) => (tile.querySelector('[data-testid="side-tab-monogram-chip"]')?.textContent ?? "").trim() === ${JSON.stringify(monogram)} && tile.getAttribute("data-active") === "true")`;
}

/**
 * How much lighter or darker the active tile's fill has to be than the ground
 * beside it, as a WCAG contrast ratio, to read as a fill at all.
 *
 * Measured on the tile's straight edge, the joined fill is 1.21:1 over the
 * light ground and 1.17:1 over the dark one; 1.10 leaves the design clear of
 * the floor by about 6%, and is the lowest ratio at which two flat greys are
 * told apart on a screen. (The driver's 1.05 floor "passed" a 1.07:1 that was
 * the anti-aliased corner arc, not the fill: see `assertTileFill`.)
 */
const ACTIVE_FILL_FLOOR = 1.1;

/**
 * The rail tile's two fills in both themes (D4, D11 - auto-tint retired,
 * `side-tab-row.tsx`): the tint lives on the ring (`side-tab-accent`'s
 * `data-accent`, `true` for a coloured tab, `false` for a task with none -
 * auto-tint no longer reaches the row, so an uncoloured task draws no ring at
 * all), and the ACTIVE tile paints its own fill around the chip. Delta (a tab
 * colour) and Epsilon (none) are read inactive and then active, on the
 * tile's own fill beside the chip.
 *
 * The point is on the tile's left edge at mid height, 3px in: straight fill,
 * clear of the chip (which starts 7px in) and of the corners. The driver read
 * the diagonal 3px in from the corner, which lies OUTSIDE the tile's 12px
 * rounded corner: it measured the anti-aliased rim, half a fill, so its 1.05
 * floor passed a "measured 1.07:1" that was not the design's contrast.
 *
 * What the tile paints is what the cascade resolved for it, not a class read
 * off the source: an active tile that is joined to its sheet paints the
 * sheet's fill (`[data-sheet-joined]`, `--join-fill`), which replaces the
 * `bg-foreground/8` of `SIDE_TAB_TILE_ACTIVE_CLASS`. So the painted pixel is
 * asserted equal to the tile's own computed `background-color` - the fill
 * reaches the screen unclipped and uncovered, which only a screenshot shows -
 * and that fill is asserted a visible step away from the resting ground.
 */
async function assertTileFill(page: Page): Promise<void> {
  const violations = violationLog();
  for (const theme of ["light", "dark"] as const) {
    await setThemeAndWait(page, theme);
    await activateEpicAndWait(page, "fixture-zeta", tileIsActive("ZS"));
    await moveTo(page, 1, 1);
    const cases = [
      { monogram: "DM", epicId: "fixture-delta", accent: "true" },
      { monogram: "EC", epicId: "fixture-epsilon", accent: "false" },
    ];
    const resting = await tilesByMonogram(page);
    for (const entry of cases) {
      const tile = resting[entry.monogram];
      if (tile === undefined || tile.chip === null) {
        violations.add(`${theme}: no "${entry.monogram}" tile with a chip`);
        continue;
      }
      violations.check(
        tile.accent === entry.accent,
        `${theme}: the "${entry.monogram}" tile's ring is data-accent=${String(tile.accent)}, expected ${entry.accent} (D11)`,
      );
      const point = {
        x: tile.rect.x + 3,
        y: tile.rect.y + tile.rect.height / 2,
      };
      const ground = await samplePixelAt(page, point.x, point.y);
      const chipPixel = await samplePixelAt(
        page,
        tile.chip.x + 2,
        tile.chip.y + tile.chip.height / 2,
      );
      await activateEpicAndWait(
        page,
        entry.epicId,
        tileIsActive(entry.monogram),
      );
      const active = (await tilesByMonogram(page))[entry.monogram];
      const computed = await page.evaluate<string>(`(() => {
        const tile = [...document.querySelectorAll('[data-testid="side-tab-strip"] [data-side-tab="collapsed"][data-tile-kind="monogram"]')].find((node) => (node.querySelector('[data-testid="side-tab-monogram-chip"]')?.textContent ?? "").trim() === ${JSON.stringify(entry.monogram)});
        return tile === undefined ? "" : getComputedStyle(tile).backgroundColor;
      })()`);
      const painted = await samplePixelAt(page, point.x, point.y);
      const expected = await resolveRgb(page, computed);
      const fillRatio = contrastRatio(ground, painted);
      const chipRatio = contrastRatio(chipPixel, ground);
      note(
        `${theme}: "${entry.monogram}" (accent ${String(tile.accent)}) ground ${rgbText(ground)} -> active ${rgbText(painted)} = ${fillRatio.toFixed(2)}:1 (its computed fill is ${computed}); chip ${rgbText(chipPixel)} against the ground ${chipRatio.toFixed(2)}:1`,
      );
      violations.check(
        active?.active === "true",
        `${theme}: "${entry.monogram}" is data-active=${String(active?.active)} after activating it`,
      );
      violations.check(
        painted.every(
          (channel, index) => Math.abs(channel - expected[index]) <= 3,
        ),
        `${theme}: the active "${entry.monogram}" tile paints ${rgbText(painted)} at (${point.x.toFixed(0)}, ${point.y.toFixed(0)}), not its own computed fill ${computed} (${rgbText(expected)}): something covers or clips the fill`,
      );
      violations.check(
        fillRatio >= ACTIVE_FILL_FLOOR,
        `${theme}: the active "${entry.monogram}" tile's fill is ${fillRatio.toFixed(2)}:1 against the ground beside it (${rgbText(ground)} -> ${rgbText(painted)}), under ${String(ACTIVE_FILL_FLOOR)}:1, so nothing marks it active`,
      );
      // The chip is the tint: it has to read as something other than the
      // tile's own ground. A ratio of 1.00 is the same colour sampled twice.
      violations.check(
        chipRatio >= CHIP_DIFFERS_FLOOR,
        `${theme}: the "${entry.monogram}" chip paints its tile's own fill (${chipRatio.toFixed(2)}:1), so its tint is not drawn`,
      );
      await activateEpicAndWait(page, "fixture-zeta", tileIsActive("ZS"));
    }
  }
  violations.assertNone("D4/D11: the rail tile's fills");
}

/**
 * How far apart the chip's tint and the tile's ground have to be, as a WCAG
 * contrast ratio, to count as two colours: the same colour sampled twice reads
 * 1.00, and the softest tint in the fixture measures well above this.
 */
const CHIP_DIFFERS_FLOOR = 1.05;

/**
 * The group block in the expanded strip, at rest: ONE tinted box holding the
 * group's header and every member, including the split pair, with the members'
 * rows inside its box and a fill that is not the strip's own ground.
 *
 * This used to also check the 10px status badge on a 16px leading tile, but
 * a task row has no leading slot any more: its one status trails
 * (`sideTabStatusOf`), and Delta's seeded failure shows as the "Failed" chip
 * there, an element with its own coverage - so there was nothing left here to
 * measure.
 */
async function assertRowKit(page: Page): Promise<void> {
  const kit = await page.evaluate<{
    readonly block: Rect | null;
    readonly fill: string;
    readonly header: Rect | null;
    readonly rows: ReadonlyArray<Rect>;
  }>(`(() => {
    const strip = document.querySelector('[data-testid="side-tab-strip"]');
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const block = strip.querySelector('[data-testid^="side-tab-group-block-"]');
    if (block === null) return { block: null, fill: "", header: null, rows: [] };
    const header = block.querySelector('[data-testid^="side-tab-group-header-"]');
    return {
      block: rect(block),
      fill: getComputedStyle(block).backgroundColor,
      header: header === null ? null : rect(header),
      rows: [...block.querySelectorAll('[role="tab"]')].map(rect),
    };
  })()`);
  const violations = violationLog();
  const { block, header, rows } = kit;
  violations.check(block !== null, "no group block in the expanded strip");
  violations.check(header !== null, "the group block has no header inside it");
  violations.check(
    rows.length >= 3,
    `${String(rows.length)} member rows inside the block, expected the seeded group's three (Alpha and the Beta/Gamma pair)`,
  );
  if (block !== null) {
    note(
      `group block: ${boxText(block)}, fill ${kit.fill}; ${String(rows.length)} rows inside`,
    );
    violations.check(
      kit.fill !== "rgba(0, 0, 0, 0)",
      "the group block paints no fill, so it does not read as one block",
    );
    for (const row of rows) {
      violations.check(
        row.x >= block.x - 0.5 &&
          row.x + row.width <= block.x + block.width + 0.5 &&
          row.y >= block.y - 0.5 &&
          row.y + row.height <= block.y + block.height + 0.5,
        `a member row at ${boxText(row)} overruns its group block at ${boxText(block)}`,
      );
    }
  }
  violations.assertNone("Row kit: the expanded group's block");
}

/** A right strip sits left of a right-docked inspector, never under it (6.1). */
async function assertBesideInspector(
  page: Page,
  base: SideBase,
): Promise<void> {
  const inspector = await rectOf(page, "[data-layout-inspector]");
  expect(inspector, "no inspector in the session").not.toBeNull();
  if (inspector === null) return;
  note(`inspector ${boxText(inspector)}, strip ${boxText(base.strip)}`);
  expect(
    base.strip.x + base.strip.width,
    `the strip ends at x=${(base.strip.x + base.strip.width).toFixed(1)}, past the inspector's left edge at x=${inspector.x.toFixed(1)}`,
  ).toBeLessThanOrEqual(inspector.x + 0.5);
}

/**
 * The traffic-light reserve belongs to whatever sits at the window's top-left
 * corner (S-28, S-33): with the inspector docked left its header keeps at
 * least the 82px inset, and the strip's title row beside it drops to 12px.
 */
async function assertDockLeftInset(page: Page): Promise<void> {
  const read = await page.evaluate<{
    readonly headerPadding: number | null;
    readonly titleRowPadding: number | null;
    readonly inspectorLeft: number | null;
    readonly columnLeft: number | null;
  }>(`(() => {
    const header = document.querySelector("[data-layout-inspector-header]");
    const titleRow = document.querySelector('[data-testid="side-strip-title-row"]');
    const inspector = document.querySelector("[data-layout-inspector]");
    const column = document.querySelector("[data-layout-column]");
    return {
      headerPadding: header === null ? null : Number.parseFloat(getComputedStyle(header).paddingLeft),
      titleRowPadding: titleRow === null ? null : Number.parseFloat(getComputedStyle(titleRow).paddingLeft),
      inspectorLeft: inspector === null ? null : inspector.getBoundingClientRect().left,
      columnLeft: column === null ? null : column.getBoundingClientRect().left,
    };
  })()`);
  note(
    `inspector header pads ${String(read.headerPadding)}px, title row pads ${String(read.titleRowPadding)}px; inspector left ${String(read.inspectorLeft)}, column left ${String(read.columnLeft)}`,
  );
  expect(
    read.inspectorLeft !== null &&
      read.columnLeft !== null &&
      read.inspectorLeft <= read.columnLeft,
    "the inspector is not docked at the window's left, so the reserve is untested",
  ).toBe(true);
  expect(
    read.headerPadding !== null &&
      read.headerPadding >= WCO_LEADING_INSET_FALLBACK,
    `the left-docked inspector's header pads ${String(read.headerPadding)}px, under the ${String(WCO_LEADING_INSET_FALLBACK)}px traffic-light inset`,
  ).toBe(true);
  expect(
    read.titleRowPadding,
    `the strip's title row pads ${String(read.titleRowPadding)}px beside a left-docked inspector, expected the ${String(LEFT_DOCK_COLUMN_GUTTER)}px gutter`,
  ).toBe(LEFT_DOCK_COLUMN_GUTTER);
}

// --- the frameless window (wco none) -----------------------------------------

test.describe("a frameless window (no window-controls overlay)", () => {
  const getPage = sharedPage(
    canvasLoad({ tabs: "left", wco: "none" }, STRIP_READY),
  );

  test.beforeEach(async () => {
    await configureCanvas(getPage(), AT_REST_LEFT);
  });

  test("the strip is flush on its edge, on both edges, every part is the hit target at its centre, and the surface is flush with the window top", async () => {
    const page = getPage();
    // No band, no title row and no history arrows: a browser shell has its own.
    await assertWindow(page, "left", false, {
      band: "not-drawn",
      titleRow: false,
    });
    await configureCanvas(page, tabsAt("right", true));
    await assertWindow(page, "right", false, {
      band: "not-drawn",
      titleRow: false,
    });
  });

  test("the session row is a solid amber object with the background's text", async () => {
    await assertSessionRow(getPage());
  });

  test("a right strip ends before the right-docked inspector", async () => {
    const page = getPage();
    await configureCanvas(page, tabsAt("right", true));
    await assertBesideInspector(page, await assertFlush(page, "right"));
  });

  test("the collapsed rail is 60px wide, its monogram tiles centred 40x44 with drawn 26x22 chips over the meter row", async () => {
    const page = getPage();
    await configureCanvas(page, {
      tabs: "left",
      collapsed: true,
      dock: "right",
      session: false,
    });
    const base = await readBase(page);
    const tokens = await stripTokens(page);
    await assertRail(page, base, { px: tokens.stripRailWidthPx, exact: true });
  });

  test("the active rail tile paints its own fill, and the chip its tint, in both themes", async () => {
    const page = getPage();
    await configureCanvas(page, {
      tabs: "left",
      collapsed: true,
      dock: "right",
      session: false,
    });
    await assertTileFill(page);
  });

  test("the expanded group is one tinted block holding its header and members", async () => {
    const page = getPage();
    await configureCanvas(page, tabsAt("left", false));
    await moveTo(page, 1, 1);
    await waitForStableBoxes(
      page,
      ['[data-testid="side-tab-strip"] [data-testid^="side-tab-group-block-"]'],
      1,
    );
    await assertRowKit(page);
  });
});

// --- macOS (traffic lights over the top-left corner) -------------------------

test.describe("a macOS window", () => {
  const getPage = sharedPage(
    canvasLoad({ tabs: "left", wco: "mac" }, STRIP_READY),
  );

  test.beforeEach(async () => {
    await configureCanvas(getPage(), AT_REST_LEFT);
  });

  test("a left strip owns the title bar with a 40px row padded by the traffic lights, and every part is the hit target", async () => {
    // History arrows are drawn: the desktop has persistent history.
    await assertWindow(getPage(), "left", true, {
      band: "not-drawn",
      titleRow: true,
    });
  });

  test("a right strip sits under a 40px title band, with a dialog overlay starting beneath it", async () => {
    const page = getPage();
    await configureCanvas(page, tabsAt("right", true));
    await assertWindow(page, "right", true, { band: "shown", titleRow: false });
  });

  test("a left-docked inspector takes the traffic-light reserve and the strip's title row drops to the gutter", async () => {
    const page = getPage();
    await configureCanvas(page, { ...AT_REST_LEFT, dock: "left" });
    await assertDockLeftInset(page);
  });

  test("the collapsed rail is never narrower than the traffic-light inset", async () => {
    const page = getPage();
    await configureCanvas(page, {
      tabs: "left",
      collapsed: true,
      dock: "right",
      session: false,
    });
    const base = await readBase(page);
    const tokens = await stripTokens(page);
    await assertRail(page, base, {
      px: Math.max(tokens.stripRailWidthPx, WCO_LEADING_INSET_FALLBACK),
      exact: false,
    });
  });
});

// --- Windows (caption buttons over the top-right corner) ---------------------

test.describe("a Windows window", () => {
  const getPage = sharedPage(
    canvasLoad({ tabs: "left", wco: "win" }, STRIP_READY),
  );

  test.beforeEach(async () => {
    await configureCanvas(getPage(), AT_REST_LEFT);
  });

  test("a left strip sits under a 40px title band, with every part the hit target and the overlay beneath the band", async () => {
    await assertWindow(getPage(), "left", true, {
      band: "shown",
      titleRow: false,
    });
  });
});

// --- macOS fullscreen (the band stays in the tree, hidden) -------------------

test.describe("a macOS fullscreen window", () => {
  const getPage = sharedPage(
    canvasLoad({ tabs: "left", wco: "mac-fullscreen" }, STRIP_READY),
  );

  test.beforeEach(async () => {
    await configureCanvas(getPage(), tabsAt("right", true));
  });

  test("the title band is in the tree but not displayed, so the strip and the dialog overlay start at the window top", async () => {
    const page = getPage();
    const base = await assertFlush(page, "right");
    await assertTitleBand(page, base, { band: "hidden", titleRow: false });
    const strip = await requireRect(page, '[data-testid="side-tab-strip"]');
    expect(
      strip.y,
      `the strip starts at y=${strip.y.toFixed(1)}, not at the window top, though the band is hidden`,
    ).toBeLessThanOrEqual(base.column.y + 0.5);
  });
});
