import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// An artifact card in a task chat is a row of a virtualized list, and its
// comment surface can be raised over the task. What the reader has typed in a
// comment draft lives only in that row, so the list must not unmount it and a
// blocker that yields the raise must not take the draft with it. The pieces
// are covered in jsdom; this drives the real card inside the real transcript
// (`ChatMessages` over LegendList), where a row really unmounts when it
// scrolls far away.
//
// Each page lives in a sandboxed frame; Playwright's frame locators read it.

test.use({ viewport: { width: 900, height: 700 }, actionTimeout: 10_000 });

const CARD_A = "Report A";
const CARD_B = "Report B";
const DISCARD_QUESTION = "Discard this comment draft?";

interface ChatCardProbe {
  readonly serve: (url: string) => Promise<{
    readonly status: number;
    readonly mediaType: string;
    readonly base64: string;
  }>;
  readonly advanceHead: (artifactId: string) => void;
  readonly holdBlocker: () => void;
  readonly releaseBlocker: () => void;
  readonly failNextCreate: () => void;
}
interface ProbeWindow extends Window {
  __chatCardProbe?: ChatCardProbe;
}

/** The `window.confirm` questions the page asked; each is dismissed. */
function recordConfirms(page: Page): string[] {
  const asked: string[] = [];
  page.on("dialog", (dialog) => {
    asked.push(dialog.message());
    void dialog.dismiss();
  });
  return asked;
}

async function serveArtifactFromPage(page: Page): Promise<void> {
  await page.route(
    /^https:\/\/artifact-[^/]+\.traycer-artifact\.invalid\//,
    async (route) => {
      const served = await page.evaluate(
        (url) => (window as ProbeWindow).__chatCardProbe?.serve(url),
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

async function callProbe(
  page: Page,
  call: "holdBlocker" | "releaseBlocker" | "failNextCreate",
): Promise<void> {
  await page.evaluate((name) => {
    const probe = (window as ProbeWindow).__chatCardProbe;
    if (probe === undefined) throw new Error("no chat-card probe");
    probe[name]();
  }, call);
}

async function advanceHead(page: Page, artifactId: string): Promise<void> {
  await page.evaluate((id) => {
    const probe = (window as ProbeWindow).__chatCardProbe;
    if (probe === undefined) throw new Error("no chat-card probe");
    probe.advanceHead(id);
  }, artifactId);
}

function card(page: Page, title: string): Locator {
  return page.getByRole("figure", { name: `Artifact: ${title}` });
}

function pageFrame(page: Page, title: string) {
  return page.frameLocator(`iframe[title="${title}"]`);
}

function raisedCard(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title });
}

function draftBox(page: Page): Locator {
  return page.locator('[data-slot="anchored-draft-popover"]');
}

function draftText(page: Page): Locator {
  return draftBox(page).locator('[contenteditable="true"]');
}

function transcriptNode(): string {
  return '[data-testid="chat-messages-scroll"]';
}

async function scrollTranscriptTo(page: Page, top: number): Promise<void> {
  await page.evaluate(
    ({ selector, to }) => {
      const node = document.querySelector(selector);
      if (node === null) throw new Error("no transcript scroller");
      node.scrollTop = to;
    },
    { selector: transcriptNode(), to: top },
  );
  await nextFrames(page, 4);
}

async function scrollTranscriptToEnd(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (node === null) throw new Error("no transcript scroller");
    node.scrollTop = node.scrollHeight;
  }, transcriptNode());
  await nextFrames(page, 4);
}

/** Scroll to the end in steps, as a reader does, so the list recycles rows. */
async function scrollDownThrough(page: Page): Promise<void> {
  for (let top = 600; top <= 20_000; top += 1_500) {
    await scrollTranscriptTo(page, top);
  }
  await scrollTranscriptToEnd(page);
}

async function open(page: Page): Promise<void> {
  await serveArtifactFromPage(page);
  await page.goto(fixture("chat-artifact-card"));
  await expect(page.locator(transcriptNode())).toBeVisible();
}

/** Scroll the transcript up to the card, as a reader scrolling back would. */
async function bringIntoView(page: Page, title: string): Promise<void> {
  const row = card(page, title);
  for (let top = 0; top <= 3000; top += 300) {
    await scrollTranscriptTo(page, top);
    if ((await row.count()) > 0) break;
  }
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  await expect(pageFrame(page, title).locator("#known")).toBeVisible();
}

/**
 * Raise the card with its inline Expand button, which comes up on focus, and
 * turn Comments on inside the raised card. An inline card has no Comments.
 */
async function raiseCard(page: Page, title: string): Promise<void> {
  await expandCard(page, title);
  const toggle = raisedCard(page, title).getByRole("button", {
    name: "Comments",
  });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

async function expandCard(page: Page, title: string): Promise<void> {
  await card(page, title).getByRole("button", { name: "Expand" }).focus();
  await page.keyboard.press("Enter");
  await expect(raisedCard(page, title)).toBeVisible();
}

async function elementCenter(
  page: Page,
  title: string,
  selector: string,
): Promise<{ x: number; y: number }> {
  const frameBox = await page.locator(`iframe[title="${title}"]`).boundingBox();
  if (frameBox === null) throw new Error("no layout box for the frame");
  const inner = await pageFrame(page, title)
    .locator(selector)
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  return {
    x: Math.round(frameBox.x + inner.x + inner.width / 2),
    y: Math.round(frameBox.y + inner.y + inner.height / 2),
  };
}

/** Pick an element of the raised card's page, which opens its comment draft. */
async function pickElement(
  page: Page,
  title: string,
  selector: string,
): Promise<void> {
  const center = await elementCenter(page, title, selector);
  await page.mouse.move(center.x, center.y);
  await expect(
    page.locator("[data-canvas-selection-outline]:not(.ring-1)").first(),
  ).toBeVisible();
  await page.mouse.click(center.x, center.y);
}

/** Pick an element of the raised card's page and type into its draft. */
async function openDraft(
  page: Page,
  title: string,
  selector: string,
  words: string,
): Promise<void> {
  await pickElement(page, title, selector);
  await expect(page.getByRole("dialog", { name: "New comment" })).toBeVisible();
  await draftText(page).fill(words);
  await expect(draftText(page)).toHaveText(words);
}

/** The raised card's draft box. */
function draftIn(page: Page, title: string): Locator {
  return raisedCard(page, title).locator(
    '[data-slot="anchored-draft-popover"]',
  );
}

async function closeCard(page: Page, title: string): Promise<void> {
  const close = raisedCard(page, title).getByRole("button", {
    name: "Close",
    exact: true,
  });
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(raisedCard(page, title)).toHaveCount(0);
}

/** `window.confirm` questions, answered as `accept` says at the time. */
function answerConfirms(page: Page): { asked: string[]; accept: boolean } {
  const state = { asked: [] as string[], accept: false };
  page.on("dialog", (dialog) => {
    state.asked.push(dialog.message());
    void (state.accept ? dialog.accept() : dialog.dismiss());
  });
  return state;
}

/**
 * Card A's draft is parked: a blocker lowered A while the draft held `words`
 * (none when empty), and then went away.
 */
async function parkDraftInA(page: Page, words: string): Promise<void> {
  await bringIntoView(page, CARD_A);
  await raiseCard(page, CARD_A);
  if (words === "") {
    await pickElement(page, CARD_A, "#known");
    await expect(
      page.getByRole("dialog", { name: "New comment" }),
    ).toBeVisible();
  } else {
    await openDraft(page, CARD_A, "#known", words);
  }
  await callProbe(page, "holdBlocker");
  await expect(raisedCard(page, CARD_A)).toHaveCount(0);
  await callProbe(page, "releaseBlocker");
}

/** The toggle's place when the card shows an older version: disabled, with why. */
async function expectLatestVersionNotice(
  page: Page,
  title: string,
): Promise<void> {
  const toggle = raisedCard(page, title).getByRole("button", {
    name: "Comments",
  });
  await expect(toggle).toBeDisabled();
  await toggle.hover({ force: true });
  await expect(page.getByRole("tooltip")).toContainText(
    "Comments are on the latest version",
  );
}

function marked(page: Page, mark: string): Locator {
  return page.locator(`[data-fixture-mark="${mark}"]`);
}

async function mark(locator: Locator, name: string): Promise<void> {
  await locator.evaluate((element, value) => {
    element.setAttribute("data-fixture-mark", value);
  }, name);
}

test("a blocker that lowers a raised card keeps its draft, its row and the approval", async ({
  page,
}) => {
  const confirms = recordConfirms(page);
  await open(page);
  await bringIntoView(page, CARD_A);
  await expect(
    card(page, CARD_A).getByRole("button", { name: "Comments" }),
  ).toHaveCount(0);
  await raiseCard(page, CARD_A);
  await openDraft(page, CARD_A, "#known", "unsent words");
  await mark(draftBox(page), "draft-a");
  await mark(card(page, CARD_A), "row-a");

  await callProbe(page, "holdBlocker");

  // The raise yields; the draft waits where it was written, with its text.
  await expect(raisedCard(page, CARD_A)).toHaveCount(0);
  await expect(marked(page, "draft-a")).toHaveCount(1);
  await expect(
    marked(page, "draft-a").locator('[contenteditable="true"]'),
  ).toHaveText("unsent words");

  // The approval is the reader's next press: it takes it, and no question
  // about discarding the draft stands in its way.
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-approves", "1");
  await nextFrames(page, 4);
  expect(confirms).toEqual([]);

  // Far from the card the list unmounts rows; this one it must keep.
  await scrollDownThrough(page);
  await expect(card(page, CARD_B)).toHaveCount(0);
  await expect(marked(page, "row-a")).toHaveCount(1);
  await expect(marked(page, "draft-a")).toHaveCount(1);
  await scrollTranscriptTo(page, 0);
  await expect(marked(page, "row-a")).toBeVisible();
  await expect(marked(page, "draft-a")).toHaveCount(1);
  await expect(
    marked(page, "draft-a").locator('[contenteditable="true"]'),
  ).toHaveText("unsent words");

  await callProbe(page, "releaseBlocker");
  await expandCard(page, CARD_A);
  await expect(page.getByRole("dialog", { name: "New comment" })).toBeVisible();
  await expect(marked(page, "draft-a")).toHaveCount(1);
  await expect(draftText(page)).toHaveText("unsent words");
});

test("a head that moves past the capture keeps the raised card and the draft", async ({
  page,
}) => {
  recordConfirms(page);
  await open(page);
  await bringIntoView(page, CARD_A);
  await raiseCard(page, CARD_A);
  await openDraft(page, CARD_A, "#known", "words in flight");
  await mark(raisedCard(page, CARD_A), "raised-a");
  await mark(draftBox(page), "draft-a");

  await advanceHead(page, "report-a");

  // The card now shows an older version of the artifact, and comments are on
  // the latest one: the toggle gives way, the surface and the draft stay.
  await expectLatestVersionNotice(page, CARD_A);
  await expect(
    raisedCard(page, CARD_A).and(marked(page, "raised-a")),
  ).toBeVisible();
  await expect(marked(page, "draft-a")).toHaveCount(1);
  await expect(draftText(page)).toHaveText("words in flight");
});

test("Escape in the second card's draft asks about discarding it, and keeping it keeps its text", async ({
  page,
}) => {
  const confirms = recordConfirms(page);
  await open(page);
  await bringIntoView(page, CARD_A);
  await bringIntoView(page, CARD_B);
  await raiseCard(page, CARD_B);
  await openDraft(page, CARD_B, "#known", "typed words");
  // The first card is still mounted behind: two comment surfaces share the key.
  await expect(card(page, CARD_A)).toHaveCount(1);

  await page.keyboard.press("Escape");

  await expect.poll(() => confirms.length).toBe(1);
  expect(confirms[0]).toContain(DISCARD_QUESTION);
  await expect(page.getByRole("dialog", { name: "New comment" })).toBeVisible();
  await expect(draftText(page)).toHaveText("typed words");
});

test("a create that fails after the comment id was written keeps the draft, and posting again succeeds", async ({
  page,
}) => {
  recordConfirms(page);
  await open(page);
  await bringIntoView(page, CARD_A);
  await raiseCard(page, CARD_A);
  await openDraft(page, CARD_A, "#plain", "first try");
  await callProbe(page, "failNextCreate");

  const draft = page.getByRole("dialog", { name: "New comment" });
  await draft.getByRole("button", { name: "Comment", exact: true }).click();

  await expect(page.locator("body")).toHaveAttribute("data-edits", "1");
  // The id insert moved the head past the card's capture: the card shows an
  // older version, and the toggle gives way to the disabled notice.
  await expectLatestVersionNotice(page, CARD_A);
  await expect(draft.getByRole("alert")).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-creates", "0");
  await expect(draftText(page)).toHaveText("first try");

  await draft.getByRole("button", { name: "Comment", exact: true }).click();

  await expect(page.locator("body")).toHaveAttribute("data-creates", "1");
  await expect(draft).toHaveCount(0);
});

test("starting a comment in another card asks before it replaces a parked draft, and declining keeps it", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  await open(page);
  await parkDraftInA(page, "unsent words");

  await bringIntoView(page, CARD_B);
  await raiseCard(page, CARD_B);
  await pickElement(page, CARD_B, "#known");

  await expect.poll(() => answers.asked.length).toBe(1);
  expect(answers.asked[0]).toContain(DISCARD_QUESTION);
  await expect(draftIn(page, CARD_B)).toHaveCount(0);
  await closeCard(page, CARD_B);
  await expandCard(page, CARD_A);
  await expect(draftIn(page, CARD_A)).toHaveCount(1);
  await expect(draftText(page)).toHaveText("unsent words");
});

test("accepting the question replaces the parked draft with the new one", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  answers.accept = true;
  await open(page);
  await parkDraftInA(page, "unsent words");

  await bringIntoView(page, CARD_B);
  await raiseCard(page, CARD_B);
  await pickElement(page, CARD_B, "#known");

  await expect.poll(() => answers.asked.length).toBe(1);
  expect(answers.asked[0]).toContain(DISCARD_QUESTION);
  await expect(draftIn(page, CARD_B)).toHaveCount(1);
  await closeCard(page, CARD_B);
  await expandCard(page, CARD_A);
  await expect(draftIn(page, CARD_A)).toHaveCount(0);
});

test("an empty parked draft is replaced without a question", async ({
  page,
}) => {
  const answers = answerConfirms(page);
  await open(page);
  await parkDraftInA(page, "");

  await bringIntoView(page, CARD_B);
  await raiseCard(page, CARD_B);
  await pickElement(page, CARD_B, "#known");

  await expect(draftIn(page, CARD_B)).toHaveCount(1);
  expect(answers.asked).toEqual([]);
  await closeCard(page, CARD_B);
  await expandCard(page, CARD_A);
  await expect(draftIn(page, CARD_A)).toHaveCount(0);
});
