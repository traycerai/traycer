import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// Browser regression: the Code tab's declaration ORDER reaches the document.
//
// Drives `src/__tests__/browser/canvas-editing.html` - the real `CanvasCodeTab`
// (with the real `CSS.supports` validation) whose emitted edit is applied to a
// small HTML source by the real `@traycer/html-source` and painted into the
// page. The claim is Chrome's computed result: a later shorthand beats an
// earlier longhand of the same property and the reverse order the other way
// round. jsdom resolves that cascade wrongly (it reports the shorthand either
// way), so only a real browser can decide it. The fixture also applies the
// older per-property `set-style` edit, so a code tab that planned per-property
// edits instead of writing the typed text would change the result and fail here.
//
// What is NOT here, because jsdom decides it: the validation messages, the
// emitted edit's shape, and the debounced style fields
// (`components/canvas-artifact/__tests__/`).

test.use({ viewport: { width: 900, height: 700 }, actionTimeout: 10_000 });

const LONGHAND_FIRST = "margin-left:5px; margin:10px";
const SHORTHAND_FIRST = "margin: 10px; margin-left: 5px";
const LONGHAND_LAST = "margin-left: 5px; margin: 10px";

function styleBox(page: Page) {
  return page.getByLabel("Element styles");
}

async function writeStyle(page: Page, text: string): Promise<void> {
  await styleBox(page).fill(text);
  await page.getByRole("button", { name: "Apply styles" }).click();
}

function marginLeftOfTarget(page: Page): Promise<string> {
  return page
    .locator("#target")
    .evaluate((element) => getComputedStyle(element).marginLeft);
}

async function expectMarginLeft(page: Page, expected: string): Promise<void> {
  await expect.poll(() => marginLeftOfTarget(page)).toBe(expected);
}

test("the source as authored computes the later shorthand over the earlier longhand", async ({
  page,
}) => {
  await page.goto(fixture("canvas-editing"));

  await expect(styleBox(page)).toHaveValue(LONGHAND_FIRST);
  await expectMarginLeft(page, "10px");
});

test("writing the shorthand before the longhand makes the longhand win", async ({
  page,
}) => {
  await page.goto(fixture("canvas-editing"));

  await writeStyle(page, SHORTHAND_FIRST);

  // The positive event first: the edited source has been painted.
  await expect(page.locator("#target")).toHaveAttribute(
    "style",
    SHORTHAND_FIRST,
  );
  await expectMarginLeft(page, "5px");
});

test("writing the order back to longhand-then-shorthand restores the shorthand's result", async ({
  page,
}) => {
  await page.goto(fixture("canvas-editing"));

  await writeStyle(page, SHORTHAND_FIRST);
  await expect(page.locator("#target")).toHaveAttribute(
    "style",
    SHORTHAND_FIRST,
  );
  await expectMarginLeft(page, "5px");

  await writeStyle(page, LONGHAND_LAST);
  await expect(page.locator("#target")).toHaveAttribute("style", LONGHAND_LAST);
  await expectMarginLeft(page, "10px");
});

test("a typed duplicate and comment reach the document and the later declaration wins", async ({
  page,
}) => {
  await page.goto(fixture("canvas-editing"));
  const style = "color: red; /* kept */ color: blue";

  await writeStyle(page, style);

  await expect(page.locator("#target")).toHaveAttribute("style", style);
  await expect
    .poll(() =>
      page
        .locator("#target")
        .evaluate((element) => getComputedStyle(element).color),
    )
    .toBe("rgb(0, 0, 255)");
});

test("text typed while a save is pending survives its acknowledgement and is applied next", async ({
  page,
}) => {
  await page.goto(`${fixture("canvas-editing")}?hold`);
  const newer = `${SHORTHAND_FIRST} /* more */`;

  await writeStyle(page, SHORTHAND_FIRST);
  // The positive event: the save reached the page and is held.
  await expect(page.getByTestId("counters")).toHaveText("saves=1 pending=true");
  await expect(
    page.getByRole("button", { name: "Apply styles" }),
  ).toBeDisabled();

  // Real input into the textarea while the host has not answered.
  await styleBox(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" /* more */");
  await expect(styleBox(page)).toBeEnabled();
  await expect(styleBox(page)).toBeFocused();
  await expect(styleBox(page)).toHaveValue(newer);

  // The first save is acknowledged: the document now holds it, and the newer
  // text is still in the same focused textarea. The harness button answers by
  // a dispatched click so that, like the host's reply, it does not take focus.
  await page
    .getByRole("button", { name: "Settle save" })
    .dispatchEvent("click");
  await expect(page.getByTestId("counters")).toHaveText(
    "saves=1 pending=false",
  );
  await expect(page.locator("#target")).toHaveAttribute(
    "style",
    SHORTHAND_FIRST,
  );
  await expectMarginLeft(page, "5px");
  await expect(styleBox(page)).toHaveValue(newer);
  await expect(styleBox(page)).toBeFocused();

  // The newer text goes out as the next save, against the refreshed document.
  await page.getByRole("button", { name: "Apply styles" }).click();
  await expect(page.getByTestId("counters")).toHaveText("saves=2 pending=true");
  await page
    .getByRole("button", { name: "Settle save" })
    .dispatchEvent("click");
  await expect(page.getByTestId("counters")).toHaveText(
    "saves=2 pending=false",
  );
  await expect(page.locator("#target")).toHaveAttribute("style", newer);
  await expect(styleBox(page)).toHaveValue(newer);
  await expectMarginLeft(page, "5px");
});
