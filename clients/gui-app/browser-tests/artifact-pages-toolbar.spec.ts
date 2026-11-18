import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// On a phone the artifact's control toolbar takes its own row above the page
// instead of floating over it; on a desktop width it still floats over the
// page's corner. Where the boxes land is what jsdom cannot decide.

async function boxes(page: Page) {
  await page.goto(fixture("artifact-pages-toolbar"));
  const toolbar = page.getByRole("toolbar", { name: "HTML artifact controls" });
  await expect(toolbar).toBeVisible();
  await nextFrames(page, 2);
  // The box the served page fills. The page itself is not served in a
  // browser fixture (it needs the desktop runner), so the wrapper the frame
  // is mounted in stands for it.
  const frame = toolbar.locator("xpath=../following-sibling::div[1]");
  const toolbarBox = await toolbar.boundingBox();
  const frameBox = await frame.boundingBox();
  if (toolbarBox === null || frameBox === null) {
    throw new Error("the toolbar or the frame has no box");
  }
  return { toolbarBox, frameBox };
}

test.describe("at a phone width", () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test("the toolbar sits above the frame, not over it", async ({ page }) => {
    const { toolbarBox, frameBox } = await boxes(page);

    expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(frameBox.y);
  });
});

test.describe("at a desktop width", () => {
  test.use({ viewport: { width: 1200, height: 780 } });

  test("the toolbar floats over the frame's corner", async ({ page }) => {
    const { toolbarBox, frameBox } = await boxes(page);

    expect(toolbarBox.y).toBeGreaterThanOrEqual(frameBox.y);
    expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(
      frameBox.y + frameBox.height,
    );
  });
});
