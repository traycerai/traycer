import { expect, test, type Page } from "@playwright/test";

import {
  canvasLoad,
  configureCanvas,
  historyDepth,
  probe,
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
  sameBoxWithin,
  viewportOf,
  violationLog,
  type Box,
} from "../support/layout-editor/dom.ts";
import {
  moveInSteps,
  moveTo,
  pressAt,
  pressKey,
  releasePointer,
} from "../support/layout-editor/input.ts";
import {
  HOST_ROWS,
  collapsedReadingsProblems,
  fullWidthShowsMoreProblems,
  hostMenuProblems,
  openHostMenu,
  readHostRows,
  readReadings,
  readingPopoverProblems,
  readingsRowProblems,
  restyledUsageProblems,
  waitForReadings,
  wholeReadingProblems,
  type ReadingsKey,
} from "../support/layout-editor/foot.ts";
import {
  layoutEditorUse,
  sharedPage,
  type PageLoad,
} from "../support/layout-editor/pages.ts";
import {
  contrastRatio,
  resolveRgb,
  regionPixels,
  rgbText,
  samplePixelAt,
  sameRgb,
  type Rgb,
} from "../support/layout-editor/pixels.ts";
import {
  RAIL_INDICATORS,
  RAIL_INDICATORS_WITH_ZETA_WAITING,
  SURFACE_FRAME,
  STRIP_LIST,
  readShell,
  rowRect,
  setActivity,
  setIndicators,
  setWindowHeight,
  type ShellBoxes,
} from "../support/layout-editor/shell.ts";
import {
  waitForFiniteAnimations,
  waitForStableBoxes,
  waitUntil,
} from "../support/layout-editor/waits.ts";
import { nextFrames } from "../support/fixtures.ts";

// THE TASK SURFACE'S SHELL: THE SHEETS, THE FLIP, THE MOVES, THE JOINED TAB,
// THE RAIL'S PULSE, THE STRIP'S TOP BLOCK AND ITS RESIZE, THE OVERLAYS, THE
// LIVE AGENTS AND THE RAIL GROUPS (staging round 1, F2, F6, F7, F9, D3, D9, G3).
//
// `layout-editor-canvas.html` with `surface=epic` mounts the real app column,
// the real strip, the real sidebar panel and a real hosted chat body, and this
// file opens it TWICE, once for each side the sidebar panel loads on (the load
// is what a reload restores, so both starting sides are a load). Everything
// else - the tab placement, the strip's collapse and view, the theme, the
// indicators and the live agents - is switched live through the probe. That is
// two loads where the driver made thirty seven.
//
// What each claim is, and which of them only a browser can decide:
//
//   flip.    Staging round 1, F2: moving the panel to the other side left the
//            chat drawn over the panel. A chat body is not inside the content
//            sheet - the `StableTileSurfaceHost` plane paints it at the rect
//            its slot reports, and the geometry coordinator only re-reads
//            that rect on a SIZE change - so the body sits on its slot on
//            load, after a live flip and after flipping back, under every tab
//            placement. A real ResizeObserver is what re-reads it.
//   sheets.  The panel and the content frame touch with nothing between them,
//            the surface frame is flush to the window on every edge that has
//            no strip, and each width handle is the hit at the boundary it
//            sits on.
//   moves.   Every other live change that moves or resizes the chat's slot -
//            a strip side switch, top and side trading the header for the
//            strip, the strip's collapse and width drag, and the panel's
//            collapse to its 48px rail - keeps the body on its slot, and the
//            content sheet absorbs exactly what the column beside it gave up.
//   join.    D3: the active row and tile take the pane's fill and run it over
//            the seam onto the frame, the fill stays inside the joined shape
//            past its corners, the bridge holds over the resize handle, is
//            level with its row after a real reorder, and gives way while its
//            row is scrolled part out.
//   pulse.   A row going into waiting pulses; the ring reaches 8px past its
//            row and is painted past the last row at the list's scrolled edge.
//   top.     F1: the rail is one centred column - expand, Notifications, All
//            tasks, New Task, a divider, Home, the tiles, the avatar - with an
//            even rhythm and no badge spilling past its tile, and the
//            expanded top block aligns New Task with Home.
//   resize.  F9: a real handle drag across the snap point switches the layout
//            live under a held, captured pointer, the crossing eases with the
//            panel motion token, and Escape, a release and a reduced-motion
//            crossing land at once.
//   overlays. The hover card and the Notifications drawer sit inside the
//            window, the drawer flush with the sheets.
//   live agents. The first indent step of the active task's live agents starts
//            one 16px step past the task's own title.
//   groups.  G3: while the editor customizes the rail the stacked pair's icon
//            counts its members inside its own box, a click on the bottom
//            member's row rings the group icon, Enter toggles that row once
//            per press, Space grab-and-drop leaves it selected, and a divider
//            moves by a real drag on its grip and on its rule.
//
// Not here, because a jsdom test decides it: the panel and canvas frames'
// borders, radii, margins and pseudo-elements, and the seam suppression
// (`app-column-frame.test.tsx`, `epic-shell.test.tsx`); the rail's 60px width
// (`sides.spec.ts`) and its badge kinds (`side-tab-rail-badge.test.tsx`); the
// vertical order of the top block (`side-tab-strip.test.tsx`); New Task's fill
// (`side-strip-nav-rows.test.tsx`); the sample workspace never joining
// (`side-tab-join.test.tsx`); which side an overlay opens on
// (`side-tab-strip-overlay-placement.test.tsx`); the crossing's rules, commit
// and persistence (`side-tab-strip.test.tsx`); the live agents' disclosure,
// count and visibility (`side-tab-strip.test.tsx`); the group's rendering
// (`epic-sidebar.test.tsx`) and keyboard reorder (`sortable-list.test.tsx`);
// and the running turn's glyph (`agent-spinning-dots.test.tsx`,
// `tab-leading-icon.test.tsx`, `side-strip-nav-rows.test.tsx`).

test.use(layoutEditorUse());

/** The seeded tasks' tiles and rows, and the panel's two sides. */
type Side = "left" | "right";

/** The waiting pulse's ring spread (`side-strip-waiting-pulse` in `index.css`). */
const WAITING_PULSE_SPREAD = 8;

const SHELL_READY =
  "document.querySelector('[data-shell-sheet]') !== null && document.querySelector('[data-fixture-hosted-body]') !== null";

/**
 * The shell at a placement, from the load's own layout: the strip expanded,
 * no session, the sidebar panel on `sidebar`.
 */
async function configureShell(
  page: Page,
  input: {
    readonly tabs: Placement;
    readonly sidebar: Side;
    readonly collapsed: boolean;
  },
): Promise<void> {
  const config: CanvasConfig = {
    tabs: input.tabs,
    collapsed: input.collapsed,
    dock: "right",
    session: false,
  };
  await configureCanvas(page, config);
  await probe(page, `setSidebarSide(${JSON.stringify(input.sidebar)})`);
  await settleShell(page);
}

/** Resolves once the sheets, the slot and the hosted body have stopped moving. */
async function settleShell(page: Page): Promise<void> {
  await waitForFiniteAnimations(page);
  await waitForStableBoxes(
    page,
    [
      "[data-epic-canvas-frame]",
      "[data-epic-sidebar-panel]",
      "[data-fixture-collapsed-rail]",
      '[data-testid="tile-surface-slot"]',
      "[data-fixture-hosted-body]",
      '[data-testid="side-tab-strip"]',
    ],
    4,
  );
}

/**
 * An assertion whose subject is still settling for a frame or two (a
 * ResizeObserver re-reading a slot, a spring landing): polled until it holds,
 * and, when it never does, failed with what it last read.
 */
async function eventually(
  label: string,
  problems: () => Promise<readonly string[]>,
): Promise<void> {
  await expect
    .poll(problems, { message: label, intervals: [50, 100, 200, 400] })
    .toEqual([]);
}

// --- flip: the panel and the chat body across a live side change ------------

/**
 * F2: the panel sits flush on `side` against the content frame, the hosted
 * chat body is on its slot inside the content frame, and it does not touch the
 * panel. Read off one `readShell` so a moving layout cannot be sampled twice.
 */
function flipProblems(shell: ShellBoxes, side: Side): string[] {
  const { panel, content, slot, body } = shell;
  if (panel === null || content === null || slot === null || body === null) {
    return [
      `a box is missing: panel ${String(panel !== null)}, content ${String(content !== null)}, slot ${String(slot !== null)}, hosted body ${String(body !== null)}`,
    ];
  }
  const problems: string[] = [];
  const gap =
    side === "left" ? content.x - panel.right : panel.x - content.right;
  if (Math.abs(gap) > 0.5) {
    problems.push(
      `the panel is not flush on the ${side} against the content frame (flush surface, no ground between them): gap ${gap.toFixed(1)}px (panel ${boxText(panel)}, content ${boxText(content)})`,
    );
  }
  if (!sameBoxWithin(body, slot, 1)) {
    problems.push(
      `the hosted chat body is not on its slot: body ${boxText(body)}, slot ${boxText(slot)}`,
    );
  }
  const overlapX =
    Math.min(body.right, panel.right) - Math.max(body.x, panel.x);
  const overlapY =
    Math.min(body.bottom, panel.bottom) - Math.max(body.y, panel.y);
  if (overlapX > 0 && overlapY > 0) {
    problems.push(
      `the hosted chat body overlays the panel by ${overlapX.toFixed(0)}x${overlapY.toFixed(0)}px (body ${boxText(body)}, panel ${boxText(panel)})`,
    );
  }
  if (
    body.x < content.x - 1 ||
    body.right > content.right + 1 ||
    body.y < content.y - 1 ||
    body.bottom > content.bottom + 1
  ) {
    problems.push(
      `the hosted chat body leaves the content sheet: body ${boxText(body)}, content ${boxText(content)}`,
    );
  }
  return problems;
}

async function assertFlip(
  page: Page,
  side: Side,
  label: string,
): Promise<void> {
  await eventually(`flip ${label}`, async () =>
    flipProblems(await readShell(page), side),
  );
  const shell = await readShell(page);
  if (shell.panel !== null && shell.content !== null && shell.body !== null) {
    note(
      `${label}: panel ${boxText(shell.panel)}, content ${boxText(shell.content)}, body ${boxText(shell.body)}`,
    );
  }
}

// --- sheets: flush, and the handles at the boundaries -----------------------

interface SheetsRead {
  readonly frame: Box | null;
  readonly task: string | null;
  readonly panel: Box | null;
  readonly canvas: Box | null;
  readonly strip: Box | null;
  readonly viewport: { readonly width: number; readonly height: number };
}

const SHEETS_PROBE = `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const task = document.querySelector("[data-shell-sheet]");
  const panelNode = document.querySelector("[data-epic-sidebar-panel]");
  const panel = panelNode !== null && panelNode.getBoundingClientRect().width > 0 ? panelNode : document.querySelector("[data-fixture-collapsed-rail]");
  return {
    frame: box(document.querySelector(${JSON.stringify(SURFACE_FRAME)})),
    task: task === null ? null : task.getAttribute("data-shell-sheet"),
    panel: box(panel),
    canvas: box(document.querySelector("[data-epic-canvas-frame]")),
    strip: box(document.querySelector('[data-testid="side-tab-strip"]')),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

function isHit(
  page: Page,
  x: number,
  y: number,
  selector: string,
): Promise<boolean> {
  return page.evaluate<boolean>(
    `document.elementFromPoint(${String(x)}, ${String(y)})?.closest(${JSON.stringify(selector)}) != null`,
  );
}

/**
 * The panel and the canvas frame touch with nothing between them, the surface
 * frame is flush to the window on every edge with no strip, and each width
 * handle is the hit at the boundary it sits on (now flush, rather than centred
 * in a ground gap).
 */
async function sheetsProblems(page: Page): Promise<string[]> {
  const read = await page.evaluate<SheetsRead>(SHEETS_PROBE);
  const problems: string[] = [];
  if (read.task !== "task") {
    problems.push(
      `expected one task sheet (data-shell-sheet="task"), found ${read.task === null ? "none" : read.task}`,
    );
  }
  if (read.panel === null || read.canvas === null || read.frame === null) {
    problems.push(
      `the panel (${String(read.panel !== null)}), the canvas frame (${String(read.canvas !== null)}) or the surface frame (${String(read.frame !== null)}) is missing`,
    );
    return problems;
  }
  const [left, right] =
    read.panel.x < read.canvas.x
      ? [read.panel, read.canvas]
      : [read.canvas, read.panel];
  const gap = right.x - (left.x + left.width);
  if (Math.abs(gap) > 0.5) {
    problems.push(
      `the panel and the canvas frame are ${gap.toFixed(1)}px apart, not flush (panel ${boxText(read.panel)}, canvas ${boxText(read.canvas)})`,
    );
  }
  problems.push(...frameFlushProblems(read.frame, read.strip, read.viewport));
  const gapX = (left.x + left.width + right.x) / 2;
  const midY = read.canvas.y + read.canvas.height * 0.75;
  if (
    !(await isHit(
      page,
      gapX,
      midY,
      '[data-testid="epic-sidebar-resize-handle"]',
    ))
  ) {
    problems.push(
      `the boundary between the panel and the canvas at x=${gapX.toFixed(1)} is not the panel's width handle`,
    );
  }
  if (read.strip !== null) {
    const stripGapX =
      read.strip.x < read.frame.x
        ? (read.strip.x + read.strip.width + read.frame.x) / 2
        : (read.frame.x + read.frame.width + read.strip.x) / 2;
    if (
      !(await isHit(
        page,
        stripGapX,
        midY,
        '[data-testid="side-tab-strip-resize-handle"]',
      ))
    ) {
      problems.push(
        `the boundary between the strip and the frame at x=${stripGapX.toFixed(1)} is not the strip's width handle`,
      );
    }
  }
  return problems;
}

/** The surface frame is flush to the window on whichever edge has no strip: no ground left outside it. */
function frameFlushProblems(
  frame: Box,
  strip: Box | null,
  viewport: { readonly width: number },
): string[] {
  const problems: string[] = [];
  if ((strip === null || strip.x > frame.x) && Math.abs(frame.x) > 0.5) {
    problems.push(
      `the surface frame sits ${frame.x.toFixed(1)}px off the window's left edge, not flush`,
    );
  }
  if (strip === null || strip.x < frame.x) {
    const edgeGap = viewport.width - (frame.x + frame.width);
    if (Math.abs(edgeGap) > 0.5) {
      problems.push(
        `the surface frame sits ${edgeGap.toFixed(1)}px off the window's right edge, not flush`,
      );
    }
  }
  return problems;
}

// --- moves: every other live change that moves or resizes the slot ----------

/**
 * The rail sheet's width: the vertical `EpicLeftPanelRail`'s `w-12` (48px, not
 * the strip's 60px rail). Flush surface: the collapsed rail draws no border of
 * its own, so this is the bare width.
 */
const PANEL_RAIL_SHEET_WIDTH = 48;
/** How far the moves case drags the strip's width handle, and the slack on the width it lands at. */
const STRIP_DRAG_PX = 60;
const STRIP_DRAG_SLACK = 2;

/** The content sheet widened (or narrowed) by what the column beside it gave up (or took). */
function contentAbsorbed(
  column: {
    readonly before: number;
    readonly after: number;
    readonly what: string;
  },
  boxes: { readonly before: ShellBoxes; readonly after: ShellBoxes },
): string[] {
  const { before, after } = boxes;
  const { what } = column;
  if (before.content === null || after.content === null) {
    return ["no content frame to measure"];
  }
  const given = column.before - column.after;
  const grown = after.content.width - before.content.width;
  if (Math.abs(given) <= 1) {
    return [
      `${what} did not change width (${column.before.toFixed(1)} -> ${column.after.toFixed(1)}px)`,
    ];
  }
  if (Math.abs(grown - given) > 1) {
    return [
      `the content sheet changed width by ${grown.toFixed(1)}px, not the ${given.toFixed(1)}px ${what} gave up`,
    ];
  }
  return [];
}

function movedTabsTo(
  edge: Placement,
  before: ShellBoxes,
  after: ShellBoxes,
): string[] {
  const problems: string[] = [];
  if (after.placement !== edge) {
    problems.push(
      `the column's placement is ${String(after.placement)}, expected ${edge}`,
    );
  }
  if (edge === "top" && after.strip !== null) {
    problems.push(
      `a side strip is still drawn on the ${String(after.strip.edge)}`,
    );
  }
  if (edge !== "top" && after.strip?.edge !== edge) {
    problems.push(
      `the strip is on ${String(after.strip?.edge ?? "no edge")}, expected ${edge}`,
    );
  }
  if (
    before.content !== null &&
    after.content !== null &&
    sameBoxWithin(before.content, after.content, 0.5)
  ) {
    problems.push(
      `the content sheet did not move or resize (${boxText(after.content)})`,
    );
  }
  return problems;
}

function stripCollapsedTo(
  collapsed: boolean,
  railWidth: number,
  before: ShellBoxes,
  after: ShellBoxes,
): string[] {
  if (before.strip === null || after.strip === null) {
    return ["no side strip to collapse"];
  }
  const problems: string[] = [];
  if (after.strip.collapsed !== String(collapsed)) {
    problems.push(
      `the strip's data-collapsed is ${String(after.strip.collapsed)}, expected ${String(collapsed)}`,
    );
  }
  if (collapsed && Math.abs(after.strip.rect.width - railWidth) > 0.5) {
    problems.push(
      `the collapsed strip is ${after.strip.rect.width.toFixed(1)}px, not the ${String(railWidth)}px rail`,
    );
  }
  return [
    ...problems,
    ...contentAbsorbed(
      {
        before: before.strip.rect.width,
        after: after.strip.rect.width,
        what: "the strip",
      },
      { before, after },
    ),
  ];
}

function stripDraggedWider(before: ShellBoxes, after: ShellBoxes): string[] {
  if (
    before.strip === null ||
    after.strip === null ||
    before.stripHandle === null
  ) {
    return ["no side strip or width handle to drag"];
  }
  const widened = after.strip.rect.width - before.strip.rect.width;
  const problems: string[] = [];
  if (Math.abs(widened - STRIP_DRAG_PX) > STRIP_DRAG_SLACK) {
    problems.push(
      `the strip widened ${widened.toFixed(1)}px for a ${String(STRIP_DRAG_PX)}px drag`,
    );
  }
  return [
    ...problems,
    ...contentAbsorbed(
      {
        before: before.strip.rect.width,
        after: after.strip.rect.width,
        what: "the strip",
      },
      { before, after },
    ),
  ];
}

function panelCollapsedTo(
  collapsed: boolean,
  before: ShellBoxes,
  after: ShellBoxes,
): string[] {
  if (before.panel === null || after.panel === null) {
    return ["no panel sheet on screen"];
  }
  const problems: string[] = [];
  if (
    collapsed &&
    (after.rail === null ||
      Math.abs(after.rail.width - PANEL_RAIL_SHEET_WIDTH) > 0.5)
  ) {
    problems.push(
      `no ${String(PANEL_RAIL_SHEET_WIDTH)}px rail sheet (${after.rail === null ? "none" : boxText(after.rail)})`,
    );
  }
  if (collapsed && after.panelWidth !== 0) {
    problems.push(`the panel is still ${String(after.panelWidth)}px wide`);
  }
  if (!collapsed && after.rail !== null) {
    problems.push(`the rail sheet is still drawn at ${boxText(after.rail)}`);
  }
  if (!collapsed && (after.panelWidth ?? 0) <= PANEL_RAIL_SHEET_WIDTH) {
    problems.push(
      `the panel is ${String(after.panelWidth)}px wide, not expanded`,
    );
  }
  return [
    ...problems,
    ...contentAbsorbed(
      {
        before: before.panel.width,
        after: after.panel.width,
        what: "the panel column",
      },
      { before, after },
    ),
  ];
}

/**
 * Each step first proves it happened - the destination is on screen and the
 * content sheet's box changed the way that move changes it - so a move that
 * silently did nothing cannot pass on the unchanged geometry.
 */
interface MoveStep {
  readonly sidebar: Side;
  readonly name: string;
  readonly act: () => Promise<void>;
  readonly expected: (before: ShellBoxes, after: ShellBoxes) => string[];
}

async function assertMove(page: Page, step: MoveStep): Promise<void> {
  const before = await readShell(page);
  await step.act();
  await eventually(`moves, ${step.name}`, async () => {
    const after = await readShell(page);
    return [
      ...step.expected(before, after),
      ...flipProblems(after, step.sidebar),
    ];
  });
}

async function runMoves(
  page: Page,
  sidebar: Side,
  railWidth: number,
): Promise<void> {
  const call = (expression: string) => async (): Promise<void> => {
    await probe(page, expression);
  };
  const transitions: ReadonlyArray<readonly [Placement, Placement]> = [
    ["left", "right"],
    ["right", "left"],
    ["left", "top"],
    ["top", "right"],
    ["right", "top"],
    ["top", "left"],
  ];
  for (const [from, to] of transitions) {
    await assertMove(page, {
      sidebar,
      name: `tabs ${from} to ${to}`,
      act: call(`setTabPlacement(${JSON.stringify(to)})`),
      expected: (before, after) => movedTabsTo(to, before, after),
    });
  }
  await assertMove(page, {
    sidebar,
    name: "strip collapsed",
    act: call("setCollapsed(true)"),
    expected: (b, a) => stripCollapsedTo(true, railWidth, b, a),
  });
  await assertMove(page, {
    sidebar,
    name: "strip expanded",
    act: call("setCollapsed(false)"),
    expected: (b, a) => stripCollapsedTo(false, railWidth, b, a),
  });
  await assertMove(page, {
    sidebar,
    name: `strip dragged ${String(STRIP_DRAG_PX)}px wider`,
    act: async () => {
      const { stripHandle } = await readShell(page);
      if (stripHandle === null) return;
      const from = {
        x: stripHandle.x + stripHandle.width / 2,
        y: stripHandle.y + stripHandle.height / 2,
      };
      await pressAt(page, from.x, from.y);
      await moveInSteps(page, { x: from.x + STRIP_DRAG_PX, y: from.y });
      await releasePointer(page);
    },
    expected: stripDraggedWider,
  });
  await assertMove(page, {
    sidebar,
    name: "panel collapsed to its rail",
    act: call("setPanelCollapsed(true)"),
    expected: (b, a) => panelCollapsedTo(true, b, a),
  });
  await assertMove(page, {
    sidebar,
    name: "panel expanded",
    act: call("setPanelCollapsed(false)"),
    expected: (b, a) => panelCollapsedTo(false, b, a),
  });
}

// --- join: the joined tab and its risks -------------------------------------

type Pane = "panel" | "rail" | "canvas";

/**
 * The join's own `--join-fill` token per pane (`index.css`): the fill the
 * pane it opens onto paints. The token, not a sampled pixel, because the
 * canvas pane is mostly covered by hosted content in this fixture.
 */
function paneFillToken(pane: Pane): string {
  if (pane === "panel") return "--sidebar";
  if (pane === "rail") return "--background";
  return "--canvas";
}

interface JoinRead {
  readonly joined: {
    readonly edge: string | null;
    readonly pane: string | null;
    readonly rect: Box;
    readonly text: string;
  } | null;
  readonly bridge: Box | null;
  readonly active: Box | null;
  readonly list: Box | null;
  readonly panel: Box | null;
  readonly canvas: Box | null;
  readonly strip: Box | null;
  readonly handle: Box | null;
}

const JOIN_PROBE = `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const joined = document.querySelector("[data-sheet-joined]");
  const bridge = document.querySelector("[data-sheet-join-bridge]");
  const active = document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]');
  const list = document.querySelector(${JSON.stringify(STRIP_LIST)});
  // Whichever pane currently occupies the sidebar's screen position: the
  // real panel when expanded, or its collapsed rail (a separate element,
  // the join's "rail" pane) when not.
  const sidebarPane = [
    document.querySelector('[data-epic-sidebar-panel]'),
    document.querySelector('[data-fixture-collapsed-rail]'),
  ].find((node) => node !== null && node.getBoundingClientRect().width > 0) ?? null;
  return {
    joined: joined === null ? null : { edge: joined.getAttribute("data-sheet-joined"), pane: joined.getAttribute("data-join-pane"), rect: box(joined), text: joined.textContent.trim() },
    bridge: bridge === null || getComputedStyle(bridge).display === "none" ? null : box(bridge),
    active: box(active),
    list: box(list),
    panel: box(sidebarPane),
    canvas: box(document.querySelector('[data-epic-canvas-frame]')),
    strip: box(document.querySelector('[data-testid="side-tab-strip"]')),
    handle: box(document.querySelector('[data-testid="side-tab-strip-resize-handle"]')),
  };
})()`;

function readJoin(page: Page): Promise<JoinRead> {
  return page.evaluate<JoinRead>(JOIN_PROBE);
}

function paneNamed(name: string | null, fallback: Pane): Pane {
  return name === "rail" || name === "panel" || name === "canvas"
    ? name
    : fallback;
}

interface JoinSpots {
  readonly edge: Side;
  readonly row: Box;
  readonly strip: Box;
  readonly pane: Box;
  readonly fill: Rgb;
  readonly fillPane: Pane;
  readonly seamBorder: boolean;
  readonly state: string;
}

/**
 * The join's fill across the gap and onto the sheet, and not past the row's
 * corners: the row's sheet-side end, the gap and the sheet's border read the
 * pane's fill, and the gap 10px above and below the row reads it no more.
 */
async function joinSpotProblems(
  page: Page,
  spots: JoinSpots,
): Promise<string[]> {
  const { edge, row, strip, pane, fill, fillPane, state } = spots;
  const problems: string[] = [];
  const onLeft = edge === "left";
  const rowEnd = onLeft ? row.x + row.width - 2 : row.x + 2;
  const gapX = onLeft
    ? (strip.x + strip.width + pane.x) / 2
    : (pane.x + pane.width + strip.x) / 2;
  const borderX = onLeft ? pane.x + 0.5 : pane.x + pane.width - 0.5;
  const painted: ReadonlyArray<readonly [string, number]> = [
    ["the row's sheet-side end", rowEnd],
    ["the gap", gapX],
    // The canvas pane is filled edge to edge by the fixture's own hosted demo
    // content (a dashed border right at its own edge), which the gap spot
    // above already sits just outside of; sampling the seam border itself
    // would read that demo border instead. Panel/rail stay blank there, so the
    // check still holds for them.
    ...(spots.seamBorder ? [["the sheet's border", borderX] as const] : []),
  ];
  for (const [where, x] of painted) {
    const pixel = await samplePixelAt(page, x, row.cy);
    if (!sameRgb(pixel, fill, 3)) {
      problems.push(
        `${state}: ${where} at (${x.toFixed(1)}, ${row.cy.toFixed(0)}) is ${rgbText(pixel)}, not the ${fillPane}'s fill ${rgbText(fill)}`,
      );
    }
  }
  // Past the concave corners the join's fill does not bleed: the strip's own
  // background shows again above and below the joined row.
  for (const y of [row.y - 10, row.y + row.height + 10]) {
    const pixel = await samplePixelAt(page, gapX, y);
    if (sameRgb(pixel, fill, 3)) {
      problems.push(
        `${state}: the gap ${y < row.y ? "above" : "below"} the join (y=${y.toFixed(0)}) still reads as the joined fill ${rgbText(fill)}, past the row's own bounds`,
      );
    }
  }
  return problems;
}

/** J1-J3: the row, the bridge over the gap and the sheet's border, and containment past the corner. */
async function joinPaintProblems(
  page: Page,
  edge: Side,
  expectedPane: Pane,
  state: string,
): Promise<string[]> {
  const read = await readJoin(page);
  const { joined, bridge, strip } = read;
  if (joined === null) return [`${state}: no row or tile is joined`];
  const problems: string[] = [];
  if (joined.edge !== edge) {
    problems.push(
      `${state}: the joined row is open to the ${String(joined.edge)}, expected ${edge}`,
    );
  }
  if (bridge === null) {
    problems.push(`${state}: the bridge is not painting`);
    return problems;
  }
  // The pane the row joins: the panel (or its collapsed rail) when the
  // sidebar sits on the strip's own side, else the canvas - whichever pane
  // actually sits flush against the strip (side-tab-join.ts).
  const pane = joined.pane === "canvas" ? read.canvas : read.panel;
  if (pane === null || strip === null) {
    problems.push(`${state}: no ${String(joined.pane)} pane on screen to join`);
    return problems;
  }
  const fillPane = paneNamed(joined.pane, expectedPane);
  if (fillPane !== expectedPane) {
    problems.push(
      `${state}: the row joins the ${fillPane} pane, expected the ${expectedPane}`,
    );
  }
  const fill = await resolveRgb(page, `var(${paneFillToken(fillPane)})`);
  problems.push(
    ...(await joinSpotProblems(page, {
      edge,
      row: joined.rect,
      strip,
      pane,
      fill,
      fillPane,
      seamBorder: joined.pane !== "canvas",
      state,
    })),
  );
  if (
    Math.abs(bridge.y - joined.rect.y) > 0.5 ||
    Math.abs(bridge.height - joined.rect.height) > 0.5
  ) {
    problems.push(
      `${state}: the bridge ${boxText(bridge)} is not level with its row ${boxText(joined.rect)}`,
    );
  }
  note(
    `${state}: "${joined.text}" joined ${String(joined.edge)}, fill ${rgbText(fill)} across the gap and the border, bridge ${boxText(bridge)}`,
  );
  return problems;
}

async function assertJoinPaint(
  page: Page,
  edge: Side,
  pane: Pane,
  state: string,
): Promise<void> {
  await settleShell(page);
  await eventually(`join ${state}`, () =>
    joinPaintProblems(page, edge, pane, state),
  );
}

// --- the strip's top block --------------------------------------------------

interface StripTopRead {
  readonly strip: Box;
  readonly titleRow: Box | null;
  readonly toggle: Box | null;
  readonly inbox: Box | null;
  readonly allTasks: Box | null;
  readonly newTask: Box | null;
  readonly newTaskIcon: Box | null;
  readonly newTaskLabel: Box | null;
  readonly divider: Box | null;
  readonly home: Box | null;
  readonly homeIcon: Box | null;
  readonly homeTitle: Box | null;
  readonly tasksLabel: Box | null;
  readonly items: readonly Box[];
  readonly inboxIcon: Box | null;
  readonly inboxMark: Box | null;
  readonly rows: ReadonlyArray<{
    readonly title: string;
    readonly titleRect: Box | null;
    readonly meter: Box | null;
  }>;
  readonly avatar: Box | null;
  readonly tiles: ReadonlyArray<{
    readonly text: string;
    readonly joined: boolean;
    readonly rect: Box;
    readonly chip: Box | null;
    readonly meter: Box | null;
    readonly badge: Box | null;
    readonly badgeRadius: string | null;
  }>;
}

const STRIP_TOP_PROBE = `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const strip = document.querySelector('[data-testid="side-tab-strip"]');
  const q = (selector) => strip.querySelector(selector);
  const homeRow = q('[data-testid="tab-home"]');
  const newTask = q('[data-testid="side-strip-new-task"]');
  const tiles = [...strip.querySelectorAll('[data-testid="header-tab-strip-scroll"] [data-side-tab="collapsed"]')].map((tile) => {
    const badge = tile.querySelector('[data-testid="side-tab-rail-badge"]');
    return {
      text: (tile.querySelector('[data-testid="side-tab-monogram-chip"]')?.textContent ?? "").trim(),
      joined: tile.hasAttribute("data-side-tab-joined"),
      rect: box(tile),
      chip: box(tile.querySelector('[data-testid="side-tab-monogram-chip"]')),
      meter: box(tile.querySelector('[data-testid="side-tab-meter"]')),
      badge: box(badge),
      badgeRadius: badge === null ? null : getComputedStyle(badge).borderTopLeftRadius,
    };
  });
  return {
    strip: box(strip),
    titleRow: box(q('[data-testid="side-strip-title-row"]')),
    toggle: box(q('[data-testid="side-tab-strip-collapse"]')),
    inbox: box(q('[data-testid="side-strip-inbox"]')),
    allTasks: box(q('[data-testid="side-strip-all-tasks"]')),
    newTask: box(newTask),
    newTaskIcon: box(newTask?.querySelector("svg") ?? null),
    newTaskLabel: box(q('[data-testid="side-strip-new-task-label"]')),
    divider: box(q('[data-testid="side-strip-rail-divider"]')),
    home: box(homeRow),
    homeIcon: box(homeRow?.querySelector("svg") ?? null),
    homeTitle: box(homeRow?.querySelector(".header-tab-title-text") ?? null),
    tasksLabel: box(q('[data-testid="side-strip-tasks-label"]')),
    // The list's own items - a tile, a split pair, a group header - as the
    // rhythm's units: a pair's members are spaced by its seam, not the gap.
    items: [...(q('[data-testid="header-tab-strip-scroll"]')?.children ?? [])]
      .map((node) => box(node))
      .filter((rect) => rect.height > 0),
    inboxIcon: box(q('[data-testid="side-strip-inbox"] svg')),
    inboxMark: box(q('[data-testid="side-strip-inbox-needs-you-badge"]') ?? q('[data-testid="side-strip-inbox-unknown-indicator"]')),
    rows: [...strip.querySelectorAll('[data-side-tab="expanded"]')].map((row) => ({
      title: (row.querySelector('[data-testid="side-tab-title"]')?.textContent ?? "").trim(),
      titleRect: box(row.querySelector('[data-testid="side-tab-title"]')),
      meter: box(row.querySelector('[data-testid="side-tab-meter"]')),
    })),
    avatar: box(q('[data-testid="user-menu-trigger"]')),
    tiles,
  };
})()`;

/** The collapsed nav tiles (expand, Notifications, All tasks, New Task, the avatar): 32px squares (`size-8`). */
const STRIP_NAV_TILE = 32;
/** The rail tile's badge: a 14px disc of the strip's ground (`SIDE_TAB_RAIL_BADGE_CLASS`, D5). */
const SIDE_TAB_RAIL_BADGE = 14;
/** A hairline has to stand off the ground by at least this much to be seen. */
const RAIL_DIVIDER_CONTRAST_FLOOR = 1.15;

function gapBetween(above: Box | null, below: Box | null): number | null {
  return above === null || below === null
    ? null
    : below.y - (above.y + above.height);
}

type Named = readonly [string, Box | null];

/** Every part of the rail is centred on its axis: the nav tiles, the divider, Home, the avatar and each tile's chip and meter. */
function axisProblems(read: StripTopRead): string[] {
  const problems: string[] = [];
  const axis = read.strip.x + read.strip.width / 2;
  const centred: readonly Named[] = [
    ["expand", read.toggle],
    ["inbox", read.inbox],
    ["all tasks", read.allTasks],
    ["new task", read.newTask],
    ["divider", read.divider],
    ["home", read.home],
    ["avatar", read.avatar],
    ...read.tiles.flatMap((tile): readonly Named[] => [
      [`${tile.text} chip`, tile.chip],
      [`${tile.text} meter`, tile.meter],
    ]),
  ];
  for (const [name, rect] of centred) {
    if (rect === null) {
      problems.push(`no ${name} in the rail`);
    } else if (Math.abs(rect.x + rect.width / 2 - axis) > 0.5) {
      problems.push(
        `${name} is centred at x=${(rect.x + rect.width / 2).toFixed(1)}, off the rail's axis x=${axis.toFixed(1)}`,
      );
    }
  }
  return problems;
}

/** The collapsed nav tiles (expand, Notifications, All tasks, New Task, the avatar) are 32px squares. */
function navTileProblems(read: StripTopRead): string[] {
  const tiles: readonly Named[] = [
    ["expand", read.toggle],
    ["inbox", read.inbox],
    ["all tasks", read.allTasks],
    ["new task", read.newTask],
    ["avatar", read.avatar],
  ];
  const problems: string[] = [];
  for (const [name, rect] of tiles) {
    if (
      rect !== null &&
      (Math.abs(rect.width - STRIP_NAV_TILE) > 0.5 ||
        Math.abs(rect.height - STRIP_NAV_TILE) > 0.5)
    ) {
      problems.push(
        `${name} is ${boxText(rect)}, not a ${String(STRIP_NAV_TILE)}px tile`,
      );
    }
  }
  return problems;
}

/**
 * The Notifications tile's mark sits on its glyph's top-right corner as a task
 * badge sits on its chip: centred 1px out from that corner. Alpha waits on an
 * approval (RAIL_INDICATORS), so there is always a mark to place.
 */
function notificationsMarkProblems(read: StripTopRead): string[] {
  if (read.inboxIcon === null || read.inboxMark === null) {
    return [
      "the Notifications tile draws no glyph or no mark while a task waits",
    ];
  }
  const cx = read.inboxMark.x + read.inboxMark.width / 2;
  const cy = read.inboxMark.y + read.inboxMark.height / 2;
  const expectedX = read.inboxIcon.x + read.inboxIcon.width + 1;
  const expectedY = read.inboxIcon.y - 1;
  if (Math.abs(cx - expectedX) > 0.75 || Math.abs(cy - expectedY) > 0.75) {
    return [
      `the Notifications mark ${boxText(read.inboxMark)} is centred at (${cx.toFixed(1)}, ${cy.toFixed(1)}), not on the glyph's corner (${expectedX.toFixed(1)}, ${expectedY.toFixed(1)})`,
    ];
  }
  return [];
}

function apartProblems(name: string, gaps: readonly number[]): string[] {
  return gaps.some((value) => Math.abs(value - gaps[0]) > 0.5)
    ? [
        `${name} are ${gaps.map((value) => value.toFixed(1)).join("/")}px apart, not evenly`,
      ]
    : [];
}

/** The nav tiles are evenly apart, the divider is midway, and Home and the items keep one rhythm. */
function rhythmProblems(read: StripTopRead): string[] {
  const problems: string[] = [];
  const navGaps = [
    gapBetween(read.toggle, read.inbox),
    gapBetween(read.inbox, read.allTasks),
    gapBetween(read.allTasks, read.newTask),
  ].filter((value): value is number => value !== null);
  problems.push(...apartProblems("the nav tiles", navGaps));
  const aboveDivider = gapBetween(read.newTask, read.divider);
  const belowDivider = gapBetween(read.divider, read.home);
  if (
    aboveDivider !== null &&
    belowDivider !== null &&
    Math.abs(aboveDivider - belowDivider) > 0.5
  ) {
    problems.push(
      `the divider is ${aboveDivider.toFixed(1)}px below New Task and ${belowDivider.toFixed(1)}px above Home, not midway`,
    );
  }
  const rhythm = [read.home, ...read.items].filter(
    (rect): rect is Box => rect !== null,
  );
  const itemGaps = rhythm
    .slice(1)
    .map((rect, index) => rect.y - (rhythm[index].y + rhythm[index].height));
  problems.push(...apartProblems("Home and the list's items", itemGaps));
  return problems;
}

/** No badge spills past its tile, and each is the 14px disc (D5). */
function badgeProblems(read: StripTopRead): string[] {
  const problems: string[] = [];
  for (const tile of read.tiles) {
    if (tile.badge === null || tile.chip === null) continue;
    const t = tile.joined
      ? { ...tile.rect, x: tile.chip.x + tile.chip.width / 2 - 20, width: 40 }
      : tile.rect;
    if (
      tile.badge.x + tile.badge.width > t.x + t.width + 0.5 ||
      tile.badge.y < t.y - 1.5
    ) {
      problems.push(
        `the ${tile.text} badge ${boxText(tile.badge)} spills past its tile ${boxText(t)}`,
      );
    }
    if (
      Math.abs(tile.badge.width - SIDE_TAB_RAIL_BADGE) > 0.5 ||
      Math.abs(tile.badge.height - SIDE_TAB_RAIL_BADGE) > 0.5
    ) {
      problems.push(
        `the ${tile.text} badge is ${boxText(tile.badge)}, not a ${String(SIDE_TAB_RAIL_BADGE)}px disc`,
      );
    }
    if (
      tile.badgeRadius !== null &&
      Number.parseFloat(tile.badgeRadius) < SIDE_TAB_RAIL_BADGE / 2
    ) {
      problems.push(
        `the ${tile.text} badge's radius is ${tile.badgeRadius}, so it is not a disc`,
      );
    }
  }
  return problems;
}

/**
 * F1: the rail is one column - every part centred on the rail's axis, the nav
 * tiles 32px and evenly apart, the divider midway between New Task and Home,
 * Home spaced from the first tile as the tiles are from each other, the
 * Notifications mark on its glyph's corner and no badge spilling past its
 * 14px disc's tile. (Their order top to bottom is `side-tab-strip.test.tsx`'s.)
 */
function railColumnProblems(read: StripTopRead): string[] {
  return [
    ...axisProblems(read),
    ...navTileProblems(read),
    ...notificationsMarkProblems(read),
    ...rhythmProblems(read),
    ...badgeProblems(read),
  ];
}

/** The divider's line against the ground 4px above it: a hairline that reads, in both themes. */
async function dividerContrast(
  page: Page,
  divider: Box,
): Promise<{
  readonly ratio: number;
  readonly ground: string;
  readonly line: string;
}> {
  const x = Math.round(divider.x + divider.width / 2);
  const y = Math.round(divider.y);
  const pixels = await regionPixels(page, { x, y: y - 4, width: 1, height: 5 });
  const ground = [pixels[0], pixels[1], pixels[2]] as const;
  const line = [pixels[12], pixels[13], pixels[14]] as const;
  return {
    ratio: contrastRatio(ground, line),
    ground: rgbText(ground),
    line: rgbText(line),
  };
}

/** New Task is the Home row's box, its icon and label level with Home's. */
function newTaskProblems(read: StripTopRead): string[] {
  const { newTask, home } = read;
  if (newTask === null || home === null) {
    return ["no New Task or no Home row in the expanded top block"];
  }
  const problems: string[] = [];
  if (
    Math.abs(newTask.x - home.x) > 0.5 ||
    Math.abs(newTask.width - home.width) > 0.5 ||
    Math.abs(newTask.height - home.height) > 0.5
  ) {
    problems.push(
      `New Task ${boxText(newTask)} is not the Home row's box ${boxText(home)}`,
    );
  }
  if (
    read.newTaskIcon !== null &&
    read.homeIcon !== null &&
    Math.abs(read.newTaskIcon.x - read.homeIcon.x) > 0.5
  ) {
    problems.push(
      `New Task's icon is at x=${read.newTaskIcon.x.toFixed(1)}, Home's at x=${read.homeIcon.x.toFixed(1)}`,
    );
  }
  if (
    read.newTaskLabel !== null &&
    read.homeTitle !== null &&
    Math.abs(read.newTaskLabel.x - read.homeTitle.x) > 0.5
  ) {
    problems.push(
      `New Task's label is at x=${read.newTaskLabel.x.toFixed(1)}, Home's title at x=${read.homeTitle.x.toFixed(1)}`,
    );
  }
  return problems;
}

/** Every row's meter is centred with its title. */
function rowKitProblems(read: StripTopRead): string[] {
  const problems: string[] = [];
  const middle = (rect: Box): number => rect.y + rect.height / 2;
  for (const row of read.rows) {
    if (
      row.meter !== null &&
      row.titleRect !== null &&
      Math.abs(middle(row.meter) - middle(row.titleRect)) > 0.5
    ) {
      problems.push(
        `"${row.title}": the meter is centred at y=${middle(row.meter).toFixed(1)}, the title at y=${middle(row.titleRect).toFixed(1)}`,
      );
    }
  }
  return problems;
}

/** F7 expanded: New Task is the Home row's box, its icon and label level with Home's, and every meter is placed inside its row. */
function expandedTopProblems(read: StripTopRead): string[] {
  return [...newTaskProblems(read), ...rowKitProblems(read)];
}

/**
 * One strip configuration of F1/F7: `edge` with the panel on the strip's own
 * side (so the active tile joins it, D3), the rail or the expanded top block,
 * with a task waiting so there is a mark to place. Geometry is read once (in
 * the light theme); what a theme can change - the divider's contrast - in both.
 */
async function assertStripTop(
  page: Page,
  input: {
    readonly edge: Side;
    readonly collapsed: boolean;
    readonly session: string;
  },
): Promise<void> {
  const label = `${input.session}, ${input.edge}, ${input.collapsed ? "rail" : "expanded"}`;
  await configureShell(page, {
    tabs: input.edge,
    sidebar: input.edge,
    collapsed: input.collapsed,
  });
  await setIndicators(page, RAIL_INDICATORS);
  await setActivity(page);
  const violations = violationLog();
  for (const theme of ["light", "dark"] as const) {
    await setThemeAndWait(page, theme);
    await settleShell(page);
    const read = await page.evaluate<StripTopRead>(STRIP_TOP_PROBE);
    // Geometry once; what a theme can change - the fill and the divider's
    // contrast - in both.
    if (theme === "light") {
      const problems = input.collapsed
        ? railColumnProblems(read)
        : expandedTopProblems(read);
      for (const problem of problems)
        violations.add(`${label}, ${theme}: ${problem}`);
    }
    if (input.collapsed && read.divider !== null) {
      const contrast = await dividerContrast(page, read.divider);
      note(
        `${label}, ${theme}: divider ${contrast.line} on the ground ${contrast.ground} = ${contrast.ratio.toFixed(2)}:1`,
      );
      violations.check(
        contrast.ratio >= RAIL_DIVIDER_CONTRAST_FLOOR,
        `${label}, ${theme}: the divider ${contrast.line} on the ground ${contrast.ground} is ${contrast.ratio.toFixed(2)}:1, under ${String(RAIL_DIVIDER_CONTRAST_FLOOR)}:1, so it does not read`,
      );
    } else if (input.collapsed) {
      violations.add(`${label}, ${theme}: no divider in the rail`);
    }
  }
  violations.assertNone(`F1/F7: the strip's top block (${label})`);
}

// --- resize: a real handle drag across the snap point -----------------------

interface StripResizeRead {
  readonly width: number;
  readonly handle: { readonly x: number; readonly y: number };
  readonly collapsed: string | null;
  readonly tiles: number;
  readonly rows: number;
  readonly divider: boolean;
  readonly newTaskLabel: boolean;
  readonly liveAgents: number;
  readonly joined: string | null;
}

const STRIP_RESIZE_PROBE = `(() => {
  const strip = document.querySelector('[data-testid="side-tab-strip"]');
  const handle = strip.querySelector('[data-testid="side-tab-strip-resize-handle"]');
  const r = strip.getBoundingClientRect();
  const h = handle.getBoundingClientRect();
  const joined = strip.querySelector("[data-sheet-joined]");
  return {
    width: r.width,
    handle: { x: h.x + h.width / 2, y: h.y + h.height / 2 },
    collapsed: strip.getAttribute("data-collapsed"),
    tiles: strip.querySelectorAll('[data-side-tab="collapsed"]').length,
    rows: strip.querySelectorAll('[data-side-tab="expanded"]').length,
    divider: strip.querySelector('[data-testid="side-strip-rail-divider"]') !== null,
    newTaskLabel: strip.querySelector('[data-testid="side-strip-new-task-label"]') !== null,
    liveAgents: strip.querySelectorAll('[data-testid="strip-agent-group"] [data-testid^="strip-agent-fixture-agent-"]').length,
    joined: joined === null ? null : joined.getAttribute("data-side-tab"),
  };
})()`;

function readResize(page: Page): Promise<StripResizeRead> {
  return page.evaluate<StripResizeRead>(STRIP_RESIZE_PROBE);
}

/** A slowed panel motion token, so a probe and a screenshot land inside the ease. */
const SLOW_PANEL_MOTION_MS = 1500;

async function setPanelMotionMs(page: Page, ms: number | null): Promise<void> {
  await page.evaluate(
    ms === null
      ? `document.documentElement.style.removeProperty("--panel-animation-duration")`
      : `document.documentElement.style.setProperty("--panel-animation-duration", "${String(ms)}ms")`,
  );
}

/**
 * L-165: the drag frame that crosses the snap point eases the jump between the
 * minimum and the rail with the panel motion token, the joined tile's bridge
 * staying on the strip's content-facing edge while it runs; Escape and a
 * release land at once, and under reduced motion the crossing does too.
 * Leaves the strip expanded at its starting width.
 */
async function assertCrossingEase(
  page: Page,
  input: {
    readonly edge: Side;
    readonly railWidth: number;
    readonly minWidth: number;
    readonly snapBelow: number;
  },
): Promise<void> {
  const start = await readResize(page);
  const grip = start.handle;
  const sign = input.edge === "left" ? 1 : -1;
  const at = (width: number): { x: number; y: number } => ({
    x: grip.x + sign * (width - start.width),
    y: grip.y,
  });
  // Any width under the snap point crosses it; 100 is the driver's own pick,
  // and sits between the rail and the minimum on both sides.
  const underSnap = Math.min(100, input.snapBelow - 20);
  const violations = violationLog();
  await setPanelMotionMs(page, SLOW_PANEL_MOTION_MS);
  try {
    await pressAt(page, grip.x, grip.y);
    await moveInSteps(page, at(underSnap));
    // Somewhere inside the ease: between the rail and the minimum, joins
    // attached. The ease runs 1.5s and the width is polled for the range, so
    // a slow frame cannot land the read outside it - nor can a read taken
    // before the crossing frame, still at the starting width, pass for one.
    await expect
      .poll(
        async () => {
          const width = (await readResize(page)).width;
          return width > input.railWidth + 4 && width < input.minWidth - 4;
        },
        {
          message:
            "mid-crossing: the strip's width never eased between the rail and the minimum",
        },
      )
      .toBe(true);
    const mid = await readResize(page);
    const join = await readJoin(page);
    note(
      `mid-crossing: ${mid.width.toFixed(1)}px wide, data-collapsed=${String(mid.collapsed)}`,
    );
    violations.check(
      mid.width > input.railWidth + 4 && mid.width < input.minWidth - 4,
      `mid-crossing: the strip is ${mid.width.toFixed(1)}px wide, expected an eased width between the rail and the minimum`,
    );
    violations.check(
      mid.collapsed === "true",
      `mid-crossing: data-collapsed=${String(mid.collapsed)}, expected the rail's layout at once`,
    );
    if (join.joined === null || join.bridge === null || join.strip === null) {
      violations.add(
        "mid-crossing: no joined tile or no bridge while the width eases",
      );
    } else {
      // As at rest: the bridge runs from the tile's content-facing edge to
      // just past the strip's, so it tracks both while the width eases.
      const tile = join.joined.rect;
      const onLeft = join.joined.edge === "left";
      const tileEdge = onLeft ? tile.x + tile.width : tile.x;
      const stripEdge = onLeft ? join.strip.x + join.strip.width : join.strip.x;
      const [bridgeInner, bridgeOuter] = onLeft
        ? [join.bridge.x, join.bridge.x + join.bridge.width]
        : [join.bridge.x + join.bridge.width, join.bridge.x];
      violations.check(
        Math.abs(join.bridge.y - tile.y) <= 0.5,
        `mid-crossing: the bridge ${boxText(join.bridge)} is not level with its tile ${boxText(tile)}`,
      );
      violations.check(
        Math.abs(bridgeInner - tileEdge) <= 1.5,
        `mid-crossing: the bridge starts at x=${bridgeInner.toFixed(1)}, off the tile's edge at x=${tileEdge.toFixed(1)}`,
      );
      violations.check(
        Math.abs(bridgeOuter - stripEdge) <= 2,
        `mid-crossing: the bridge ends at x=${bridgeOuter.toFixed(1)}, off the strip's content edge at x=${stripEdge.toFixed(1)}`,
      );
    }
    // Escape mid-ease: the starting width at once.
    await pressKey(page, "Escape");
    await nextFrames(page, 2);
    const escaped = (await readResize(page)).width;
    violations.check(
      Math.abs(escaped - start.width) <= 1.5,
      `Escape mid-ease: ${escaped.toFixed(1)}px, expected ${start.width.toFixed(1)} at once`,
    );
    await releasePointer(page);
    await nextFrames(page, 2);
    // Released mid-ease: the rail at once.
    await pressAt(page, grip.x, grip.y);
    await moveInSteps(page, at(underSnap));
    await releasePointer(page);
    await nextFrames(page, 2);
    const released = (await readResize(page)).width;
    violations.check(
      Math.abs(released - input.railWidth) <= 1.5,
      `release mid-ease: ${released.toFixed(1)}px, expected the rail's ${String(input.railWidth)} at once`,
    );
    note(
      `crossing eased (${mid.width.toFixed(0)}px), Escape ${escaped.toFixed(0)}px and release ${released.toFixed(0)}px at once`,
    );
    await probe(page, "setCollapsed(false)");
    // The 1.5s ease back out: landed when the width stops moving.
    await waitForStableBoxes(page, ['[data-testid="side-tab-strip"]'], 6);
    // Reduced motion: the token goes to 0ms and the crossing lands at once.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pressAt(page, grip.x, grip.y);
    await moveInSteps(page, at(underSnap));
    await nextFrames(page, 2);
    const reduced = (await readResize(page)).width;
    await pressKey(page, "Escape");
    await releasePointer(page);
    violations.check(
      Math.abs(reduced - input.railWidth) <= 1.5,
      `reduced motion: the crossing drew ${reduced.toFixed(1)}px, expected the rail at once`,
    );
  } finally {
    await page.emulateMedia({ reducedMotion: null });
    await setPanelMotionMs(page, null);
    await releasePointer(page);
  }
  violations.assertNone("F9: the crossing's ease");
}

/**
 * F9: the strip's layout follows a real handle drag across the snap point at
 * the crossing, both ways, with the pointer still down. The crossing's own
 * rules (out of the rail, a cancelled drag, the stored width, the store written
 * once on release) are `side-tab-strip.test.tsx`'s; what only a browser has is
 * the handle jumping under a held, captured pointer.
 */
async function assertHeldPointerSnap(
  page: Page,
  input: { readonly edge: Side; readonly railWidth: number },
): Promise<void> {
  const start = await readResize(page);
  const grip = start.handle;
  const sign = input.edge === "left" ? 1 : -1;
  const at = (width: number): { x: number; y: number } => ({
    x: grip.x + sign * (width - start.width),
    y: grip.y,
  });
  const violations = violationLog();
  const expectLayout = (
    state: StripResizeRead,
    want: "rail" | "expanded",
    where: string,
  ): void => {
    const collapsed = want === "rail";
    violations.check(
      state.collapsed === String(collapsed),
      `${where}: data-collapsed=${String(state.collapsed)}, expected ${String(collapsed)}`,
    );
    violations.check(
      collapsed
        ? state.tiles > 0 && state.rows === 0
        : state.rows > 0 && state.tiles === 0,
      `${where}: ${String(state.tiles)} tiles and ${String(state.rows)} rows, expected the ${want} layout`,
    );
    violations.check(
      state.divider === collapsed,
      `${where}: the rail divider is ${state.divider ? "drawn" : "absent"}, expected the ${want} top block`,
    );
    violations.check(
      state.newTaskLabel !== collapsed,
      `${where}: the New Task label is ${state.newTaskLabel ? "drawn" : "absent"}, expected the ${want} top block`,
    );
    violations.check(
      state.liveAgents > 0 !== collapsed,
      `${where}: ${String(state.liveAgents)} live agents under the active row, expected ${collapsed ? "none on the rail" : "Epsilon's 3"}`,
    );
    violations.check(
      state.joined === (collapsed ? "collapsed" : "expanded"),
      `${where}: the joined item is ${String(state.joined)}, expected the ${want}'s`,
    );
  };
  const expectWidth = (
    state: StripResizeRead,
    width: number,
    where: string,
  ): void => {
    violations.check(
      Math.abs(state.width - width) <= 1.5,
      `${where}: the strip is ${state.width.toFixed(1)}px wide, expected ${String(width)}`,
    );
  };
  // 1. Expanded -> under the snap point, pointer held: snapped live to the
  // rail (never a rail drawn in a wider strip).
  await pressAt(page, grip.x, grip.y);
  await moveInSteps(page, at(100));
  await expect
    .poll(async () => (await readResize(page)).collapsed, {
      message:
        "held under the snap point: the strip never took the rail's layout",
    })
    .toBe("true");
  await waitForStableBoxes(page, ['[data-testid="side-tab-strip"]'], 4);
  let state = await readResize(page);
  expectWidth(state, input.railWidth, "held under the snap point");
  expectLayout(state, "rail", "held under the snap point");
  // 2. Back over it, still held: the expanded layout again.
  await moveInSteps(page, at(220));
  await expect
    .poll(async () => (await readResize(page)).collapsed, {
      message:
        "held back over the snap point: the strip never came back to expanded",
    })
    .toBe("false");
  await waitForStableBoxes(page, ['[data-testid="side-tab-strip"]'], 4);
  state = await readResize(page);
  expectWidth(state, 220, "held back over the snap point");
  expectLayout(state, "expanded", "held back over the snap point");
  // 3. Under again and released: the rail.
  await moveInSteps(page, at(100));
  await releasePointer(page);
  await waitForStableBoxes(page, ['[data-testid="side-tab-strip"]'], 4);
  state = await readResize(page);
  expectWidth(state, input.railWidth, "released under the snap point");
  expectLayout(state, "rail", "released under the snap point");
  note(`final ${state.width.toFixed(0)}px`);
  violations.assertNone("F9: a held handle across the snap point");
}

// --- overlays, the live agents ----------------------------------------------

/** The hover card and the Notifications drawer sit inside the window, the drawer flush with the sheets. */
async function assertOverlays(page: Page): Promise<void> {
  const frame = await requireRect(page, SURFACE_FRAME);
  const strip = await requireRect(page, '[data-testid="side-tab-strip"]');
  const viewport = await viewportOf(page);
  const inside = (name: string, box: Box | null): string[] => {
    if (box === null) return [`${name} did not open`];
    if (
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > viewport.width ||
      box.y + box.height > viewport.height
    ) {
      return [`${name} ${boxText(box)} leaves the window`];
    }
    note(`${name} ${boxText(box)}`);
    return [];
  };
  const violations = violationLog();

  const alpha = await rowRect(page, "epic:fixture-alpha");
  await moveTo(page, alpha.cx, alpha.cy);
  await waitUntil(
    page,
    `document.querySelector('[data-testid="side-tab-hover-card"]') !== null`,
  );
  await waitForStableBoxes(page, ['[data-testid="side-tab-hover-card"]'], 3);
  for (const line of inside(
    "the hover card",
    await rectOf(page, '[data-testid="side-tab-hover-card"]'),
  )) {
    violations.add(line);
  }
  await moveTo(page, frame.cx, frame.cy);
  await waitUntil(
    page,
    `document.querySelector('[data-testid="side-tab-hover-card"]') === null`,
  );

  const inbox = await requireRect(page, '[data-testid="side-strip-inbox"]');
  await moveTo(page, inbox.cx, inbox.cy);
  await page.mouse.down();
  await page.mouse.up();
  await waitUntil(
    page,
    `document.querySelector('[data-testid="side-strip-inbox-drawer"]') !== null`,
  );
  await waitForStableBoxes(
    page,
    ['[data-testid="side-strip-inbox-drawer"]'],
    4,
  );
  const drawer = await rectOf(page, '[data-testid="side-strip-inbox-drawer"]');
  for (const line of inside("the Notifications drawer", drawer))
    violations.add(line);
  if (drawer !== null) {
    violations.check(
      Math.abs(drawer.y - frame.y) <= 1 &&
        Math.abs(drawer.y + drawer.height - (frame.y + frame.height)) <= 1,
      `the Notifications drawer ${boxText(drawer)} is not level with the sheets ${boxText(frame)}`,
    );
    // Flush surface: the strip and the frame sit with no ground between them,
    // so the drawer opens flush off the strip's content-facing (left) edge.
    violations.check(
      Math.abs(drawer.x + drawer.width - strip.x) <= 1,
      `the Notifications drawer ${boxText(drawer)} does not open flush off the strip ${boxText(strip)}`,
    );
  }
  await pressKey(page, "Escape");
  await waitUntil(
    page,
    `document.querySelector('[data-testid="side-strip-inbox-drawer"]') === null`,
  );
  violations.assertNone("The overlays");
}

interface LiveAgentsRead {
  readonly group: Box | null;
  readonly rows: readonly string[];
  readonly active: Box | null;
  readonly strip: Box | null;
  /** Where the task's title text starts, and where the first agent's glyph does. */
  readonly taskTitleX: number | null;
  readonly glyphX: number | null;
}

const LIVE_AGENTS_PROBE = `(() => {
  const group = document.querySelector('[data-testid="strip-agent-group"]');
  const rows = group === null ? [] : [...group.querySelectorAll('[data-testid^="strip-agent-fixture-agent-"]')];
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const strip = document.querySelector('[data-testid="side-tab-strip"]');
  const walker = document.createTreeWalker(strip, NodeFilter.SHOW_TEXT);
  let taskTitleX = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.data.trim() !== "Epsilon cleanup") continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    taskTitleX = range.getBoundingClientRect().x;
    break;
  }
  const glyph = rows.length === 0 ? null : rows[0].firstElementChild;
  return {
    group: box(group),
    rows: rows.map((row) => row.getAttribute("data-testid")),
    active: box(document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]')),
    strip: box(strip),
    taskTitleX,
    glyphX: glyph === null ? null : glyph.getBoundingClientRect().x,
  };
})()`;

/**
 * D9: the active task's agents nest under its row and inside the strip, their
 * guide sits on the task's title start edge, and their glyph column just inside
 * it. That alignment is read across two components - the task's title in the
 * row, the guide and glyph in the group - so it is measured here, not from
 * either.
 */
async function assertLiveAgents(page: Page): Promise<void> {
  await settleShell(page);
  await waitUntil(
    page,
    `document.querySelector('[data-testid="strip-agent-group"] [data-testid^="strip-agent-fixture-agent-"]') !== null`,
  );
  await settleShell(page);
  const shown = await page.evaluate<LiveAgentsRead>(LIVE_AGENTS_PROBE);
  const violations = violationLog();
  if (
    shown.taskTitleX === null ||
    shown.glyphX === null ||
    shown.group === null
  ) {
    let missing = "agent group";
    if (shown.taskTitleX === null) missing = "task title text";
    else if (shown.glyphX === null) missing = "agent glyph";
    violations.add(`no ${missing} to measure`);
  } else {
    violations.check(
      Math.abs(shown.group.x - shown.taskTitleX) <= 0.5,
      `the agents' guide is at x=${shown.group.x.toFixed(1)}, ${(shown.group.x - shown.taskTitleX).toFixed(1)}px past the task's title start edge, expected 0`,
    );
    violations.check(
      shown.glyphX - shown.group.x >= 1 && shown.glyphX - shown.group.x <= 12,
      `the agents' glyph column starts ${(shown.glyphX - shown.group.x).toFixed(1)}px past the guide, expected just inside it (1px to 12px)`,
    );
  }
  if (shown.group === null || shown.active === null || shown.strip === null) {
    violations.add("no agent group or no active row to measure");
  } else {
    violations.check(
      shown.group.y >= shown.active.y + shown.active.height - 0.5,
      `the agents ${boxText(shown.group)} are not under the active row ${boxText(shown.active)}`,
    );
    violations.check(
      shown.group.x >= shown.strip.x &&
        shown.group.x + shown.group.width <= shown.strip.x + shown.strip.width,
      `the agents ${boxText(shown.group)} leave the strip ${boxText(shown.strip)}`,
    );
  }
  violations.assertNone("D9: the agents under the active row");
}

// --- the rail groups --------------------------------------------------------

interface RailGroupRead {
  readonly buttons: ReadonlyArray<{
    readonly testId: string | null;
    readonly label: string | null;
    readonly current: boolean;
    readonly rect: Box;
  }>;
  readonly groups: ReadonlyArray<{
    readonly id: string | null;
    readonly buttons: number;
    readonly count: { readonly text: string | null; readonly rect: Box } | null;
    readonly button: Box | null;
  }>;
}

const RAIL_GROUP_PROBE = `(() => {
  const rail = document.querySelector('[data-testid="epic-sidebar-rail"]');
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  if (rail === null) return null;
  return {
    buttons: [...rail.querySelectorAll("button")].map((node) => ({
      testId: node.getAttribute("data-testid"),
      label: node.getAttribute("aria-label"),
      current: node.getAttribute("aria-current") === "true",
      rect: box(node),
    })),
    groups: [...rail.querySelectorAll("[data-rail-stack]")].map((node) => {
      const count = node.querySelector('[data-testid="epic-rail-stack-count"]');
      return {
        id: node.getAttribute("data-rail-stack"),
        buttons: node.querySelectorAll("button").length,
        count: count === null ? null : { text: count.textContent, rect: box(count) },
        button: box(node.querySelector("button")),
      };
    }),
  };
})()`;

/** `selection-ring.ts`'s two numbers (`RING_PADDING`, `RING_BLEED`): how far the ring stands off its region, at most. */
const RING_PADDING = 3;
const RING_BLEED = 6;

const ARTIFACTS_ROW =
  '[data-layout-inspector] [data-sortable-id="railArtifacts"] [data-row-grab]';

const SIDEBAR_PANELS =
  '[data-layout-inspector] [role="group"][aria-label="Sidebar panels"]';

/**
 * G3: while the editor customizes the rail the stacked pair's icon paints its
 * member count inside its own box; a click on the bottom member's row (it has
 * no icon of its own once stacked, so the row is its click target) rings the
 * GROUP's icon; Enter on the focused row toggles its selection once per press;
 * and Space grab-and-drop leaves it selected (the list's keydown takes Space,
 * so the button's native keyup click must not also select or clear it).
 */
async function assertGroupIconAndKeys(page: Page): Promise<void> {
  await configureCanvas(page, {
    tabs: "left",
    collapsed: false,
    dock: "right",
    session: true,
  });
  // Opens the Sidebar area (T3/T4's two-level form) with no row selected, so
  // the Panels list exists in the document to be read.
  await probe(page, 'openAreaOf("railAgents")');
  await waitUntil(
    page,
    `document.querySelector(${JSON.stringify(ARTIFACTS_ROW)}) !== null`,
  );
  await waitForFiniteAnimations(page);
  const violations = violationLog();
  const rail = await page.evaluate<RailGroupRead | null>(RAIL_GROUP_PROBE);
  if (rail === null || rail.groups.length !== 1) {
    violations.add(
      `${String(rail?.groups.length ?? 0)} groups on the rail, expected the one stacked pair`,
    );
  } else {
    const group = rail.groups[0];
    // The count is the pair's two members, painted on the icon's own box.
    if (group.count === null || group.count.text !== "2") {
      violations.add(
        `the group's count is ${group.count === null ? "missing" : `"${String(group.count.text)}"`}, expected "2"`,
      );
    } else if (group.button !== null) {
      const c = group.count.rect;
      const b = group.button;
      violations.check(
        c.width > 0 &&
          c.x >= b.x - 0.5 &&
          c.x + c.width <= b.x + b.width + 0.5 &&
          c.y >= b.y - 0.5 &&
          c.y + c.height <= b.y + b.height + 0.5,
        `the count ${boxText(c)} is not on its icon ${boxText(b)}`,
      );
    }
  }

  // Opening a row's disclosure selects its region (`toggleRow`), and the
  // selection rings the group's icon, the node that stands for it, never an
  // invisible selection.
  await page.evaluate(
    `document.querySelector(${JSON.stringify(ARTIFACTS_ROW)})?.scrollIntoView({ block: "center" })`,
  );
  await waitForStableBoxes(page, [ARTIFACTS_ROW], 3);
  const artifactsSelected = `(() => {
    const grab = document.querySelector(${JSON.stringify(ARTIFACTS_ROW)});
    const row = grab?.closest("[data-sortable-id]");
    return { selected: row?.getAttribute("data-sortable-selected") ?? null, pressed: grab?.getAttribute("aria-pressed") ?? null };
  })()`;
  const row = await requireRect(page, ARTIFACTS_ROW);
  await pressAt(page, row.cx, row.cy);
  await releasePointer(page);
  await expect
    .poll(
      () =>
        page.evaluate<{ selected: string | null; pressed: string | null }>(
          artifactsSelected,
        ),
      {
        message: "Artifacts row clicked: the row never read as selected",
      },
    )
    .toEqual({ selected: "1", pressed: "true" });
  // The ring lands on the group icon: `railAgents`, its top member. Where it
  // is clamped inside the window is `selection-ring.test.ts`'s (`insideWindow`).
  await waitUntil(
    page,
    `(() => { const ring = document.querySelector("[data-layout-selection-ring]"); return ring !== null && !ring.hidden && ring.getAttribute("data-on") === "1"; })()`,
  );
  await waitForStableBoxes(page, ["[data-layout-selection-ring]"], 4);
  const ring = await page.evaluate<{
    readonly ring: Box;
    readonly region: Box;
  } | null>(`(() => {
    const ring = document.querySelector("[data-layout-selection-ring]");
    const node = document.querySelector('[data-layout-region="railAgents"]');
    if (ring === null || node === null) return null;
    const a = ring.getBoundingClientRect();
    const b = node.getBoundingClientRect();
    const box = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 });
    return { ring: box(a), region: box(b) };
  })()`);
  if (ring === null) {
    violations.add("Artifacts selected: no ring or no group icon to compare");
  } else {
    // The ring stands `RING_PADDING` off its region, less what the window's
    // bleed clamp takes (at most `RING_BLEED`): every edge within their sum.
    const reach = RING_PADDING + RING_BLEED;
    const off = [
      Math.abs(ring.ring.x - ring.region.x),
      Math.abs(ring.ring.y - ring.region.y),
      Math.abs(
        ring.ring.x + ring.ring.width - (ring.region.x + ring.region.width),
      ),
      Math.abs(
        ring.ring.y + ring.ring.height - (ring.region.y + ring.region.height),
      ),
    ];
    violations.check(
      off.every((distance) => distance <= reach + 1.5),
      `Artifacts selected: the ring at ${boxText(ring.ring)} is not on the group icon ${boxText(ring.region)} (edges ${off.map((distance) => distance.toFixed(1)).join("/")}px off, at most ${String(reach)})`,
    );
  }
  // Enter on the focused grab toggles the selection exactly once per press:
  // from selected, one press clears and the next selects.
  const focusGrab = `document.querySelector(${JSON.stringify(ARTIFACTS_ROW)})?.focus()`;
  for (const expected of [null, "1"] as const) {
    await page.evaluate(focusGrab);
    await pressKey(page, "Enter");
    await expect
      .poll(
        async () =>
          (await page.evaluate<{ selected: string | null }>(artifactsSelected))
            .selected,
        {
          message: `Enter on the Artifacts row: expected selected=${String(expected)} (one toggle per press)`,
        },
      )
      .toBe(expected);
  }
  // Space in this ordered list grabs and drops the row (L-31). The list's
  // keydown takes it, so the button's native keyup click must not also select
  // or clear it: grab plus drop leaves the selection.
  await page.evaluate(focusGrab);
  for (let press = 0; press < 2; press += 1) {
    await pressKey(page, "Space");
    await nextFrames(page, 3);
  }
  const afterSpace = await page.evaluate<{ selected: string | null }>(
    artifactsSelected,
  );
  violations.check(
    afterSpace.selected === "1",
    `Space grab and drop on the Artifacts row changed its selection to ${String(afterSpace.selected)}`,
  );
  violations.assertNone("G3: the stacked pair's icon and its row's keys");
}

/**
 * A divider added with "+ Add divider" moves like any other row of the Sidebar
 * panels list: a REAL drag taken by its grip, and another by its line, each
 * one history step. The grip, the name and the line all sit inside the row's
 * grab `<button>`, which a guard refusing every press inside a button once made
 * undraggable. (The keyboard move is `sortable-list.test.tsx`'s.)
 */
async function assertDividerRowDrags(page: Page): Promise<void> {
  await configureCanvas(page, {
    tabs: "left",
    collapsed: false,
    dock: "right",
    session: true,
  });
  await probe(page, 'openAreaOf("railAgents")');
  await waitUntil(
    page,
    `document.querySelector(${JSON.stringify(SIDEBAR_PANELS)}) !== null`,
  );
  const order = (): Promise<readonly string[]> =>
    page.evaluate<readonly string[]>(
      `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR_PANELS} > [data-sortable-id]`)})].map((row) => row.getAttribute("data-sortable-id"))`,
    );
  const clicked = await page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll("[data-layout-inspector] button")].find((node) => node.textContent.trim() === "Add divider");
    button?.click();
    return button !== undefined;
  })()`);
  expect(
    clicked,
    "divider moves: the Sidebar panels list has no Add divider",
  ).toBe(true);
  await expect
    .poll(async () => (await order()).some((id) => id.startsWith("divider:")), {
      message: "divider moves: Add divider added no divider row",
    })
    .toBe(true);
  // Down past the panel below it by the grip, then back up by the line.
  for (const [part, step] of [
    ["[data-row-grip]", 1],
    ["[data-divider-rule]", -1],
  ] as const) {
    const rows = await order();
    const index = rows.findIndex((id) => id.startsWith("divider:"));
    const neighbour = rows.at(index + step);
    expect(
      index >= 0 && neighbour !== undefined,
      `divider moves: no divider with a row beside it in ${rows.join(", ")}`,
    ).toBe(true);
    const rowSelector = `${SIDEBAR_PANELS} > [data-sortable-id="${rows[index]}"]`;
    await page.evaluate(
      `document.querySelector(${JSON.stringify(rowSelector)})?.scrollIntoView({ block: "center" })`,
    );
    await waitForStableBoxes(page, [`${rowSelector} ${part}`], 3);
    const from = await requireRect(page, `${rowSelector} ${part}`);
    const past = await requireRect(
      page,
      `${SIDEBAR_PANELS} > [data-sortable-id="${neighbour}"]`,
    );
    const before = await historyDepth(page);
    await pressAt(page, from.cx, from.cy);
    await moveInSteps(page, {
      x: from.cx,
      y: step > 0 ? past.y + past.height - 2 : past.y + 2,
    });
    // The lift is read off the row's transform: a sortable row carries no
    // region or member id.
    await expect
      .poll(
        () =>
          page.evaluate<boolean>(
            `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR_PANELS} > [data-sortable-id]`)})].some((row) => row.style.transform !== "" && row.style.transform !== "none")`,
          ),
        {
          message: `divider moves: a real drag by its ${part} never lifted the row`,
        },
      )
      .toBe(true);
    await releasePointer(page);
    const expected = [...rows];
    expected.splice(index, 1);
    expected.splice(index + step, 0, rows[index]);
    await expect
      .poll(order, {
        message: `divider moves: dragged by its ${part}, the list did not settle at the expected order`,
      })
      .toEqual(expected);
    expect(
      await historyDepth(page),
      `divider moves: the drag by its ${part} was not one history step`,
    ).toBe(before + 1);
  }
}

// --- the two loads ----------------------------------------------------------

/**
 * `surface=epic` with the account row in the foot, opened with the sidebar
 * panel on `side`: the shell tests run against it, and the load is the
 * starting side a reload restores.
 */
function shellLoad(
  side: Side,
  extra: Readonly<Record<string, string | number>>,
): PageLoad {
  return canvasLoad(
    { tabs: "left", sidebar: side, surface: "epic", account: 1, ...extra },
    SHELL_READY,
  );
}

/** The tests that run on either load, for the panel's own side. */
function registerShellTests(getPage: () => Page, side: Side): void {
  const other: Side = side === "left" ? "right" : "left";

  test.beforeEach(async () => {
    await configureShell(getPage(), {
      tabs: "left",
      sidebar: side,
      collapsed: false,
    });
  });

  test(`the panel sits flush on the ${side}, and the chat body on its slot, on load and after a live flip and flipping back, under each tab placement`, async () => {
    const page = getPage();
    await assertFlip(page, side, `panel ${side}, on load`);
    for (const tabs of ["left", "right", "top"] as const) {
      await probe(page, `setTabPlacement(${JSON.stringify(tabs)})`);
      await settleShell(page);
      for (const [to, step] of [
        [other, "live flip"],
        [side, "live flip back"],
      ] as const) {
        await probe(page, `setSidebarSide(${JSON.stringify(to)})`);
        await settleShell(page);
        await assertFlip(page, to, `tabs ${tabs}, panel ${side}, ${step}`);
      }
    }
  });

  test(`the panel and the content frame touch, the frame is flush to the window, and every width handle is the hit at its boundary (panel ${side})`, async () => {
    const page = getPage();
    for (const tabs of ["left", "right", "top"] as const) {
      await probe(page, `setTabPlacement(${JSON.stringify(tabs)})`);
      await settleShell(page);
      await eventually(`sheets, tabs ${tabs}, panel ${side}`, () =>
        sheetsProblems(page),
      );
    }
  });

  test(`a strip switch, the header trade, the strip's collapse and width drag and the panel's collapse to its rail keep the chat body on its slot (panel ${side})`, async () => {
    const page = getPage();
    const tokens = await stripTokens(page);
    await runMoves(page, side, tokens.stripRailWidthPx);
  });
}

test.describe("the shell with the panel loaded on the left", () => {
  const getPage = sharedPage(shellLoad("left", { hosts: 1, warm: 1 }));
  registerShellTests(getPage, "left");

  test("the joined row paints the panel's fill across the gap and the seam, and not past its corners, with the bridge level, then the same for the collapsed tile", async () => {
    const page = getPage();
    await assertJoinPaint(
      page,
      "left",
      "panel",
      "left strip, panel left, expanded",
    );
    // The strip on its rail: the tile joins the same panel, the panel's fill.
    await probe(page, "setCollapsed(true)");
    await settleShell(page);
    await assertJoinPaint(
      page,
      "left",
      "panel",
      "left strip on its rail, panel left",
    );
    // The panel on its own 48px rail: the tile joins that rail's fill.
    await probe(page, "setPanelCollapsed(true)");
    await settleShell(page);
    await assertJoinPaint(
      page,
      "left",
      "rail",
      "left strip on its rail, panel on its rail",
    );
  });

  test("with the panel on the far side the row joins the canvas instead", async () => {
    const page = getPage();
    await probe(page, 'setSidebarSide("right")');
    await settleShell(page);
    await assertJoinPaint(
      page,
      "left",
      "canvas",
      "left strip, panel right, expanded",
    );
  });

  test("the resize handle stays the hit where the bridge crosses it, and its hover line is drawn under the bridge", async () => {
    const page = getPage();
    await settleShell(page);
    const before = await readJoin(page);
    expect(before.joined, "no row is joined").not.toBeNull();
    expect(before.handle, "no resize handle").not.toBeNull();
    if (before.joined === null || before.handle === null) return;
    const row = before.joined.rect;
    const x = before.handle.cx;
    const fill = await resolveRgb(
      page,
      `var(${paneFillToken(before.joined.pane === "rail" ? "rail" : "panel")})`,
    );
    await moveTo(page, x, row.cy);
    await expect
      .poll(
        () =>
          page.evaluate<boolean>(
            `document.querySelector('[data-testid="side-tab-strip-resize-handle"]').matches(":hover")`,
          ),
        {
          message:
            "the resize handle is not the hit where the bridge crosses it",
        },
      )
      .toBe(true);
    await waitForFiniteAnimations(page);
    const pixel = await samplePixelAt(page, x, row.cy);
    expect(
      sameRgb(pixel, fill, 3),
      `the hovered handle's line cuts the joined band at x=${x.toFixed(1)}: ${rgbText(pixel)}, fill ${rgbText(fill)}`,
    ).toBe(true);
  });

  test("a row cut by the list's edge is a plain active row, and joins again once wholly back in view", async () => {
    const page = getPage();
    await setWindowHeight(page, 340);
    await settleShell(page);
    const overflow = await page.evaluate<number>(
      `(() => { const list = document.querySelector(${JSON.stringify(STRIP_LIST)}); return list.scrollHeight - list.clientHeight; })()`,
    );
    expect(
      overflow,
      `the row list does not overflow at 340px (${String(overflow)}px), so the scrolled-out case is not measured`,
    ).toBeGreaterThanOrEqual(40);
    // Half of the active row past the list's bottom edge, beside the foot.
    await page.evaluate(`(() => {
      const list = document.querySelector(${JSON.stringify(STRIP_LIST)});
      const row = document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]');
      const r = row.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      list.scrollTop += r.y + r.height / 2 - (l.y + l.height);
    })()`);
    await expect
      .poll(async () => (await readJoin(page)).joined, {
        message: "a row cut by the list's edge is still joined",
      })
      .toBeNull();
    await waitForFiniteAnimations(page);
    const cut = await readJoin(page);
    const violations = violationLog();
    violations.check(
      cut.bridge === null,
      `the bridge paints at ${cut.bridge === null ? "-" : boxText(cut.bridge)} for a row cut by the list's edge`,
    );
    if (cut.strip === null || cut.list === null || cut.panel === null) {
      violations.add("no strip, list or panel to measure the cut row against");
    } else {
      const gapX = (cut.strip.x + cut.strip.width + cut.panel.x) / 2;
      const fill = await resolveRgb(page, `var(${paneFillToken("panel")})`);
      const listBottom = cut.list.y + cut.list.height;
      const cutRow = await page.evaluate<{ y: number; bottom: number }>(
        `(() => { const r = document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]').getBoundingClientRect(); return { y: r.y, bottom: r.y + r.height }; })()`,
      );
      violations.check(
        cutRow.y < listBottom && cutRow.bottom > listBottom,
        `the active row [${cutRow.y.toFixed(0)}, ${cutRow.bottom.toFixed(0)}] is not cut by the list's bottom edge at ${listBottom.toFixed(0)}`,
      );
      // A row cut by the list's edge is unjoined: its would-be fill does not
      // bleed into the strip's own chrome around the list.
      for (const [where, y] of [
        ["beside the row's visible half", listBottom - 4],
        ["beside the foot", listBottom + 4],
      ] as const) {
        const pixel = await samplePixelAt(page, gapX, y);
        violations.check(
          !sameRgb(pixel, fill, 3),
          `the gap ${where} (y=${y.toFixed(0)}) reads as the pane's fill ${rgbText(fill)}, but nothing should be joined here`,
        );
      }
    }
    violations.assertNone("D3: a row scrolled part out");
    await page.evaluate(
      `document.querySelector('[data-testid="side-tab-strip"] [data-side-tab][data-active="true"]').scrollIntoView({ block: "nearest" })`,
    );
    await expect
      .poll(
        async () => {
          const back = await readJoin(page);
          return back.joined !== null && back.bridge !== null;
        },
        { message: "the row did not join again once wholly back in the list" },
      )
      .toBe(true);
  });

  test("the bridge is level with its row once a real reorder has settled", async () => {
    const page = getPage();
    await settleShell(page);
    const epsilon = await rowRect(page, "epic:fixture-epsilon");
    const delta = await rowRect(page, "epic:fixture-delta");
    await pressAt(page, epsilon.cx, epsilon.cy);
    await moveInSteps(page, { x: epsilon.cx, y: delta.cy - 8 });
    await nextFrames(page, 6);
    await releasePointer(page);
    await expect
      .poll(async () => (await rowRect(page, "epic:fixture-epsilon")).y, {
        message: "the reorder did not move Epsilon",
      })
      .toBeLessThan(epsilon.y - 1);
    await settleShell(page);
    await eventually("join after the reorder", async () => {
      const read = await readJoin(page);
      if (read.joined === null || read.bridge === null) {
        return ["after the reorder nothing is joined"];
      }
      return Math.abs(read.bridge.y - read.joined.rect.y) > 0.5 ||
        Math.abs(read.bridge.height - read.joined.rect.height) > 0.5
        ? [
            `the bridge ${boxText(read.bridge)} is not level with its row ${boxText(read.joined.rect)}`,
          ]
        : [];
    });
  });

  test("the waiting pulse is painted past the last row at the list's scrolled edge", async () => {
    const page = getPage();
    // The panel on the far side, so no tile is joined.
    await probe(page, 'setSidebarSide("right")');
    await setIndicators(page, RAIL_INDICATORS);
    await setWindowHeight(page, 420);
    await settleShell(page);
    await page.evaluate(
      `(() => { const list = document.querySelector(${JSON.stringify(STRIP_LIST)}); list.scrollTop = list.scrollHeight; })()`,
    );
    await settleShell(page);
    const zeta = await rowRect(page, "epic:fixture-zeta");
    const list = await requireRect(page, STRIP_LIST);
    const spot = { x: zeta.cx, y: zeta.y + zeta.height + 2 };
    const quiet = await samplePixelAt(page, spot.x, spot.y);
    await setIndicators(page, RAIL_INDICATORS_WITH_ZETA_WAITING);
    // Held a third into its first ring: the spread is past 2px and the colour still shows.
    await waitUntil(
      page,
      `(() => {
        const row = document.querySelector('[data-testid="tab-close-epic-fixture-zeta"]').closest("[data-side-tab]");
        return row.getAnimations().some((animation) => animation.animationName === "side-strip-waiting-pulse");
      })()`,
    );
    const held = await page.evaluate<number>(`(() => {
      const row = document.querySelector('[data-testid="tab-close-epic-fixture-zeta"]').closest("[data-side-tab]");
      const rings = row.getAnimations().filter((animation) => animation.animationName === "side-strip-waiting-pulse");
      for (const ring of rings) { ring.pause(); ring.currentTime = 200; }
      return rings.length;
    })()`);
    await nextFrames(page, 2);
    const pulsing = await samplePixelAt(page, spot.x, spot.y);
    await page.evaluate(
      `document.querySelector('[data-testid="tab-close-epic-fixture-zeta"]').closest("[data-side-tab]").getAnimations().forEach((animation) => animation.finish())`,
    );
    expect(held, "Zeta going into waiting started no pulse").toBeGreaterThan(0);
    const room = list.y + list.height - (zeta.y + zeta.height);
    expect(
      room,
      `the last row ends ${room.toFixed(1)}px above the list's clip, less than the pulse's ${String(WAITING_PULSE_SPREAD)}px spread`,
    ).toBeGreaterThanOrEqual(WAITING_PULSE_SPREAD - 0.5);
    note(
      `pulse below the last row: ${rgbText(quiet)} -> ${rgbText(pulsing)}, ${room.toFixed(1)}px to the list's clip`,
    );
    expect(
      sameRgb(quiet, pulsing, 6),
      `the pulse is not painted 2px below the last row (${rgbText(pulsing)}, quiet ${rgbText(quiet)}): the list clips it`,
    ).toBe(false);
  });

  test("the rail is one centred column with an even rhythm, on each edge, and the divider reads in both themes", async () => {
    const page = getPage();
    for (const edge of ["left", "right"] as const) {
      await assertStripTop(page, { edge, collapsed: true, session: "browser" });
    }
  });

  test("the expanded top block lines New Task up with Home, and every meter and monogram sits in its row, on each edge", async () => {
    const page = getPage();
    for (const edge of ["left", "right"] as const) {
      await assertStripTop(page, {
        edge,
        collapsed: false,
        session: "browser",
      });
    }
  });

  test("a held handle across the snap point switches the layout live under a captured pointer, both ways", async () => {
    const page = getPage();
    await probe(page, 'setStripView("activity")');
    await setActivity(page);
    await settleShell(page);
    const tokens = await stripTokens(page);
    await assertHeldPointerSnap(page, {
      edge: "left",
      railWidth: tokens.stripRailWidthPx,
    });
  });

  test("the crossing eases with the panel motion token, and Escape, a release and reduced motion land at once", async () => {
    const page = getPage();
    await probe(page, 'setStripView("activity")');
    await setActivity(page);
    await settleShell(page);
    const tokens = await stripTokens(page);
    await assertCrossingEase(page, {
      edge: "left",
      railWidth: tokens.stripRailWidthPx,
      minWidth: tokens.stripMinWidthPx,
      snapBelow: tokens.stripSnapToRailBelowPx,
    });
  });

  test("the active task's agents nest under its row and inside the strip, their guide on its title start edge", async () => {
    const page = getPage();
    await probe(page, 'setStripView("activity")');
    await setActivity(page);
    await assertLiveAgents(page);
  });

  test("the stacked pair's icon counts its members inside its own box, its bottom member's row rings that icon, and Enter and Space act once", async () => {
    await assertGroupIconAndKeys(getPage());
  });

  test("a divider moves by a real drag on its grip and on its rule, each one history step", async () => {
    await assertDividerRowDrags(getPage());
  });

  test("the account menu opens on one click toward the content, inside the window and no wider than 256px, and a long offline host name truncates and reads in full from its tooltip", async () => {
    const page = getPage();
    await openHostMenu(page);
    expect(
      await hostMenuProblems(page, "right"),
      "G4: the account menu on a left strip",
    ).toEqual([]);
    // The tooltip on the offline row: the longest name, the row a click does
    // not act on. Waited on as the node the tooltip is, not as a delay.
    const offline = HOST_ROWS[1];
    const rows = await readHostRows(page);
    const row = rows?.find((entry) => entry.hostId === offline.hostId);
    expect(row, `no ${offline.hostId} row`).toBeDefined();
    if (row === undefined || offline.fullName === null) return;
    await moveTo(page, row.box.x + 40, row.box.cy);
    await expect
      .poll(
        () =>
          page.evaluate<string>(
            `document.querySelector('[role="tooltip"]')?.textContent ?? ""`,
          ),
        {
          message: `hovering ${offline.hostId}'s name shows no tooltip with its full name`,
        },
      )
      .toContain(offline.fullName);
    // The tooltip is its own dismissable layer and would take the Escape: the
    // pointer leaves the row first.
    await moveTo(page, 1, 1);
    await waitUntil(
      page,
      `document.querySelector('[role="tooltip"]') === null`,
    );
    await pressKey(page, "Escape");
    await waitUntil(
      page,
      `document.querySelector('[data-testid="user-menu-content"]') === null`,
    );
  });
});

test.describe("the shell with the panel loaded on the right", () => {
  const getPage = sharedPage(
    shellLoad("right", { hosts: 1, readings: "both", warm: 1 }),
  );
  registerShellTests(getPage, "right");

  test("the joined row paints the panel's fill across the gap and the seam on a right strip too", async () => {
    const page = getPage();
    await probe(page, 'setTabPlacement("right")');
    await settleShell(page);
    await assertJoinPaint(
      page,
      "right",
      "panel",
      "right strip, panel right, expanded",
    );
  });

  test("a held handle across the snap point switches the layout live on a right strip too", async () => {
    const page = getPage();
    await probe(page, 'setTabPlacement("right")');
    await probe(page, 'setStripView("activity")');
    await setActivity(page);
    await settleShell(page);
    const tokens = await stripTokens(page);
    await assertHeldPointerSnap(page, {
      edge: "right",
      railWidth: tokens.stripRailWidthPx,
    });
  });

  test("the crossing eases, and Escape, a release and reduced motion land at once, on a right strip too", async () => {
    const page = getPage();
    await probe(page, 'setTabPlacement("right")');
    await probe(page, 'setStripView("activity")');
    await setActivity(page);
    await settleShell(page);
    const tokens = await stripTokens(page);
    await assertCrossingEase(page, {
      edge: "right",
      railWidth: tokens.stripRailWidthPx,
      minWidth: tokens.stripMinWidthPx,
      snapBelow: tokens.stripSnapToRailBelowPx,
    });
  });

  test("the hover card and the Notifications drawer sit inside the window, the drawer flush with the sheets, on the right edge", async () => {
    const page = getPage();
    await probe(page, 'setTabPlacement("right")');
    await settleShell(page);
    await assertOverlays(page);
  });

  test("the stacked pair's icon counts its members and its row rings that icon with the panel on the right", async () => {
    const page = getPage();
    await assertGroupIconAndKeys(page);
  });

  test("two readings split the foot's row in equal halves and one takes it all, no reading is cut and a restyled usage still fits, on each edge", async () => {
    const page = getPage();
    for (const edge of ["left", "right"] as const) {
      for (const readings of ["both", "usage", "resource"] as const) {
        const label = `${edge} ${readings}`;
        await configureShell(page, {
          tabs: edge,
          sidebar: "right",
          collapsed: false,
        });
        await probe(page, `setReadings(${JSON.stringify(readings)})`);
        await waitForReadings(page, readings, false);
        await settleShell(page);
        const full = readings !== "both";
        await eventually(`readings ${label}`, async () => {
          const read = await readReadings(page);
          return [
            ...readingsRowProblems(read, readings),
            ...wholeReadingProblems(read),
            ...(full && readings === "resource"
              ? fullWidthShowsMoreProblems(read.resourceReadings, "resource")
              : []),
          ];
        });
        const settled = await readReadings(page);
        note(
          `${label}: row ${settled.row === null ? "-" : boxText(settled.row)}, usage ${settled.usage === null ? "-" : boxText(settled.usage)}, resources ${settled.resource === null ? "-" : boxText(settled.resource)}`,
        );
        // Usage draws the status bar's own readings, so how many fit is its
        // Style's to say (G6): the shipped Style spells the reset time out.
        // Under a compact one, half width shows the first reading (bar only)
        // and full width more than one (bar and percent).
        if (readings !== "resource") {
          const compact = full ? "barPercent" : "barOnly";
          await probe(page, `applyUsageStyle(${JSON.stringify(compact)})`);
          await eventually(
            `readings ${label}, restyled ${compact}`,
            async () => {
              const read = await readReadings(page);
              return [
                ...restyledUsageProblems(read),
                ...(full
                  ? fullWidthShowsMoreProblems(read.usageReadings, "usage")
                  : []),
              ];
            },
          );
        }
      }
    }
  });

  test("collapsed, the readings stack as rail-wide tiles centred on the rail above the avatar, on each edge", async () => {
    const page = getPage();
    for (const edge of ["left", "right"] as const) {
      await configureShell(page, {
        tabs: edge,
        sidebar: "right",
        collapsed: true,
      });
      await waitForReadings(page, "both", true);
      await settleShell(page);
      await eventually(`collapsed readings, ${edge}`, async () =>
        collapsedReadingsProblems(await readReadings(page)),
      );
    }
  });

  test("each reading's popover opens toward the content and inside the window, on each edge", async () => {
    const page = getPage();
    for (const edge of ["left", "right"] as const) {
      await configureShell(page, {
        tabs: edge,
        sidebar: "right",
        collapsed: false,
      });
      await waitForReadings(page, "both", false);
      await settleShell(page);
      const keys: readonly ReadingsKey[] = ["usage", "resource"];
      for (const key of keys) {
        expect(
          await readingPopoverProblems(page, key, edge),
          `the ${key} popover on the ${edge} strip`,
        ).toEqual([]);
      }
    }
  });

  test("the account menu opens toward the content on a right strip too, inside the window and no wider than 256px", async () => {
    const page = getPage();
    await configureShell(page, {
      tabs: "right",
      sidebar: "right",
      collapsed: false,
    });
    await openHostMenu(page);
    expect(
      await hostMenuProblems(page, "left"),
      "G4: the account menu on a right strip",
    ).toEqual([]);
    await pressKey(page, "Escape");
    await waitUntil(
      page,
      `document.querySelector('[data-testid="user-menu-content"]') === null`,
    );
  });
});

// The strip's top block under a macOS traffic-light title band: the one
// placement whose structure differs (the left strip's top block sits beside the
// window controls), so it is the one that loads with `wco=mac`.
test.describe("the strip's top block under a macOS title band", () => {
  const getPage = sharedPage(
    canvasLoad(
      {
        tabs: "left",
        sidebar: "left",
        wco: "mac",
        surface: "epic",
        account: 1,
      },
      SHELL_READY,
    ),
  );

  test("the rail is one centred column with an even rhythm on a left strip beside the traffic lights, and the divider reads in both themes", async () => {
    await assertStripTop(getPage(), {
      edge: "left",
      collapsed: true,
      session: "mac",
    });
  });

  test("the expanded top block lines New Task up with Home on a left strip beside the traffic lights", async () => {
    await assertStripTop(getPage(), {
      edge: "left",
      collapsed: false,
      session: "mac",
    });
  });
});
