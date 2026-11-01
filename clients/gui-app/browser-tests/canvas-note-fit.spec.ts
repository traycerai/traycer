import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Browser regression: a title's font shrinks so its rendered text actually
// fits a real container width, never grows past the note's own size, and a
// sticky note's own wrap/grow behaviour stays untouched - none of which
// jsdom's always-0 `offsetWidth`/`clientWidth` can decide.

test.use({ viewport: { width: 900, height: 700 }, actionTimeout: 10_000 });

const TITLE_SIZE = 30;

function widthSlider(page: Page): Locator {
  return page.locator("#note-width");
}

/** The element the production code sets the live fit `font-size` on. */
function fitContainer(page: Page): Locator {
  return page.locator('[data-testid="note-box"] [style*="--canvas-note-size"]');
}

async function setWidth(page: Page, width: number): Promise<void> {
  await widthSlider(page).fill(String(width));
  await nextFrames(page, 2);
}

async function fontSize(page: Page): Promise<number> {
  return fitContainer(page).evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
}

/** The rendered text's own width against the container it has to fit inside. */
async function textFit(
  page: Page,
): Promise<{ readonly textWidth: number; readonly containerWidth: number }> {
  return fitContainer(page).evaluate((container) => {
    const textEl = container.querySelector("[data-canvas-note-text]");
    if (textEl === null) throw new Error("no note text element");
    const range = document.createRange();
    range.selectNodeContents(textEl);
    return {
      textWidth: range.getBoundingClientRect().width,
      containerWidth: container.clientWidth,
    };
  });
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${fixture("canvas-note-fit")}${query}`);
  await expect(widthSlider(page)).toBeVisible();
  await nextFrames(page, 2);
}

test("a title's font shrinks so its text actually fits a narrow width, then returns to exactly the note's own size once widened", async ({
  page,
}) => {
  await open(page, "");
  await setWidth(page, 120);
  const narrow = await textFit(page);
  expect(narrow.textWidth).toBeLessThanOrEqual(narrow.containerWidth + 1);
  expect(await fontSize(page)).toBeLessThan(TITLE_SIZE);

  await setWidth(page, 640);
  expect(await fontSize(page)).toBe(TITLE_SIZE);
});

test("fits the title live while it is typed, in edit mode", async ({
  page,
}) => {
  await open(page, "?text=Hi");
  await setWidth(page, 220);
  expect(await fontSize(page)).toBe(TITLE_SIZE);

  await page.getByRole("button", { name: "Edit note" }).click();
  const editor = page.getByRole("textbox", { name: "Title text" });
  await expect(editor).toBeFocused();
  await editor.press("End");
  await editor.pressSequentially(" this title keeps getting longer and longer");
  await expect.poll(() => fontSize(page)).toBeLessThan(TITLE_SIZE);
});

test("a view-only title shrinks to fit exactly like an editable one", async ({
  page,
}) => {
  await open(page, "?viewOnly");
  await setWidth(page, 600);
  expect(await fontSize(page)).toBe(TITLE_SIZE);

  await setWidth(page, 120);
  expect(await fontSize(page)).toBeLessThan(TITLE_SIZE);
});

test("an existing multi-line title renders fitted onto a single, unwrapped line", async ({
  page,
}) => {
  await open(page, `?text=${encodeURIComponent("Roadmap\nfor 2027")}`);
  await setWidth(page, 160);

  const title = page.getByRole("button", { name: "Edit title" });
  await expect(title).toHaveText("Roadmap for 2027");
  const whiteSpace = await title.evaluate(
    (element) => getComputedStyle(element).whiteSpace,
  );
  expect(whiteSpace).toBe("pre");

  // The display wrapper is `min-h-full` (it stretches to the box's own
  // height), so the single-line claim has to be read off the text itself.
  const text = page.locator("[data-canvas-note-text]");
  const { height, lineHeight } = await text.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
  expect(height).toBeLessThan(lineHeight * 1.5);
});

test("a sticky note still wraps and grows its box as it is typed, unlike a title", async ({
  page,
}) => {
  await open(page, "?type=sticky&text=&h=40");
  await setWidth(page, 200);

  const before = Number.parseFloat(
    await page
      .locator('[data-testid="note-box"]')
      .evaluate((element) => getComputedStyle(element).height),
  );

  await page.getByRole("button", { name: "Edit note" }).click();
  const editor = page.getByRole("textbox", { name: "Sticky note text" });
  await editor.pressSequentially(
    "A sticky note's text wraps across several lines instead of shrinking to fit.",
  );
  await expect
    .poll(async () =>
      Number(await page.getByTestId("grow-count").textContent()),
    )
    .toBeGreaterThan(0);

  const after = Number.parseFloat(
    await page
      .locator('[data-testid="note-box"]')
      .evaluate((element) => getComputedStyle(element).height),
  );
  expect(after).toBeGreaterThan(before);

  // A sticky note's own font never shrinks to fit - it stays at its default.
  const stickyFontSize = await fitContainer(page).evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(stickyFontSize).toBe(14);
});
