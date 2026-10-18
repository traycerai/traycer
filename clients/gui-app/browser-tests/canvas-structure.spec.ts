import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// Browser regression: the canvas structure gestures (reorder, resize) and the
// align arithmetic, against Chrome's real layout.
//
// Drives `src/__tests__/browser/canvas-structure.html`: a real canvas page in
// an iframe, read through the real `SandboxBridgeHost`, with the production
// `CanvasStructureOverlay` and its gesture hook placed over it the way the
// canvas places it (an untransformed overlay sharing the board's zoom
// transform). The only fake is the host: `epic.editArtboard` records the
// request, so a spec reads exactly what a gesture would have saved.
//
// The claims are the ones jsdom cannot decide: a trusted mouse drag at canvas
// zoom lands on the right CSS pixels, Escape ends a drag Chrome still holds
// the pointer for, a page that changes under a gesture is noticed from its real
// geometry, and an alignment never changes an element's size for boxes anchored
// in the ways computed styles cannot tell apart.
//
// What is NOT here, because jsdom decides it: the arithmetic on hand-made
// layouts, selection and revision guards around a held reply, and the toolbar
// (`components/canvas-artifact/__tests__/`).

test.use({ viewport: { width: 1000, height: 700 }, actionTimeout: 10_000 });

const BOARD_CSS_WIDTH = 640;

interface RecordedEdit {
  readonly kind: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly before:
    | {
        readonly kind: "position";
        readonly startTagOffset: number;
        readonly tagName: string;
      }
    | { readonly kind: "tid"; readonly tid: string }
    | null;
}

interface Measure {
  readonly width: number;
  readonly height: number;
}

interface AlignMeasurement {
  readonly applied: boolean;
  readonly before: Readonly<Record<string, Measure>>;
  readonly after: Readonly<Record<string, Measure>>;
  readonly edges: Readonly<Record<string, { x: number; y: number }>>;
}

interface StructureProbe {
  readonly ready: boolean;
  readonly select: (tid: string) => Promise<void>;
  readonly edits: () => readonly RecordedEdit[];
  readonly alignAndMeasure: (
    tids: readonly string[],
    mode: string,
  ) => Promise<AlignMeasurement>;
}

interface ProbeWindow extends Window {
  __structureProbe?: StructureProbe;
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${fixture("canvas-structure")}${query}`);
  // The positive event: the board's page answered and the probe is installed.
  await expect(page.locator("#stage")).toHaveAttribute("data-ready", "true");
  await page.waitForFunction(
    () => (window as ProbeWindow).__structureProbe?.ready === true,
  );
}

async function select(page: Page, tid: string): Promise<void> {
  await page.evaluate(
    (target) => (window as ProbeWindow).__structureProbe?.select(target),
    tid,
  );
}

async function openRowWithSelected(
  page: Page,
  zoom: number,
  tid: string,
): Promise<void> {
  await open(page, `?zoom=${String(zoom)}`);
  await select(page, tid);
  // The overlay draws its handles once the page has reported the layout.
  await expect(resizeHandle(page, "bottom right")).toBeVisible();
  await expect(reorderHandle(page, 1)).toBeEnabled();
  await nextFrames(page, 2);
}

function reorderHandle(page: Page, index: number): Locator {
  return page.getByRole("button", { name: `Reorder element (${String(index)})` });
}

function resizeHandle(page: Page, corner: string): Locator {
  return page.getByRole("button", { name: `Resize element ${corner}` });
}

function insertionBar(page: Page): Locator {
  return page.locator("[data-canvas-insertion-marker]");
}

async function recordedEdits(page: Page): Promise<readonly RecordedEdit[]> {
  return page.evaluate(
    () => (window as ProbeWindow).__structureProbe?.edits() ?? [],
  );
}

/** The screen point of a point given in the board's own CSS pixels. */
async function screenPoint(
  page: Page,
  cssX: number,
  cssY: number,
): Promise<{ readonly x: number; readonly y: number }> {
  const box = await page.locator("#board").boundingBox();
  if (box === null) throw new Error("the board has no layout box");
  const scale = box.width / BOARD_CSS_WIDTH;
  return { x: box.x + cssX * scale, y: box.y + cssY * scale };
}

/** The marker the board's page stamped on the element, which names it in source. */
async function markerOf(page: Page, tid: string): Promise<number> {
  const marker = await page
    .frameLocator("#board")
    .locator(`[data-tid="${tid}"]`)
    .getAttribute("data-traycer-pos");
  if (marker === null) throw new Error(`${tid} has no marker`);
  return Number(marker);
}

async function pressAt(
  page: Page,
  point: { readonly x: number; readonly y: number },
): Promise<void> {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
}

async function dragFrom(
  page: Page,
  handle: Locator,
  by: { readonly x: number; readonly y: number },
): Promise<void> {
  const start = await centreOf(handle);
  await pressAt(page, start);
  await page.mouse.move(start.x + by.x, start.y + by.y, { steps: 6 });
}

test.describe("resizing at canvas zoom", () => {
  // The board is drawn at `zoom` of its CSS size: a screen pixel is 1/zoom of
  // a CSS pixel, so one drag asks for a different size at each zoom. Card `a`
  // is 100 x 60 with a 1px border, in a border-box.
  for (const zoom of [0.5, 1, 2]) {
    test(`a 40 x 20 screen drag at ${String(zoom)}x grows the card by 40/${String(zoom)} x 20/${String(zoom)}`, async ({
      page,
    }) => {
      await openRowWithSelected(page, zoom, "a");

      await dragFrom(page, resizeHandle(page, "bottom right"), { x: 40, y: 20 });
      // The positive event: the dashed preview shows the size that will be saved.
      await expect(page.locator("[data-canvas-resize-preview]")).toBeVisible();
      await page.mouse.up();

      await expect.poll(async () => (await recordedEdits(page)).length).toBe(1);
      const [edit] = await recordedEdits(page);
      expect(edit.kind).toBe("set-box");
      expect(edit.width ?? Number.NaN).toBeCloseTo(100 + 40 / zoom, 0);
      expect(edit.height ?? Number.NaN).toBeCloseTo(60 + 20 / zoom, 0);
    });
  }

  test("the dashed preview sits where the saved size will put the card", async ({
    page,
  }) => {
    await openRowWithSelected(page, 2, "a");
    await dragFrom(page, resizeHandle(page, "bottom right"), { x: 60, y: 40 });

    const preview = page.locator("[data-canvas-resize-preview]");
    await expect(preview).toBeVisible();
    const previewBox = await preview.boundingBox();
    if (previewBox === null) throw new Error("the preview has no box");
    // The card is 100 x 60 CSS; at 2x the drag is 30 x 20 CSS more.
    expect(previewBox.width).toBeCloseTo(2 * 130, -1);
    expect(previewBox.height).toBeCloseTo(2 * 80, -1);
    await page.mouse.up();
  });
});

test.describe("reordering at canvas zoom", () => {
  for (const zoom of [0.5, 1, 2]) {
    test(`dropping a over c's left half at ${String(zoom)}x moves a before c`, async ({
      page,
    }) => {
      await openRowWithSelected(page, zoom, "a");
      const cMarker = await markerOf(page, "c");

      // Card a is x 40..140, b 160..260, c 280..380 in the board; 270 is
      // past b's middle and before c's.
      const drop = await screenPoint(page, 270, 90);
      await pressAt(page, await centreOf(reorderHandle(page, 1)));
      await page.mouse.move(drop.x, drop.y, { steps: 8 });
      await expect(insertionBar(page)).toBeVisible();
      await page.mouse.up();

      await expect.poll(async () => (await recordedEdits(page)).length).toBe(1);
      const [edit] = await recordedEdits(page);
      expect(edit.kind).toBe("move-element");
      expect(edit.before).toEqual({
        kind: "position",
        startTagOffset: cMarker,
        tagName: "div",
      });
    });
  }

  test("dropping past the last card moves it to the end", async ({ page }) => {
    await openRowWithSelected(page, 1, "a");

    const drop = await screenPoint(page, 400, 90);
    await pressAt(page, await centreOf(reorderHandle(page, 1)));
    await page.mouse.move(drop.x, drop.y, { steps: 8 });
    await expect(insertionBar(page)).toBeVisible();
    await page.mouse.up();

    await expect.poll(async () => (await recordedEdits(page)).length).toBe(1);
    const [edit] = await recordedEdits(page);
    expect(edit.kind).toBe("move-element");
    expect(edit.before).toBeNull();
  });
});

test.describe("Escape cancels a gesture", () => {
  for (const zoom of [1, 2]) {
    test(`a reorder abandoned with Escape at ${String(zoom)}x saves nothing, and the next drag still works`, async ({
      page,
    }) => {
      await openRowWithSelected(page, zoom, "a");
      const cMarker = await markerOf(page, "c");
      const drop = await screenPoint(page, 270, 90);

      await pressAt(page, await centreOf(reorderHandle(page, 1)));
      await page.mouse.move(drop.x, drop.y, { steps: 8 });
      await expect(insertionBar(page)).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(insertionBar(page)).toBeHidden();
      await page.mouse.up();

      // The next drag is the positive event for the first one's silence: it
      // is the only save, so the abandoned one never reached the host.
      await pressAt(page, await centreOf(reorderHandle(page, 1)));
      await page.mouse.move(drop.x, drop.y, { steps: 8 });
      await expect(insertionBar(page)).toBeVisible();
      await page.mouse.up();

      await expect.poll(async () => (await recordedEdits(page)).length).toBe(1);
      const [edit] = await recordedEdits(page);
      expect(edit.before).toEqual({
        kind: "position",
        startTagOffset: cMarker,
        tagName: "div",
      });
    });
  }

  test("a resize abandoned with Escape saves nothing", async ({ page }) => {
    await openRowWithSelected(page, 1, "a");

    await dragFrom(page, resizeHandle(page, "bottom right"), { x: 50, y: 30 });
    await expect(page.locator("[data-canvas-resize-preview]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-canvas-resize-preview]")).toBeHidden();
    await page.mouse.up();

    // A second, completed gesture is the positive event.
    await dragFrom(page, resizeHandle(page, "bottom right"), { x: 20, y: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await recordedEdits(page)).length).toBe(1);
    const [edit] = await recordedEdits(page);
    expect(edit.width ?? Number.NaN).toBeCloseTo(120, 0);
  });
});

test.describe("the board changes under a gesture", () => {
  test("a drag over siblings the page has since resized saves nothing and says why", async ({
    page,
  }) => {
    await openRowWithSelected(page, 1, "a");
    const drop = await screenPoint(page, 270, 90);

    await pressAt(page, await centreOf(reorderHandle(page, 1)));
    await page.mouse.move(drop.x, drop.y, { steps: 8 });
    await expect(insertionBar(page)).toBeVisible();

    // The page changes the row itself, as a script on the board would.
    await page
      .frameLocator("#board")
      .locator('[data-tid="b"]')
      .evaluate((element) => {
        element.setAttribute("style", "width:160px");
      });
    await page.mouse.up();

    await expect(page.getByRole("status")).toBeVisible();
    expect(await recordedEdits(page)).toEqual([]);
  });
});

test.describe("alignment never changes a size", () => {
  // Chrome reports computed `left`, `right` and `width` of an absolutely
  // positioned box as used pixels whichever way it is anchored, so an auto-width
  // box anchored by `right` looks the same as one with a fixed width. Writing
  // `left` on the first stretches it. The claim holds for the arithmetic the
  // toolbar uses, on the page's own layout: it either refuses or leaves every
  // size as it was.
  async function align(
    page: Page,
    tids: readonly string[],
    mode: string,
  ): Promise<AlignMeasurement> {
    const result = await page.evaluate(
      ([targets, how]) =>
        (window as ProbeWindow).__structureProbe?.alignAndMeasure(targets, how),
      [tids, mode] as const,
    );
    if (result === undefined) throw new Error("the probe is missing");
    return result;
  }

  function expectSizesKept(result: AlignMeasurement): void {
    for (const [tid, before] of Object.entries(result.before)) {
      expect(result.after[tid].width).toBeCloseTo(before.width, 0);
      expect(result.after[tid].height).toBeCloseTo(before.height, 0);
    }
  }

  test("a fixed-width box anchored by right aligns with a left-anchored one", async ({
    page,
  }) => {
    await open(page, "?board=align");
    const result = await align(page, ["free", "fixed-right"], "left");

    expect(result.applied).toBe(true);
    expectSizesKept(result);
    expect(result.edges["fixed-right"].x).toBeCloseTo(result.edges.free.x, 0);
  });

  for (const [name, tid, mode] of [
    ["an auto-width box anchored by right", "auto-right", "left"],
    ["a box stretched between left and right", "stretch", "right"],
    ["an auto-height box anchored by bottom", "auto-bottom", "top"],
  ] as const) {
    test(`${name} is refused or keeps its size`, async ({ page }) => {
      await open(page, "?board=align");
      const result = await align(page, ["free", tid], mode);

      expectSizesKept(result);
    });
  }

  test("a relative box whose right wins in a right-to-left container is refused or lined up", async ({
    page,
  }) => {
    await open(page, "?board=rtl");
    const result = await align(page, ["rel-left", "rel-right"], "left");

    expectSizesKept(result);
    // Writing `left` there moves nothing, so an applied edit would leave the
    // edges apart: it has to be refused instead.
    if (result.applied)
      expect(result.edges["rel-right"].x).toBeCloseTo(result.edges["rel-left"].x, 0);
  });

  test("an alignment that is applied lines the edges up", async ({ page }) => {
    await open(page, "?board=align");
    const result = await align(page, ["free", "fixed-right"], "top");

    expect(result.applied).toBe(true);
    expect(result.edges["fixed-right"].y).toBeCloseTo(result.edges.free.y, 0);
  });
});
