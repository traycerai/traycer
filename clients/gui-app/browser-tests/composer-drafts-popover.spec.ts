import { expect, test, type Page } from "@playwright/test";

import {
  centreOf,
  chromeLaunchOptions,
  fixture,
  nextFrames,
} from "./support/fixtures.ts";

// The start page's Drafts popover, over the composer editor that keeps focus
// while the list is open. Two claims only real focus and hit testing decide:
// a toast's Undo does not dismiss the list (sonner refocuses the editor when
// its list unmounts, which Radix read as focus leaving), and the revealed
// Open / Copy / Delete buttons are what a click lands on, not the faded
// timestamp that shares their grid cell.

// A fine, hovering pointer (see toast-undo-over-modal.spec.ts), so the row's
// hover reveal behaves the same on every runner.
const MOUSE_INPUT_ARGS = [
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

test.use({
  launchOptions: chromeLaunchOptions(MOUSE_INPUT_ARGS),
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 1,
  permissions: ["clipboard-read", "clipboard-write"],
});

const TRIGGER = "button[aria-label^='Drafts']";
const POPOVER = "[data-slot='popover-content']";
const EDITOR = "[contenteditable='true']";
const ROW = "[data-draft-row-id]";
const TOAST = "[data-sonner-toast][data-mounted=true]";
const UNDO = `${TOAST}[data-front=true] [data-button]`;

interface ProbeState {
  readonly draftIds: ReadonlyArray<string>;
  readonly activeDraftId: string | null;
  readonly closedById: Readonly<Record<string, boolean>>;
}

async function probeState(page: Page): Promise<ProbeState> {
  return page.evaluate<ProbeState>("window.__draftsProbe.state()");
}

async function openList(page: Page): Promise<void> {
  await page.goto(fixture("composer-drafts-popover"));
  await page.waitForFunction("window.__draftsProbeReady === true");
  // The premise the launch flags create: a fine, hovering pointer, where the
  // row's actions are hidden until hover. On a coarse one they are always
  // visible and the hover waits below would prove nothing.
  expect(
    await page.evaluate(
      () => matchMedia("(hover: hover) and (pointer: fine)").matches,
    ),
    "the pointer must be fine and hovering",
  ).toBe(true);
  // Real focus in the editor, as when the person is typing.
  await page.locator(EDITOR).click();
  await expect(page.locator(EDITOR)).toBeFocused();
  await page.locator(TRIGGER).click();
  await expect(page.locator(ROW)).toHaveCount(3);
  await expect(page.locator(EDITOR)).toBeFocused();
  await page.waitForFunction("document.getAnimations().length === 0");
}

/** Hover a row and wait for the actions to be the visible layer. */
async function hoverRow(page: Page, id: string) {
  const row = page.locator(`[data-draft-row-id='${id}']`);
  const { x, y } = await centreOf(row);
  await page.mouse.move(x, y);
  const delete_ = row.getByRole("button", { name: "Delete draft" });
  await expect(delete_.locator("..")).toHaveCSS("opacity", "1");
  // The words slide open under a transition; the centre is final once done.
  await page.waitForFunction("document.getAnimations().length === 0");
  return row;
}

test("Undo on the Deleted toast keeps the Drafts list open", async ({
  page,
}) => {
  await openList(page);
  // Deleted from the keyboard, so this test reaches Undo whether or not the
  // Delete button's own hit target is right (the next test owns that).
  await hoverRow(page, "landing-a");
  await page.keyboard.press("d");
  await expect(page.locator(ROW)).toHaveCount(2);
  await expect(page.locator(UNDO)).toHaveCount(1);
  await page.waitForFunction("document.getAnimations().length === 0");

  const undo = await centreOf(page.locator(UNDO));
  await page.mouse.click(undo.x, undo.y);

  // Undo restored the row once: a second run would list a fourth.
  await expect(page.locator(ROW)).toHaveCount(3);
  await expect(page.locator(TOAST)).toHaveCount(0);
  // Sonner hands focus back to the editor as its list unmounts; that arrival
  // is what used to dismiss the list, so look only after it and a frame.
  await expect(page.locator(EDITOR)).toBeFocused();
  await nextFrames(page, 2);
  await expect(
    page.locator(POPOVER),
    "the toast going must not dismiss the list",
  ).toHaveCount(1);
  expect((await probeState(page)).draftIds).toHaveLength(4);
});

test("a click at the revealed Delete deletes the row and does not open it", async ({
  page,
}) => {
  await openList(page);
  const row = await hoverRow(page, "landing-a");
  const button = row.getByRole("button", { name: "Delete draft" });
  const { x, y } = await centreOf(button);
  expect(
    await button.evaluate(
      (node, point) =>
        node.contains(document.elementFromPoint(point.x, point.y)),
      { x, y },
    ),
    "the hit target at Delete's centre must be Delete or inside it",
  ).toBe(true);

  await page.mouse.click(x, y);

  await expect(page.locator(ROW)).toHaveCount(2);
  const state = await probeState(page);
  expect(state.draftIds).not.toContain("landing-a");
  expect(state.activeDraftId, "the row must not have been opened").toBe(
    "landing-active",
  );
  await expect(page.locator(POPOVER)).toHaveCount(1);
});

test("a click at the revealed Copy copies the draft and does not open it", async ({
  page,
}) => {
  await openList(page);
  const row = await hoverRow(page, "landing-a");
  const button = row.getByRole("button", { name: "Copy draft" });
  const { x, y } = await centreOf(button);
  expect(
    await button.evaluate(
      (node, point) =>
        node.contains(document.elementFromPoint(point.x, point.y)),
      { x, y },
    ),
    "the hit target at Copy's centre must be Copy or inside it",
  ).toBe(true);

  await page.mouse.click(x, y);

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Draft landing-a");
  expect((await probeState(page)).activeDraftId).toBe("landing-active");
  await expect(page.locator(POPOVER)).toHaveCount(1);
});

test("a click at the revealed Open opens that draft", async ({ page }) => {
  await openList(page);
  const row = await hoverRow(page, "landing-b");
  const button = row.getByRole("button", { name: "Open draft" });
  const { x, y } = await centreOf(button);
  expect(
    await button.evaluate(
      (node, point) =>
        node.contains(document.elementFromPoint(point.x, point.y)),
      { x, y },
    ),
    "the hit target at Open's centre must be Open or inside it",
  ).toBe(true);

  await page.mouse.click(x, y);

  await expect
    .poll(async () => (await probeState(page)).activeDraftId)
    .toBe("landing-b");
  await expect(page.locator(POPOVER)).toHaveCount(0);
});
