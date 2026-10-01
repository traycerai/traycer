import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The group editor in the Activity view, in real Chrome: the "Work" group is
// split across Working and Idle, so it has a block (or a rail column) in each,
// and the editor has to open on the one it was asked from. Where a popover
// sits is real layout, and the right-click and the keys are real input.

test.use({ viewport: { width: 900, height: 900 } });

const ACTIVITY = `${fixture("side-tab-strip")}?edge=left&scene=sections`;
const GROUP = "fixture-group";

async function openStrip(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
  await nextFrames(page, 4);
}

function blockIn(page: Page, lane: "working" | "idle"): Locator {
  return page.locator(
    `[data-testid="side-tab-group-block-${GROUP}"][data-strip-lane="${lane}"]`,
  );
}

function columnIn(page: Page, lane: "working" | "idle"): Locator {
  return page.locator(
    `[data-testid="side-tab-group-column-${GROUP}"][data-strip-lane="${lane}"]`,
  );
}

/**
 * The one editor open, the only one, beside the strip and once its entrance
 * has played, its top level with its anchor's.
 */
async function expectAnchoredTo(page: Page, anchor: Locator): Promise<void> {
  const name = page.getByRole("textbox", { name: "Group name" });
  await expect(name).toBeVisible();
  await expect(name).toHaveCount(1);
  const popover = page.locator('[data-slot="popover-content"]');
  await popover.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  const anchorBox = await anchor.boundingBox();
  const popoverBox = await popover.boundingBox();
  if (anchorBox === null || popoverBox === null) throw new Error("no layout");
  expect(popoverBox.x).toBeGreaterThanOrEqual(anchorBox.x + anchorBox.width);
  expect(popoverBox.y).toBeCloseTo(anchorBox.y, 0);
}

for (const lane of ["working", "idle"] as const) {
  test(`opens the editor on a right-click of the ${lane} block's label, at that label`, async ({
    page,
  }) => {
    await openStrip(page, ACTIVITY);
    const label = blockIn(page, lane).getByTestId(
      `side-tab-group-label-${GROUP}`,
    );

    await label.click({ button: "right" });

    await expectAnchoredTo(page, label);
  });
}

for (const [key, name] of [
  ["F2", "F2"],
  ["ContextMenu", "the context-menu key"],
  ["Shift+F10", "Shift+F10"],
  ["Enter", "Enter"],
  ["Space", "Space"],
] as const) {
  test(`opens the editor on ${name} on a focused label, at that label`, async ({
    page,
  }) => {
    await openStrip(page, ACTIVITY);
    const label = blockIn(page, "idle").getByTestId(
      `side-tab-group-label-${GROUP}`,
    );

    await label.focus();
    await page.keyboard.press(key);

    await expectAnchoredTo(page, label);
  });
}

test("opens nothing on a click of the label", async ({ page }) => {
  await openStrip(page, ACTIVITY);
  const label = blockIn(page, "idle").getByTestId(
    `side-tab-group-label-${GROUP}`,
  );

  await label.click();

  // The click landed: the label took focus. The editor would open by now.
  await expect(label).toBeFocused();
  await nextFrames(page, 10);
  await expect(page.getByRole("textbox", { name: "Group name" })).toHaveCount(
    0,
  );
});

test("opens a task's Edit group… at the label of that task's own block", async ({
  page,
}) => {
  await openStrip(page, ACTIVITY);
  const block = blockIn(page, "idle");
  await block.getByTestId("tab-epic-fixture-launch").click({ button: "right" });
  await page.getByText("Tab appearance").click();

  await page.getByRole("menuitem", { name: "Edit group…" }).click();

  await expectAnchoredTo(
    page,
    block.getByTestId(`side-tab-group-label-${GROUP}`),
  );
});

test("opens the editor on a right-click of a rail column outside its tiles, at that column", async ({
  page,
}) => {
  await openStrip(page, `${ACTIVITY}&rail=1`);
  const column = columnIn(page, "idle");
  const box = await column.boundingBox();
  if (box === null) throw new Error("no layout");

  // The column's own 4px inset, beside its first tile.
  await page.mouse.click(box.x + 2, box.y + box.height / 2, {
    button: "right",
  });

  await expectAnchoredTo(page, column);
});

test("opens a rail tile's Edit group… at that tile's own column", async ({
  page,
}) => {
  await openStrip(page, `${ACTIVITY}&rail=1`);
  const column = columnIn(page, "idle");
  await column
    .getByTestId("tab-epic-fixture-launch")
    .click({ button: "right" });
  await page.getByText("Tab appearance").click();

  await page.getByRole("menuitem", { name: "Edit group…" }).click();

  await expectAnchoredTo(page, column);
});
