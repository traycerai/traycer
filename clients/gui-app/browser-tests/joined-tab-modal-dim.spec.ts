import { expect, test, type Page } from "@playwright/test";

import {
  canvasLoad,
  configureCanvas,
  probe,
  setThemeAndWait,
  type ThemeName,
} from "./support/layout-editor/canvas.ts";
import { layoutEditorUse, sharedPage } from "./support/layout-editor/pages.ts";
import {
  rgbText,
  samplePixelAt,
  sameRgb,
  type Rgb,
} from "./support/layout-editor/pixels.ts";
import { SURFACE_FRAME } from "./support/layout-editor/shell.ts";
import {
  waitForFiniteAnimations,
  waitUntil,
} from "./support/layout-editor/waits.ts";

// A MODAL'S DIM REACHES THE JOINED TAB.
//
// In the desktop window (`.wco` on <html>) a modal's backdrop starts below the
// 40px title band (`window-chrome.css`), and the active top tab, which is
// joined to its task's sheet, sits in that band. Before `JoinedTabDim` the tab
// stayed bright over a dimmed page, so the join read as a lit cut-out. The
// claim: with a modal open, the joined tab's pixels match the dimmed sheet
// under it, exactly as they match with no modal. The tab takes the colour of
// the backdrop beside it: the shared dialog's `bg-black/10`, the modal frame's
// `bg-black/30` and the blocking modals' `bg-black/40`, and stacked modals take
// all of theirs, as the page does (a frame under a dialog, and a dialog under
// a dialog, which is a sheet with a confirm dialog over it). Each backdrop
// publishes itself (`BackdropDimSource`) and `JoinedTabDim` draws one layer per
// published backdrop. The tab's two concave feet, which flare out of its sides
// into the title band, are dimmed with it, and the bar's own ground is not.
//
// What decides this is paint: the dim is an element anchored to the tab with
// CSS anchor positioning and composited over a tab whose fill is a theme
// token, so it is read off a screenshot. Which backdrop a surface opens is
// jsdom's.
//
// The modals are the production `Dialog`, `PromotableModalFrame` and
// `MigrationBlockingModalHost`, opened through the fixture's `openBackdrop`,
// so the backdrop measured is the one the product draws. The other /40 modal,
// `WindowHostModal`, is the same overlay but takes a live host narration
// (cause, variant, progress, recovery actions), which is machinery the
// fixture has no use for.

test.use(layoutEditorUse());

const getPage = sharedPage(
  canvasLoad(
    { tabs: "top", header: "app", surface: "epic", wco: "mac" },
    "document.querySelector('[data-testid=\"tab-chrome-box\"]') !== null",
  ),
);

/** A joined tab and its sheet are one fill, so they read alike to rounding. */
const SAME_FILL_TOLERANCE = 1;
/** The dimmest backdrop (`bg-black/10`) darkens the darkest theme by at least this, summed over the channels. */
const MIN_DARKENING = 3;
/** A dialog's `bg-black/10` over the frame's `bg-black/30` darkens the darkest theme by at least this, summed over the channels. */
const MIN_STACKED_DARKENING = 2;
/** The sheet sample's height above the panel's bottom edge, below its rail and task header. */
const PANEL_FLOOR_OFFSET = 40;
/** The sample beside the tab's left edge, clear of its corner and its title. */
const TAB_INSET = 10;

const JOINED_TAB = '[data-testid="tab-chrome-box"][data-sheet-joined]';
/** The foot sample sits this far outside the tab's left edge. */
const FOOT_INSET = 2;
/** The foot sample sits this far above the title band's bottom edge. */
const FOOT_RISE = 2;
/** The ground sample sits this far outside the tab's left edge, clear of its feet. */
const GROUND_DISTANCE = 30;

/** The shared dialog's overlay is the `bg-black/10` one, the modal frame's the `bg-black/30`. */
const DIALOG_OVERLAY = '[data-slot="dialog-overlay"].bg-black\\/10';
const FRAME_OVERLAY = '[data-slot="dialog-overlay"].bg-black\\/30';
const BLOCKING_OVERLAY = '[data-testid="migration-blocking-overlay"]';

interface ExpectedOverlays {
  readonly selector: string;
  /** How many of them the probe kind puts on screen. */
  readonly count: number;
}

/** The overlays each probe kind puts on screen. */
const OVERLAYS: Readonly<Record<Kind, readonly ExpectedOverlays[]>> = {
  dialog: [{ selector: DIALOG_OVERLAY, count: 1 }],
  frame: [{ selector: FRAME_OVERLAY, count: 1 }],
  blocking: [{ selector: BLOCKING_OVERLAY, count: 1 }],
  "frame+dialog": [
    { selector: FRAME_OVERLAY, count: 1 },
    { selector: DIALOG_OVERLAY, count: 1 },
  ],
  "dialog+dialog": [{ selector: DIALOG_OVERLAY, count: 2 }],
};

type Kind = "dialog" | "frame" | "blocking" | "frame+dialog" | "dialog+dialog";
type SingleKind = "dialog" | "frame" | "blocking";

const KIND_NAME: Readonly<Record<SingleKind, string>> = {
  dialog: "a dialog",
  frame: "the modal frame",
  blocking: "a blocking modal",
};

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Samples {
  readonly tab: Rgb;
  readonly sheet: Rgb;
  /** Inside the flare of the tab's left foot. */
  readonly foot: Rgb;
  /** The header's ground, well clear of the tab. */
  readonly ground: Rgb;
}

interface SamplePoints {
  readonly tab: Point;
  readonly sheet: Point;
  readonly foot: Point;
  readonly ground: Point;
}

/**
 * Where to read the joined tab and the sheet it joins. The sheet's own fill is
 * the surface pane's `--background`, which is what the tab takes
 * (`data-join-pane="surface"`); the fixture's content pane holds a tinted
 * stand-in for the hosted chat, so the sheet sample is the sidebar panel's
 * empty floor, which paints `--background` and nothing else. Read with no
 * modal open, because that the point IS the bare panel (it is the hit target
 * there) and lies inside the task's surface frame is what keeps the sample
 * from drifting onto content.
 */
async function locateSamplePoints(page: Page): Promise<SamplePoints> {
  const located = await page.evaluate(
    ({
      joinedTab,
      surfaceFrame,
      inset,
      floor,
      footInset,
      footRise,
      groundDistance,
    }) => {
      const box = document.querySelector(joinedTab)?.getBoundingClientRect();
      const header = document
        .querySelector('[data-testid="app-header"]')
        ?.getBoundingClientRect();
      const frame = document
        .querySelector(surfaceFrame)
        ?.getBoundingClientRect();
      const panel = document.querySelector("[data-epic-sidebar-panel]");
      if (
        box === undefined ||
        frame === undefined ||
        header === undefined ||
        panel === null
      ) {
        return null;
      }
      const panelBox = panel.getBoundingClientRect();
      const sheet = {
        x: Math.round(panelBox.left + panelBox.width / 2),
        y: Math.round(panelBox.bottom - floor),
      };
      return {
        tab: {
          x: Math.round(box.left + inset),
          y: Math.round(box.top + box.height / 2),
        },
        sheet,
        foot: {
          x: Math.round(box.left - footInset),
          y: Math.round(header.bottom - footRise),
        },
        ground: {
          x: Math.round(box.left - groundDistance),
          y: Math.round(box.top + box.height / 2),
        },
        sheetIsBarePanel: document.elementFromPoint(sheet.x, sheet.y) === panel,
        sheetInFrame:
          sheet.y >= frame.top &&
          sheet.y < frame.bottom &&
          sheet.x >= frame.left &&
          sheet.x < frame.right,
      };
    },
    {
      joinedTab: JOINED_TAB,
      surfaceFrame: SURFACE_FRAME,
      inset: TAB_INSET,
      floor: PANEL_FLOOR_OFFSET,
      footInset: FOOT_INSET,
      footRise: FOOT_RISE,
      groundDistance: GROUND_DISTANCE,
    },
  );
  if (located === null) {
    throw new Error(
      "the joined tab, the sidebar panel or the surface frame is missing",
    );
  }
  expect(
    located.sheetIsBarePanel,
    "the sheet sample is the sidebar panel's bare floor",
  ).toBe(true);
  expect(
    located.sheetInFrame,
    "the sheet sample lies inside the surface frame",
  ).toBe(true);
  return {
    tab: located.tab,
    sheet: located.sheet,
    foot: located.foot,
    ground: located.ground,
  };
}

/** The joined tab's pixel and the sheet's, as painted. */
async function sampleTabAndSheet(
  page: Page,
  points: SamplePoints,
): Promise<Samples> {
  return {
    tab: await samplePixelAt(page, points.tab.x, points.tab.y),
    sheet: await samplePixelAt(page, points.sheet.x, points.sheet.y),
    foot: await samplePixelAt(page, points.foot.x, points.foot.y),
    ground: await samplePixelAt(page, points.ground.x, points.ground.y),
  };
}

/** Opens `kind` and resolves once every backdrop it puts up is fully faded in. */
async function openAndSettle(page: Page, kind: Kind): Promise<void> {
  await probe(page, `openBackdrop(${JSON.stringify(kind)})`);
  for (const { selector, count } of OVERLAYS[kind]) {
    await waitUntil(
      page,
      `(() => {
        const overlays = [...document.querySelectorAll(${JSON.stringify(selector)})];
        return overlays.length === ${count}
          && overlays.every(
            (overlay) =>
              overlay.getAttribute("data-state") === "open"
              && getComputedStyle(overlay).opacity === "1",
          );
      })()`,
    );
  }
  await waitForFiniteAnimations(page);
}

/** Closes the modal and resolves once no backdrop is left in the document. */
async function closeAndSettle(page: Page): Promise<void> {
  await probe(page, "openBackdrop(null)");
  await waitUntil(
    page,
    `document.querySelector('[data-slot="dialog-overlay"]') === null`,
  );
  await waitForFiniteAnimations(page);
}

function darkening(before: Rgb, after: Rgb): number {
  return before.reduce(
    (sum, channel, index) => sum + channel - after[index],
    0,
  );
}

const THEMES: readonly ThemeName[] = ["dark", "light"];
const KINDS: readonly SingleKind[] = ["dialog", "frame", "blocking"];

for (const theme of THEMES) {
  test.describe(`in the ${theme} theme`, () => {
    test.beforeEach(async () => {
      const page = getPage();
      await configureCanvas(page, {
        tabs: "top",
        collapsed: false,
        dock: "right",
        session: false,
      });
      await setThemeAndWait(page, theme);
      await probe(page, "activateEpicTab('fixture-epsilon')");
      await waitUntil(
        page,
        `document.querySelector(${JSON.stringify(JOINED_TAB)}) !== null
          && document.querySelector('[data-sheet-join-bridge="top"][data-join-active]') !== null`,
      );
      await waitForFiniteAnimations(page);
    });

    for (const kind of KINDS) {
      test(`${KIND_NAME[kind]} dims the joined tab like the sheet under it`, async () => {
        const page = getPage();

        // The premise: with no modal the tab is the sheet's fill, so a
        // difference under a modal can only be the modal's dim.
        const points = await locateSamplePoints(page);
        const bare = await sampleTabAndSheet(page, points);
        expect(
          sameRgb(bare.tab, bare.sheet, SAME_FILL_TOLERANCE),
          `no modal: tab ${rgbText(bare.tab)} is the sheet's ${rgbText(bare.sheet)}`,
        ).toBe(true);

        await openAndSettle(page, kind);
        const dimmed = await sampleTabAndSheet(page, points);
        expect(
          darkening(bare.sheet, dimmed.sheet),
          `the ${kind} backdrop darkens the sheet (${rgbText(bare.sheet)} to ${rgbText(dimmed.sheet)})`,
        ).toBeGreaterThanOrEqual(MIN_DARKENING);
        expect(
          sameRgb(dimmed.tab, dimmed.sheet, SAME_FILL_TOLERANCE),
          `${kind} modal open: tab ${rgbText(dimmed.tab)} is the dimmed sheet's ${rgbText(dimmed.sheet)}`,
        ).toBe(true);
        expect(
          darkening(bare.tab, dimmed.tab),
          `the ${kind} backdrop darkens the joined tab (${rgbText(bare.tab)} to ${rgbText(dimmed.tab)})`,
        ).toBeGreaterThanOrEqual(MIN_DARKENING);
        // The feet flare out of the tab's sides, so they are part of the tab
        // the dim covers (anti-aliased, so only "darker" is asked of one); the
        // bar's ground beyond them is not.
        expect(
          darkening(bare.foot, dimmed.foot),
          `the ${kind} backdrop darkens the tab's foot (${rgbText(bare.foot)} to ${rgbText(dimmed.foot)})`,
        ).toBeGreaterThanOrEqual(MIN_DARKENING);
        expect(
          sameRgb(dimmed.ground, bare.ground, SAME_FILL_TOLERANCE),
          `the ${kind} backdrop leaves the bar's ground alone (${rgbText(bare.ground)} to ${rgbText(dimmed.ground)})`,
        ).toBe(true);

        await closeAndSettle(page);
        const closed = await sampleTabAndSheet(page, points);
        expect(
          sameRgb(closed.tab, bare.tab, SAME_FILL_TOLERANCE),
          `modal closed: tab ${rgbText(closed.tab)} is back to ${rgbText(bare.tab)}`,
        ).toBe(true);
        expect(
          sameRgb(closed.foot, bare.foot, SAME_FILL_TOLERANCE),
          `modal closed: foot ${rgbText(closed.foot)} is back to ${rgbText(bare.foot)}`,
        ).toBe(true);
      });
    }

    // Settings opens its add-host and danger-zone dialogs over its frame, and
    // a sheet opens a confirm dialog over itself: the page is darkened by both
    // backdrops, so the tab is too.
    const STACKED: ReadonlyArray<{
      readonly name: string;
      readonly first: Kind;
      readonly both: Kind;
    }> = [
      {
        name: "a dialog over the modal frame",
        first: "frame",
        both: "frame+dialog",
      },
      {
        name: "a dialog over a dialog",
        first: "dialog",
        both: "dialog+dialog",
      },
    ];
    for (const { name, first, both } of STACKED) {
      test(`${name} dims the joined tab like the sheet under both`, async () => {
        const page = getPage();
        const points = await locateSamplePoints(page);
        const bare = await sampleTabAndSheet(page, points);

        await openAndSettle(page, first);
        const firstOnly = await sampleTabAndSheet(page, points);

        await openAndSettle(page, both);
        const stacked = await sampleTabAndSheet(page, points);
        expect(
          darkening(firstOnly.sheet, stacked.sheet),
          `the second backdrop darkens the sheet further (${rgbText(firstOnly.sheet)} to ${rgbText(stacked.sheet)})`,
        ).toBeGreaterThanOrEqual(MIN_STACKED_DARKENING);
        expect(
          sameRgb(stacked.tab, stacked.sheet, SAME_FILL_TOLERANCE),
          `stacked modals open: tab ${rgbText(stacked.tab)} is the dimmed sheet's ${rgbText(stacked.sheet)}`,
        ).toBe(true);
        expect(
          darkening(firstOnly.tab, stacked.tab),
          `the second backdrop darkens the joined tab further (${rgbText(firstOnly.tab)} to ${rgbText(stacked.tab)})`,
        ).toBeGreaterThanOrEqual(MIN_STACKED_DARKENING);

        await closeAndSettle(page);
        const closed = await sampleTabAndSheet(page, points);
        expect(
          sameRgb(closed.tab, bare.tab, SAME_FILL_TOLERANCE),
          `modals closed: tab ${rgbText(closed.tab)} is back to ${rgbText(bare.tab)}`,
        ).toBe(true);
      });
    }
  });
}
