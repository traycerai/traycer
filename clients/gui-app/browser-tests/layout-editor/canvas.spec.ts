import { expect, test, type Page } from "@playwright/test";

import {
  canvasLoad,
  configureCanvas,
  historyDepth,
  probe,
  probeValue,
  waitForShell,
  type CanvasConfig,
} from "../support/layout-editor/canvas.ts";
import {
  boxText,
  insideViewport,
  note,
  rectOf,
  requireRect,
  sameBoxWithin,
  viewportOf,
  violationLog,
  type Box,
  type ViolationLog,
} from "../support/layout-editor/dom.ts";
import {
  clickAt,
  dragPointer,
  moveInSteps,
  moveTo,
  pressAt,
  pressKey,
  releasePointer,
  waitForDropSettled,
  type DragSibling,
  type MidDrag,
} from "../support/layout-editor/input.ts";
import { layoutEditorUse, sharedPage } from "../support/layout-editor/pages.ts";
import {
  countLit,
  sampleAmber,
  type LitCount,
} from "../support/layout-editor/pixels.ts";
import {
  becomesTruthy,
  waitForFiniteAnimations,
  waitForStableBox,
  waitForStableBoxes,
  waitUntil,
} from "../support/layout-editor/waits.ts";
import { nextFrames } from "../support/fixtures.ts";

// THE LAYOUT EDITOR'S CANVAS INTERACTION REGRESSION (L-115 .. L-135), and the
// live placement switch (A14).
//
// One page: `layout-editor-canvas.html` at its defaults (the sample workspace
// under the top placement), driven with REAL mouse input. It exists because
// three review gates and thousands of jsdom tests passed while that scene was
// wrapped in `inert`: jsdom has no hit testing, no layout and no paint order,
// so nothing below is decidable there.
//
//   A3. Nothing (`inert`, an overlay, a sibling) sits over a region where it
//       takes input: the element at every region's centre answers for that
//       region, and a real `mouseMoved` onto a few of them stamps
//       `data-hover` and raises the name chip.
//   A4. A real click selects, opens that region's inspector section, and the
//       APP does not act: no menu, no popover, no file chooser, no panel
//       toggled.
//   A5. Real drags - a toolbar member leftwards past the cluster's narrow
//       leading member (L-143), a rail icon across a divider (the tight
//       geometry of L-143 and L-150), and the clamp - each read back off the
//       layout store as exactly one history step, with
//       `[data-layout-dragging]` and a reflowing sibling measured mid-gesture.
//   A8. A real right-click opens the quick-verb menu on a region at rest,
//       where the region's named element is `display: contents` and has no box
//       of its own (L-129, L-19).
//   A9. The editing frame is counted in PIXELS off a screenshot, within 3 CSS
//       px of each of the column's four edges - including the top edge under
//       the opaque positioned header, which is the exact place the pre-L-130
//       outline was painted under (LV2-04). Its inset and radius are asserted
//       against L-137's numbers rather than merely read, and each of the four
//       corners is checked for the square join an arc cannot draw.
//   A14. A real click on Position "Left" moves the strip in one frame as one
//       history step, and one undo restores the top.
//   D14/T09. The tab strip and the sidebar are each selected by their own
//       space, the placement bar sits beside them (never over them) with its
//       pictograms checked on the current edge, a pictogram writes the edge,
//       and a real drag lights every drop zone (the current one marked, the
//       one under the pointer lit) and writes the band it is released over.
//
// The canvas fixture mounts the shell's own `AppColumnFrame`; all of it runs
// at the `top` placement except A14, which switches it live.
//
// Not here, because a jsdom test decides it: the ghost a hidden region leaves
// under a hover on the inspector's index row - A6's Microphone and A7's
// Hidden + Chip dock member (`use-layout-region.test.tsx`, "a hidden region's
// ghost"); the selection ring following a region that MOVED
// (`selection-ring.test.ts`, "follows a region that MOVED"); the editor's own
// tab filled with the editing colour (`tab-strip.test.tsx`, "fills the
// editor's own tab"); the swallowed gestures and the right-clicks that get
// through (`edit-firewall.test.ts`, `region-quick-verbs.test.tsx`); and the
// fixture's own coverage tables.

test.use(layoutEditorUse());

const SESSION_AT_TOP: CanvasConfig = {
  tabs: "top",
  collapsed: false,
  dock: "right",
  session: true,
};

test.describe("the canvas at the top placement", () => {
  const getPage = sharedPage(
    canvasLoad({}, 'document.querySelector("[data-sample-turn]") !== null'),
  );

  test.beforeEach(async () => {
    await configureCanvas(getPage(), SESSION_AT_TOP);
  });

  // --- A3 -------------------------------------------------------------------

  test("nothing sits over a region where it takes input, and a real pointer over one hovers it and raises its chip", async () => {
    const page = getPage();
    const regions = await mountedRegions(page);
    await waitForStableBoxes(
      page,
      regions.map((regionId) => regionSelector(regionId)),
      3,
    );

    // The hit test: the element at each region's centre answers for that
    // region. An `inert` subtree, an overlay or a sibling region painted over
    // it would answer for something else, and the canvas resolves hover and
    // selection off exactly this element (`regionNodeUnder`).
    const swept = await page.evaluate<
      ReadonlyArray<{
        readonly regionId: string;
        readonly error: string | null;
        readonly x: number;
        readonly y: number;
        readonly owner: string | null;
        readonly hit: string;
      }>
    >(`(() => {
      const regions = ${JSON.stringify(regions.map((regionId) => ({ regionId, selector: regionSelector(regionId) })))};
      return regions.map(({ regionId, selector }) => {
        const node = document.querySelector(selector);
        if (node === null) return { regionId, error: "no node", x: 0, y: 0, owner: null, hit: "" };
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return { regionId, error: "the region has no box", x: 0, y: 0, owner: null, hit: "" };
        }
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        const owner = hit === null ? null : hit.closest("[data-layout-region], [data-layout-region-part]");
        return {
          regionId,
          error: null,
          x,
          y,
          owner: owner === null ? null : (owner.getAttribute("data-layout-region") ?? owner.getAttribute("data-layout-region-part")),
          hit: hit === null ? "nothing" : hit.tagName + "." + String(hit.getAttribute("class") ?? "").slice(0, 60),
        };
      });
    })()`);
    const violations = violationLog();
    for (const entry of swept) {
      if (entry.error !== null) {
        violations.add(`A3 ${entry.regionId}: ${entry.error}`);
        continue;
      }
      violations.check(
        entry.owner === entry.regionId,
        `A3 ${entry.regionId}: the element at its centre (${entry.x.toFixed(0)}, ${entry.y.toFixed(0)}) answers for ${String(entry.owner)} (${entry.hit}), so a real pointer never reaches it`,
      );
    }
    violations.assertNone("A3: something covers a region");

    // The pipeline end to end, with real moves onto three regions of three
    // kinds: a rail icon, a composer control and a dock member. The sweep
    // above is what makes each of the twenty one of them work.
    for (const regionId of ["railBrowsers", "mic", "changedFiles"]) {
      const box = await requireRect(page, regionSelector(regionId));
      await moveTo(page, box.cx, box.cy);
      await expect
        .poll(async () => (await hoverOf(page, regionId)).hover, {
          message: `A3 ${regionId}: a real mouseMoved onto (${box.cx.toFixed(0)}, ${box.cy.toFixed(0)}) left data-hover unset`,
        })
        .toBe("1");
      const hover = await hoverOf(page, regionId);
      expect(
        hover.chipHidden || !hover.chipOnScreen,
        `A3 ${regionId}: no name chip on screen (hidden=${String(hover.chipHidden)})`,
      ).toBe(false);
    }
  });

  // --- A4 -------------------------------------------------------------------

  test("a real click selects a region and opens its section, and the app does not act", async () => {
    const page = getPage();
    // The regions whose app control does something on a press: the file
    // chooser, the model and permission menus, the dictation toggle, a rail
    // panel, and a dock member.
    const clicked = [
      "attachImage",
      "model",
      "access",
      "mic",
      "railBrowsers",
      "changedFiles",
    ];
    const names = await probeValue<Readonly<Partial<Record<string, string>>>>(
      page,
      "names",
    );
    // A chooser is a Chrome event the DOM cannot answer, so it is counted.
    const choosers: string[] = [];
    page.on("filechooser", () => {
      choosers.push("filechooser");
    });
    const violations = violationLog();
    for (const regionId of clicked) {
      const box = await requireRect(page, regionSelector(regionId));
      await moveTo(page, box.cx, box.cy);
      await nextFrames(page, 2);
      const before = await page.evaluate<AppActed>(APP_ACTED_PROBE);
      const choosersBefore = choosers.length;
      await clickAt(page, box.cx, box.cy, "left");
      // The positive event first: the press landed as a selection. What the
      // app might have done in answer arrives in the same frames, so the
      // negatives below are read after it.
      const landed = await becomesTruthy(
        page,
        `document.querySelector(${JSON.stringify(regionSelector(regionId))})?.getAttribute("data-selected") === "1"`,
        3_000,
      );
      await nextFrames(page, 3);
      const after = await page.evaluate<AppActed>(APP_ACTED_PROBE);
      const selected = await page.evaluate<{
        readonly selected: string | null;
        readonly atIndex: boolean;
        readonly inspectorText: string;
      }>(selectionProbe(regionId));
      violations.check(
        landed && selected.selected === "1",
        `A4 ${regionId}: a real click at (${box.cx.toFixed(0)}, ${box.cy.toFixed(0)}) left data-selected=${String(selected.selected)}`,
      );
      if (selected.atIndex) {
        violations.add(
          `A4 ${regionId}: the inspector is still on its index, so the click opened no section`,
        );
      } else {
        violations.check(
          selected.inspectorText.includes(names[regionId] ?? ""),
          `A4 ${regionId}: the inspector section does not name it; it reads "${selected.inspectorText.slice(0, 120)}"`,
        );
      }
      violations.check(
        after.layers === 0,
        `A4 ${regionId}: the click opened ${String(after.layers)} menu/dialog/popover layer(s) - the app acted`,
      );
      const expandedChanged = changedCount(before.expanded, after.expanded);
      const statesChanged = changedCount(before.states, after.states);
      violations.check(
        expandedChanged === 0 && statesChanged === 0,
        `A4 ${regionId}: the click toggled an app control (aria-expanded changed on ${String(expandedChanged)} of ${String(before.expanded.length)}, data-state on ${String(statesChanged)} of ${String(before.states.length)})`,
      );
      violations.check(
        choosers.length === choosersBefore,
        `A4 ${regionId}: the click opened a file chooser`,
      );
    }
    violations.assertNone("A4: a click was not swallowed or did not select");
  });

  // --- A5 -------------------------------------------------------------------

  test("a real drag of a toolbar member leftwards past the cluster's leading member is one history step", async () => {
    // The leftward drag is the case this once had to reverse: a member
    // claimed a slot only when its CENTRE passed the neighbour's, and the
    // clamp keeps it inside its cluster, so a WIDE member pulled in front of a
    // narrower one at the cluster's leading edge could never get its centre
    // far enough left. Measured on this composer: `access` is 120px wide at x
    // 274.5, `attachImage` is at x 242.5, and the cluster ends at 394.5, so
    // the furthest left `access` could be dropped put its centre at 302.5
    // while `attachImage`'s is 256.5, and the drop was refused however hard
    // the pointer pulled. The slot is claimed by the LEADING EDGE now, which
    // `access` gets past 256.5 at an offset of -18, well inside the clamp's
    // 32px of travel - so this is the gesture that has to stay possible.
    const page = getPage();
    await probe(page, "reset()");
    const arrangement = await arrangementOf(page);
    const first = arrangement.toolbarLeft.at(0);
    const last = arrangement.toolbarLeft.at(-1);
    expect(
      first !== undefined && last !== undefined && first !== last,
      "the composer toolbar's left cluster has fewer than two members, so there is nothing to reorder",
    ).toBe(true);
    if (first === undefined || last === undefined) return;
    await runDrag(page, {
      id: "toolbar member leftwards past the cluster's leading member",
      memberId: last,
      memberSelector: regionSelector(last),
      siblingSelector: regionSelector(first),
      target: {
        kind: "member",
        selector: regionSelector(first),
        dx: -DROP_OVERSHOOT,
        dy: 0,
        leadingEdge: false,
      },
      expect: {
        kind: "order",
        group: "toolbarLeft",
        ids: placedBeside(arrangement.toolbarLeft, last, first, false),
      },
    });
  });

  test("a real drag of a rail icon across a divider is one history step", async () => {
    // The tight geometry, on the rail as it is measured: the Agents group 0..36
    // (a stacked pair draws one icon, G3), a 4px gap, the 8px divider at
    // 40..48, a 4px gap, Terminals 52..88. Terminals' top edge is aimed at 44 -
    // 18 = 26 and the pointer placed half a member behind it, at 44, so the
    // pointer travels 26 and the member 20 (`drag-engine.ts` takes its grab
    // point at the move that crosses the 6px activation distance). Both the
    // claim boundary (`drag-model.ts` claims by the LEADING EDGE) and the 12px
    // travel floor (L-150(4)) are cleared, and one gesture claims one slot.
    const page = getPage();
    await probe(page, "reset()");
    await probe(page, "addRailDivider()");
    await runDrag(page, {
      id: "rail icon across a divider",
      memberId: "railTerminals",
      memberSelector: regionSelector("railTerminals"),
      siblingSelector: '[data-layout-member="divider:1"]',
      target: {
        kind: "member",
        selector: '[data-layout-member="divider:1"]',
        // The sample sidebar is expanded, so its rail runs horizontally (F3).
        dx: -DROP_OVERSHOOT,
        dy: 0,
        // A 36px icon against an 8px divider: the overshoot has to be
        // measured on the edge that claims the slot, or the icon passes the
        // PANEL before the divider too (L-143).
        leadingEdge: true,
      },
      expect: { kind: "rail", ids: TERMINALS_ABOVE_THE_DIVIDER },
    });
  });

  test("a rail icon pulled far outside its column is clamped, and a clamped drag writes nothing", async () => {
    const page = getPage();
    await probe(page, "reset()");
    await runDrag(page, {
      id: "the clamp: a rail icon pulled far outside the column",
      memberId: "railComments",
      memberSelector: regionSelector("railComments"),
      siblingSelector: null,
      // The expanded sample sidebar's rail runs horizontally (F3).
      target: { kind: "viewport", dx: -60, dy: 300, axis: "x" },
      expect: { kind: "none" },
    });
  });

  // --- A8 -------------------------------------------------------------------

  test("a real right-click on the mic at rest opens the quick-verb menu, though its named element has no box", async () => {
    const page = getPage();
    const names = await probeValue<Readonly<Partial<Record<string, string>>>>(
      page,
      "names",
    );
    const mic = names.mic ?? "Microphone";
    // In a session first: the baseline the at-rest click has to equal.
    const micBox = await requireRect(page, regionSelector("mic"));
    const inSession = await rightClickMenu(page, micBox.cx, micBox.cy);
    expect(
      inSession.open,
      "A8: a real right-click on the mic INSIDE a session opened no [role=menu]",
    ).toBe(true);
    expect(
      inSession.text,
      `A8: the in-session menu does not name Microphone; it reads "${inSession.text.slice(0, 120)}"`,
    ).toContain(mic);
    await dismissLayers(page);

    await probe(page, "endSession()");
    await waitUntil(
      page,
      'document.querySelector("[data-layout-inspector]") === null',
    );
    await nextFrames(page, 2);
    // Not the named element's own rect: outside a session `ComposerMicSlot`
    // draws its wrapper `display: contents`, so the element that CARRIES the
    // region name has no box at all. That is the shipped shape (the box only
    // exists while the ring and the hover outline need one), and the product
    // still resolves the region because the menu walks `closest` up from the
    // real control - which is what this point has to be on.
    const atRestPoint = await page.evaluate<{
      readonly x: number;
      readonly y: number;
      readonly boxless: boolean;
    } | null>(`(() => {
      const node = document.querySelector(${JSON.stringify(regionSelector("mic"))});
      if (node === null) return null;
      const boxOf = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      };
      const own = boxOf(node);
      const rect = own ?? [...node.querySelectorAll("*")].map(boxOf).find((candidate) => candidate !== null) ?? null;
      if (rect === null) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, boxless: own === null };
    })()`);
    expect(
      atRestPoint,
      "A8: the mic lost its region name when the session ended, so a right-click at rest can no longer resolve it (L-129)",
    ).not.toBeNull();
    if (atRestPoint === null) return;
    expect(
      atRestPoint.boxless,
      "A8: the mic's named element has a box at rest, so this no longer exercises the display: contents path (L-129)",
    ).toBe(true);
    const atRest = await rightClickMenu(page, atRestPoint.x, atRestPoint.y);
    expect(
      atRest.open,
      "A8: a real right-click on the mic AT REST opened no [role=menu] (L-19)",
    ).toBe(true);
    expect(
      atRest.text,
      `A8: the at-rest menu does not name Microphone; it reads "${atRest.text.slice(0, 120)}"`,
    ).toContain(mic);
    await dismissLayers(page);
  });

  // --- A9 -------------------------------------------------------------------

  test("the editing frame is painted on all four edges and rounded at its corners", async () => {
    const page = getPage();
    // The frame is counted in one dock mode: the frame is the column's, and
    // the three modes (right, left, float) measured identical counts.
    const amber = await sampleAmber(page);
    note(`--warning-foreground paints as rgb(${amber.join(", ")})`);
    const frame = await readFrameGeometry(page);
    expect(
      frame,
      `A9: the frame's geometry is not a plain px value, so nothing below measured where the stroke actually is (inset and radius read as ${JSON.stringify(frame)})`,
    ).not.toBeNull();
    if (frame === null) return;
    expect(
      frame.inset === DESIGNED_FRAME_INSET &&
        frame.radius === DESIGNED_FRAME_RADIUS,
      `A9: the frame is inset ${String(frame.inset)}px with a ${String(frame.radius)}px radius, expected ${String(DESIGNED_FRAME_INSET)}px and ${String(DESIGNED_FRAME_RADIUS)}px (L-137)`,
    ).toBe(true);
    note(
      `editing frame is inset ${String(frame.inset)}px with a ${String(frame.radius)}px radius; each edge's straight run is counted at that inset`,
    );
    const column = await requireRect(page, "[data-layout-column]");
    const violations = violationLog();
    for (const edge of ["top", "bottom", "left", "right"] as const) {
      const count = await countEdge(
        page,
        column,
        { edge, target: amber },
        frame,
      );
      const ratio = count.along === 0 ? 0 : count.lit / count.along;
      note(
        `frame ${edge}: ${String(count.lit)}/${String(count.along)} lit (${(ratio * 100).toFixed(1)}%)`,
      );
      // The floor only. A dotted stroke lights about a quarter to a half of
      // its run, and a SOLID stroke lights all of it, which is a legitimate
      // design too: there is no ceiling to fail it. What is asserted is that
      // the edge is not missing or painted over (the inset bug this count was
      // added for measured exactly 0).
      violations.check(
        ratio >= FRAME_LIT_FLOOR,
        `A9 ${edge}: ${String(count.lit)} of ${String(count.along)} positions along the straight run of that edge are amber (${(ratio * 100).toFixed(1)}%, expected at least ${String(FRAME_LIT_FLOOR * 100)}%); column ${boxText(column)}`,
      );
      for (const [index, quarter] of count.quarters.entries()) {
        if (quarter.along === 0) continue;
        const share = quarter.lit / quarter.along;
        violations.check(
          share >= FRAME_QUARTER_LIT_FLOOR,
          `A9 ${edge}: quarter ${String(index + 1)} of that edge's straight run is ${(share * 100).toFixed(1)}% amber (expected at least ${String(FRAME_QUARTER_LIT_FLOOR * 100)}%), so part of the edge is covered or missing; column ${boxText(column)}`,
        );
      }
    }
    // The four corners, which the edge counts above cut out by construction
    // (`countEdge` starts each run at `inset + radius`). Nothing in those
    // counts can tell a 12px arc from a square join, so this asks the one
    // question that can be asked of a pixel: is the corner of the frame's own
    // RECTANGLE dark, as only a rounded corner leaves it.
    for (const corner of [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ] as const) {
      const cornerX = corner.endsWith("left")
        ? column.x + frame.inset
        : column.x + column.width - frame.inset;
      const cornerY = corner.startsWith("top")
        ? column.y + frame.inset
        : column.y + column.height - frame.inset;
      const ink = await countLit(
        page,
        {
          x: Math.max(0, cornerX - FRAME_CORNER_PROBE / 2),
          y: Math.max(0, cornerY - FRAME_CORNER_PROBE / 2),
          width: FRAME_CORNER_PROBE,
          height: FRAME_CORNER_PROBE,
        },
        { horizontal: true, target: amber, tolerance: 90 },
      );
      violations.check(
        ink.lit === 0,
        `A9 ${corner}: amber ink at the frame's own rectangle corner (${String(ink.lit)} of ${String(ink.along)} columns), which a ${String(frame.radius)}px radius cannot produce (L-137); the box is 4px square at the corner and anything painted there will report, so read the pixels before reading the border-radius; column ${boxText(column)}`,
      );
    }
    violations.assertNone("A9: the editing frame is not drawn as designed");
  });

  // --- the placement bar and the surface drag (D14, T09) --------------------

  test("the tab strip is selected by its own space with the placement bar beside it, and a pictogram writes the edge", async () => {
    const page = getPage();
    await configureCanvas(page, { ...SESSION_AT_TOP, tabs: "left" });
    await probe(page, "clearSelection()");
    let read = await placementOf(page);
    expect(
      read.spacer,
      "placement: the left strip draws no drag spacer to select it by",
    ).not.toBeNull();
    if (read.spacer === null) return;
    await clickAt(page, read.spacer.cx, read.spacer.cy, "left");
    await waitUntil(
      page,
      'document.querySelector("[data-layout-placement-bar]") !== null',
    );
    await waitForStableBox(page, "[data-layout-placement-bar]", 3);
    read = await placementOf(page);
    const violations = violationLog();
    checkBar(
      read,
      {
        surface: "topBar",
        edges: ["top", "left", "right"],
        current: "left",
        views: true,
      },
      violations,
    );
    // Beside the strip it places, never over it.
    if (read.bar !== null && read.strip !== null) {
      violations.check(
        read.bar.rect.x >= read.strip.x + read.strip.width,
        `the bar ${boxText(read.bar.rect)} covers the strip ${boxText(read.strip)} it places`,
      );
    }
    violations.assertNone("placement: the strip's bar");
    note(
      `strip bar ${read.bar === null ? "-" : boxText(read.bar.rect)}, ring ${read.ring === null ? "-" : boxText(read.ring)}`,
    );

    // A pictogram writes the edge, and the bar follows the strip.
    const right = read.bar?.edges.find((edge) => edge.edge === "right");
    expect(
      right,
      "placement: the strip's bar has no right pictogram",
    ).toBeDefined();
    if (right === undefined) return;
    await clickAt(page, right.rect.cx, right.rect.cy, "left");
    await waitUntil(
      page,
      `document.querySelector("[data-tab-strip-placement]")?.getAttribute("data-tab-strip-placement") === "right" &&
        document.querySelector('[data-testid="side-tab-strip"]')?.getAttribute("data-edge") === "right"`,
    );
    await waitForFiniteAnimations(page);
    await waitForStableBoxes(
      page,
      ["[data-layout-placement-bar]", '[data-testid="side-tab-strip"]'],
      3,
    );
    read = await placementOf(page);
    expect(
      [read.placement, read.stripEdge],
      `the right pictogram left the strip at ${String(read.placement)} (edge ${String(read.stripEdge)})`,
    ).toEqual(["right", "right"]);
    const after = violationLog();
    checkBar(
      read,
      {
        surface: "topBar",
        edges: ["top", "left", "right"],
        current: "right",
        views: true,
      },
      after,
    );
    if (read.bar !== null && read.strip !== null) {
      after.check(
        read.bar.rect.x + read.bar.rect.width <= read.strip.x,
        `on the right, the bar ${boxText(read.bar.rect)} covers the strip ${boxText(read.strip)}`,
      );
    }
    after.assertNone("placement: the bar after the pictogram");
  });

  test("the tab strip dragged by its own space lights every drop zone and is written where it is dropped", async () => {
    const page = getPage();
    await configureCanvas(page, { ...SESSION_AT_TOP, tabs: "left" });
    await probe(page, "clearSelection()");
    for (const edge of ["left", "top"] as const) {
      const read = await placementOf(page);
      expect(
        read.spacer,
        `placement: no drag spacer to drag the strip toward ${edge}`,
      ).not.toBeNull();
      if (read.spacer === null) return;
      const mid = await dragSurfaceTo(page, read.spacer, edge);
      const violations = violationLog();
      checkDrop(mid, edge, violations);
      violations.assertNone(`placement: dragging the strip toward ${edge}`);
      await expect
        .poll(async () => (await placementOf(page)).placement, {
          message: `dropping the strip on the ${edge} band did not write it`,
        })
        .toBe(edge);
      note(
        `strip dragged to ${edge}: zones ${mid.zones.map((zone) => `${zone.edge}${zone.current ? "*" : ""}${zone.over ? "!" : ""}`).join(" ")}, in hand ${String(mid.dragging)}`,
      );
      await waitForShell(page, {
        ...SESSION_AT_TOP,
        tabs: edge,
      });
    }
  });

  test("the sidebar is selected by its own space, a pictogram writes its side, and a drag writes the band it is dropped on", async () => {
    const page = getPage();
    await configureCanvas(page, { ...SESSION_AT_TOP, tabs: "left" });
    await probe(page, "clearSelection()");
    let read = await placementOf(page);
    expect(
      read.aside,
      "placement: the sample sidebar is not on screen",
    ).not.toBeNull();
    if (read.aside === null) return;
    // The sidebar's empty space, low in its column: a click there selects the
    // sidebar as a surface, where a click on its rail icons would select them.
    const spot = {
      cx: read.aside.cx,
      cy: read.aside.y + read.aside.height - 24,
    };
    await clickAt(page, spot.cx, spot.cy, "left");
    await waitUntil(
      page,
      'document.querySelector("[data-layout-placement-bar=\\"sidebar\\"]") !== null',
    );
    await waitForStableBox(page, "[data-layout-placement-bar]", 3);
    read = await placementOf(page);
    const violations = violationLog();
    checkBar(
      read,
      {
        surface: "sidebar",
        edges: ["left", "right"],
        current: "left",
        views: false,
      },
      violations,
    );
    violations.assertNone("placement: the sidebar's bar");
    const sidebarRight = read.bar?.edges.find((edge) => edge.edge === "right");
    expect(
      sidebarRight,
      "placement: the sidebar's bar has no right pictogram",
    ).toBeDefined();
    if (sidebarRight === undefined) return;
    await clickAt(page, sidebarRight.rect.cx, sidebarRight.rect.cy, "left");
    await expect
      .poll(async () => (await placementOf(page)).sidebarSide, {
        message: "the right pictogram did not move the sidebar",
      })
      .toBe("right");
    await waitForStableBoxes(
      page,
      ["[data-layout-placement-bar]", 'aside[aria-label="Sample sidebar"]'],
      3,
    );

    read = await placementOf(page);
    expect(read.aside, "placement: the sidebar left the screen").not.toBeNull();
    if (read.aside === null) return;
    const back = await dragSurfaceTo(
      page,
      { cx: read.aside.cx, cy: read.aside.y + read.aside.height - 24 },
      "left",
    );
    const dropped = violationLog();
    checkDrop(back, "left", dropped);
    dropped.assertNone("placement: dragging the sidebar toward left");
    await expect
      .poll(async () => (await placementOf(page)).sidebarSide, {
        message: "dropping the sidebar on the left band did not write it",
      })
      .toBe("left");
    note(
      `sidebar dragged to left: zones ${back.zones.map((zone) => `${zone.edge}${zone.current ? "*" : ""}${zone.over ? "!" : ""}`).join(" ")}`,
    );
  });

  // --- A14 ------------------------------------------------------------------

  test("a real click on Tab placement Left moves the strip in one frame as one history step, and one undo restores the top", async () => {
    const page = getPage();
    // The two-level form (T3/T4): a real click on the Task tabs row opens its
    // area before the Tab placement control exists in the document.
    const taskTabsArea = await requireRect(
      page,
      '[data-layout-inspector] [data-layout-area="topBar"]',
    );
    await clickAt(page, taskTabsArea.cx, taskTabsArea.cy, "left");
    const radio = await rectOfPlacementLeft(page);
    const depthBefore = await historyDepth(page);
    await clickAt(page, radio.cx, radio.cy, "left");
    // ONE frame after the click, not a settle: the strip is where it will stay.
    const first = await page.evaluate<StripPlacement>(
      `new Promise((resolve) => requestAnimationFrame(() => resolve(${STRIP_PLACEMENT_PROBE})))`,
    );
    expect(
      first.placement === "left" && first.strip !== null,
      `A14: one frame after a real click on Left the column is ${String(first.placement)} with ${first.strip === null ? "no strip" : "a strip"}`,
    ).toBe(true);
    if (first.strip === null || first.column === null) return;
    expect(
      Math.abs(first.strip.x - first.column.x),
      `A14: the strip is at ${boxText(first.strip)}, not on the column's left edge ${boxText(first.column)}`,
    ).toBeLessThanOrEqual(0.5);
    expect(
      first.header,
      "A14: the header is still mounted beside the left strip",
    ).toBe(false);
    await waitForFiniteAnimations(page);
    await waitForStableBox(page, '[data-testid="side-tab-strip"]', 3);
    const settled = await page.evaluate<StripPlacement>(STRIP_PLACEMENT_PROBE);
    expect(
      settled.strip !== null && sameBoxWithin(first.strip, settled.strip, 0.5),
      `A14: the strip kept moving after the first frame (${boxText(first.strip)} -> ${settled.strip === null ? "gone" : boxText(settled.strip)}), so the switch is animated rather than one frame`,
    ).toBe(true);
    const depthAfter = await historyDepth(page);
    expect(
      depthAfter,
      `A14: the click cost ${String(depthAfter - depthBefore)} history steps, expected one`,
    ).toBe(depthBefore + 1);

    // One undo puts the top back, in one step of history.
    const undo = await requireRect(
      page,
      '[data-layout-inspector] button[aria-label="Undo"]',
    );
    await moveTo(page, undo.cx, undo.cy);
    await clickAt(page, undo.cx, undo.cy, "left");
    const afterUndo = await page.evaluate<StripPlacement>(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(${STRIP_PLACEMENT_PROBE}))))`,
    );
    expect(
      afterUndo.placement === "top" &&
        afterUndo.strip === null &&
        afterUndo.header,
      `A14: one undo left the column at ${String(afterUndo.placement)} (strip ${afterUndo.strip === null ? "gone" : "still mounted"}, header ${String(afterUndo.header)})`,
    ).toBe(true);
    const depthUndone = await historyDepth(page);
    expect(
      depthUndone,
      `A14: after one undo the history is ${String(depthUndone)} deep, expected ${String(depthBefore)}`,
    ).toBe(depthBefore);
  });
});

// --- probes -----------------------------------------------------------------

/**
 * The regions the sample scene draws, in the order the assertions walk them.
 * The three it does not draw (`homeTab`, `usageLimits`, `resourceMonitor`,
 * plus `railArtifacts` inside Agents' group icon) are shell chrome the app
 * column draws outside the sample tab, which this fixture has no host for.
 *
 * Intersected with the product's own `LAYOUT_REGION_IDS` at run time (see
 * `mountedRegions`), so a region the app retires stops being asserted here
 * instead of failing as "no node on the canvas".
 */
const CANVAS_REGIONS = [
  "railAgents",
  "railTerminals",
  "railBrowsers",
  "railGitDiff",
  "railPullRequests",
  "railFileTree",
  "railSharing",
  "railComments",
  "minimap",
  // The sample conversation's own regions (L-175, L-178): a reasoning-only
  // activity row and a command row in its last two turns, and a stamp on
  // every prompt.
  "toolActivity",
  "thinking",
  "timestamps",
  "contextUsage",
  "changedFiles",
  "runningAgents",
  "background",
  "todo",
  "attachImage",
  "access",
  "model",
  "mic",
];

async function mountedRegions(page: Page): Promise<readonly string[]> {
  const known = await probeValue<readonly string[]>(page, "regionIds");
  return CANVAS_REGIONS.filter((regionId) => known.includes(regionId));
}

function regionSelector(regionId: string): string {
  // Timestamps are the one region drawn once per message, and the first in
  // the document is the oldest prompt, scrolled out of a conversation that
  // opens at its end. The last turn's stamp is the one on screen, which is
  // also the one the editor's chip and ring go to (`preferredRegionInstance`).
  if (regionId === "timestamps") {
    return `[data-sample-turn]:last-child [data-layout-region="timestamps"]`;
  }
  return `[data-layout-region="${regionId}"]`;
}

async function hoverOf(
  page: Page,
  regionId: string,
): Promise<{
  readonly hover: string | null;
  readonly chipHidden: boolean;
  readonly chipOnScreen: boolean;
}> {
  return page.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(regionSelector(regionId))});
    const chip = document.querySelector("[data-layout-hover-chip]");
    const rect = chip === null || chip.hidden ? null : chip.getBoundingClientRect();
    return {
      hover: node === null ? null : node.getAttribute("data-hover"),
      chipHidden: chip === null ? true : chip.hidden,
      chipOnScreen: rect !== null && rect.width > 0 && rect.height > 0,
    };
  })()`);
}

function selectionProbe(regionId: string): string {
  return `(() => {
    const node = document.querySelector(${JSON.stringify(regionSelector(regionId))});
    const panel = document.querySelector("[data-layout-inspector]");
    return {
      selected: node === null ? null : node.getAttribute("data-selected"),
      // The two-level form: a click opens the region's area with its row
      // selected, so "still at the index" is no area form on screen.
      atIndex: panel !== null && panel.querySelector("[data-layout-area-form]") === null,
      inspectorText: (() => {
        const row = panel === null ? null : panel.querySelector('[data-sortable-id=${JSON.stringify(regionId)}][data-sortable-selected="1"]');
        return row === null ? "" : (row.textContent ?? "").slice(0, 400);
      })(),
    };
  })()`;
}

interface AppActed {
  readonly expanded: readonly string[];
  readonly states: readonly string[];
  readonly layers: number;
}

/** How many entries differ, a length change counting as every entry of the longer list. */
function changedCount(
  before: readonly string[],
  after: readonly string[],
): number {
  if (before.length !== after.length)
    return Math.max(before.length, after.length);
  return before.filter((value, index) => value !== after[index]).length;
}

/**
 * Whether the APP acted, read either side of a click (4.4).
 *
 * A swallowed click leaves nothing behind, so the proof has to be that every
 * observable the app's own controls move is unchanged: the open/closed state
 * of every disclosure inside the column, and the number of menu, dialog and
 * popover layers anywhere. The file chooser is the one the DOM cannot answer;
 * that one is a Chrome event.
 *
 * The sample sidebar's body is left out: it shows the panel of the selected
 * Sidebar setting by design (F3), so a click that selects a rail icon swaps
 * its sections without the app having acted. So is the sample model picker,
 * which the editor opens while Model is selected so its footer has something
 * to show: it is the editor's picture, not a popover the app opened.
 */
const APP_ACTED_PROBE = `(() => {
  const column = document.querySelector("[data-layout-column]");
  if (column === null) return { expanded: ["no column"], states: ["no column"], layers: -1 };
  const appOwn = (node) =>
    node.closest("[data-sample-sidebar-body], [data-testid='sample-model-picker']") === null;
  return {
    expanded: [...column.querySelectorAll("[aria-expanded]")]
      .filter(appOwn)
      .map((node) => String(node.getAttribute("aria-expanded"))),
    states: [...column.querySelectorAll("[data-state]")]
      .filter(appOwn)
      .map((node) => String(node.getAttribute("data-state"))),
    layers: [
      ...document.querySelectorAll(
        '[role="menu"],[role="dialog"],[role="listbox"],[data-radix-popper-content-wrapper]',
      ),
    ].filter(appOwn).length,
  };
})()`;

async function rightClickMenu(
  page: Page,
  x: number,
  y: number,
): Promise<{ readonly open: boolean; readonly text: string }> {
  await clickAt(page, x, y, "right");
  // The menu opens in the frames after the press; its absence is the finding,
  // so the wait ends at a bound rather than at an event.
  await becomesTruthy(
    page,
    "document.querySelector('[role=\"menu\"]') !== null",
    3_000,
  );
  return page.evaluate(`(() => {
    const menu = document.querySelector('[role="menu"]');
    return { open: menu !== null, text: menu === null ? "" : (menu.textContent ?? "") };
  })()`);
}

async function dismissLayers(page: Page): Promise<void> {
  await pressKey(page, "Escape");
  await waitUntil(page, "document.querySelector('[role=\"menu\"]') === null");
  await nextFrames(page, 2);
}

// --- drags ------------------------------------------------------------------

/**
 * How far past a neighbour's centre a drag is aimed.
 *
 * `drag-engine.ts` takes its grab point at the move that CROSSES the 6px
 * activation distance rather than at the press, so the effective travel is six
 * pixels less than the pointer's. Aiming six past a centre therefore lands
 * exactly ON it, where the comparison is strict and the member keeps its own
 * slot. Eighteen leaves twelve pixels of margin.
 *
 * What the overshoot is measured ON changed with L-143: `drag-model.ts` now
 * claims a slot once the dragged member's LEADING EDGE in the direction of
 * travel passes the neighbour's centre, not once its own centre does. A plan
 * whose anchor is smaller than the member it drags therefore sets
 * `leadingEdge`, and the pointer is placed so that EDGE lands the overshoot
 * past the anchor.
 */
const DROP_OVERSHOOT = 18;

/**
 * `railTerminals` ended up above the divider, however the gesture got it there.
 *
 * The shipped rail carries no dividers (L-155), so the rail plan puts one in
 * first through the product's own add-divider action - between Artifacts and
 * Terminals, which is where `divider:1` sat in the rail this wave replaced, so
 * the measured geometry the overshoot is tuned on is unchanged.
 *
 * `stack:railAgents+railArtifacts` is the shipped rail's one stack LINK
 * (L-166), named after the PAIR it joins. It is a member of the order like any
 * other entry, so it is named here; the rail draws the pair as one icon (G3).
 */
const TERMINALS_ABOVE_THE_DIVIDER = [
  "railAgents",
  "stack:railAgents+railArtifacts",
  "railArtifacts",
  "railTerminals",
  "divider:1",
  "railBrowsers",
  "railGitDiff",
  "railPullRequests",
  "railFileTree",
  "railSharing",
  "railComments",
];

interface Arrangement {
  readonly toolbarLeft: readonly string[];
  readonly dock: readonly string[];
  readonly rail: ReadonlyArray<{ readonly id: string }>;
}

async function arrangementOf(page: Page): Promise<Arrangement> {
  const snapshot = await probeValue<{ readonly arrangement: Arrangement }>(
    page,
    "snapshot()",
  );
  return snapshot.arrangement;
}

type DragTarget =
  | {
      readonly kind: "member";
      readonly selector: string;
      readonly dx: number;
      readonly dy: number;
      readonly leadingEdge: boolean;
    }
  | {
      readonly kind: "viewport";
      readonly dx: number;
      readonly dy: number;
      readonly axis: "x" | "y";
    };

interface DragPlan {
  readonly id: string;
  readonly memberId: string;
  readonly memberSelector: string;
  readonly siblingSelector: string | null;
  readonly target: DragTarget;
  readonly expect:
    | {
        readonly kind: "order";
        readonly group: "toolbarLeft" | "dock";
        readonly ids: readonly string[];
      }
    | { readonly kind: "rail"; readonly ids: readonly string[] }
    | { readonly kind: "none" };
}

/**
 * `layout-arrangement.ts`'s `placedBeside`, restated for the EXPECTATION.
 *
 * The expected order is computed from the order the app is actually holding
 * rather than written out, so a cluster that gains a member changes what the
 * drop should produce without changing this file. The arithmetic is the
 * product's own: take the member out, put it back beside the anchor.
 */
function placedBeside(
  order: readonly string[],
  moved: string,
  anchor: string,
  after: boolean,
): readonly string[] {
  const rest = order.filter((id) => id !== moved);
  const at = rest.indexOf(anchor);
  if (at < 0) return order;
  const insertAt = after ? at + 1 : at;
  return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
}

interface Destination {
  readonly x: number;
  readonly y: number;
}

/** Where the pointer is taken to: a member's own centre (or its leading edge), or past the window's corner. */
async function dragDestination(
  page: Page,
  plan: DragPlan,
  member: Box,
): Promise<Destination | null> {
  if (plan.target.kind !== "member") {
    const view = await viewportOf(page);
    return { x: view.width + plan.target.dx, y: view.height + plan.target.dy };
  }
  const anchor = await rectOf(page, plan.target.selector);
  expect(
    anchor,
    `A5 ${plan.id}: no drop anchor ${plan.target.selector}`,
  ).not.toBeNull();
  if (anchor === null) return null;
  const to = { x: anchor.cx + plan.target.dx, y: anchor.cy + plan.target.dy };
  if (!plan.target.leadingEdge) return to;
  // `to` named where the member's LEADING EDGE should land (L-143); the
  // pointer is half a member behind it, on the axis the drag travels.
  return {
    x:
      plan.target.dx === 0
        ? to.x
        : to.x - Math.sign(plan.target.dx) * (member.width / 2),
    y:
      plan.target.dy === 0
        ? to.y
        : to.y - Math.sign(plan.target.dy) * (member.height / 2),
  };
}

/** How far the member in hand travelled from its start along `axis`, or `null` when none was in hand. */
function travelAlong(
  axis: "x" | "y",
  mid: MidDrag,
  member: Box,
): number | null {
  if (mid.draggingCenter === null) return null;
  return axis === "y"
    ? Math.abs(mid.draggingCenter.y - member.cy)
    : Math.abs(mid.draggingCenter.x - member.cx);
}

/**
 * The clamp: the member may travel, but not as far as the pointer did, and it
 * may not be dropped anywhere (L-29), so nothing is written.
 */
async function assertClamped(
  page: Page,
  plan: DragPlan,
  run: {
    readonly mid: MidDrag;
    readonly member: Box;
    readonly to: Destination;
    readonly before: Arrangement;
    readonly depthBefore: number;
  },
): Promise<void> {
  const { mid, member, to, before, depthBefore } = run;
  // The clamp: the member may travel, but not as far as the pointer did, and
  // it may not be dropped anywhere (L-29). Where the member is PAINTED,
  // against the pointer, on the rail's axis: the pull across it is the
  // clamp's too, but not what it moves along.
  const axis = plan.target.kind === "viewport" ? plan.target.axis : "x";
  const raw =
    axis === "y" ? Math.abs(to.y - member.cy) : Math.abs(to.x - member.cx);
  const travelled = travelAlong(axis, mid, member);
  note(
    `clamp: pointer pulled ${raw.toFixed(0)}px to ${JSON.stringify(to)}, member travelled ${travelled === null ? "n/a" : travelled.toFixed(0)}px`,
  );
  expect(
    travelled,
    `A5 ${plan.id}: no member in hand to measure`,
  ).not.toBeNull();
  if (travelled !== null) {
    // Unclamped, the member trails the pointer by the 6px activation
    // distance alone (`drag-engine.ts`), so it would cover nearly all of
    // the pull; clamped, it stops at its cluster's edge plus the rubber
    // band.
    expect(
      travelled,
      `A5 ${plan.id}: the member followed the pointer ${travelled.toFixed(0)}px of ${raw.toFixed(0)}px, so nothing clamped it to its cluster`,
    ).toBeLessThanOrEqual(raw / 2);
  }
  // Nothing is written, and the wait for "nothing" is the drop landing.
  await waitForDropSettled(page);
  const after = await arrangementOf(page);
  expect(
    JSON.stringify(after),
    `A5 ${plan.id}: the arrangement was written although the member was pulled out of its cluster`,
  ).toBe(JSON.stringify(before));
  const depthAfter = await historyDepth(page);
  expect(
    depthAfter,
    `A5 ${plan.id}: history went ${String(depthBefore)} -> ${String(depthAfter)}; a clamped drag writes nothing`,
  ).toBe(depthBefore);
}

async function runDrag(page: Page, plan: DragPlan): Promise<void> {
  await nextFrames(page, 2);
  const selectors = [plan.memberSelector];
  if (plan.siblingSelector !== null) selectors.push(plan.siblingSelector);
  await waitForStableBoxes(page, selectors, 3);
  const member = await rectOf(page, plan.memberSelector);
  expect(
    member,
    `A5 ${plan.id}: nothing matches ${plan.memberSelector}`,
  ).not.toBeNull();
  if (member === null) return;

  const to = await dragDestination(page, plan, member);
  if (to === null) return;

  const siblingBox =
    plan.siblingSelector === null
      ? null
      : await rectOf(page, plan.siblingSelector);
  const sibling: DragSibling | null =
    plan.siblingSelector === null || siblingBox === null
      ? null
      : { selector: plan.siblingSelector, before: siblingBox };
  const before = await arrangementOf(page);
  const depthBefore = await historyDepth(page);

  const mid = await dragPointer(page, member, to, sibling);

  expect(
    mid.dragging,
    `A5 ${plan.id}: nothing carried [data-layout-dragging] mid-gesture, so the press never became a drag (from ${boxText(member)} to ${JSON.stringify(to)})`,
  ).not.toBeNull();
  expect(
    mid.dragging,
    `A5 ${plan.id}: the element in hand was ${String(mid.dragging)}, expected ${plan.memberId}`,
  ).toBe(plan.memberId);

  if (plan.expect.kind === "none") {
    await assertClamped(page, plan, { mid, member, to, before, depthBefore });
    return;
  }

  // The release is a spring, and the write happens only once it has settled:
  // the history step is the event waited for, not a delay.
  await expect
    .poll(() => historyDepth(page), {
      message: `A5 ${plan.id}: the drop was never written; one drag is exactly one step (L-18)`,
    })
    .toBeGreaterThan(depthBefore);
  await waitForDropSettled(page);
  const depthAfter = await historyDepth(page);
  expect(
    depthAfter - depthBefore,
    `A5 ${plan.id}: history went ${String(depthBefore)} -> ${String(depthAfter)}; one drag is exactly one step (L-18)`,
  ).toBe(1);

  const after = await arrangementOf(page);
  const actual =
    plan.expect.kind === "rail"
      ? after.rail.map((entry) => entry.id)
      : after[plan.expect.group];
  expect(
    actual,
    `A5 ${plan.id}: the layout store reads ${JSON.stringify(actual)}, expected ${JSON.stringify(plan.expect.ids)} (dragged from ${boxText(member)} to ${JSON.stringify(to)})`,
  ).toEqual(plan.expect.ids);

  if (siblingBox !== null) {
    expect(
      mid.siblingRect,
      `A5 ${plan.id}: could not measure the sibling mid-drag`,
    ).not.toBeNull();
    if (mid.siblingRect !== null) {
      expect(
        Math.abs(mid.siblingRect.x - siblingBox.x) >= 1 ||
          Math.abs(mid.siblingRect.y - siblingBox.y) >= 1,
        `A5 ${plan.id}: the sibling did not reflow mid-drag (still at ${mid.siblingRect.x.toFixed(1)}, ${mid.siblingRect.y.toFixed(1)})`,
      ).toBe(true);
    }
  }
  note(
    `drag "${plan.id}": ${JSON.stringify(actual)}, history +${String(depthAfter - depthBefore)}`,
  );
}

// --- the editing frame ------------------------------------------------------

/**
 * The window the frame's stroke is looked for in, across each edge.
 *
 * The frame is held `--layout-editor-frame-inset` inside the column and
 * rounded by `--layout-editor-frame-radius`, both read at run time: where the
 * stylesheet puts the stroke is a design decision, and a test that kept
 * scanning the outermost four pixels reported a deliberate 4px inset as four
 * unlit edges (measured, 0 of 1180 on every one of twelve edges). The window
 * is wider than the 2px border on purpose - what is being asserted is that the
 * edge is LIT near the inset, not that it is a CSS border, so the same count
 * survives the stroke becoming an SVG or a shadow.
 */
const FRAME_BAND_BEFORE_INSET = 2;
const FRAME_BAND_AFTER_INSET = 6;

/**
 * L-137's two numbers, stated here so that reading them is not the same as
 * accepting them (`--layout-editor-frame-inset` and
 * `--layout-editor-frame-radius` in `layout-editor.css`).
 *
 * The count is taken AT the inset the column reports, which is what lets one
 * count describe every dock mode without restating the stylesheet. The cost is
 * that the count moves with the value: a frame that regressed to `inset: 0`
 * with square corners - which is exactly what the owner's fourth live pass
 * believed it was looking at - would be counted at zero and pass every edge,
 * because a stroke flush with the window edge is still a stroke. So the value
 * is asserted as well as read. The pixels then answer the other half, which no
 * computed style can: whether the CORNERS are drawn on the radius the
 * stylesheet declares.
 */
const DESIGNED_FRAME_INSET = 4;
const DESIGNED_FRAME_RADIUS = 12;

/**
 * The square of pixels a SQUARE corner would light and a rounded one cannot.
 *
 * Centred on the frame's own rectangle corner, `(inset, inset)` in the
 * column's coordinates. With `border-radius: r`, the stroke's outer edge near
 * that corner is the arc centred at `(inset + r, inset + r)` with radius `r`,
 * and every point of this box is further from that centre than `r` - the
 * nearest, `(inset + 2, inset + 2)`, by 14.1 against 12 - so the designed
 * frame provably leaves it dark no matter where the dot phase falls. A square
 * corner puts its mitre join exactly there. The assertion is therefore in the
 * safe direction: it can only fire on ink the design cannot produce.
 */
const FRAME_CORNER_PROBE = 4;

/**
 * The share of an edge's straight run that the stroke must light, as this
 * count can see it.
 *
 * A 2px dotted border repeats every 4px, so the design duty cycle is a half.
 * What the count measures is narrower than that: a position is lit when some
 * pixel in the band is within tolerance of pure amber, and whether a dot's 2px
 * disc covers one pixel fully or two pixels at 77% is decided by where that
 * dot's centre falls on the pixel grid. Chromium distributes the dots along
 * the WHOLE rounded border path, so each side starts at its own sub-pixel
 * phase, and the same one stylesheet rule measures 50.0% on the top edge and
 * 25.0% on the other three. Neither number is a fact about the design, so the
 * floor sits where it separates an edge that is missing or painted over
 * (reads 0%) from one that is drawn. It has no ceiling: a solid stroke reads
 * 100% and is as legitimate as a dotted one.
 */
const FRAME_LIT_FLOOR = 0.15;

/**
 * The same question asked of each QUARTER of an edge's straight run.
 *
 * The floor above cannot fail for a HALF-covered edge, which is the defect the
 * frame was rebuilt for (L-130): an edge that loses 40% of its lit positions
 * to an opaque descendant still clears 15%. An opaque child covers a
 * CONTIGUOUS stretch, so it empties whole quarters; a stroke that is merely
 * phased differently does not, because the dot pitch is 4px and a quarter of
 * the shortest edge is far longer than that.
 *
 * Floored well under the measured 25% baseline (50% on the top edge) rather
 * than beside it, because a quarter is a quarter of the sample and the phase
 * is decided per edge by where the rounded path's dots land.
 */
const FRAME_QUARTER_LIT_FLOOR = 0.1;

/**
 * A CSS length that is written in plain pixels, or `null`.
 *
 * `getPropertyValue` on a custom property returns the token as authored, so
 * `Number.parseFloat` is only meaningful once the unit has been checked: it
 * reads `0.25rem` as 0.25 and `calc(4px)` as NaN, and a caller that took
 * either would be measuring a number the stylesheet never expressed.
 */
function pxValue(token: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(token.trim());
  return match === null ? null : Number(match[1]);
}

async function readFrameGeometry(
  page: Page,
): Promise<{ readonly inset: number; readonly radius: number } | null> {
  const tokens = await page.evaluate<{
    readonly inset: string;
    readonly radius: string;
  }>(`(() => {
    const style = getComputedStyle(document.querySelector("[data-layout-column]"));
    return {
      inset: style.getPropertyValue("--layout-editor-frame-inset").trim(),
      radius: style.getPropertyValue("--layout-editor-frame-radius").trim(),
    };
  })()`);
  const inset = pxValue(tokens.inset);
  const radius = pxValue(tokens.radius);
  return inset === null || radius === null ? null : { inset, radius };
}

/**
 * One edge's STRAIGHT run, counted at the frame's own inset.
 *
 * Both ends are cut by `inset + radius`, because the frame's corners are arcs
 * and an arc leaves the straight edge before the column's corner does: counted
 * to the corner, a deliberate 12px radius reads as an unlit stretch at each
 * end of every edge. What is left is the part of the edge that is supposed to
 * be a straight dotted line, which is the thing LV2-04 was about.
 */
async function countEdge(
  page: Page,
  column: Box,
  run: {
    readonly edge: "top" | "bottom" | "left" | "right";
    readonly target: readonly [number, number, number];
  },
  frame: { readonly inset: number; readonly radius: number },
): Promise<LitCount> {
  const { edge, target } = run;
  const horizontal = edge === "top" || edge === "bottom";
  const cut = frame.inset + frame.radius;
  const near = Math.max(0, frame.inset - FRAME_BAND_BEFORE_INSET);
  const thickness = FRAME_BAND_BEFORE_INSET + FRAME_BAND_AFTER_INSET;
  const clip = horizontal
    ? {
        x: column.x + cut,
        y:
          edge === "top"
            ? column.y + near
            : column.y + column.height - near - thickness,
        width: Math.max(1, column.width - cut * 2),
        height: thickness,
      }
    : {
        x:
          edge === "left"
            ? column.x + near
            : column.x + column.width - near - thickness,
        y: column.y + cut,
        width: thickness,
        height: Math.max(1, column.height - cut * 2),
      };
  return countLit(page, clip, { horizontal, target, tolerance: 90 });
}

// --- the live placement switch ---------------------------------------------

interface StripPlacement {
  readonly placement: string | null;
  readonly column: Box | null;
  readonly strip: Box | null;
  readonly header: boolean;
}

const STRIP_PLACEMENT_PROBE = `(() => {
  const column = document.querySelector("[data-layout-column]");
  const strip = document.querySelector('[data-testid="side-tab-strip"]');
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    placement: column === null ? null : column.getAttribute("data-tab-strip-placement"),
    column: box(column),
    strip: box(strip),
    header: document.querySelector("[data-fixture-header]") !== null,
  };
})()`;

/** The "Left" radio of the Tab placement group, scrolled into view and boxed. */
async function rectOfPlacementLeft(page: Page): Promise<Box> {
  await waitUntil(
    page,
    `(() => {
      const group = document.querySelector('[data-layout-inspector] [role="radiogroup"][aria-label="Tab placement"]');
      return group !== null && [...group.querySelectorAll('[role="radio"]')].some((node) => (node.textContent ?? "").trim() === "Left");
    })()`,
  );
  await page.evaluate(`(() => {
    const group = document.querySelector('[data-layout-inspector] [role="radiogroup"][aria-label="Tab placement"]');
    const left = [...group.querySelectorAll('[role="radio"]')].find((node) => (node.textContent ?? "").trim() === "Left");
    left.scrollIntoView({ block: "center" });
  })()`);
  await waitForStableBox(
    page,
    '[data-layout-inspector] [role="radiogroup"][aria-label="Tab placement"] [role="radio"]:nth-child(2)',
    3,
  );
  return requireRect(
    page,
    '[data-layout-inspector] [role="radiogroup"][aria-label="Tab placement"] [role="radio"]:nth-child(2)',
  );
}

// --- the placement bar and the surface drag ---------------------------------

interface BarRead {
  readonly surface: string | null;
  readonly rect: Box;
  readonly edges: ReadonlyArray<{
    readonly edge: string | null;
    readonly checked: string | null;
    readonly rect: Box;
  }>;
  readonly views: boolean;
}

interface PlacementRead {
  readonly placement: string | null;
  readonly stripEdge: string | null;
  readonly strip: Box | null;
  readonly spacer: Box | null;
  readonly ring: Box | null;
  readonly bar: BarRead | null;
  readonly aside: Box | null;
  readonly sidebarSide: string | null;
  readonly viewport: { readonly width: number; readonly height: number };
}

const PLACEMENT_PROBE = `(() => {
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const bar = document.querySelector("[data-layout-placement-bar]");
  const aside = document.querySelector('aside[aria-label="Sample sidebar"]');
  const body = document.querySelector("[data-sample-workspace-body]");
  return {
    placement: document.querySelector("[data-tab-strip-placement]")?.getAttribute("data-tab-strip-placement") ?? null,
    stripEdge: document.querySelector('[data-testid="side-tab-strip"]')?.getAttribute("data-edge") ?? null,
    strip: box(document.querySelector('[data-testid="side-tab-strip"]')),
    spacer: box(document.querySelector('[data-testid="side-strip-drag-spacer"]')),
    ring: box(document.querySelector('[data-layout-selection-ring][data-on="1"]')),
    bar: bar === null ? null : {
      surface: bar.getAttribute("data-layout-placement-bar"),
      rect: box(bar),
      edges: [...bar.querySelectorAll("[data-placement-edge]")].map((node) => ({ edge: node.getAttribute("data-placement-edge"), checked: node.getAttribute("aria-checked"), rect: box(node) })),
      views: bar.querySelector('[role="radiogroup"][aria-label="Tabs view"]') !== null,
    },
    aside: box(aside),
    sidebarSide: aside === null || body === null ? null : (aside.getBoundingClientRect().x > body.getBoundingClientRect().x + body.getBoundingClientRect().width / 2 ? "right" : "left"),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

function placementOf(page: Page): Promise<PlacementRead> {
  return page.evaluate<PlacementRead>(PLACEMENT_PROBE);
}

/**
 * What one placement bar must be: for the surface it places, offering exactly
 * `edges` with `current` checked (and the Tabs view pair only for the strip),
 * wholly inside the window, with the selection ring drawn around the surface.
 */
function checkBar(
  read: PlacementRead,
  bar: {
    readonly surface: string;
    readonly edges: readonly string[];
    readonly current: string;
    readonly views: boolean;
  },
  violations: ViolationLog,
): void {
  const { surface, edges, current, views } = bar;
  if (read.bar === null) {
    violations.add(`no placement bar for ${surface}`);
    return;
  }
  violations.check(
    read.bar.surface === surface,
    `the bar is for ${String(read.bar.surface)}, expected ${surface}`,
  );
  const drawn = read.bar.edges.map((edge) => edge.edge);
  violations.check(
    drawn.join(",") === edges.join(","),
    `the ${surface} bar offers ${drawn.join(", ")}, expected ${edges.join(", ")}`,
  );
  const checked = read.bar.edges
    .filter((edge) => edge.checked === "true")
    .map((edge) => edge.edge);
  violations.check(
    checked.join(",") === current,
    `the ${surface} bar checks ${checked.join(", ") || "nothing"}, expected ${current}`,
  );
  violations.check(
    read.bar.views === views,
    `the ${surface} bar ${views ? "lacks" : "carries"} the Tabs view pair`,
  );
  violations.check(
    insideViewport(read.bar.rect, read.viewport),
    `the ${surface} bar ${boxText(read.bar.rect)} leaves the window`,
  );
  violations.check(
    read.ring !== null,
    `no selection ring around the ${surface}`,
  );
}

interface DropZones {
  readonly dragging: boolean;
  readonly zones: ReadonlyArray<{
    readonly edge: string | null;
    readonly current: boolean;
    readonly over: boolean;
    readonly cx: number;
    readonly cy: number;
  }>;
}

const DROP_ZONES_PROBE = `(() => ({
  dragging: document.querySelector('[data-layout-surface-dragging="1"]') !== null,
  zones: [...document.querySelectorAll("[data-layout-drop-zone]")].map((node) => {
    const r = node.getBoundingClientRect();
    return { edge: node.getAttribute("data-layout-drop-zone"), current: node.getAttribute("data-current") === "1", over: node.getAttribute("data-over") === "1", cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }),
}))()`;

function checkDrop(
  mid: DropZones,
  edge: string,
  violations: ViolationLog,
): void {
  violations.check(
    mid.dragging,
    `dragging toward ${edge}: the surface in hand is not marked`,
  );
  const over = mid.zones.filter((zone) => zone.over).map((zone) => zone.edge);
  violations.check(
    over.join(",") === edge,
    `dragging toward ${edge}: the zone under the pointer is ${over.join(", ") || "none"}`,
  );
  violations.check(
    mid.zones.filter((zone) => zone.current).length === 1,
    `dragging toward ${edge}: ${String(mid.zones.filter((zone) => zone.current).length)} zones marked current`,
  );
}

/** Press on the surface's own space, pass the activation distance, then into the edge's band. */
async function dragSurfaceTo(
  page: Page,
  from: { readonly cx: number; readonly cy: number },
  edge: string,
): Promise<DropZones> {
  await pressAt(page, from.cx, from.cy);
  const armed = { x: from.cx + 12, y: from.cy + 12 };
  await moveInSteps(page, armed);
  // The zones mount once the press has travelled far enough to be a drag.
  await waitUntil(
    page,
    'document.querySelectorAll("[data-layout-drop-zone]").length > 0',
  );
  const started = await page.evaluate<DropZones>(DROP_ZONES_PROBE);
  const zone = started.zones.find((candidate) => candidate.edge === edge);
  const target = zone === undefined ? armed : { x: zone.cx, y: zone.cy };
  await moveInSteps(page, target);
  await waitUntil(
    page,
    `document.querySelector('[data-layout-drop-zone="${edge}"]')?.getAttribute("data-over") === "1"`,
  );
  const mid = await page.evaluate<DropZones>(DROP_ZONES_PROBE);
  await releasePointer(page);
  await waitUntil(
    page,
    'document.querySelector("[data-layout-surface-dragging]") === null',
  );
  return mid;
}
