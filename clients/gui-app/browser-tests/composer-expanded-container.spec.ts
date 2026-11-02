import { expect, test } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The composer card is a size container (`@container`) so its toolbar can
// reflow to its own width. An engine whose containers trap `fixed` boxes drops
// that while the sheet is open (`containerTrapsFixedBoxes`); the test browser
// does not trap them, so the card must keep its container while expanded. The
// engine's behaviour is what jsdom cannot decide.

test.use({ viewport: { width: 390, height: 780 } });

test("the card keeps its size container while the sheet is expanded", async ({
  page,
}) => {
  await page.goto(fixture("composer-expanded-container"));
  await nextFrames(page, 2);

  const shell = page.locator("[data-composer-shell]");
  await expect(shell).toHaveAttribute("data-composer-expanded", "");
  const card = shell.locator(
    "xpath=ancestor::div[contains(@class,'@container')][1]",
  );

  await expect(card).toHaveCSS("container-type", "inline-size");
});
