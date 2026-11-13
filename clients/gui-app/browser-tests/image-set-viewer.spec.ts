import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// Images attached together share one viewer that steps between them. What
// jsdom cannot decide is the part that makes stepping usable: the viewer has
// no boxes there, and a button that disables itself under focus only swallows
// keys in a real browser. The fixture is the real composer strip holding three
// images of three different shapes.

const SHOTS = process.env.IMAGE_SET_VIEWER_SHOTS;

async function openViewerAt(page: Page, position: number): Promise<Locator> {
  await page.goto(fixture("image-set-viewer"));
  await page
    .getByRole("button", { name: `Open Image#${String(position)}:` })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(counter(dialog)).toHaveText(`${String(position)} / 3`);
  await shownImageIsFitted(dialog);
  // The dialog scales in as it opens; a box read before that ends is not the
  // box it rests at.
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  return dialog;
}

function counter(dialog: Locator): Locator {
  return dialog.getByRole("status", { name: /^Image \d of 3$/ });
}

/** The stage reports a zoom only once the shown image has decoded and fitted. */
async function shownImageIsFitted(dialog: Locator): Promise<void> {
  await expect(
    dialog.getByRole("button", { name: "Fit to screen" }),
  ).toHaveAttribute("aria-pressed", "true");
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  await nextFrames(page, 2);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test("the viewer and its arrows keep their place from one image to the next", async ({
  page,
}) => {
  const dialog = await openViewerAt(page, 2);
  const next = dialog.getByRole("button", { name: "Next image" });
  const before = {
    dialog: await dialog.boundingBox(),
    next: await next.boundingBox(),
  };
  await shot(page, "second-of-three");

  // Image 3 is nearly five times as wide as image 2.
  await next.click();
  await expect(counter(dialog)).toHaveText("3 / 3");
  await shownImageIsFitted(dialog);
  await shot(page, "third-of-three");

  expect({
    dialog: await dialog.boundingBox(),
    next: await next.boundingBox(),
  }).toEqual(before);
});

test("the arrow keys still step after the pressed arrow disables itself", async ({
  page,
}) => {
  const dialog = await openViewerAt(page, 1);
  await shot(page, "first-of-three");
  const next = dialog.getByRole("button", { name: "Next image" });
  const nextCentre = await centreOf(next);

  await page.mouse.click(nextCentre.x, nextCentre.y);
  await expect(counter(dialog)).toHaveText("2 / 3");
  await page.mouse.click(nextCentre.x, nextCentre.y);
  await expect(counter(dialog)).toHaveText("3 / 3");
  await expect(next).toBeDisabled();

  await page.keyboard.press("ArrowLeft");
  await expect(counter(dialog)).toHaveText("2 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(counter(dialog)).toHaveText("3 / 3");
});

test("an image opens fitted, not at the zoom its neighbour was left at", async ({
  page,
}) => {
  const dialog = await openViewerAt(page, 1);
  const fit = dialog.getByRole("button", { name: "Fit to screen" });

  await dialog.getByRole("button", { name: "Zoom in" }).click();
  await expect(fit).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("ArrowRight");
  await expect(counter(dialog)).toHaveText("2 / 3");
  await shownImageIsFitted(dialog);

  await page.keyboard.press("ArrowLeft");
  await expect(counter(dialog)).toHaveText("1 / 3");
  await shownImageIsFitted(dialog);
});
