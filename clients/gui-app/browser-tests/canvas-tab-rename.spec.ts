import { expect, test, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// Edit Title on the epic canvas tab strip's context menu (`TabStrip`,
// `src/components/epic-canvas/canvas/tab-strip.tsx`): choosing it must leave
// the inline rename input mounted AND focused until Enter commits it.
//
// The regression this guards is a real focus transfer with no user gesture
// behind it. `ContextMenuContent` goes `pointer-events: none` for its exit
// animation (so a pointer drifting over a closing item cannot refocus it -
// the earlier fix), and Chrome answers that style change by dispatching
// `pointerleave` on the item still under the pointer, mouse unmoved. Radix's
// item-leave handler then focuses the menu content, which blurs the input
// `useInlineRename` had just mounted and focused; the blur commits and
// unmounts it before a keystroke lands. jsdom has no hit testing, no style-
// driven boundary events and no real focus, so only trusted input in Chrome
// can show the input surviving - or not.
//
// The fixture renders the production strip with chat tabs (`?kind=chat`), the
// one tab kind whose menu carries Edit Title; a blank tab cannot be renamed.

const STRIP = '[data-testid="tab-strip"]';
const INPUT = '[data-testid^="tab-title-input-"]';
const TAB_COUNT = 2;
// Frames to let every deferred focus hand-off run - the menu's exit
// animation, the rename hook's next-frame refocus, Chrome's synthetic
// boundary events after the style change - before the result is read.
const SETTLE_FRAMES = 30;

test.use({
  viewport: { width: 640, height: 200 },
  deviceScaleFactor: 1,
});

interface InputTrace {
  readonly mounted: number;
  readonly unmounted: number;
}

declare global {
  interface Window {
    __renameInputTrace?: InputTrace;
    /** Written by the fixture: every rename the strip committed. */
    __committedRenames?: readonly { readonly title: string }[];
  }
}

async function openChatStrip(page: Page): Promise<void> {
  await page.goto(
    `${fixture("canvas-tab-strip-overflow")}?tabs=${String(TAB_COUNT)}&kind=chat`,
  );
  await expect(page.locator(`${STRIP} [role="tab"]`)).toHaveCount(TAB_COUNT);
  await nextFrames(page, 3);
}

/** Counts the rename input's mounts and unmounts from here on. */
async function traceInput(page: Page): Promise<void> {
  await page.evaluate((inputSelector: string) => {
    const trace = { mounted: 0, unmounted: 0 };
    window.__renameInputTrace = trace;
    const matches = (node: Node): boolean =>
      node instanceof Element &&
      (node.matches(inputSelector) ||
        node.querySelector(inputSelector) !== null);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (matches(node)) trace.mounted += 1;
        }
        for (const node of record.removedNodes) {
          if (matches(node)) trace.unmounted += 1;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, INPUT);
}

function readTrace(page: Page): Promise<InputTrace> {
  return page.evaluate(() => {
    const trace = window.__renameInputTrace;
    if (trace === undefined)
      throw new Error("the input trace is not installed");
    return { mounted: trace.mounted, unmounted: trace.unmounted };
  });
}

function readActiveElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return "null";
    const testId = active.getAttribute("data-testid");
    return `${active.tagName.toLowerCase()}${testId === null ? "" : `#${testId}`}`;
  });
}

test("Edit Title keeps the rename input mounted and focused until Enter commits it", async ({
  page,
}) => {
  await openChatStrip(page);
  await traceInput(page);

  // Real input by coordinates: the claim is about what the browser does with
  // a pointer that stays where the click landed.
  const tabCentre = await centreOf(
    page.locator(`${STRIP} [role="tab"]`).first(),
  );
  await page.mouse.click(tabCentre.x, tabCentre.y, { button: "right" });
  const editTitle = page.getByRole("menuitem", { name: "Edit Title" });
  await expect(editTitle).toBeVisible();
  const itemCentre = await centreOf(editTitle);
  await page.mouse.click(itemCentre.x, itemCentre.y);

  await expect
    .poll(async () => (await readTrace(page)).mounted, {
      message: "the rename input must mount after Edit Title is chosen",
    })
    .toBeGreaterThan(0);
  await nextFrames(page, SETTLE_FRAMES);

  const trace = await readTrace(page);
  const activeElement = await readActiveElement(page);
  expect(
    trace.unmounted,
    `the rename input must not unmount on its own after Edit Title ` +
      `(mounted ${String(trace.mounted)}, unmounted ${String(trace.unmounted)}, ` +
      `focus now on ${activeElement})`,
  ).toBe(0);
  await expect(page.locator(INPUT)).toHaveCount(1);
  expect(
    activeElement.startsWith("input#tab-title-input-"),
    `the rename input must hold focus while the menu finishes closing ` +
      `(focus is on ${activeElement})`,
  ).toBe(true);

  // The input is live: typing lands in it and Enter commits through the
  // strip's rename handler.
  await page.keyboard.type("Renamed");
  await page.keyboard.press("Enter");
  await expect(page.locator(INPUT)).toHaveCount(0);
  const renames = await page.evaluate(
    () => window.__committedRenames?.map((rename) => rename.title) ?? null,
  );
  expect(renames).toEqual(["Renamed"]);
});
