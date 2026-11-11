import { expect, test, type Locator, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

async function openPanel(page: Page): Promise<void> {
  await page.goto(fixture("sandbox-failure-row-layout"));
  await expect(page.locator("html")).toHaveCSS("font-size", "16px");
  await expect(page.getByTestId("sandboxes-row")).toHaveCount(2);
  await nextFrames(page, 2);
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("Expected a sandbox row element box");
  return result;
}

async function expectNoOverflow(locator: Locator): Promise<void> {
  expect(
    await locator.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
}

async function measureRow(row: Locator) {
  const identity = row.locator(":scope > div").first();
  const facts = identity.locator(":scope > div").last();
  const actions = row.locator(":scope > div").last();
  for (const element of [
    identity,
    facts,
    actions,
    ...(await facts.locator("p, span, div").all()),
    ...(await actions.getByRole("button").all()),
  ]) {
    await expectNoOverflow(element);
  }
  return {
    identity: await box(identity),
    facts: await box(facts),
    actions: await box(actions),
    row: await box(row),
  };
}

test("at 1280px failure remedies wrap beside a readable sandbox identity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPanel(page);
  const failed = page.locator('[data-sandbox-row="settings-failure"]');
  for (const name of [
    "Retry applying",
    "Open terminal",
    "Stop",
    "Choose another host",
    "Details",
    "More actions for Sandbox — environment settings could not be applied",
  ]) {
    await expect(
      failed.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  }
  for (const row of await page.getByTestId("sandboxes-row").all()) {
    const measured = await measureRow(row);
    expect(measured.identity.width).toBeGreaterThanOrEqual(20 * 16);
    expect(measured.actions.x).toBeGreaterThanOrEqual(
      measured.identity.x + measured.identity.width,
    );
    expect(measured.actions.y).toBeLessThan(
      measured.identity.y + measured.identity.height,
    );
  }
  const buttons = await failed.getByRole("button").all();
  const lines = new Set(
    await Promise.all(buttons.map(async (button) => (await box(button)).y)),
  );
  expect(lines.size).toBe(2);
});

test("at 390px sandbox controls stay stacked inside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPanel(page);
  for (const row of await page.getByTestId("sandboxes-row").all()) {
    const measured = await measureRow(row);
    expect(measured.actions.y).toBeGreaterThanOrEqual(
      measured.identity.y + measured.identity.height,
    );
    for (const button of await row.getByRole("button").all()) {
      await expect(button).toBeVisible();
      const control = await box(button);
      expect(control.x).toBeGreaterThanOrEqual(0);
      expect(control.x + control.width).toBeLessThanOrEqual(390);
    }
  }
});
