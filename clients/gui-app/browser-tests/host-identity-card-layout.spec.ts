import { expect, test, type Locator, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

async function openCards(page: Page): Promise<void> {
  await page.goto(fixture("host-identity-card-layout"));
  await expect(page.getByTestId("fixture-failed")).toBeVisible();
  await nextFrames(page, 2);
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("Expected a visible element box");
  return result;
}

test("at 390px long host names use their own row with rename beside them and actions below", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCards(page);

  for (const id of ["fixture-windows", "fixture-failed"]) {
    const card = page.getByTestId(id);
    const nameRow = card.getByTestId("host-identity-name-row");
    const row = await box(nameRow);
    const available = await box(nameRow.locator(".."));
    const name = await box(nameRow.getByRole("heading"));
    const rename = await box(card.getByRole("button", { name: "Edit name" }));
    const actions = await box(card.getByTestId("fixture-host-actions"));

    expect(Math.abs(row.width - available.width)).toBeLessThan(2);
    expect(rename.x).toBeGreaterThanOrEqual(name.x + name.width);
    expect(Math.abs(rename.y - name.y)).toBeLessThan(2);
    expect(actions.y).toBeGreaterThanOrEqual(row.y + row.height);
    for (const button of await card.getByRole("button").all()) {
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      const control = await box(button);
      expect(control.x).toBeGreaterThanOrEqual(0);
      expect(control.x + control.width).toBeLessThanOrEqual(390);
    }
  }
});

test("on desktop host actions remain beside the name", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCards(page);

  for (const id of ["fixture-windows", "fixture-failed"]) {
    const card = page.getByTestId(id);
    const nameRow = await box(card.getByTestId("host-identity-name-row"));
    const actions = await box(card.getByTestId("fixture-host-actions"));
    expect(actions.y).toBeLessThan(nameRow.y + nameRow.height);
    expect(actions.y + actions.height).toBeGreaterThan(nameRow.y);
  }
});

test("at 390px About this host and the install record wrap within the pane", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCards(page);

  const about = page.getByTestId("host-overview-about");
  const record = page.getByTestId("host-overview-install-record");
  await expect(
    about.getByRole("heading", { name: "About this host" }),
  ).toBeVisible();
  for (const label of [
    "Host ID",
    "Added to account",
    "Last seen",
    "Last reported version",
    "Platform",
  ]) {
    await expect(about.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(
    record.getByRole("heading", { name: "Install record" }),
  ).toBeVisible();
  for (const label of ["Version", "Build", "SHA-256", "Platform"]) {
    await expect(record.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(
    record.getByText(
      "local-runtime-2026-11-08-release-integration-with-a-long-build-identifier",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    record.getByText("Unsigned local build", { exact: true }),
  ).toBeVisible();

  for (const group of [about, record]) {
    for (const value of await group.locator("dd").all()) {
      const rect = await box(value);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(390);
      expect(
        await value.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
  }
  for (const name of ["Copy host ID", "Copy SHA-256"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeVisible();
    const control = await box(button);
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.x + control.width).toBeLessThanOrEqual(390);
  }
});
