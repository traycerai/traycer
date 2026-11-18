import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Browser regression: the inline text editor sits exactly over the text it
// edits, in Chrome's real layout.
//
// Drives `src/__tests__/browser/canvas-inline-text.html`: a real canvas page in
// an iframe, described through the real `SandboxBridgeHost` so the box and the
// computed styles come from Chrome, with the production `CanvasInlineTextField`
// placed over it the way the canvas places it. The claims are geometric: the
// box lands on the element's box, the text is styled and wrapped the same, and
// the text underneath cannot show through. All of that is layout and paint, so
// only a real browser can decide it.
//
// What is NOT here, because jsdom decides it: what the editor saves, its keys,
// and the CSS variables derived from a description
// (`components/canvas-artifact/__tests__/`).

test.use({ viewport: { width: 1000, height: 700 }, actionTimeout: 10_000 });

const BOARD_CSS_WIDTH = 640;
const TOLERANCE_PX = 1;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface TextStyle {
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly lineHeight: string;
  readonly textAlign: string;
  readonly paddingTop: string;
  readonly paddingRight: string;
  readonly paddingBottom: string;
  readonly paddingLeft: string;
  readonly color: string;
  readonly backgroundColor: string;
}

function textarea(page: Page): Locator {
  return page.getByRole("textbox", { name: "Edit element text" });
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${fixture("canvas-inline-text")}${query}`);
  // The positive event: the page was described and the editor is up.
  await expect(page.locator("#stage")).toHaveAttribute("data-ready", "true");
  await expect(textarea(page)).toBeVisible();
  await nextFrames(page, 2);
}

/** The headline as the board's own document lays it out, in that frame's CSS pixels. */
async function headlineInBoard(
  page: Page,
): Promise<{ readonly box: Box; readonly style: TextStyle }> {
  return page
    .frameLocator("#board")
    .locator("#headline")
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        box: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        style: {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          textAlign: style.textAlign,
          paddingTop: style.paddingTop,
          paddingRight: style.paddingRight,
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft,
          color: style.color,
          backgroundColor: style.backgroundColor,
        },
      };
    });
}

function editorStyle(page: Page): Promise<TextStyle> {
  return textarea(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      textAlign: style.textAlign,
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
      color: style.color,
      backgroundColor: style.backgroundColor,
    };
  });
}

/** Where the board's headline appears on screen, after the board's zoom and position. */
async function headlineOnScreen(page: Page): Promise<Box> {
  const frame = await page.locator("#board").boundingBox();
  if (frame === null) throw new Error("the board has no layout box");
  const scale = frame.width / BOARD_CSS_WIDTH;
  const { box } = await headlineInBoard(page);
  return {
    x: frame.x + box.x * scale,
    y: frame.y + box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

async function editorOnScreen(page: Page): Promise<Box> {
  const box = await textarea(page).boundingBox();
  if (box === null) throw new Error("the editor has no layout box");
  return box;
}

function expectSameBox(actual: Box, expected: Box): void {
  for (const key of ["x", "y", "width", "height"] as const)
    expect(
      Math.abs(actual[key] - expected[key]),
      `${key}: editor ${actual[key]}, element ${expected[key]}`,
    ).toBeLessThanOrEqual(TOLERANCE_PX);
}

test("the editor covers the element it edits", async ({ page }) => {
  await open(page, "");
  expectSameBox(await editorOnScreen(page), await headlineOnScreen(page));
});

test("the editor still covers the element when the board is zoomed and moved", async ({
  page,
}) => {
  await open(page, "?zoom=0.6&shifted");
  const frame = await page.locator("#board").boundingBox();
  expect(frame?.width).toBeCloseTo(BOARD_CSS_WIDTH * 0.6, 0);
  expect(frame?.x).toBeGreaterThan(100);

  expectSameBox(await editorOnScreen(page), await headlineOnScreen(page));
});

test("the editor is styled like the element it replaces", async ({ page }) => {
  await open(page, "");
  const { style: wanted } = await headlineInBoard(page);
  const actual = await editorStyle(page);

  expect(actual).toMatchObject({
    fontFamily: wanted.fontFamily,
    fontSize: wanted.fontSize,
    fontWeight: wanted.fontWeight,
    lineHeight: wanted.lineHeight,
    textAlign: wanted.textAlign,
    paddingTop: wanted.paddingTop,
    paddingRight: wanted.paddingRight,
    paddingBottom: wanted.paddingBottom,
    paddingLeft: wanted.paddingLeft,
  });
});

test("the text wraps onto the same lines, with nothing to scroll", async ({
  page,
}) => {
  await open(page, "");
  const { box, style } = await headlineInBoard(page);
  const padding = (value: string): number => Number.parseFloat(value);
  const lineHeight = padding(style.lineHeight);
  const elementLines = Math.round(
    (box.height - padding(style.paddingTop) - padding(style.paddingBottom)) /
      lineHeight,
  );
  expect(elementLines).toBeGreaterThan(1);

  const editor = await textarea(page).evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  const editorLines = Math.round(
    (editor.scrollHeight -
      padding(style.paddingTop) -
      padding(style.paddingBottom)) /
      lineHeight,
  );
  expect(editorLines).toBe(elementLines);
  expect(editor.scrollHeight).toBeLessThanOrEqual(editor.clientHeight + 1);
});

test("an element with its own opaque colours keeps them in the editor", async ({
  page,
}) => {
  await open(page, "");
  const { style: wanted } = await headlineInBoard(page);
  const actual = await editorStyle(page);

  expect(wanted.backgroundColor).toBe("rgb(255, 238, 204)");
  expect(actual.backgroundColor).toBe(wanted.backgroundColor);
  expect(actual.color).toBe(wanted.color);
});

test("an element with no background gets an opaque one, so the old text cannot show through", async ({
  page,
}) => {
  await open(page, "?bg=transparent");
  const { style: wanted } = await headlineInBoard(page);
  expect(wanted.backgroundColor).toBe("rgba(0, 0, 0, 0)");

  const actual = await editorStyle(page);
  expect(actual.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(actual.backgroundColor).not.toBe("transparent");
  // The text stays readable against the fill it was given.
  expect(actual.color).not.toBe(actual.backgroundColor);
});
