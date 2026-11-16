import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./support/fixtures.ts";

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE });

async function openView(
  page: Page,
  view: "account" | "computer" | "team-admin" | "team-viewer",
): Promise<void> {
  await page.goto(fixture("notification-hooks-mobile") + "?view=" + view);
  await expect(page.locator("#root")).toBeVisible();
}

async function expectPhoneWidthFits(page: Page): Promise<void> {
  const result = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    clippedControls: [
      ...document.querySelectorAll<HTMLElement>("button,[role=switch]"),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .filter(
        (element) =>
          element.getBoundingClientRect().right > window.innerWidth + 0.5,
      )
      .map(
        (element) =>
          element.innerText ||
          element.getAttribute("aria-label") ||
          element.tagName,
      ),
  }));
  expect(result.viewport).toBe(390);
  expect(result.document).toBeLessThanOrEqual(result.viewport);
  expect(result.body).toBeLessThanOrEqual(result.viewport);
  expect(result.clippedControls).toEqual([]);
}

test("account hook controls and empty state fit a 390px screen", async ({
  page,
}) => {
  await openView(page, "account");

  await expect(page.getByRole("button", { name: "Add hook" })).toBeVisible();
  await expectPhoneWidthFits(page);
});

test("computer hook controls and a literal HTTP hook fit a 390px screen", async ({
  page,
}) => {
  await openView(page, "computer");

  await expect(page.getByText("Build alerts", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  await expectPhoneWidthFits(page);
});

test("team editor controls and literal HTTP hook fit a 390px screen", async ({
  page,
}) => {
  await openView(page, "team-admin");

  await expect(page.getByText("Build alerts", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add hook" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  await expectPhoneWidthFits(page);
});

test("team Viewer sees the hook read-only without action controls at 390px", async ({
  page,
}) => {
  await openView(page, "team-viewer");

  await expect(page.getByText("Build alerts", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add hook" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: "Build alerts enabled" }),
  ).toBeDisabled();
  await expectPhoneWidthFits(page);
});
