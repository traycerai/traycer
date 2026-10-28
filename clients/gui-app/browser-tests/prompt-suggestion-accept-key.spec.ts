import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// The key that accepts the composer's suggested prompt.
//
// The suggestion is the empty composer's placeholder, and the "Accept
// suggested reply" keybinding fills it: a bare → by default, Tab for a person
// who rebinds it in Settings. The binding is matched inside the editor, ahead
// of its keymaps and the browser default, and only while the suggestion is
// showing.
//
// jsdom can check the predicate and nothing else. Where a Tab the composer
// does not take sends focus, whether a Tab it does take keeps focus in the
// composer, and whether an Enter binding can beat the editor's own
// Enter-submits keymap, are Chrome's focus traversal and ProseMirror's real
// keydown pipeline against a real contenteditable, which is what these drive.

interface AcceptKeyProbe {
  readonly bind: (chord: string | null) => void;
  readonly submits: () => number;
}

declare global {
  interface Window {
    __acceptKeyProbe?: AcceptKeyProbe;
  }
}

const SUGGESTION = "Add a test for the new endpoint";
const EDITOR = '[data-testid="composer-editor"]';
const PLACEHOLDER = `${EDITOR} p.is-editor-empty`;
const BEFORE = '[data-testid="before-composer"]';
const AFTER = '[data-testid="after-composer"]';

/** Loads the fixture, focuses the composer and waits for the suggestion. */
async function openComposer(page: Page): Promise<void> {
  await page.goto(fixture("prompt-suggestion-accept-key"));
  await expect(page.locator(PLACEHOLDER)).toHaveAttribute(
    "data-placeholder",
    SUGGESTION,
  );
  await page.locator(EDITOR).focus();
  await expect(page.locator(EDITOR)).toBeFocused();
}

/** Rebinds the accept key through the production store, live. */
async function bind(page: Page, chord: string | null): Promise<void> {
  await page.evaluate((next: string | null) => {
    const probe = window.__acceptKeyProbe;
    if (probe === undefined) throw new Error("probe missing");
    probe.bind(next);
  }, chord);
}

async function submits(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = window.__acceptKeyProbe;
    if (probe === undefined) throw new Error("probe missing");
    return probe.submits();
  });
}

test("→ fills the composer with the suggestion by default, and keeps focus there", async ({
  page,
}) => {
  await openComposer(page);

  await page.keyboard.press("ArrowRight");

  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
  await expect(page.locator(EDITOR)).toBeFocused();
});

// The default leaves Tab its job: a person tabbing past an empty composer
// must not find it filled behind them.
test("Tab moves focus on and leaves the composer empty while → is the binding", async ({
  page,
}) => {
  await openComposer(page);

  await page.keyboard.press("Tab");

  await expect(page.locator(AFTER)).toBeFocused();
  await expect(page.locator(EDITOR)).toHaveText("");
  await expect(page.locator(PLACEHOLDER)).toHaveAttribute(
    "data-placeholder",
    SUGGESTION,
  );
});

test("Tab fills the composer and keeps focus there once it is the binding, and → no longer does", async ({
  page,
}) => {
  await openComposer(page);
  await bind(page, "tab");

  await page.keyboard.press("ArrowRight");
  await expect(page.locator(EDITOR)).toHaveText("");

  await page.keyboard.press("Tab");

  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
  await expect(page.locator(EDITOR)).toBeFocused();
});

// Only the bare key is the binding: backward traversal stays the browser's.
test("Shift+Tab still moves focus back while Tab is the binding", async ({
  page,
}) => {
  await openComposer(page);
  await bind(page, "tab");

  await page.keyboard.press("Shift+Tab");

  await expect(page.locator(BEFORE)).toBeFocused();
  await expect(page.locator(EDITOR)).toHaveText("");
});

// Once the composer holds the suggestion there is nothing left to accept, and
// Tab is a Tab again.
test("Tab moves focus on once the suggestion has been accepted", async ({
  page,
}) => {
  await openComposer(page);
  await bind(page, "tab");

  await page.keyboard.press("Tab");
  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);

  await page.keyboard.press("Tab");

  await expect(page.locator(AFTER)).toBeFocused();
  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
});

// The editor's own keymap submits on Enter. A binding has to be matched ahead
// of it, or Settings would offer a key that silently never fires - and the
// fill must never turn into a send.
test("an Enter binding fills without sending, ahead of the editor's submit keymap", async ({
  page,
}) => {
  await openComposer(page);
  await bind(page, "enter");

  await page.keyboard.press("Enter");

  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
  expect(await submits(page)).toBe(0);
});

// The press that filled is still held and still repeating, and a modifier
// tapped meanwhile is a fresh keydown of another key. The held Enter's next
// repeat must not reach the submit keymap with the suggestion now filled.
test("a held Enter binding does not send the text it filled, even across a Shift tapped meanwhile", async ({
  page,
}) => {
  await openComposer(page);
  await bind(page, "enter");

  await page.keyboard.down("Enter");
  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
  await page.keyboard.down("Shift");
  await page.keyboard.up("Shift");
  // A second `down` of a key already held is dispatched as an OS repeat.
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");

  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
  expect(await submits(page)).toBe(0);
});

test("an unbound action accepts nothing, and → moves the caret as usual", async ({
  page,
}) => {
  await openComposer(page);
  await bind(page, null);

  await page.keyboard.press("ArrowRight");

  await expect(page.locator(EDITOR)).toHaveText("");
  await expect(page.locator(PLACEHOLDER)).toHaveAttribute(
    "data-placeholder",
    SUGGESTION,
  );
});
