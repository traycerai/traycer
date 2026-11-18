import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
} from "@playwright/test";
import { fixture, nextFrames, type Point } from "./support/fixtures.ts";

// A file dragged anywhere over a Tracy pane is taken by that pane's message
// box, and the box's drop overlay covers the pane: the channel's section, the
// thread pane's section and each Threads card. jsdom lays nothing out, so
// these drive TRUSTED drag events through the DevTools protocol
// (`Input.dispatchDragEvent`, as `chat-pane-file-drop.spec.ts` does) with a real
// file, and read back what Chrome hit-tests and paints: that the pane is
// positioned for its overlay, the overlay's geometry and paint order, a card's
// rounded corners, a hidden pane under the pointer, a pane whose drag target
// leaves the document, and a retained card whose box unmounts mid-drag.
//
// The fixtures are the existing pages: `bot-threads-cards` (`?surface=channel`
// for the channel section over the real transcript, the default for the cards)
// and `bot-thread-tasks-bound` (`?images=delivered` lets its thread panel's box
// take images).

declare global {
  interface Window {
    __postGone?: (threadId: string) => void;
  }
}

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type DragType = "dragEnter" | "dragOver" | "drop" | "dragCancel";

interface FileDrag {
  readonly session: CDPSession;
  readonly path: string;
}

const CHANNEL = '[data-testid="bot-channel"]';
const PANEL = '[data-testid="bot-thread-panel"]';
const CARD = '[data-testid="bot-thread-card"]';
const BADGE = "[data-composer-image-strip-badge]";

function overlayIn(page: Page, pane: string): Locator {
  return page.locator(`${pane} > .border-dashed`);
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

async function dragInto(drag: FileDrag, point: Point): Promise<void> {
  await sendDrag(drag, "dragEnter", point);
  await sendDrag(drag, "dragOver", point);
}

/** A drag moved to `point` after its last target was hidden or removed. */
async function dragMovedTo(drag: FileDrag, point: Point): Promise<void> {
  await sendDrag(drag, "dragOver", point);
  await sendDrag(drag, "dragOver", point);
}

async function startDrag(page: Page, path: string): Promise<FileDrag> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG_1X1);
  return { session: await page.context().newCDPSession(page), path };
}

async function openChannel(page: Page, query: string): Promise<void> {
  await page.goto(`${fixture("bot-threads-cards")}?surface=channel&${query}`);
  await expect(page.locator(`${CHANNEL} [data-composer-editor]`)).toBeVisible();
}

async function openCards(page: Page): Promise<void> {
  await page.goto(fixture("bot-threads-cards"));
  await expect(
    page.locator(`${CARD}[data-thread-id="thread-release"]`),
  ).toHaveAttribute("data-full", "true");
}

async function openPanel(page: Page): Promise<void> {
  await page.goto(
    `${fixture("bot-thread-tasks-bound")}?loaded=true&images=delivered`,
  );
  await expect(page.locator(`${PANEL} [data-composer-editor]`)).toBeVisible();
}

/** A point over the pane that no box, button or layer of its own covers: its top-left inset. */
async function paneCorner(page: Page, pane: string): Promise<Point> {
  const box = await page.locator(pane).first().boundingBox();
  if (box === null) throw new Error(`${pane} has no box`);
  return { x: Math.round(box.x + 24), y: Math.round(box.y + 24) };
}

async function positionOf(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).position);
}

/**
 * The overlay fills the pane's padding box (`absolute inset-0`): the pane's box
 * inset by its own border widths, which are none on the channel section and the
 * thread pane, so those match exactly, and one pixel on a card.
 */
async function overlayMatchesPane(
  pane: Locator,
  overlay: Locator,
): Promise<void> {
  await expect(overlay).toBeVisible();
  const [overlayBox, paneBox, borders] = await Promise.all([
    overlay.boundingBox(),
    pane.first().boundingBox(),
    pane.first().evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        left: parseFloat(style.borderLeftWidth),
        top: parseFloat(style.borderTopWidth),
        right: parseFloat(style.borderRightWidth),
        bottom: parseFloat(style.borderBottomWidth),
      };
    }),
  ]);
  if (overlayBox === null || paneBox === null) throw new Error("no box");
  expect(overlayBox.x).toBeCloseTo(paneBox.x + borders.left, 0);
  expect(overlayBox.y).toBeCloseTo(paneBox.y + borders.top, 0);
  expect(overlayBox.width).toBeCloseTo(
    paneBox.width - borders.left - borders.right,
    0,
  );
  expect(overlayBox.height).toBeCloseTo(
    paneBox.height - borders.top - borders.bottom,
    0,
  );
}

/** Whether the overlay is painted above the pane's own box, at the box's centre. */
async function overlayPaintedAboveBox(
  page: Page,
  pane: string,
): Promise<boolean> {
  return page.evaluate((selector) => {
    const overlayElement = document.querySelector<HTMLElement>(
      `${selector} > .border-dashed`,
    );
    const editor = document.querySelector(`${selector} [data-composer-editor]`);
    if (overlayElement === null || editor === null) {
      throw new Error("a surface is missing");
    }
    editor.scrollIntoView({ block: "center" });
    const box = editor.getBoundingClientRect();
    overlayElement.style.pointerEvents = "auto";
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
    if (hit === null) {
      overlayElement.style.pointerEvents = "";
      throw new Error("the probe point is outside the viewport");
    }
    const above = overlayElement.contains(hit);
    overlayElement.style.pointerEvents = "";
    return above;
  }, pane);
}

test("the channel section is positioned, and its overlay covers it above the box", async ({
  page,
}, testInfo) => {
  await openChannel(page, "");
  expect(await positionOf(page, CHANNEL)).toBe("relative");
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));

  await dragInto(drag, await paneCorner(page, CHANNEL));

  await overlayMatchesPane(page.locator(CHANNEL), overlayIn(page, CHANNEL));
  expect(await overlayPaintedAboveBox(page, CHANNEL)).toBe(true);
});

test("a file dropped on the channel's transcript becomes an attachment in the channel's box", async ({
  page,
}, testInfo) => {
  await openChannel(page, "");
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));
  const point = await paneCorner(page, CHANNEL);
  await dragInto(drag, point);
  await expect(overlayIn(page, CHANNEL)).toBeVisible();

  await sendDrag(drag, "drop", point);

  await expect(page.locator(`${CHANNEL} ${BADGE}`)).toHaveCount(1);
  await expect(overlayIn(page, CHANNEL)).toHaveCount(0);
});

test("the thread pane's section is positioned, and its overlay covers it above the box", async ({
  page,
}, testInfo) => {
  await openPanel(page);
  expect(await positionOf(page, PANEL)).toBe("relative");
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));

  await dragInto(drag, await paneCorner(page, PANEL));

  await overlayMatchesPane(page.locator(PANEL), overlayIn(page, PANEL));
  expect(await overlayPaintedAboveBox(page, PANEL)).toBe(true);
});

test("a Threads card is positioned, and its overlay covers it with the card's own rounded corners", async ({
  page,
}, testInfo) => {
  await openCards(page);
  const card = page.locator(`${CARD}[data-thread-id="thread-release"]`);
  expect(await card.evaluate((el) => getComputedStyle(el).position)).toBe(
    "relative",
  );
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));

  await dragInto(
    drag,
    await paneCorner(page, `${CARD}[data-thread-id="thread-release"]`),
  );

  const overlay = card.locator("> .border-dashed");
  await overlayMatchesPane(card, overlay);
  const radii = await Promise.all([
    card.evaluate((el) => getComputedStyle(el).borderTopLeftRadius),
    overlay.evaluate((el) => getComputedStyle(el).borderTopLeftRadius),
  ]);
  expect(radii[0]).not.toBe("0px");
  expect(radii[1]).toBe(radii[0]);
  expect(
    await overlayPaintedAboveBox(
      page,
      `${CARD}[data-thread-id="thread-release"]`,
    ),
  ).toBe(true);
});

test("a drag over a channel that is hidden and shown again leaves no overlay, and the channel takes the next drag", async ({
  page,
}, testInfo) => {
  await openChannel(page, "");
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));
  await dragInto(drag, await paneCorner(page, CHANNEL));
  await expect(overlayIn(page, CHANNEL)).toBeVisible();

  await page.evaluate((selector) => {
    const section = document.querySelector<HTMLElement>(selector);
    if (section !== null) section.style.display = "none";
  }, CHANNEL);
  await expect(page.locator(CHANNEL)).toBeHidden();
  await dragMovedTo(drag, { x: 20, y: 20 });
  await page.evaluate((selector) => {
    const section = document.querySelector<HTMLElement>(selector);
    if (section !== null) section.style.display = "";
  }, CHANNEL);

  await expect(page.locator(CHANNEL)).toBeVisible();
  await expect(overlayIn(page, CHANNEL)).toHaveCount(0);
  await nextFrames(page, 3);
  await expect(overlayIn(page, CHANNEL)).toHaveCount(0);
  await dragInto(drag, await paneCorner(page, CHANNEL));
  await expect(overlayIn(page, CHANNEL)).toBeVisible();
  await sendDrag(drag, "dragCancel", { x: 20, y: 20 });
});

test("an overlay whose drag target is removed from under the pointer ends when the drag is seen outside the pane", async ({
  page,
}, testInfo) => {
  await openChannel(page, "width=600");
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));
  const point = await paneCorner(page, CHANNEL);
  await dragInto(drag, point);
  await expect(overlayIn(page, CHANNEL)).toBeVisible();

  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    if (target === null) throw new Error("nothing under the drag");
    target.remove();
  }, point);
  await expect(overlayIn(page, CHANNEL)).toBeVisible();
  await dragMovedTo(drag, { x: 800, y: 300 });

  await expect(overlayIn(page, CHANNEL)).toHaveCount(0);
  await sendDrag(drag, "dragCancel", { x: 800, y: 300 });
});

test("a retained card whose box goes mid-drag loses its overlay and takes no later drop", async ({
  page,
}, testInfo) => {
  await openCards(page);
  const selector = `${CARD}[data-thread-id="thread-release"]`;
  const card = page.locator(selector);
  const drag = await startDrag(page, testInfo.outputPath("pane-drop.png"));
  const point = await paneCorner(page, selector);
  await dragInto(drag, point);
  await expect(card.locator("> .border-dashed")).toBeVisible();

  await page.evaluate(() => window.__postGone?.("thread-release"));
  await expect(card).toHaveAttribute("data-full", "false");
  await expect(card.locator("> .border-dashed")).toHaveCount(0);

  const later = await paneCorner(page, selector);
  await dragInto(drag, later);
  await sendDrag(drag, "drop", later);
  await nextFrames(page, 3);
  await expect(card.locator("> .border-dashed")).toHaveCount(0);
  await expect(page.locator(BADGE)).toHaveCount(0);
});
