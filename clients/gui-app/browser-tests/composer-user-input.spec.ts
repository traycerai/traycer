import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./support/fixtures.ts";

// The runtime pre-start's only editor signal is `onUserInput`: input the
// person makes into the FOCUSED editor, with whether the document was empty
// before it. Focus is a real-browser claim (jsdom never focuses a
// contenteditable), so it is decided here against the real editor in
// `src/__tests__/browser/composer-user-input.tsx`.

interface HandleProbe {
  readonly focus: () => void;
  readonly isReady: () => boolean;
  readonly insertDictatedText: (text: string) => void;
  readonly syncContent: (content: unknown, selection: null) => void;
  readonly setContent: (content: unknown, selection: null) => void;
}

declare global {
  interface Window {
    __userInputs?: boolean[];
    __composer?: HandleProbe | null;
  }
}

const RESTORED = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "restored draft" }] },
  ],
};

async function open(page: Page): Promise<void> {
  await page.goto(fixture("composer-user-input"));
  await page.waitForFunction(() => window.__composer?.isReady() === true);
}

async function inputs(page: Page): Promise<boolean[]> {
  return page.evaluate(() => [...(window.__userInputs ?? [])]);
}

test("a keystroke into the empty focused editor reports an empty draft, the next one a non-empty draft", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("textbox").click();

  await page.keyboard.type("a");
  await expect.poll(() => inputs(page)).toEqual([true]);
  await page.keyboard.type("b");

  await expect.poll(() => inputs(page)).toEqual([true, false]);
});

test("a dictation segment into the empty editor reports an empty draft", async ({
  page,
}) => {
  await open(page);

  await page.evaluate(() => {
    window.__composer?.insertDictatedText("spoken words");
  });

  await expect.poll(() => inputs(page)).toEqual([true]);
});

test("a dictation segment with the editor blurred by keyboard (focus on a button) still reports input, and does not take focus", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#elsewhere")).toBeFocused();
  await expect(page.getByRole("textbox")).not.toBeFocused();

  await page.evaluate(() => {
    window.__composer?.insertDictatedText("spoken while blurred");
  });

  await expect.poll(() => inputs(page)).toEqual([true]);
  await expect(page.locator("#elsewhere")).toBeFocused();
});

test("inserted text (a paste or IME commit) into the focused empty editor reports an empty draft", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("textbox").click();

  await page.keyboard.insertText("pasted words");

  await expect.poll(() => inputs(page)).toEqual([true]);
});

test("focus alone reports nothing", async ({ page }) => {
  await open(page);

  await page.getByRole("textbox").click();
  await page.evaluate(() => {
    window.__composer?.focus();
  });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("contenteditable") === "true",
  );

  expect(await inputs(page)).toEqual([]);
});

test("a draft the app writes reports nothing, whether it notifies or not", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("textbox").click();

  await page.evaluate((content) => {
    window.__composer?.syncContent(content, null);
    window.__composer?.setContent(content, null);
  }, RESTORED);
  await expect(page.getByRole("textbox")).toContainText("restored draft");

  expect(await inputs(page)).toEqual([]);
});
