import { expect, test, type Locator } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The Worktrees settings progress strip (`WorktreeDeleteProgressStrip`, the
// real component) with ten backgrounded failures of twenty tail lines each,
// inside a fill-height card whose inventory below it is `min-h-0 flex-1`
// (`worktree-delete-progress-overflow.html`). Layout is the claim: how tall
// the inventory stays, and whether every failed path's tail can still be
// reached, which jsdom cannot decide.

const FAILED_COUNT = 10;

test.use({ viewport: { width: 900, height: 700 } });

test.beforeEach(async ({ page }) => {
  await page.goto(fixture("worktree-delete-progress-overflow"));
  await expect(
    page.getByTestId("worktree-delete-progress-strip"),
  ).toBeVisible();
  await nextFrames(page, 3);
});

test("failure detail leaves the inventory a usable share of the card", async ({
  page,
}) => {
  const card = await page.getByTestId("fixture-card").boundingBox();
  const inventory = await page.getByTestId("fixture-inventory").boundingBox();
  if (card === null || inventory === null) throw new Error("no layout boxes");
  expect(inventory.height).toBeGreaterThanOrEqual(card.height * 0.4);
});

test("every failed path and its tail can be scrolled into the card", async ({
  page,
}) => {
  const details = page.getByTestId("worktree-delete-batch-failures");
  const failures = page.getByTestId("worktree-delete-batch-failure");
  await expect(failures).toHaveCount(FAILED_COUNT);
  await expect(details).toBeVisible();
  // The details region scrolls: its content is taller than its own box.
  expect(
    await details.evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);

  const card = page.getByTestId("fixture-card");
  const within = async (inner: Locator, label: string): Promise<void> => {
    const [region, cardBox, box] = await Promise.all([
      details.boundingBox(),
      card.boundingBox(),
      inner.boundingBox(),
    ]);
    if (region === null || cardBox === null || box === null) {
      throw new Error(`no layout box for ${label}`);
    }
    for (const outer of [region, cardBox]) {
      expect(box.y, `${label} top`).toBeGreaterThanOrEqual(outer.y);
      expect(box.y + box.height, `${label} bottom`).toBeLessThanOrEqual(
        outer.y + outer.height + 1,
      );
    }
  };

  for (let index = 0; index < FAILED_COUNT; index += 1) {
    const path = `/synthetic/worktrees/repo-${index}`;
    const failure = failures.filter({ hasText: path });
    // The path and its own tail belong to one entry.
    const pathLine = failure.getByText(path, { exact: true });
    const tail = failure.getByTestId("worktree-delete-error-tail");
    await expect(tail).toContainText(`repo-${index} tail line 19`);

    await pathLine.scrollIntoViewIfNeeded();
    await within(pathLine, `${path} path`);

    // A 20-line tail can be taller than the region, so only its END must fit.
    await tail.evaluate((node) => {
      node.scrollIntoView({ block: "end" });
    });
    const [region, cardBox, tailBox] = await Promise.all([
      details.boundingBox(),
      card.boundingBox(),
      tail.boundingBox(),
    ]);
    if (region === null || cardBox === null || tailBox === null) {
      throw new Error(`no layout box for ${path} tail`);
    }
    const tailBottom = tailBox.y + tailBox.height;
    for (const outer of [region, cardBox]) {
      expect(tailBottom, `${path} tail end`).toBeGreaterThan(outer.y);
      expect(tailBottom, `${path} tail end`).toBeLessThanOrEqual(
        outer.y + outer.height + 1,
      );
    }
  }
});
