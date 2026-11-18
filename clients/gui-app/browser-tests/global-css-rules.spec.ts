import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Rules in `index.css` whose claims need a real engine: the reduced-motion
// rule (computed durations, started transitions, `transitionend`) and the one
// hiding toasts while the menu is open.

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test.beforeEach(async ({ page }) => {
    await page.goto(fixture("global-css-rules"));
    await nextFrames(page, 2);
  });

  test("an element with no declared transition has no transition duration", async ({
    page,
  }) => {
    expect(await transitionDuration(page, "#plain")).toBe("0s");
  });

  test("changing `top` on an element with no declared transition starts no transition", async ({
    page,
  }) => {
    const running = await page.evaluate(async () => {
      const plain = document.getElementById("plain");
      if (plain === null) throw new Error("fixture lost #plain");
      plain.style.top = "100px";
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return plain.getAnimations().length;
    });

    expect(running).toBe(0);
  });

  test("an element that declares a transition still fires transitionend", async ({
    page,
  }) => {
    const ended = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const declared = document.getElementById("declared");
          if (declared === null) throw new Error("fixture lost #declared");
          declared.addEventListener("transitionend", (event) =>
            resolve(event.propertyName),
          );
          declared.style.top = "100px";
        }),
    );

    expect(ended).toBe("top");
    expect(
      Number.parseFloat(await transitionDuration(page, "#declared")),
    ).toBeGreaterThan(0);
  });
});

test.describe("toasts under the menu", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(fixture("global-css-rules"));
    await nextFrames(page, 2);
  });

  test("the toaster is hidden while the menu is open", async ({ page }) => {
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-mobile-menu-open", "");
    });

    await expect(page.locator("#toaster")).toHaveCSS("visibility", "hidden");
  });

  test("the toaster is visible while the menu is closed", async ({ page }) => {
    await expect(page.locator("#toaster")).toHaveCSS("visibility", "visible");
  });
});

function transitionDuration(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate((element) => getComputedStyle(element).transitionDuration);
}
