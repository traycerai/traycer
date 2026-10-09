import { expect, test, type Page } from "@playwright/test";

import {
  canvasLoad,
  configureCanvas,
  probe,
  setThemeAndWait,
  type ThemeName,
} from "../support/layout-editor/canvas.ts";
import {
  boxText,
  note,
  rectOf,
  violationLog,
  type Box,
} from "../support/layout-editor/dom.ts";
import {
  hostMenuProblems,
  openHostMenu,
} from "../support/layout-editor/foot.ts";
import {
  moveInSteps,
  moveTo,
  pressAt,
  pressKey,
  releasePointer,
} from "../support/layout-editor/input.ts";
import { layoutEditorUse, sharedPage } from "../support/layout-editor/pages.ts";
import {
  rgbText,
  resolveRgb,
  samplePixelAt,
  sameRgb,
  type Rgb,
} from "../support/layout-editor/pixels.ts";
import { SURFACE_FRAME } from "../support/layout-editor/shell.ts";
import {
  waitForFiniteAnimations,
  waitForStableBoxes,
  waitUntil,
} from "../support/layout-editor/waits.ts";
import { nextFrames } from "../support/fixtures.ts";

// THE TOP PLACEMENT'S TABS ARE BOXES ON THE GROUND (staging round 1, F4).
//
// `layout-editor-canvas.html` with `header=app` mounts the REAL `AppHeader`
// above the task surface, on `tabs=top` with the sidebar panel on the left and
// no window controls. That is ONE load: the theme, the active tab and the
// pointer are switched live through the probe, and what the other window
// chromes (a macOS or Windows title band, the panel on the right) change is
// the header's clearance, which `sides.spec.ts` measures on its own loads.
//
// In both themes the active tab, the split pair's focused member and both
// drag overlays are one 32px box - `TAB_BOX_CLASS` (`inset-0.5` in the 36px
// `h-9` frame), a 1px border, the same corners all round (a joined tab opens
// its bottom two square) - centred in the 40px header, with ground under every
// unjoined box (an inactive tab's hover) and the surface frame flush against the header's bottom edge.
// Nothing of the strip reaches below the header but a tab's colour line on the
// sheets' top border, no folder-tab cap or baseline cover is drawn, and no rule
// spans the strip: a tab's colour line (`TabColorEdgeLine`) is exactly its own
// tab's width, never a line across the strip. An inactive tab's real hover is
// the same box.
//
// What decides these is a box laid out by a real engine and the ground painted
// under it, which jsdom has neither of.
//
// Not here, because a jsdom test decides it: the strip's items and their active
// state (`tab-strip.test.tsx`), whether an active tab and its drag overlay are
// joined to the sheet (`header-strip-active-join.test.tsx`), and the account
// menu's host rows and keyboard (`user-menu-host-section.test.tsx`).

test.use(layoutEditorUse());

const getPage = sharedPage(
  canvasLoad(
    {
      tabs: "top",
      wco: "none",
      sidebar: "left",
      surface: "epic",
      header: "app",
      account: 1,
      hosts: 1,
    },
    "document.querySelector('[data-testid=\"app-header\"]') !== null && document.querySelector('[data-testid=\"tab-strip\"]') !== null",
  ),
);

test.beforeEach(async () => {
  await configureCanvas(getPage(), {
    tabs: "top",
    collapsed: false,
    dock: "right",
    session: false,
  });
});

/** The tab box: 32px, centred in the 40px header. `TAB_BOX_CLASS` is `inset-0.5` inside the `h-9` (36px) tab frame. */
const HEADER_TAB_BOX_HEIGHT = 32;
/** A filled element this thin is a line: `TAB_COLOR_MARK_CLASS` is `h-0.5` (2px), the tallest thing the strip draws as a mark. */
const THIN_LINE_MAX_HEIGHT = 3;
/** The header tabs' ground: the drag holds the tab this far off its slot before it is read. */
const HEADER_DRAG_TRAVEL = 48;

interface HeaderBox extends Box {
  readonly right: number;
  readonly bottom: number;
}

interface ThinLine {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /**
   * The width of the single strip item (`[data-strip-item-id]`) this line
   * sits inside, or `null` off any item. A coloured tab's own edge-to-edge
   * mark (`TabColorEdgeLine`) is exactly its own item's width; a rule that
   * actually spans the strip - the folder-baseline language F4 retired - has
   * no such bound, or exceeds it.
   */
  readonly ownItemWidth: number | null;
}

interface HeaderRead {
  readonly header: HeaderBox | null;
  readonly frame: HeaderBox | null;
  readonly sheet: HeaderBox | null;
  readonly strip: HeaderBox | null;
  readonly active: HeaderBox | null;
  readonly activeRadii: readonly string[] | null;
  readonly activeJoined: boolean;
  readonly itemJoined: boolean;
  readonly activeBorder: string | null;
  readonly activePseudo: readonly string[];
  readonly caps: number;
  readonly newButton: HeaderBox | null;
  readonly below: readonly string[];
  readonly thinLines: readonly ThinLine[];
}

type HeaderScope = "strip" | "overlay";

const headerProbe = (scope: HeaderScope): string => `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const radii = (node) => {
    const style = getComputedStyle(node);
    return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
  };
  const pseudo = (node) => [getComputedStyle(node, "::before").content, getComputedStyle(node, "::after").content].filter((value) => value !== "none" && value !== "normal");
  const header = document.querySelector('[data-testid="app-header"]');
  const strip = document.querySelector('[data-testid="tab-strip"]');
  const scope = ${
    scope === "strip"
      ? "strip"
      : `document.querySelector('[data-testid="header-tab-drag-overlay"]')`
  };
  // In the strip, the selected tab's box; in a drag overlay, which has no tab
  // roles, the one box it draws.
  const activeItem = scope === null ? null : scope.matches('[data-testid="header-tab-drag-overlay"]')
    ? scope
    : scope.querySelector('[role="tab"][aria-selected="true"]');
  const activeBox = activeItem === null ? null : activeItem.matches('[data-testid="tab-chrome-box"]')
    ? activeItem
    : activeItem.querySelector('[data-testid="tab-chrome-box"]');
  const activeRoot = activeBox === null ? null : activeBox.parentElement;
  const sheet = document.querySelector('[data-epic-canvas-frame]');
  const painted = strip === null ? [] : [...strip.querySelectorAll("*")]
    .map((node) => ({ node, r: node.getBoundingClientRect() }))
    .filter(({ node, r }) => r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden");
  const label = (node, r, edge) => (node.getAttribute("data-testid") ?? node.tagName.toLowerCase()) + "@" + edge.toFixed(1);
  return {
    header: box(header),
    frame: box(document.querySelector(${JSON.stringify(SURFACE_FRAME)})),
    sheet: box(sheet),
    strip: box(strip),
    active: box(activeBox),
    activeRadii: activeBox === null ? null : radii(activeBox),
    // The active tab opens into its task's sheet (the sheet join, index.css):
    // joined, its two bottom corners go square rather than matching the top.
    activeJoined: activeBox !== null && activeBox.hasAttribute("data-sheet-joined"),
    // A split pair joins as the GROUP's own box (split-tab-chrome.tsx), a
    // sibling of the focused member's chrome rather than a descendant of it:
    // the member's own box stays fully rounded and unjoined even while the
    // pair behind it fills the strip below with its sheet's fill instead of
    // ground. Search the whole strip item (data-strip-item-id, the lone
    // tab's own wrapper or the split group's) so either shape is found.
    itemJoined: activeBox !== null && activeBox.closest("[data-strip-item-id]")?.querySelector("[data-sheet-joined]") != null,
    activeBorder: activeBox === null ? null : getComputedStyle(activeBox).borderTopWidth,
    activePseudo: activeRoot === null ? [] : [...pseudo(activeRoot), ...pseudo(activeBox)],
    caps: document.querySelectorAll('[data-testid^="tab-cap"], [data-testid="tab-baseline-cover"]').length,
    newButton: box(document.querySelector('[data-testid="tab-new"]')),
    // Every painted part of the strip: nothing may reach below the header but
    // a tab's colour line, which lies on the sheets' 1px top border where the
    // joined tab's feet turn out (TabColorEdgeLine), and the scroller's clip
    // box, which reaches that far to draw it and paints nothing itself.
    below: header === null ? [] : painted
      .filter(({ r }) => r.bottom > header.getBoundingClientRect().bottom + 0.5)
      .filter(({ node, r }) => !(
        ["tab-color-edge-line", "header-tab-strip-scroll"].includes(node.getAttribute("data-testid") ?? "") &&
        r.bottom <= header.getBoundingClientRect().bottom + 1.5
      ))
      .map(({ node, r }) => label(node, r, r.bottom)),
    // Every thin FILLED element in the strip, whatever it is called: the
    // folder-baseline language F4 retired is one of these spanning the strip.
    thinLines: painted
      .filter(({ node, r }) => r.height <= ${String(THIN_LINE_MAX_HEIGHT)} && getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)")
      .map(({ node, r }) => {
        const item = node.closest("[data-strip-item-id]");
        return {
          name: node.getAttribute("data-testid") ?? node.tagName.toLowerCase(),
          width: r.width,
          height: r.height,
          ownItemWidth: item === null ? null : item.getBoundingClientRect().width,
        };
      }),
  };
})()`;

function readHeader(page: Page, scope: HeaderScope): Promise<HeaderRead> {
  return page.evaluate<HeaderRead>(headerProbe(scope));
}

/** What the strip must not draw: caps, anything below the header, a rule across it. */
function stripProblems(read: HeaderRead): string[] {
  const problems: string[] = [];
  if (read.header === null || read.strip === null) {
    return ["no header or no tab strip"];
  }
  if (read.caps > 0) {
    problems.push(
      `${String(read.caps)} folder-tab cap or baseline cover(s) still drawn`,
    );
  }
  if (read.below.length > 0) {
    problems.push(
      `part of the tab strip reaches below the header (bottom ${read.header.bottom.toFixed(1)}): ${read.below.join(", ")}`,
    );
  }
  // A rule crosses a tab boundary - no single strip item bounds it, or it
  // reaches wider than the one it sits in - unlike a tab's own edge-to-edge
  // colour mark (`TabColorEdgeLine`), which is exactly that tab's own width
  // and never wider.
  const rules = read.thinLines.filter(
    (line) => line.ownItemWidth === null || line.width > line.ownItemWidth + 1,
  );
  if (rules.length > 0) {
    problems.push(
      `a thin rule crosses a tab boundary instead of staying a tab's own colour mark: ${rules.map((line) => `${line.name} ${line.width.toFixed(0)}x${line.height.toFixed(1)}${line.ownItemWidth === null ? " (off any strip item)" : ` (its item is ${line.ownItemWidth.toFixed(0)}px)`}`).join(", ")}`,
    );
  }
  return problems;
}

/** The lone active tab's box: what every other box is compared with. */
interface BoxReference {
  readonly y: number;
  readonly height: number;
  readonly radius: string;
}

/** The box's own shape: 32px tall, a 1px border, no pseudo-element, and self-consistent corners. */
function boxShapeProblems(
  read: HeaderRead,
  active: HeaderBox,
  activeRadii: readonly string[],
): string[] {
  const problems: string[] = [];
  if (read.activePseudo.length > 0) {
    problems.push(
      `the active tab draws a pseudo-element (${read.activePseudo.join(", ")})`,
    );
  }
  if (Math.abs(active.height - HEADER_TAB_BOX_HEIGHT) > 0.5) {
    problems.push(
      `the box is ${active.height.toFixed(1)}px tall, not ${String(HEADER_TAB_BOX_HEIGHT)}`,
    );
  }
  if (read.activeBorder !== "1px") {
    problems.push(`the box's border is ${String(read.activeBorder)}, not 1px`);
  }
  // Flush surface: the sheets carry no radius of their own any more, so the
  // box's own rounding only has to stay self-consistent - all four corners
  // alike, unless the box is joined into its sheet, which opens its two bottom
  // corners square (the sheet join, index.css) while the top two stay rounded
  // alike.
  const [tl, tr, br, bl] = activeRadii;
  if (!read.activeJoined) {
    if (new Set(activeRadii).size !== 1) {
      problems.push(
        `the box's corners are ${activeRadii.join(" ")}, not the same on all four`,
      );
    }
    return problems;
  }
  if (tl !== tr) {
    problems.push(`the box's top corners are ${tl} and ${tr}, not the same`);
  }
  if (br !== "0px" || bl !== "0px") {
    problems.push(
      `the box's joined bottom corners are ${br} and ${bl}, not square (0px)`,
    );
  }
  return problems;
}

/** In the strip: centred in the header, under it and above the sheet, with the surface frame flush at the header's bottom. */
function boxPlacementProblems(
  read: HeaderRead,
  header: HeaderBox,
  sheet: HeaderBox,
  active: HeaderBox,
): string[] {
  const problems: string[] = [];
  if (Math.abs(active.cy - header.cy) > 0.5) {
    problems.push(
      `the box is not centred in the header: its centre ${active.cy.toFixed(1)}, the header's ${header.cy.toFixed(1)}`,
    );
  }
  if (
    read.newButton !== null &&
    Math.abs(read.newButton.cy - header.cy) > 0.5
  ) {
    problems.push(
      `the new-tab button is not centred: ${read.newButton.cy.toFixed(1)} against ${header.cy.toFixed(1)}`,
    );
  }
  if (active.bottom > header.bottom || active.bottom > sheet.y) {
    problems.push(
      `the box reaches ${active.bottom.toFixed(1)}, past the header (${header.bottom.toFixed(1)}) or into the sheet (${sheet.y.toFixed(1)})`,
    );
  }
  // Flush surface: the surface frame sits right at the header's own bottom
  // edge, with no shell gap between them any more.
  if (read.frame !== null && Math.abs(read.frame.y - header.bottom) > 0.5) {
    problems.push(
      `the surface frame sits ${(read.frame.y - header.bottom).toFixed(1)}px off the header's bottom edge, not flush`,
    );
  }
  return problems;
}

/**
 * The active box in `scope`, checked against the design and, with a
 * `reference`, against another box's geometry.
 */
async function boxProblems(
  page: Page,
  scope: HeaderScope,
  reference: BoxReference | null,
): Promise<{ readonly problems: string[]; readonly box: BoxReference | null }> {
  const read = await readHeader(page, scope);
  const { header, sheet, active, activeRadii } = read;
  if (header === null || sheet === null) {
    return {
      problems: [
        `no header (${String(header !== null)}) or content sheet (${String(sheet !== null)})`,
      ],
      box: null,
    };
  }
  if (active === null || activeRadii === null) {
    return { problems: ["no active tab box"], box: null };
  }
  const problems = boxShapeProblems(read, active, activeRadii);
  if (scope === "strip") {
    problems.push(...boxPlacementProblems(read, header, sheet, active));
  }
  if (
    reference !== null &&
    (Math.abs(active.height - reference.height) > 0.5 ||
      activeRadii[0] !== reference.radius ||
      (scope === "strip" && Math.abs(active.y - reference.y) > 0.5))
  ) {
    problems.push(
      `the box (y ${active.y.toFixed(1)}, h ${active.height.toFixed(1)}, r ${activeRadii[0]}) is not the lone active tab's (y ${reference.y.toFixed(1)}, h ${reference.height.toFixed(1)}, r ${reference.radius})`,
    );
  }
  note(
    `${scope}: box ${boxText(active)} r ${activeRadii[0]} in header ${boxText(header)}, sheet top ${sheet.y.toFixed(1)}, joined ${String(read.activeJoined)}, item joined ${String(read.itemJoined)}`,
  );
  return {
    problems,
    box: { y: active.y, height: active.height, radius: activeRadii[0] },
  };
}

/**
 * A coloured tab's own edge-to-edge mark, resolved from its rendered pixel:
 * `null` where the tab carries none. Read at the DOM element the tab draws
 * (`tab-color-edge-line`), not the arrangement's stored colour string, since
 * that is what a screenshot can actually show under it.
 */
async function ownColorEdgeRgb(
  page: Page,
  tabSelector: string,
): Promise<Rgb | null> {
  return page.evaluate<Rgb | null>(`(() => {
    const node = document.querySelector(${JSON.stringify(`${tabSelector} [data-testid="tab-color-edge-line"]`)});
    if (node === null) return null;
    const match = getComputedStyle(node).backgroundColor.match(/\\d+/g);
    return match === null ? null : match.slice(0, 3).map(Number);
  })()`);
}

/**
 * Pixels: ground between an UNJOINED box and the header's own bottom edge. The
 * active tab of this fixture is always joined (its bridge fills that strip with
 * the sheet's fill instead, the sheet join in index.css), and so is a split
 * pair as a group, so the unjoined box that is on screen is an inactive tab's
 * hover. A COLOURED inactive tab's own edge-to-edge mark (`TabColorEdgeLine`)
 * sits in this exact band regardless of hover, so its own colour is allowed
 * here too - the claim is "nothing ELSE paints here", not "nothing paints
 * here at all".
 */
async function groundUnderProblems(
  page: Page,
  box: { readonly cx: number; readonly bottom: number },
  ownColor: Rgb | null,
): Promise<string[]> {
  const ground = await resolveRgb(page, "var(--shell-ground)");
  const y = box.bottom + 1.5;
  const pixel = await samplePixelAt(page, box.cx, y);
  if (sameRgb(pixel, ground, 2)) return [];
  if (ownColor !== null && sameRgb(pixel, ownColor, 2)) return [];
  return [
    `no ground between the box and the header's bottom (${box.cx.toFixed(0)}, ${y.toFixed(0)}): ${rgbText(pixel)}, ground ${rgbText(ground)}${ownColor === null ? "" : `, own colour ${rgbText(ownColor)}`}`,
  ];
}

async function eventuallyNoProblems(
  label: string,
  problems: () => Promise<readonly string[]>,
): Promise<void> {
  await expect
    .poll(problems, { message: label, intervals: [50, 100, 200, 400] })
    .toEqual([]);
}

/** The strip item that is selected, waited on by its own id: "some tab is selected" would pass before the switch. */
async function activateAndWait(
  page: Page,
  call: string,
  itemId: string,
): Promise<void> {
  await probe(page, call);
  await waitUntil(
    page,
    `document.querySelector('[data-testid="tab-strip"] [role="tab"][aria-selected="true"]')?.closest("[data-strip-item-id]")?.getAttribute("data-strip-item-id") === ${JSON.stringify(itemId)}`,
  );
  await moveTo(page, 1, 1);
  await waitForFiniteAnimations(page);
  await waitForStableBoxes(
    page,
    ['[data-testid="tab-strip"] [data-testid="tab-chrome-box"]'],
    4,
  );
}

const EPSILON = {
  call: 'activateEpicTab("fixture-epsilon")',
  itemId: "tab:epic:fixture-epsilon",
};
const SPLIT = {
  call: 'activateStripItem("fixture-split")',
  itemId: "fixture-split",
};

/** The lone active tab's box in `theme`: read once as the reference the other boxes are compared with. */
async function loneBox(page: Page, theme: ThemeName): Promise<BoxReference> {
  await setThemeAndWait(page, theme);
  await activateAndWait(page, EPSILON.call, EPSILON.itemId);
  const { box } = await boxProblems(page, "strip", null);
  if (box === null) throw new Error(`no lone active box in the ${theme} theme`);
  return box;
}

const THEMES: readonly ThemeName[] = ["light", "dark"];

test("the active tab is one 32px box with a 1px border and equal corners, centred in the header, and the surface frame flush at the header's bottom, in both themes", async () => {
  const page = getPage();
  for (const theme of THEMES) {
    await setThemeAndWait(page, theme);
    await activateAndWait(page, EPSILON.call, EPSILON.itemId);
    await eventuallyNoProblems(
      `lone tab, ${theme}`,
      async () => (await boxProblems(page, "strip", null)).problems,
    );
  }
});

test("nothing of the strip reaches below the header, no folder-tab cap or baseline cover is drawn, and no rule spans the strip, in both themes", async () => {
  const page = getPage();
  for (const theme of THEMES) {
    await setThemeAndWait(page, theme);
    await activateAndWait(page, EPSILON.call, EPSILON.itemId);
    await eventuallyNoProblems(`strip, ${theme}`, async () =>
      stripProblems(await readHeader(page, "strip")),
    );
    const read = await readHeader(page, "strip");
    const widest = read.thinLines.reduce<ThinLine | null>(
      (best, line) => (best === null || line.width > best.width ? line : best),
      null,
    );
    note(
      `${theme}: the widest thin filled element is ${widest === null ? "none" : `${widest.name} ${widest.width.toFixed(0)}x${widest.height.toFixed(1)}`} of a ${read.strip === null ? "-" : read.strip.width.toFixed(0)}px strip`,
    );
  }
});

test("an inactive tab's real hover is the same box as the active one, with ground under it, in both themes", async () => {
  const page = getPage();
  for (const theme of THEMES) {
    const lone = await loneBox(page, theme);
    const alpha = await rectOf(page, '[data-testid="tab-epic-fixture-alpha"]');
    expect(alpha, `${theme}: no Alpha tab`).not.toBeNull();
    if (alpha === null) continue;
    await moveTo(page, alpha.cx, alpha.cy);
    const readHover = (): Promise<{
      readonly y: number;
      readonly cx: number;
      readonly bottom: number;
      readonly height: number;
      readonly radius: string;
      readonly opacity: string;
    } | null> =>
      page.evaluate(`(() => {
        const node = document.querySelector('[data-testid="tab-epic-fixture-alpha"] [data-testid="tab-hover-box"]');
        if (node === null) return null;
        const r = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { y: r.y, cx: r.x + r.width / 2, bottom: r.bottom, height: r.height, radius: style.borderTopLeftRadius, opacity: style.opacity };
      })()`);
    await expect
      .poll(
        async () => Number.parseFloat((await readHover())?.opacity ?? "0"),
        {
          message: `${theme}: Alpha's hover box is not shown under a real hover`,
        },
      )
      .toBeGreaterThan(0.9);
    const hover = await readHover();
    expect(hover, `${theme}: Alpha draws no hover box`).not.toBeNull();
    if (hover === null) continue;
    note(
      `${theme}: hover box y ${hover.y.toFixed(1)} h ${hover.height.toFixed(1)} r ${hover.radius} opacity ${hover.opacity}`,
    );
    expect(
      Math.abs(hover.y - lone.y) <= 0.5 &&
        Math.abs(hover.height - lone.height) <= 0.5 &&
        hover.radius === lone.radius,
      `${theme}: the hover box (y ${hover.y.toFixed(1)}, h ${hover.height.toFixed(1)}, r ${hover.radius}) is not the active box's (y ${lone.y.toFixed(1)}, h ${lone.height.toFixed(1)}, r ${lone.radius})`,
    ).toBe(true);
    const ownColor = await ownColorEdgeRgb(
      page,
      '[data-testid="tab-epic-fixture-alpha"]',
    );
    expect(
      await groundUnderProblems(page, hover, ownColor),
      `${theme}: the ground under Alpha's hover box`,
    ).toEqual([]);
    await moveTo(page, 1, 1);
  }
});

test("the split pair's focused member is the same box as a lone active tab, in both themes", async () => {
  const page = getPage();
  for (const theme of THEMES) {
    const lone = await loneBox(page, theme);
    await activateAndWait(page, SPLIT.call, SPLIT.itemId);
    await eventuallyNoProblems(
      `split pair, ${theme}`,
      async () => (await boxProblems(page, "strip", lone)).problems,
    );
  }
});

test("the drag overlays wear the same box: a lone tab, then the split pair", async () => {
  const page = getPage();
  await setThemeAndWait(page, "dark");
  await activateAndWait(page, EPSILON.call, EPSILON.itemId);
  const reference = (await boxProblems(page, "strip", null)).box;
  expect(
    reference,
    "no lone active box to compare the overlays with",
  ).not.toBeNull();
  if (reference === null) return;
  const violations = violationLog();
  // Each dragged while it is the active item, so its overlay draws a box.
  const drags = [
    {
      what: "lone tab",
      grab: '[data-testid="tab-epic-fixture-epsilon"]',
      active: EPSILON,
    },
    {
      what: "split pair",
      grab: '[data-testid="tab-epic-fixture-beta"]',
      active: SPLIT,
    },
  ] as const;
  for (const { what, grab, active } of drags) {
    await activateAndWait(page, active.call, active.itemId);
    const from = await rectOf(page, grab);
    if (from === null) {
      violations.add(`nothing to grab for the ${what} drag`);
      continue;
    }
    // A real press on the tab, dragged and held: dnd-kit needs the travel.
    await pressAt(page, from.cx, from.cy);
    await moveInSteps(page, { x: from.cx + HEADER_DRAG_TRAVEL, y: from.cy });
    await waitUntil(
      page,
      `document.querySelector('[data-testid="header-tab-drag-overlay"]') !== null`,
    );
    await waitForStableBoxes(
      page,
      ['[data-testid="header-tab-drag-overlay"]'],
      3,
    );
    const { problems } = await boxProblems(page, "overlay", reference);
    for (const problem of problems)
      violations.add(`${what} drag overlay: ${problem}`);
    // Back to where the drag began, and released there, so nothing reorders.
    await moveInSteps(page, { x: from.cx, y: from.cy });
    await releasePointer(page);
    await waitUntil(
      page,
      `document.querySelector('[data-testid="header-tab-drag-overlay"]') === null`,
    );
    await nextFrames(page, 2);
    await moveTo(page, 1, 1);
  }
  violations.assertNone("F4: the drag overlays' box");
});

test("the account menu in the header opens below its trigger on one click, inside the window and no wider than 256px", async () => {
  const page = getPage();
  await openHostMenu(page);
  expect(
    await hostMenuProblems(page, "below"),
    "G4: the account menu under the header",
  ).toEqual([]);
  await pressKey(page, "Escape");
  await waitUntil(
    page,
    `document.querySelector('[data-testid="user-menu-content"]') === null`,
  );
});
