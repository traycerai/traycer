import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// Browser regression: a tweak control keeps native focus and the caret while
// its save is pending, acknowledged and refused.
//
// Drives `src/__tests__/browser/canvas-tweak-focus.html`: the real
// `CanvasTweaksSection` and its knobs, fed the props the panel gives it, with
// every save held until the page answers it. Disabling a focused field blurs
// it in Chrome and moves the caret, which jsdom cannot show, so only a real
// browser can decide that the person can keep typing through a save.
//
// What is NOT here, because jsdom decides it: what a commit sends, the typing
// pause, and the draft rules (`components/canvas-artifact/__tests__/`).

test.use({ viewport: { width: 700, height: 600 }, actionTimeout: 10_000 });

const TYPING_PAUSE_SETTLED = "saves=2 pending=true";

function counters(page: Page): Locator {
  return page.getByTestId("counters");
}

function font(page: Page): Locator {
  return page.getByLabel("--font");
}

/** The fixture's answer to the oldest save; dispatched so, like the host's reply, it takes no focus. */
async function answer(page: Page, name: "Settle save" | "Refuse save") {
  await page.getByRole("button", { name }).dispatchEvent("click");
}

async function replaceFont(page: Page, text: string): Promise<void> {
  await font(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test("the field being saved stays enabled and focused, and the section says it is busy", async ({
  page,
}) => {
  await page.goto(fixture("canvas-tweak-focus"));
  const section = page.getByRole("region", { name: "Tweaks" });
  await expect(section).toHaveAttribute("aria-busy", "false");

  await replaceFont(page, "Helvetica");
  // The positive event: the save reached the page and is held.
  await expect(counters(page)).toHaveText("saves=1 pending=true");

  await expect(section).toHaveAttribute("aria-busy", "true");
  await expect(font(page)).toBeEnabled();
  await expect(font(page)).toBeFocused();
  await expect(font(page)).toHaveValue("Helvetica");

  await answer(page, "Settle save");
  await expect(counters(page)).toHaveText("saves=1 pending=false");
  await expect(section).toHaveAttribute("aria-busy", "false");
  await expect(font(page)).toBeFocused();
  await expect(font(page)).toHaveValue("Helvetica");
});

test("text typed during a save survives its acknowledgement, with the caret at the end", async ({
  page,
}) => {
  await page.goto(fixture("canvas-tweak-focus"));

  await replaceFont(page, "Helvetica");
  await expect(counters(page)).toHaveText("saves=1 pending=true");

  // Real keystrokes into the field the host has not answered yet.
  await page.keyboard.type(", sans-serif");
  await expect(font(page)).toHaveValue("Helvetica, sans-serif");
  await expect(font(page)).toBeFocused();
  // The typing pause sends it as the next save, queued behind the first.
  await expect(counters(page)).toHaveText(TYPING_PAUSE_SETTLED);

  await answer(page, "Settle save");
  await expect(font(page)).toBeFocused();
  await expect(font(page)).toHaveValue("Helvetica, sans-serif");

  await answer(page, "Settle save");
  await expect(counters(page)).toHaveText("saves=2 pending=false");
  await expect(font(page)).toBeFocused();
  await expect(font(page)).toHaveValue("Helvetica, sans-serif");

  const caret = await font(page).evaluate((element) =>
    element instanceof HTMLInputElement
      ? [element.selectionStart, element.selectionEnd, element.value.length]
      : [],
  );
  expect(caret).toEqual([21, 21, 21]);
});

test("a refused save leaves the field focused with what was typed, and shows the reason", async ({
  page,
}) => {
  await page.goto(fixture("canvas-tweak-focus"));

  await replaceFont(page, "Helvetica");
  await expect(counters(page)).toHaveText("saves=1 pending=true");
  await answer(page, "Refuse save");

  await expect(counters(page)).toHaveText("saves=1 pending=false");
  await expect(
    page.getByRole("region", { name: "Tweaks" }).getByRole("status"),
  ).toHaveText("The artboard changed. Select the element again and retry.");
  await expect(font(page)).toBeEnabled();
  await expect(font(page)).toBeFocused();
  await expect(font(page)).toHaveValue("Helvetica");

  // The same text can be sent again.
  await page.keyboard.press("Enter");
  await expect(counters(page)).toHaveText("saves=2 pending=true");
  await answer(page, "Settle save");
  await expect(counters(page)).toHaveText("saves=2 pending=false");
  await expect(
    page.getByRole("region", { name: "Tweaks" }).getByRole("status"),
  ).toHaveCount(0);
});
