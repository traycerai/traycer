import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// A press that starts a comment replaces the task's open draft, so the draft
// must be asked about, once. The question comes from the opener
// (`yieldOpenDraft`, reached by a pick). In comment mode the guest cancels its
// own mousedown, so a mouse or touch pick never moves focus into the frame and
// relays no press: the pick alone asks. Focus reaches the frame only by
// keyboard (Tab). The press the relay then dispatches on the frame element
// carries the opener mark while Comments is on, so the draft box leaves it
// alone and that Tab asks nothing.
//
// Every gesture is followed to its own end, never to a quiet interval: the
// guest's pick message arrives, the selection ring settles on the picked
// element, and then the pick's terminal is observed (its question, or for an
// accepted question the draft moving to the new element). A trace installed
// in the top window counts the guest's pick messages and the relayed frame
// presses, so each gesture also proves how many of each it produced.
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

interface PressTrace {
  picks: number;
  relayed: number;
}

interface ProbeWindow extends Window {
  __commentModeProbe?: CommentModeProbe;
  __pressTrace?: PressTrace;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Answers {
  readonly asked: string[];
  accept: boolean;
}

/** `window.confirm` questions, answered as `accept` says when each arrives. */
function answerConfirms(page: Page): Answers {
  const state: Answers = { asked: [], accept: false };
  page.on("dialog", (dialog) => {
    state.asked.push(dialog.message());
    void (state.accept ? dialog.accept() : dialog.dismiss());
  });
  return state;
}

/**
 * Runs in the top window before the app: counts the guest's pick messages and
 * the presses the relay replays on the frame element (synthetic clicks whose
 * target is an iframe). Init scripts also run in frames, which are skipped.
 */
function installPressTrace(): void {
  if (window !== window.top) return;
  const trace = { picks: 0, relayed: 0 };
  Reflect.set(window, "__pressTrace", trace);
  window.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    if (!("jsonrpc" in data) || !("method" in data)) return;
    if (data.jsonrpc === "2.0" && data.method === "traycer/canvas/pick")
      trace.picks += 1;
  });
  window.addEventListener("click", (event) => {
    if (!event.isTrusted && event.target instanceof HTMLIFrameElement)
      trace.relayed += 1;
  });
}

async function readTrace(page: Page): Promise<PressTrace> {
  return page.evaluate(() => {
    const trace = (window as ProbeWindow).__pressTrace;
    if (trace === undefined)
      throw new Error("the press trace is not installed");
    return { picks: trace.picks, relayed: trace.relayed };
  });
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
  await page.addInitScript(installPressTrace);
  await page.goto(fixture("html-artifact-comment-mode"));
  await expect(pageFrame(page).locator("#counter")).toHaveText("count 0");
  await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "false");
}

/**
 * Press the toggle. Each press asks synchronously in its pointerdown, before
 * the click flips the mode, so the mode changing is that press's terminal.
 */
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

/** Largest edge by which `marker` misses the element's box. */
async function boxDelta(
  page: Page,
  marker: Locator,
  selector: string,
): Promise<number> {
  const outline = await marker.first().boundingBox();
  if (outline === null) return Number.POSITIVE_INFINITY;
  const target = await boxInPage(page, selector);
  return Math.max(
    Math.abs(outline.x - target.x),
    Math.abs(outline.y - target.y),
    Math.abs(outline.width - target.width),
    Math.abs(outline.height - target.height),
  );
}

/** The hover rectangle, which is the outline without the selection's ring. */
function hoverOutline(page: Page): Locator {
  return page.locator("[data-canvas-selection-outline]:not(.ring-1)");
}

/** The picked element's rectangle: the outline with the selection's ring. */
function selectionRing(page: Page): Locator {
  return page.locator("[data-canvas-selection-outline].ring-1");
}

/** Move onto the element and wait until the hover rectangle is its own. */
async function hover(page: Page, selector: string): Promise<void> {
  const centre = await centreInPage(page, selector);
  await page.mouse.move(centre.x, centre.y);
  await expect
    .poll(() => boxDelta(page, hoverOutline(page), selector))
    .toBeLessThanOrEqual(2);
}

/** Hover, then press: the way a reader picks with a mouse. */
async function mousePick(page: Page, selector: string): Promise<void> {
  await hover(page, selector);
  const centre = await centreInPage(page, selector);
  await page.mouse.click(centre.x, centre.y);
}

/** The press right where the pointer lands, with no hover before it. */
async function mouseClick(page: Page, selector: string): Promise<void> {
  const centre = await centreInPage(page, selector);
  await page.mouse.click(centre.x, centre.y);
}

async function tap(page: Page, selector: string): Promise<void> {
  const centre = await centreInPage(page, selector);
  await page.touchscreen.tap(centre.x, centre.y);
}

/**
 * One pick, followed to its end: the guest delivers exactly one pick message,
 * the selection ring settles on the element, and then `terminal` observes what
 * the pick finally did. Nothing is relayed by a pick, so the relayed count
 * stays where it was.
 */
async function gesture(
  page: Page,
  selector: string,
  press: () => Promise<void>,
  terminal: () => Promise<void>,
): Promise<void> {
  const before = await readTrace(page);
  await press();
  await expect
    .poll(async () => (await readTrace(page)).picks)
    .toBe(before.picks + 1);
  await expect
    .poll(() => boxDelta(page, selectionRing(page), selector))
    .toBeLessThanOrEqual(2);
  await terminal();
  expect(await readTrace(page)).toEqual({
    picks: before.picks + 1,
    relayed: before.relayed,
  });
}

/**
 * The questions asked so far are exactly `count`. A declined pick ends at its
 * question, and nothing a gesture asks comes after its terminal.
 */
async function expectQuestions(answers: Answers, count: number): Promise<void> {
  await expect.poll(() => answers.asked.length).toBe(count);
  expect(answers.asked).toHaveLength(count);
  for (const question of answers.asked)
    expect(question).toContain(DISCARD_QUESTION);
}

/** Comments on, a draft opened on `#top`, and `WORDS` typed into it. */
async function openDirtyDraft(page: Page): Promise<string> {
  await pressComments(page, true);
  await gesture(
    page,
    "#top",
    () => mousePick(page, "#top"),
    () => expect(newComment(page)).toBeVisible(),
  );
  await draftText(page).fill(WORDS);
  await expect(draftText(page)).toHaveText(WORDS);
  const label = await draftLabel(page).textContent();
  if (label === null) throw new Error("the draft has no label");
  return label;
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
  await expectQuestions(answers, 0);

  await gesture(
    page,
    "#note",
    () => mousePick(page, "#note"),
    () => expectQuestions(answers, 1),
  );

  await expect(newComment(page)).toBeVisible();
  await expect(draftLabel(page)).toHaveText(label);
  await expect(draftText(page)).toHaveText(WORDS);
});

test("each further pick asks again", async ({ page }) => {
  const answers = answerConfirms(page);
  await open(page);
  await openDirtyDraft(page);
  await gesture(
    page,
    "#note",
    () => mousePick(page, "#note"),
    () => expectQuestions(answers, 1),
  );

  await gesture(
    page,
    "#fresh",
    () => mousePick(page, "#fresh"),
    () => expectQuestions(answers, 2),
  );

  await expect(draftText(page)).toHaveText(WORDS);
});

test("accepting the question moves the draft to the picked element, empty", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  await open(page);
  const label = await openDirtyDraft(page);
  answers.accept = true;

  await gesture(
    page,
    "#note",
    () => mousePick(page, "#note"),
    async () => {
      await expectQuestions(answers, 1);
      await expect(draftLabel(page)).not.toHaveText(label);
    },
  );

  await expect(newComment(page)).toBeVisible();
  await expect(draftText(page)).not.toContainText(WORDS);
  await expect(page.getByText(WORDS)).toHaveCount(0);
});

test("the first pick after Comments is turned back on asks once", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  await open(page);
  await openDirtyDraft(page);

  // The mode's own toggle is an outside press too: each press of it asks, and
  // declining keeps the draft. Each press ends when the mode has flipped.
  await pressComments(page, false);
  await pressComments(page, true);
  await expect(draftText(page)).toHaveText(WORDS);
  const before = answers.asked.length;

  await gesture(
    page,
    "#note",
    () => mouseClick(page, "#note"),
    () => expectQuestions(answers, before + 1),
  );

  await expect(draftText(page)).toHaveText(WORDS);
});

test("Tab into the frame asks nothing, and the next pick asks once", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  await open(page);
  await openDirtyDraft(page);
  const before = await readTrace(page);

  // Keyboard is the only way focus enters the frame in comment mode. The press
  // the relay dispatches on the frame element announces it, and the frame
  // carries the opener mark while Comments is on.
  await commentsToggle(page).focus();
  let inFrame = false;
  for (let tabs = 0; tabs < MAX_TABS && !inFrame; tabs += 1) {
    await page.keyboard.press("Tab");
    inFrame = await frameHasFocus(page);
  }
  expect(inFrame).toBe(true);
  await expect
    .poll(async () => (await readTrace(page)).relayed)
    .toBe(before.relayed + 1);
  expect(answers.asked).toHaveLength(0);
  await expect(draftText(page)).toHaveText(WORDS);

  await gesture(
    page,
    "#fresh",
    () => mousePick(page, "#fresh"),
    () => expectQuestions(answers, 1),
  );

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
    await gesture(
      page,
      "#top",
      () => tap(page, "#top"),
      () => expect(newComment(page)).toBeVisible(),
    );
    await draftText(page).fill(WORDS);
    await expect(draftText(page)).toHaveText(WORDS);

    await gesture(
      page,
      "#fresh",
      () => tap(page, "#fresh"),
      () => expectQuestions(answers, 1),
    );

    await expect(draftText(page)).toHaveText(WORDS);
  });
});
