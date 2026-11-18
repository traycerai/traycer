import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Browser regression: a new-comment draft reaches the host once per user
// action, and a slow answer to it cannot undo what the user did meanwhile.
//
// Drives `src/__tests__/browser/comment-draft-submit.html` - the real
// `FloatingDraftPopover` and `CommentComposer` over a real Tiptap editor with
// the real `threadAnchor` mark, through the real Query mutation, against a
// mock host whose `epic.createCommentThread` stays pending until the page's
// "Answer oldest create" button answers it. Input is trusted Chrome input.
//
// What is NOT here, because jsdom decides it: the rejected-create retry,
// the pending lock on the button, and range mapping for edits made while a
// create is in flight (`components/comments/__tests__/floating-draft-popover-submit.test.tsx`).

// A control covered by the popover fails in seconds instead of stalling.
test.use({ viewport: { width: 900, height: 700 }, actionTimeout: 10_000 });

const SHORTCUT_MODIFIERS = ["Control", "Meta"] as const;

function counters(page: Page) {
  return page.getByTestId("counters");
}

function composerEditor(page: Page) {
  return page.locator('[data-slot="comment-composer-editor"]');
}

async function startDraft(
  page: Page,
  target: "commentable" | "world",
  text: string,
): Promise<void> {
  await page.getByRole("button", { name: `Draft on ${target}` }).click();
  await expect(composerEditor(page)).toBeFocused();
  await page.keyboard.type(text);
  await expect(composerEditor(page)).toHaveText(text);
}

async function expectCreatesStayAtOne(page: Page): Promise<void> {
  // The positive event first: the dispatch has reached the host.
  await expect(counters(page)).toHaveText(/^creates=1$/m);
  // Then a window for a second dispatch to show up if there were one.
  await nextFrames(page, 3);
  await expect(counters(page)).toHaveText(/^creates=1$/m);
}

async function answerAndExpectOneAnchor(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Answer oldest create" }).click();
  await expect(counters(page)).toHaveText(/^anchors=thread-1:commentable$/m);
  await expect(counters(page)).toHaveText(/^draft=none$/m);
  // A repeat dispatch queued behind the first would only reach the host after
  // this answer, so look again now.
  await nextFrames(page, 10);
  await expect(counters(page)).toHaveText(/^creates=1$/m);
  await expect(counters(page)).toHaveText(/^answered=1$/m);
}

test.beforeEach(async ({ page }) => {
  await page.goto(fixture("comment-draft-submit"));
});

test("a click on Comment dispatches one create and anchors the quote", async ({
  page,
}) => {
  await startDraft(page, "commentable", "one click");

  await page.getByRole("button", { name: /^Comment/ }).click();

  await expectCreatesStayAtOne(page);
  await answerAndExpectOneAnchor(page);
});

for (const modifier of SHORTCUT_MODIFIERS) {
  test(`${modifier}+Enter dispatches one create`, async ({ page }) => {
    await startDraft(page, "commentable", "one shortcut");

    await page.keyboard.press(`${modifier}+Enter`);

    await expectCreatesStayAtOne(page);
    await answerAndExpectOneAnchor(page);
  });

  test(`holding ${modifier}+Enter (key repeat) still dispatches one create`, async ({
    page,
  }) => {
    await startDraft(page, "commentable", "held shortcut");

    await page.keyboard.down(modifier);
    // A held key repeats keydown; Playwright marks the later ones as repeats.
    for (let repeat = 0; repeat < 6; repeat += 1) {
      await page.keyboard.down("Enter");
    }
    await page.keyboard.up("Enter");
    await page.keyboard.up(modifier);

    await expectCreatesStayAtOne(page);
    await answerAndExpectOneAnchor(page);
  });
}

test("a slow answer to a cancelled draft anchors it without touching the draft opened since", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await startDraft(page, "commentable", "old comment");
  await page.getByRole("button", { name: /^Comment/ }).click();
  await expect(counters(page)).toHaveText(/^creates=1$/m);

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(composerEditor(page)).toHaveCount(0);
  await startDraft(page, "world", "new comment");
  // The replacement composer is a new editor, not the one still saving.
  await expect(composerEditor(page)).toHaveAttribute("contenteditable", "true");

  await page.getByRole("button", { name: "Answer oldest create" }).click();

  await expect(counters(page)).toHaveText(/^anchors=thread-1:commentable$/m);
  await expect(counters(page)).toHaveText(/^draft=world$/m);
  await expect(composerEditor(page)).toHaveText("new comment");
});

test("typing while the create is pending cannot change the text being saved", async ({
  page,
}) => {
  await startDraft(page, "commentable", "submitted text");

  // The keyboard route keeps focus in the editor, so the keys below are aimed
  // at it.
  await page.keyboard.press("Control+Enter");
  await expect(counters(page)).toHaveText(/^creates=1$/m);
  await expect(composerEditor(page)).toHaveAttribute(
    "contenteditable",
    "false",
  );

  await page.keyboard.type("lost words");
  await nextFrames(page, 3);

  await expect(composerEditor(page)).toHaveText("submitted text");
  await answerAndExpectOneAnchor(page);
});

test("a mention picker left open cannot change the text being saved", async ({
  page,
}) => {
  await startDraft(page, "commentable", "hi @al");
  const aliceOption = page.getByRole("option", { name: /Alice Chen/ });
  await expect(aliceOption).toBeVisible();

  // The keyboard route keeps focus in the editor, so a blur cannot be what
  // hides the picker, and the picker does not cover the button.
  await page.keyboard.press("Control+Enter");
  await expect(counters(page)).toHaveText(/^creates=1$/m);
  await expect(composerEditor(page)).toHaveAttribute(
    "contenteditable",
    "false",
  );

  // The picker either closed with the submit or ignores the click; it must not
  // insert a mention into the text that is being saved.
  if ((await aliceOption.count()) > 0) await aliceOption.click();
  await nextFrames(page, 3);

  await expect(composerEditor(page)).toHaveText("hi @al");
  await expect(composerEditor(page)).not.toContainText("Alice");
});
