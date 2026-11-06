import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The search panel is drawn in the slot beside a bot's channel, which is 576px
// wide by default and no narrower than 320px, and as the full screen of a
// phone. Whether its filter row wraps inside that pane instead of running out
// of it, whether a long result holds to two lines, and whether the page
// scrolls sideways are layout, which jsdom does not compute. This renders the
// production panel at each width, over a search it already holds, against the
// real stylesheet.

const PANE = '[data-testid="pane"]';
const FILTERS = '[data-testid="bot-search-filters"]';
const HIT = '[data-testid="bot-search-hit"]';
const SNIPPET = ".line-clamp-2";

// The slot widths sit in a desktop window; the phone's pane is its whole window.
// `rows` is how many rows of buttons the four filters need AT LEAST there: the
// default width holds them in one, and the narrower two must wrap.
const SLOT_DEFAULT = {
  name: "the slot's default width",
  width: 576,
  rows: 1,
  viewport: { width: 1400, height: 900 },
};
const SLOT_MINIMUM = {
  name: "the slot's minimum width",
  width: 320,
  rows: 2,
  viewport: { width: 1400, height: 900 },
};
const PHONE = {
  name: "a phone's width",
  width: 390,
  rows: 2,
  viewport: { width: 390, height: 844 },
};

const FiltersSchema = z.object({
  paneLeft: z.number(),
  paneRight: z.number(),
  boxRight: z.number(),
  scrollWidth: z.number(),
  clientWidth: z.number(),
  buttonLefts: z.array(z.number()),
  buttonRights: z.array(z.number()),
  buttonTops: z.array(z.number()),
});

async function openPanel(page: Page, width: number): Promise<void> {
  await page.goto(`${fixture("bot-search-panel")}?width=${String(width)}`);
  await expect(page.locator(HIT)).toHaveCount(4);
  await nextFrames(page, 2);
}

async function readFilters(page: Page): Promise<z.infer<typeof FiltersSchema>> {
  return FiltersSchema.parse(
    await page.evaluate(
      (selectors: { readonly pane: string; readonly filters: string }) => {
        const element = (selector: string): Element => {
          const found = document.querySelector(selector);
          if (found === null) throw new Error(`no ${selector}`);
          return found;
        };
        const pane = element(selectors.pane).getBoundingClientRect();
        const box = element(selectors.filters);
        const rect = box.getBoundingClientRect();
        const buttons = [...box.querySelectorAll("button")].map((button) =>
          button.getBoundingClientRect(),
        );
        return {
          paneLeft: pane.left,
          paneRight: pane.right,
          boxRight: rect.right,
          scrollWidth: box.scrollWidth,
          clientWidth: box.clientWidth,
          buttonLefts: buttons.map((button) => button.left),
          buttonRights: buttons.map((button) => button.right),
          buttonTops: buttons.map((button) => Math.round(button.top)),
        };
      },
      { pane: PANE, filters: FILTERS },
    ),
  );
}

for (const { name, width, rows, viewport } of [
  SLOT_DEFAULT,
  SLOT_MINIMUM,
  PHONE,
]) {
  test.describe(`at ${name}`, () => {
    test.use({ viewport });

    test("the filter row wraps inside the pane", async ({ page }) => {
      await openPanel(page, width);

      const filters = await readFilters(page);

      expect(filters.buttonLefts).toHaveLength(4);
      for (const left of filters.buttonLefts) {
        expect(left).toBeGreaterThanOrEqual(filters.paneLeft);
      }
      for (const right of filters.buttonRights) {
        expect(right).toBeLessThanOrEqual(filters.paneRight);
      }
      expect(filters.boxRight).toBeLessThanOrEqual(filters.paneRight);
      expect(filters.scrollWidth).toBeLessThanOrEqual(filters.clientWidth);
      // Where the pane is too narrow for one row, it is the wrap that keeps
      // them inside.
      expect(new Set(filters.buttonTops).size).toBeGreaterThanOrEqual(rows);
    });

    test("a long snippet holds two lines", async ({ page }) => {
      await openPanel(page, width);

      const snippet = page.locator(HIT).first().locator(SNIPPET);
      const reading = z
        .object({
          height: z.number(),
          lineHeight: z.number(),
          clamped: z.boolean(),
        })
        .parse(
          await snippet.evaluate((element) => {
            const lineHeight = Number.parseFloat(
              getComputedStyle(element).lineHeight,
            );
            return {
              height: element.getBoundingClientRect().height,
              lineHeight,
              // More text than the two lines show: the clamp is doing the work.
              clamped: element.scrollHeight > element.clientHeight,
            };
          }),
        );

      expect(reading.clamped).toBe(true);
      expect(reading.height).toBeLessThanOrEqual(reading.lineHeight * 2 + 1);
      expect(reading.height).toBeGreaterThan(reading.lineHeight + 1);
    });

    test("the page does not scroll sideways", async ({ page }) => {
      await openPanel(page, width);

      const overflow = z
        .object({
          page: z.number(),
          pane: z.number(),
          widestRow: z.number(),
        })
        .parse(
          await page.evaluate(
            (selectors: { readonly pane: string; readonly hit: string }) => {
              const pane = document.querySelector(selectors.pane);
              if (pane === null) throw new Error("no pane");
              const rows = [...document.querySelectorAll(selectors.hit)];
              return {
                page:
                  document.documentElement.scrollWidth -
                  document.documentElement.clientWidth,
                pane: pane.scrollWidth - pane.clientWidth,
                widestRow: Math.max(
                  ...rows.map((row) => row.scrollWidth - row.clientWidth),
                ),
              };
            },
            { pane: PANE, hit: HIT },
          ),
        );

      expect(overflow).toEqual({ page: 0, pane: 0, widestRow: 0 });
    });
  });
}
