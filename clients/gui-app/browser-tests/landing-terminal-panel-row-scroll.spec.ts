import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture } from "./support/fixtures.ts";

// The Start Page's collapsed terminal panel is parked past its row's right
// edge (a negative right margin at the open width), and the panel's tab strip
// scrolls its active tab into view when it mounts. If the row is a scroll
// container - `overflow: hidden` is one - that scroll walks the ROW sideways,
// shifting the whole page left and leaving a blank band where the panel sits.
// The row must be `overflow: clip`, which no scroll can move.
//
// jsdom cannot answer any of it: it lays nothing out (no scroll range, no
// panel position), and `overflow-hidden` versus `overflow-clip` is a computed
// behaviour rather than a class name a string assertion can be held to. This
// renders the production tab host, Start Page surface and terminal host against
// the real stylesheet at a real width, lets the tab strip's own
// `scrollIntoView` run, and reads the row back.

const VIEWPORT = { width: 1512, height: 900 } as const;
const PANEL = '[data-testid="landing-terminal-panel"]';
const VISIBLE_ROW =
  '[data-surface-kind="draft"][data-visible="true"] [data-testid="landing-draft-surface"]';
const COLUMN = "[data-composer-placement]";

test.use({ viewport: VIEWPORT });

const ReadingSchema = z.object({
  scrollLeft: z.number(),
  clientWidth: z.number(),
  panelOpen: z.string().nullable(),
  panelOffset: z.number(),
  columnCentre: z.number(),
  rowCentre: z.number(),
});
type Reading = z.infer<typeof ReadingSchema>;

/**
 * Counts the panel tab strip's real `scrollIntoView` calls, calling through to
 * the browser's own. It is the wait for "the mount effect has run" - the
 * negative claim below has no positive event of its own to wait for.
 */
async function watchPanelTabScrollIntoView(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original: unknown = Reflect.get(Element.prototype, "scrollIntoView");
    if (typeof original !== "function") {
      throw new Error("Element.prototype.scrollIntoView is missing");
    }
    let calls = 0;
    Reflect.set(window, "__panelTabScrollCalls", () => calls);
    Element.prototype.scrollIntoView = function (
      this: Element,
      options: ScrollIntoViewOptions | undefined,
    ): void {
      if (
        this.getAttribute("role") === "tab" &&
        this.closest('[data-testid="landing-terminal-panel"]') !== null
      ) {
        calls += 1;
      }
      Reflect.apply(original, this, [options]);
    };
  });
}

async function panelTabScrollCalls(page: Page): Promise<number> {
  return z
    .number()
    .parse(await page.evaluate("window.__panelTabScrollCalls()"));
}

async function readRow(page: Page): Promise<Reading> {
  return ReadingSchema.parse(
    await page.evaluate(
      (selectors: {
        readonly row: string;
        readonly panel: string;
        readonly column: string;
      }) => {
        const row = document.querySelector(selectors.row);
        const panel = row?.querySelector(selectors.panel);
        const column = row?.querySelector(selectors.column);
        if (!row || !panel || !column) {
          throw new Error("the Start Page row, panel or column is missing");
        }
        const rowBox = row.getBoundingClientRect();
        const columnBox = column.getBoundingClientRect();
        return {
          scrollLeft: row.scrollLeft,
          clientWidth: row.clientWidth,
          panelOpen: panel.getAttribute("data-open"),
          // Where the panel starts in the row's own scrollable coordinates, so
          // the reading does not move when the row does.
          panelOffset:
            panel.getBoundingClientRect().left - rowBox.left + row.scrollLeft,
          columnCentre: columnBox.left + columnBox.width / 2,
          rowCentre: rowBox.left + rowBox.width / 2,
        };
      },
      { row: VISIBLE_ROW, panel: PANEL, column: COLUMN },
    ),
  );
}

/**
 * The claim, on one reading. The premise comes first so a layout that never
 * parked the panel cannot pass for a fix: the panel is collapsed and starts at
 * or past the row's right edge, which is the geometry that gives
 * `scrollIntoView` something to scroll.
 */
function expectRowUnscrolledAndCentred(reading: Reading): void {
  expect(reading.panelOpen).toBe("false");
  expect(reading.panelOffset).toBeGreaterThanOrEqual(reading.clientWidth - 1);
  // Soft, so a scrolled row reports the offset and the shifted column both.
  expect.soft(reading.scrollLeft).toBe(0);
  expect
    .soft(Math.abs(reading.columnCentre - reading.rowCentre))
    .toBeLessThan(1);
}

async function activateStartPage(page: Page, index: number): Promise<void> {
  await page.evaluate(
    `window.__landingPanelRowScroll.activate(${String(index)})`,
  );
}

test("a collapsed panel with an active tab leaves the Start Page row unscrolled and centred", async ({
  page,
}) => {
  await watchPanelTabScrollIntoView(page);
  await page.goto(fixture("landing-terminal-panel-row-scroll"));
  await expect.poll(() => panelTabScrollCalls(page)).toBeGreaterThan(0);

  expectRowUnscrolledAndCentred(await readRow(page));
});

test("switching Start Pages re-mounts the panel without scrolling either row", async ({
  page,
}) => {
  await watchPanelTabScrollIntoView(page);
  await page.goto(fixture("landing-terminal-panel-row-scroll"));
  await expect.poll(() => panelTabScrollCalls(page)).toBeGreaterThan(0);

  for (const index of [1, 0]) {
    const before = await panelTabScrollCalls(page);
    await activateStartPage(page, index);
    // The panel re-portals into the newly focused page's row, which remounts
    // it and fires its tab strip's scrollIntoView again.
    await expect.poll(() => panelTabScrollCalls(page)).toBeGreaterThan(before);

    expectRowUnscrolledAndCentred(await readRow(page));
  }
});
