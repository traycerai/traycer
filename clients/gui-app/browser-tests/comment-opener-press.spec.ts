import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A press that starts a comment replaces the task's open draft, so the draft
// must be asked about, once. The question comes from the opener
// (`yieldOpenDraft`, reached by a pick). In comment mode the guest cancels its
// own mousedown, so a mouse or touch pick never moves focus into the frame and
// relays no press: the pick alone asks. Focus reaches the frame only by
// keyboard (Tab). The press the relay then dispatches on the frame element
// carries the opener mark while Comments is on, so the draft box leaves it
// alone and that Tab asks nothing.
//
// Everything is real input at element centres in the real comment surface and
// sandboxed frame; the questions are the page's `window.confirm` dialogs.

test.use({ viewport: { width: 900, height: 700 }, actionTimeout: 10_000 });

const FRAME_TITLE = "Comment page";
const DISCARD_QUESTION = "Discard this comment draft?";
const WORDS = "unsent words";
const MAX_TABS = 8;

interface CommentModeProbe {
  readonly serve: (url: string) => Promise<{
    readonly status: number;
    readonly mediaType: string;
    readonly base64: string;
  }>;
}
interface ProbeWindow extends Window {
  __commentModeProbe?: CommentModeProbe;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** `window.confirm` questions, answered as `accept` says when each arrives. */
function answerConfirms(page: Page): { asked: string[]; accept: boolean } {
  const state = { asked: [] as string[], accept: false };
  page.on("dialog", (dialog) => {
    state.asked.push(dialog.message());
    void (state.accept ? dialog.accept() : dialog.dismiss());
  });
  return state;
}

function frameElement(page: Page): Locator {
  return page.locator(`iframe[title="${FRAME_TITLE}"]`);
}

function pageFrame(page: Page) {
  return page.frameLocator(`iframe[title="${FRAME_TITLE}"]`);
}

function commentsToggle(page: Page): Locator {
  return page.getByRole("button", { name: "Comments" });
}

function newComment(page: Page): Locator {
  return page.getByRole("dialog", { name: "New comment" });
}

function draftText(page: Page): Locator {
  return page
    .locator('[data-slot="anchored-draft-popover"]')
    .locator('[contenteditable="true"]');
}

/** What the draft says it is on: the line above its composer. */
function draftLabel(page: Page): Locator {
  return page.locator('[data-slot="anchored-draft-popover"] > p').first();
}

async function serveArtifactFromPage(page: Page): Promise<void> {
  await page.route(
    /^https:\/\/artifact-[^/]+\.traycer-artifact\.invalid\//,
    async (route) => {
      const served = await page.evaluate(
        (url) => (window as ProbeWindow).__commentModeProbe?.serve(url),
        route.request().url(),
      );
      if (served === undefined) {
        await route.abort();
        return;
      }
      await route.fulfill({
        status: served.status,
        contentType: served.mediaType,
        body: Buffer.from(served.base64, "base64"),
      });
    },
  );
}

async function open(page: Page): Promise<void> {
  await serveArtifactFromPage(page);
  await page.goto(fixture("html-artifact-comment-mode"));
  await expect(pageFrame(page).locator("#counter")).toHaveText("count 0");
  await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "false");
}

/** Press the toggle; the page waits for the mode, and nothing else. */
async function pressComments(page: Page, on: boolean): Promise<void> {
  await commentsToggle(page).click();
  await expect(commentsToggle(page)).toHaveAttribute(
    "aria-pressed",
    on ? "true" : "false",
  );
}

async function boxInPage(page: Page, selector: string): Promise<Box> {
  const frameBox = await frameElement(page).boundingBox();
  if (frameBox === null) throw new Error("no layout box for the frame");
  const inner = await pageFrame(page)
    .locator(selector)
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  return {
    x: frameBox.x + inner.x,
    y: frameBox.y + inner.y,
    width: inner.width,
    height: inner.height,
  };
}

/** Whole CSS pixels at the element's centre, so a touch lands where a mouse does. */
async function centreInPage(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number }> {
  const box = await boxInPage(page, selector);
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

/** The hover rectangle, which is the outline without the selection's ring. */
function hoverOutline(page: Page): Locator {
  return page.locator("[data-canvas-selection-outline]:not(.ring-1)");
}

/** Move onto the element and wait until the hover rectangle is its own. */
async function hover(page: Page, selector: string): Promise<void> {
  const centre = await centreInPage(page, selector);
  await page.mouse.move(centre.x, centre.y);
  await expect
    .poll(async () => {
      const outline = await hoverOutline(page).first().boundingBox();
      if (outline === null) return Number.POSITIVE_INFINITY;
      const target = await boxInPage(page, selector);
      return Math.max(
        Math.abs(outline.x - target.x),
        Math.abs(outline.y - target.y),
        Math.abs(outline.width - target.width),
        Math.abs(outline.height - target.height),
      );
    })
    .toBeLessThanOrEqual(2);
}

/** Hover, then press: the way a reader picks. */
async function pick(page: Page, selector: string): Promise<void> {
  await hover(page, selector);
  const centre = await centreInPage(page, selector);
  await page.mouse.click(centre.x, centre.y);
}

/** The press right where the pointer lands, with nothing awaited before it. */
async function pickAtOnce(page: Page, selector: string): Promise<void> {
  const centre = await centreInPage(page, selector);
  await page.mouse.click(centre.x, centre.y);
}

/** Comments on, a draft opened on `#top`, and `WORDS` typed into it. */
async function openDirtyDraft(page: Page): Promise<string> {
  await pressComments(page, true);
  await pick(page, "#top");
  await expect(newComment(page)).toBeVisible();
  await draftText(page).fill(WORDS);
  await expect(draftText(page)).toHaveText(WORDS);
  const label = await draftLabel(page).textContent();
  if (label === null) throw new Error("the draft has no label");
  return label;
}

/** Let the gesture settle, then the count must still be what it was. */
async function expectAsked(
  asked: readonly string[],
  count: number,
  page: Page,
): Promise<void> {
  await expect.poll(() => asked.length).toBe(count);
  await nextFrames(page, 8);
  expect(asked).toHaveLength(count);
  for (const question of asked) expect(question).toContain(DISCARD_QUESTION);
}

async function frameHasFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.tagName === "IFRAME");
}

test("a pick on another element asks once, and declining keeps the draft where it was", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  await open(page);
  const label = await openDirtyDraft(page);

  await pick(page, "#note");

  await expectAsked(answers.asked, 1, page);
  await expect(newComment(page)).toBeVisible();
  await expect(draftLabel(page)).toHaveText(label);
  await expect(draftText(page)).toHaveText(WORDS);
});

test("each further pick asks again", async ({ page }) => {
  const answers = answerConfirms(page);
  await open(page);
  await openDirtyDraft(page);

  await pick(page, "#note");
  await expectAsked(answers.asked, 1, page);
  await pick(page, "#fresh");

  await expectAsked(answers.asked, 2, page);
  await expect(draftText(page)).toHaveText(WORDS);
});

test("accepting the question moves the draft to the picked element, empty", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  await open(page);
  const label = await openDirtyDraft(page);
  answers.accept = true;

  await pick(page, "#note");

  await expectAsked(answers.asked, 1, page);
  await expect(newComment(page)).toBeVisible();
  await expect(draftLabel(page)).not.toHaveText(label);
  await expect(draftText(page)).not.toContainText(WORDS);
  await expect(page.getByText(WORDS)).toHaveCount(0);
});

test("a pick the moment Comments turns on again asks exactly once", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  await open(page);
  await openDirtyDraft(page);

  // The mode's own toggle is an outside press too: each press of it asks, and
  // declining keeps the draft.
  await pressComments(page, false);
  await pressComments(page, true);
  await expect(draftText(page)).toHaveText(WORDS);
  const before = answers.asked.length;

  await pickAtOnce(page, "#note");

  await expectAsked(answers.asked, before + 1, page);
  await expect(draftText(page)).toHaveText(WORDS);
});

test("Tab into the frame asks nothing, and the next pick asks once", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  await open(page);
  await openDirtyDraft(page);

  // Keyboard is the only way focus enters the frame in comment mode. The press
  // the relay dispatches on the frame element announces it, and the frame
  // carries the opener mark while Comments is on.
  await commentsToggle(page).focus();
  let inFrame = false;
  for (let tabs = 0; tabs < MAX_TABS && !inFrame; tabs += 1) {
    await page.keyboard.press("Tab");
    await nextFrames(page, 2);
    inFrame = await frameHasFocus(page);
  }
  expect(inFrame).toBe(true);
  await expectAsked(answers.asked, 0, page);

  await pick(page, "#fresh");

  await expectAsked(answers.asked, 1, page);
  await expect(draftText(page)).toHaveText(WORDS);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  // Guards one question per tap with no mouse: no hover exists, so the pointer
  // never enters the page, and the tap's pick is what asks.
  test("a tap on another element asks exactly once", async ({ page }) => {
    const answers = answerConfirms(page);
    await open(page);
    await commentsToggle(page).tap();
    await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "true");
    const top = await centreInPage(page, "#top");
    await page.touchscreen.tap(top.x, top.y);
    await expect(newComment(page)).toBeVisible();
    await draftText(page).fill(WORDS);
    await expect(draftText(page)).toHaveText(WORDS);
    const fresh = await centreInPage(page, "#fresh");

    await page.touchscreen.tap(fresh.x, fresh.y);

    await expectAsked(answers.asked, 1, page);
    await expect(draftText(page)).toHaveText(WORDS);
  });
});
