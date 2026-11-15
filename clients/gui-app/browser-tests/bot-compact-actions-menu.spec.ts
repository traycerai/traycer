import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// What a choice in the compact header's Channel actions menu hands focus to once
// the menu has closed. Radix returns focus to the menu's trigger from a
// zero-delay timer at close, and the panel the choice opens must end up
// holding it instead; real focus and real pointer and key dispatch decide that,
// which jsdom does not. The page is the production surface, header, menu,
// search panel and settings panel over a fake host.

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

const SETTINGS = '[data-testid="bot-channel-settings"]';
const SEARCH_INPUT = '[data-testid="bot-search-input"]';

async function openMenu(page: Page): Promise<Locator> {
  await page.goto(fixture("bot-compact-actions-menu"));
  await page.getByRole("button", { name: /^Channel actions/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

type Choice = "pointer" | "keyboard";

async function choose(page: Page, item: Locator, how: Choice): Promise<void> {
  await expect(item).toBeVisible();
  if (how === "pointer") {
    await item.click();
    return;
  }
  await item.focus();
  await page.keyboard.press("Enter");
}

for (const how of ["pointer", "keyboard"] as const) {
  test.describe(`a ${how} choice`, () => {
    test("opens the channel settings holding the focus, and Escape closes them", async ({
      page,
    }) => {
      const menu = await openMenu(page);

      await choose(page, menu.getByText(/settings/i), how);

      await expect(page.getByRole("menu")).toHaveCount(0);
      const settings = page.locator(SETTINGS);
      await expect(settings).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(settings).toHaveCount(0);
    });

    test("opens Search with its field holding the focus", async ({ page }) => {
      const menu = await openMenu(page);

      await choose(page, menu.getByText(/^Search/), how);

      await expect(page.getByRole("menu")).toHaveCount(0);
      const input = page.locator(SEARCH_INPUT);
      await expect(input).toBeFocused();
      await page.keyboard.type("release");
      await expect(input).toHaveValue("release");
    });
  });
}
