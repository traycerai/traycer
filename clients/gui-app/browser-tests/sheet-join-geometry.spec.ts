import type { Page } from "@playwright/test";

import {
  activateEpsilon,
  activateFirstSingle,
  activateFirstSplit,
  activateHome,
  activateLastTab,
  DESKTOP_WINDOW,
  EPSILON,
  expect,
  frameOverruns,
  joinState,
  measureArcAntialias,
  offsetDeltas,
  prepareCanvas,
  probe,
  readRenderedJoin,
  readSheetJoin,
  setHomeShown,
  test,
  withEnlargedTokens,
  type EdgeSide,
  type JoinSide,
  type SheetJoinRead,
} from "./support/canvas-geometry.ts";
import { centreOf, nextFrames } from "./support/fixtures.ts";

// Every test here runs in one worker, so the worker-scoped pages boot once
// per run instead of once per worker that gets a test (the config is
// `fullyParallel`).
test.describe.configure({ mode: "default" });

// The "sheet join": the concave corners (arcs) that stitch a joined tab - a
// side strip's active row/tile/split pair, or the top header's active tab -
// onto its task's sheet.
//
// `src/index.css`'s `[data-sheet-join-bridge=...][data-join-active]`
// rules position each arc's `::before`/`::after` pseudo-element with a plain
// percentage offset. The bridge carries a 1px border, and an absolutely
// positioned pseudo's containing block is its host's PADDING box - so an
// offset of `calc(100% - 1px)` (the bug) lands the arc's edge 1 CSS px inside
// the bridge, short of the padding box's true edge; the fix is a plain `100%`.
// jsdom has no anchor positioning, no real border resolution and no pseudo
// geometry, so this renders the real fixture in Chrome and reads
// `getComputedStyle(bridge, "::before"/"::after")`, which Chrome reports as
// used-value px, against the bridge's own measured padding box.
//
// WHAT IS MEASURED HERE, AND WHAT IS NOT. The arcs' offsets are CSS `100%` of
// the same box on every variant, and the only thing a variant changes is the
// join's fill (`--join-fill`), so the offsets are read once per bridge (top,
// left, right) rather than once per side x strip state x panel state x split
// combination. Which join a given combination draws (edge, and which pane's
// fill) is a pure rule, `useSideTabJoin`, and its matrix is jsdom's:
// `side-strip-tab-row.test.tsx`. Each bridge still gets a presence check here,
// because "the bridge lays out with real size" is a fact only a layout engine
// can state.

const EDGES: ReadonlyArray<EdgeSide> = ["left", "right"];

function expectArcsOnBridgeEdges(read: SheetJoinRead, side: JoinSide): void {
  for (const { what, delta } of offsetDeltas(read, side)) {
    expect(
      Math.abs(delta),
      `${side} bridge: ${what} by ${delta.toFixed(3)}px`,
    ).toBeLessThanOrEqual(EPSILON);
  }
}

function expectArcsWithinFrame(
  read: SheetJoinRead,
  side: JoinSide,
  label: string,
): void {
  const overruns = frameOverruns(read, side);
  expect(
    overruns,
    `${label}: no surface frame to bound the arcs (the join measured nothing)`,
  ).not.toBeNull();
  for (const { what, past } of overruns ?? []) {
    expect(
      past,
      `${label}: ${what} (${past.toFixed(3)}px past)`,
    ).toBeLessThanOrEqual(EPSILON);
  }
}

test.describe("offsets: the arcs meet the bridge's true inner edge", () => {
  test("top bridge", async ({ topCanvas }) => {
    const { page, setWindow } = topCanvas;
    await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
    await prepareCanvas(page, "top", "left");
    await activateEpsilon(page);

    expectArcsOnBridgeEdges(
      await readRenderedJoin(page, "top", "top tab"),
      "top",
    );
  });

  for (const edge of EDGES) {
    test(`${edge} bridge`, async ({ sidesCanvas }) => {
      const { page, setWindow } = sidesCanvas;
      await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
      await prepareCanvas(page, edge, edge);
      await activateEpsilon(page);

      expectArcsOnBridgeEdges(
        await readRenderedJoin(page, edge, `${edge} strip`),
        edge,
      );
    });
  }
});

// A tab group's colour line runs under its inactive members and meets the
// joined active member's outline at its feet, so the group reads as one line.
// The feet sit on the task frame's top border (the bridge's bottom), 3px below
// the tabs' own frames, so a line drawn along a tab's bottom floats over them.
test("top: a group's line meets the joined tab's feet on both sides", async ({
  topCanvas,
}) => {
  const { page, setWindow } = topCanvas;
  // Wide enough that the group's three tabs and its chip fit unscrolled: the
  // active tab joins only when it is wholly in the strip.
  await setWindow(1700, DESKTOP_WINDOW.height, 1);
  await prepareCanvas(page, "top", "left");
  await page.evaluate(`(async () => {
    const { useTabsStore } = await import("/src/stores/tabs/store.ts");
    const store = useTabsStore.getState();
    const ref = (id) => ({ kind: "epic", id: "fixture-" + id });
    const groupId = store.createGroup(ref("delta"));
    if (groupId === null) throw new Error("tab group was not created");
    store.setTabGroup(ref("epsilon"), groupId);
    store.setTabGroup(ref("zeta"), groupId);
    store.updateGroup(groupId, { name: "Group", color: "#fdd663", collapsed: false });
    window.__junctionGroupId = groupId;
  })()`);
  try {
    await activateEpsilon(page);
    await page.waitForSelector(
      '[data-sheet-join-bridge="top"][data-join-active]',
    );
    await nextFrames(page, 2);
    const read = await page.evaluate(() => {
      const box = (selector: string) => {
        const node = document.querySelector(selector);
        if (node === null) throw new Error(`no ${selector}`);
        return node.getBoundingClientRect();
      };
      const line = (id: string) =>
        box(
          `[data-testid="tab-epic-fixture-${id}"] [data-testid="tab-color-edge-line"]`,
        );
      const bridge = document.querySelector(
        '[data-sheet-join-bridge="top"][data-join-active]',
      );
      if (bridge === null) throw new Error("no joined top bridge");
      const radius = parseFloat(getComputedStyle(bridge, "::after").width);
      return {
        bridge: bridge.getBoundingClientRect(),
        radius,
        before: line("delta"),
        after: line("zeta"),
        clip: box('[data-testid="header-tab-strip-scroll"]').bottom,
      };
    });

    for (const [side, line] of [
      ["before", read.before],
      ["after", read.after],
    ] as const) {
      // On the feet's row, and inside the strip's clip, so it is drawn there.
      expect(
        Math.abs(line.bottom - read.bridge.bottom),
        `${side}: the line's foot against the bridge's`,
      ).toBeLessThanOrEqual(EPSILON);
      expect(line.bottom, `${side}: clipped by the strip`).toBeLessThanOrEqual(
        read.clip + EPSILON,
      );
    }
    // Reaching each foot's flare, which runs `radius` out from the bridge.
    expect(read.before.right).toBeGreaterThanOrEqual(
      read.bridge.left - read.radius,
    );
    expect(read.after.left).toBeLessThanOrEqual(
      read.bridge.right + read.radius,
    );
  } finally {
    await page.evaluate(`(async () => {
      const { useTabsStore } = await import("/src/stores/tabs/store.ts");
      useTabsStore.getState().ungroup(window.__junctionGroupId);
    })()`);
  }
});

test.describe("presence: the bridge lays out with real size", () => {
  test("top: the active header tab is joined", async ({ topCanvas }) => {
    const { page, setWindow } = topCanvas;
    await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
    await prepareCanvas(page, "top", "left");
    await activateEpsilon(page);

    await readRenderedJoin(page, "top", "top tab");
  });

  for (const edge of EDGES) {
    // The expanded strip draws the joined ROW and the collapsed strip a joined
    // TILE: two different elements carrying the anchor the bridge hangs from,
    // which no jsdom test can see laid out.
    test(`${edge}: the active row joins, and so does its tile once the strip collapses`, async ({
      sidesCanvas,
    }) => {
      const { page, setWindow } = sidesCanvas;
      await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
      await prepareCanvas(page, edge, edge);
      await activateEpsilon(page);

      await readRenderedJoin(page, edge, `${edge} strip, expanded (a row)`);

      await probe(page, "setCollapsed(true)");
      await readRenderedJoin(page, edge, `${edge} strip, collapsed (a tile)`);
    });
  }
});

test.describe("corners: an arc never extends past the surface frame", () => {
  // The frame (`[data-tab-edge]`) draws one seam line, on the edge facing the
  // tabs, with no radius left to carve a corner out of, so "past the joined
  // sheet's own corner radius" is now just "past the frame's own edge on the
  // flare axis". Each case is measured with the shipped tokens and again with
  // `--radius-lg` (the join's own radius) enlarged to 12px, which grows the
  // arcs and would expose an overshoot the default radius hides.
  async function expectWithinFrameAtBothRadii(
    page: Page,
    side: JoinSide,
    label: string,
  ): Promise<void> {
    expectArcsWithinFrame(
      await readRenderedJoin(page, side, label),
      side,
      label,
    );
    await withEnlargedTokens(page, async () => {
      const enlarged = `${label} (enlarged tokens)`;
      expectArcsWithinFrame(
        await readRenderedJoin(page, side, enlarged),
        side,
        enlarged,
      );
    });
  }

  test("top: the first tab, a lone one", async ({ topCanvas }) => {
    const { page, setWindow } = topCanvas;
    await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
    await prepareCanvas(page, "top", "left");
    await activateFirstSingle(page);

    await expectWithinFrameAtBothRadii(page, "top", "top, first single tab");
  });

  test("top: the first tab, a split pair", async ({ topCanvas }) => {
    const { page, setWindow } = topCanvas;
    await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
    await prepareCanvas(page, "top", "left");
    await activateFirstSplit(page);

    await expectWithinFrameAtBothRadii(page, "top", "top, first split pair");
  });

  test("top: Home, the strip's leftmost tab", async ({ topCanvas }) => {
    const { page, setWindow } = topCanvas;
    await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
    await prepareCanvas(page, "top", "left");
    await activateHome(page);

    await expectWithinFrameAtBothRadii(page, "top", "top, Home");
  });

  for (const edge of EDGES) {
    test(`${edge}: the first row, a lone one`, async ({ sidesCanvas }) => {
      const { page, setWindow } = sidesCanvas;
      await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
      await prepareCanvas(page, edge, edge);
      await activateFirstSingle(page);

      await expectWithinFrameAtBothRadii(
        page,
        edge,
        `${edge}, first single row`,
      );
    });

    test(`${edge}: the first row, a split pair`, async ({ sidesCanvas }) => {
      const { page, setWindow } = sidesCanvas;
      await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
      await prepareCanvas(page, edge, edge);
      await activateFirstSplit(page);

      await expectWithinFrameAtBothRadii(
        page,
        edge,
        `${edge}, first split pair`,
      );
    });

    // Short window and a scrolled list: the last row is the one that can sit
    // against the strip's own far edge, where an arc has the least room.
    test(`${edge}: the last row, scrolled to the end of a short strip`, async ({
      sidesCanvas,
    }) => {
      const { page, setWindow } = sidesCanvas;
      await setWindow(900, 420, 1);
      await prepareCanvas(page, edge, edge);
      await setHomeShown(page, true);
      await activateLastTab(page);
      const scrolled = await page.evaluate(() => {
        const list = document.querySelector('[data-strip-axis="y"]');
        if (list === null) return null;
        list.scrollTop = list.scrollHeight;
        return list.scrollTop;
      });
      expect(
        scrolled,
        "the strip must really scroll at this height, or 'the last row at the far end' is the first row",
      ).toBeGreaterThan(0);

      const label = `${edge}, last row`;
      expectArcsWithinFrame(
        await readRenderedJoin(page, edge, label),
        edge,
        label,
      );
    });
  }
});

test.describe("the top strip's split preview", () => {
  // Over another tab's middle the dragged tab's overlay fades out, since the
  // preview names the task. Its join must go with it: the bridge is drawn
  // outside the overlay, so left anchored to the faded box it painted the
  // sheet's notch and feet into the strip with no tab above them.
  test("the dragged active tab's join goes while the preview names the task", async ({
    topCanvas,
  }) => {
    const { page, setWindow } = topCanvas;
    await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
    await prepareCanvas(page, "top", "left");
    await activateEpsilon(page);
    await readRenderedJoin(page, "top", "split preview, baseline");

    const epsilon = await centreOf(
      page.getByTestId("tab-epic-fixture-epsilon"),
    );
    const delta = await centreOf(page.getByTestId("tab-epic-fixture-delta"));
    await page.mouse.move(epsilon.x, epsilon.y);
    await page.mouse.down();
    await page.mouse.move(delta.x, delta.y, { steps: 12 });

    await expect(
      page.getByTestId("tab-strip-pair-preview-epic-fixture-delta"),
    ).toHaveText("Epsilon cleanup");
    await expect
      .poll(() => joinState(page), {
        message: "no joined box and no bridge while the split preview shows",
      })
      .toEqual({ joined: false, bridgeVisible: false });

    // Back where it began, so the release reorders nothing, and then off the
    // strip: the page is shared, and a tab's hover card left opening under
    // the pointer would cover the join a later test measures.
    await page.mouse.move(epsilon.x, epsilon.y, { steps: 12 });
    await page.mouse.up();
    await page.mouse.move(1, 1);
  });
});

test.describe("the top strip's overflow", () => {
  // The active tab's join is a bridge OUTSIDE the tab list, which cannot be
  // clipped with the list. So a tab scrolled partly out of the list must be
  // drawn as a plain active tab (`use-wholly-in-tab-strip.ts`), and join again
  // once it is wholly back.
  test("a partly clipped active tab unjoins, and rejoins once it is back in view", async ({
    topCanvas,
  }) => {
    const { page, setWindow } = topCanvas;
    await setWindow(900, DESKTOP_WINDOW.height, 1);
    await prepareCanvas(page, "top", "left");
    await setHomeShown(page, false);
    await probe(page, "activateEpicTab('fixture-alpha')");
    await readRenderedJoin(page, "top", "top overflow, baseline");

    const tab = '[data-header-tab-key="epic:fixture-alpha"]';
    const list = '[data-strip-axis="x"]';
    await page.evaluate(
      ([tabSelector, listSelector]) => {
        const tabElement = document.querySelector(tabSelector);
        const listElement = document.querySelector(listSelector);
        if (tabElement === null || listElement === null) {
          throw new Error("the active tab or the strip's scroller is missing");
        }
        const tabBox = tabElement.getBoundingClientRect();
        const listBox = listElement.getBoundingClientRect();
        listElement.scrollLeft += tabBox.left - listBox.left + 10;
      },
      [tab, list],
    );

    // The premise, asserted positively: the tab really straddles the
    // scroller's clip edge, or none of what follows proves a partial clip.
    const straddles = (): Promise<boolean> =>
      page.evaluate(
        ([tabSelector, listSelector]) => {
          const tabBox = document
            .querySelector(tabSelector)
            ?.getBoundingClientRect();
          const listBox = document
            .querySelector(listSelector)
            ?.getBoundingClientRect();
          if (tabBox === undefined || listBox === undefined) return false;
          return tabBox.left < listBox.left && tabBox.right > listBox.left;
        },
        [tab, list],
      );
    await expect
      .poll(straddles, {
        message:
          "the active tab must straddle the strip's clip edge after scrolling, or this does not prove a genuine partial clip",
      })
      .toBe(true);

    await expect
      .poll(async () => (await joinState(page)).joined, {
        message:
          "[data-sheet-joined] must be gone while the active tab is partially clipped",
      })
      .toBe(false);
    expect(
      (await joinState(page)).bridgeVisible,
      "the join bridge must not be visible while the active tab is partially clipped",
    ).toBe(false);

    await page.evaluate((tabSelector) => {
      document
        .querySelector(tabSelector)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, tab);
    await expect
      .poll(async () => (await readSheetJoin(page, "top")) !== null, {
        message:
          "the tab must rejoin (a joined element and a visible bridge) after scrolling back into view",
      })
      .toBe(true);
  });

  test("the last tab, scrolled to the strip's far end, still lands on the seam", async ({
    topCanvas,
  }) => {
    const { page, setWindow } = topCanvas;
    await setWindow(900, DESKTOP_WINDOW.height, 1);
    await prepareCanvas(page, "top", "left");
    await setHomeShown(page, false);
    await activateLastTab(page);
    const scrolled = await page.evaluate(() => {
      const list = document.querySelector('[data-strip-axis="x"]');
      if (list === null) return null;
      list.scrollLeft = list.scrollWidth;
      return list.scrollLeft;
    });
    expect(
      scrolled,
      "the strip must really scroll at this width, or 'the last tab at the far end' is the first tab",
    ).toBeGreaterThan(0);

    const label = "top, last tab";
    expectArcsWithinFrame(
      await readRenderedJoin(page, "top", label),
      "top",
      label,
    );
  });
});

test.describe("anti-aliasing: the arcs are rounded boxes, not hard-stop gradients", () => {
  // One bridge, one theme, two device pixel ratios: the four arcs of all three
  // bridges are ONE rule (`index.css`, the shared `&::before, &::after`), so
  // another side or theme repeats it. The light theme is the strict one - its
  // three flat colours sit closest together, so its blend floor is the hardest
  // to clear. DPR 1.5 is left out on purpose: there a gradient is resampled,
  // which blurs it, so it cannot tell a gradient from a rounded box.
  for (const devicePixelRatio of [1, 2]) {
    test(`top arcs, light theme, at DPR ${devicePixelRatio}`, async ({
      topCanvas,
    }) => {
      const { page, setWindow } = topCanvas;
      await prepareCanvas(page, "top", "left");
      await probe(page, 'setTheme("light")');
      await setWindow(
        DESKTOP_WINDOW.width,
        DESKTOP_WINDOW.height,
        devicePixelRatio,
      );
      await activateEpsilon(page);
      await nextFrames(page, 2);
      const read = await readRenderedJoin(page, "top", "top tab");

      const arcs = await measureArcAntialias(
        topCanvas,
        "top",
        read,
        devicePixelRatio,
      );

      expect(arcs, "both arcs must be measured").toHaveLength(2);
      for (const arc of arcs) {
        test.info().annotations.push({
          type: `dpr ${devicePixelRatio} ${arc.pseudo}`,
          description: `${arc.blended} blended device pixels, floor ${arc.needed}`,
        });
        expect(
          arc.blended,
          `the ${arc.pseudo} arc has ${arc.blended} blended device pixels, fewer than ${arc.needed}: its outline and fill are not anti-aliased`,
        ).toBeGreaterThanOrEqual(arc.needed);
      }
    });
  }
});
