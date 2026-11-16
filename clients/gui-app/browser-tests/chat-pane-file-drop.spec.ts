import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  centreOf,
  fixture,
  nextFrames,
  type Point,
} from "./support/fixtures.ts";

// A file dragged anywhere over a chat pane (transcript and composer) is taken
// by that chat's composer, and the composer's drop overlay covers the pane.
// jsdom cannot show that the browser really hit-tests the pane, supplies the
// outside `dragover` that ends a drag over a hidden pane, or re-exposes it, so
// these drive TRUSTED drag events through the DevTools protocol
// (`Input.dispatchDragEvent`): Chrome picks each event's target by the
// coordinates, as for a file dragged in from the desktop. What that does not
// prove: the operating system's own drag session (the drag image, the cursor)
// and a file manager's real payload; the transfer here is one image file path.
//
// The fixture (`src/__tests__/browser/chat-pane-file-drop.tsx`) lays out the
// tile's pane element and drop scope around the real transcript surface and
// the real `ChatComposer`, with a stand-in neighbour that has a drop handler
// of its own.

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

interface PaneDropProbe {
  readonly ready: boolean;
  readonly open: () => void;
  readonly setPaneHidden: (hidden: boolean) => void;
  readonly neighbourDrops: () => number;
}

declare global {
  interface Window {
    __paneDrop?: PaneDropProbe;
  }
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type DragType = "dragEnter" | "dragOver" | "drop" | "dragCancel";

interface FileDrag {
  readonly session: CDPSession;
  readonly path: string;
}

async function sendDrag(
  drag: FileDrag,
  type: DragType,
  point: Point,
): Promise<void> {
  await drag.session.send("Input.dispatchDragEvent", {
    type,
    x: point.x,
    y: point.y,
    data: { items: [], files: [drag.path], dragOperationsMask: 1 },
  });
}

/** The first dragenter and dragover of a file drag at `point`. */
async function dragInto(drag: FileDrag, point: Point): Promise<void> {
  await sendDrag(drag, "dragEnter", point);
  await sendDrag(drag, "dragOver", point);
}

/**
 * A drag moved to `point` after its last target was hidden or removed: Chrome
 * answers the first move there with a dragenter alone, and the drag's dragover
 * (the event the pane watches for) from the second.
 */
async function dragMovedTo(drag: FileDrag, point: Point): Promise<void> {
  await sendDrag(drag, "dragOver", point);
  await sendDrag(drag, "dragOver", point);
}

async function openPane(page: Page): Promise<void> {
  await page.goto(fixture("chat-pane-file-drop"));
  await page.waitForFunction(() => window.__paneDrop?.ready === true);
  await page.evaluate(() => window.__paneDrop?.open());
  await expect(
    page.locator("[data-chat-pane] [data-composer-editor]"),
  ).toBeVisible();
  await expect(page.getByText("Earlier prompt number 14")).toBeVisible();
}

async function startDrag(page: Page, testInfoPath: string): Promise<FileDrag> {
  mkdirSync(dirname(testInfoPath), { recursive: true });
  writeFileSync(testInfoPath, PNG_1X1);
  return {
    session: await page.context().newCDPSession(page),
    path: testInfoPath,
  };
}

function overlayOf(page: Page): Locator {
  return page.locator("[data-chat-pane] > .border-dashed");
}

/** A point over the transcript, clear of the composer and the lower layer. */
async function transcriptPoint(page: Page): Promise<Point> {
  const pane = await page.locator("[data-chat-pane]").boundingBox();
  const lower = await page
    .locator("[data-chat-lower-surfaces-overlay]")
    .boundingBox();
  if (pane === null || lower === null) throw new Error("pane has no box");
  const point = {
    x: Math.round(pane.x + pane.width / 2),
    y: Math.round(pane.y + (lower.y - pane.y) / 2),
  };
  const overTranscript = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return (
      hit !== null &&
      hit.closest("[data-chat-pane]") !== null &&
      hit.closest("[data-chat-lower-surfaces-overlay]") === null
    );
  }, point);
  expect(overTranscript, "the point is over the transcript").toBe(true);
  return point;
}

test("a file dragged over the transcript shows the drop overlay across the whole pane, above the composer", async ({
  page,
}, testInfo) => {
  await openPane(page);
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));
  await dragInto(drag, await transcriptPoint(page));

  const overlay = overlayOf(page);
  await expect(overlay).toBeVisible();
  const pane = page.locator("[data-chat-pane]");
  const [overlayBox, paneBox] = await Promise.all([
    overlay.boundingBox(),
    pane.boundingBox(),
  ]);
  if (overlayBox === null || paneBox === null) throw new Error("no box");
  expect(overlayBox.x).toBeCloseTo(paneBox.x, 0);
  expect(overlayBox.y).toBeCloseTo(paneBox.y, 0);
  expect(overlayBox.width).toBeCloseTo(paneBox.width, 0);
  expect(overlayBox.height).toBeCloseTo(paneBox.height, 0);

  // The overlay takes no pointer, so it is made hit-testable for the check:
  // the topmost element at a point then follows paint order. Over the
  // transcript, the composer's editor and the lower layer's own box, the
  // topmost element must be the overlay (or inside it), or the overlay is
  // painted under that surface.
  const paintedAbove = await page.evaluate(() => {
    const overlayElement = document.querySelector<HTMLElement>(
      "[data-chat-pane] > .border-dashed",
    );
    const lower = document.querySelector("[data-chat-lower-surfaces-overlay]");
    const editor = document.querySelector("[data-composer-editor]");
    const pane = document.querySelector("[data-chat-pane]");
    if (
      overlayElement === null ||
      lower === null ||
      editor === null ||
      pane === null
    ) {
      throw new Error("a surface is missing");
    }
    const centreOfBox = (element: Element): { x: number; y: number } => {
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const paneBox = pane.getBoundingClientRect();
    const targets = {
      transcript: { x: paneBox.x + paneBox.width / 2, y: paneBox.y + 40 },
      lowerLayer: centreOfBox(lower),
      composerEditor: centreOfBox(editor),
    };
    overlayElement.style.pointerEvents = "auto";
    const result = Object.fromEntries(
      Object.entries(targets).map(([name, at]) => [
        name,
        overlayElement.contains(document.elementFromPoint(at.x, at.y)),
      ]),
    );
    overlayElement.style.pointerEvents = "";
    return result;
  });
  expect(paintedAbove).toEqual({
    transcript: true,
    lowerLayer: true,
    composerEditor: true,
  });
});

test("a file dropped on the transcript becomes an attachment in that chat's composer", async ({
  page,
}, testInfo) => {
  await openPane(page);
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));
  const point = await transcriptPoint(page);
  await dragInto(drag, point);
  await expect(overlayOf(page)).toBeVisible();
  await sendDrag(drag, "drop", point);

  await expect(
    page.locator(
      "[data-chat-pane] [data-composer-attachment-strip] [data-composer-image-strip-badge]",
    ),
  ).toHaveCount(1);
  await expect(overlayOf(page)).toHaveCount(0);
});

test("a drag over a pane that is hidden and shown again leaves no overlay, and the pane takes the next drag", async ({
  page,
}, testInfo) => {
  await openPane(page);
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));
  const point = await transcriptPoint(page);
  await dragInto(drag, point);
  await expect(overlayOf(page)).toBeVisible();

  // Another pane opens over the one-tile layout: the pane is hidden under the
  // pointer, and the neighbour takes the room it left.
  await page.evaluate(() => window.__paneDrop?.setPaneHidden(true));
  const neighbour = page.getByTestId("neighbour-drop");
  await expect(page.locator("[data-chat-pane]")).toBeHidden();
  await dragMovedTo(drag, await centreOf(neighbour));

  await page.evaluate(() => window.__paneDrop?.setPaneHidden(false));
  await expect(page.locator("[data-chat-pane]")).toBeVisible();
  await expect(overlayOf(page)).toHaveCount(0);
  await nextFrames(page, 3);
  await expect(overlayOf(page)).toHaveCount(0);

  const again = await transcriptPoint(page);
  await dragInto(drag, again);
  await expect(overlayOf(page)).toBeVisible();

  await dragMovedTo(drag, await centreOf(neighbour));
  await expect(overlayOf(page)).toHaveCount(0);
  await sendDrag(drag, "dragCancel", await centreOf(neighbour));
});

test("an overlay whose drag target is removed from under the pointer ends when the drag is seen outside the pane", async ({
  page,
}, testInfo) => {
  await openPane(page);
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));
  const point = await transcriptPoint(page);
  await dragInto(drag, point);
  await expect(overlayOf(page)).toBeVisible();

  // The element the drag last entered leaves the document, so the browser has
  // no node to send its dragleave to: only the drag's next sighting outside
  // the pane can end the overlay.
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    if (target === null) throw new Error("nothing under the drag");
    target.remove();
  }, point);
  await expect(overlayOf(page)).toBeVisible();
  const neighbour = page.getByTestId("neighbour-drop");
  await dragMovedTo(drag, await centreOf(neighbour));
  await expect(overlayOf(page)).toHaveCount(0);
  await sendDrag(drag, "dragCancel", await centreOf(neighbour));
});

test("a neighbouring pane keeps its own drop and the chat composer receives nothing", async ({
  page,
}, testInfo) => {
  await openPane(page);
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));
  const neighbour = page.getByTestId("neighbour-drop");
  const point = await centreOf(neighbour);
  await dragInto(drag, point);
  await nextFrames(page, 3);
  await expect(overlayOf(page)).toHaveCount(0);
  await sendDrag(drag, "drop", point);

  await expect(neighbour).toHaveAttribute("data-drops", "1");
  await nextFrames(page, 3);
  await expect(overlayOf(page)).toHaveCount(0);
  await expect(page.locator("[data-composer-image-strip-badge]")).toHaveCount(
    0,
  );
});
