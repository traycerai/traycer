import { expect, test } from "@playwright/test";
import { centreOf, fixture } from "./support/fixtures.ts";

for (const setting of ["model", "reasoning", "fast mode"] as const) {
  test(`the new-agent prompt receives the next click after changing ${setting}`, async ({
    page,
  }) => {
    await page.goto(fixture("model-picker-modal-focus"));
    const prompt = page.getByRole("textbox", { name: "Ask Traycer anything" });
    await expect(prompt).toBeVisible();
    const background = page.locator(
      '[data-composer-editor][aria-label="Background chat"]',
    );
    await expect(background).toHaveCount(1);
    expect(
      await background.evaluate(
        (element) => element.closest('[aria-hidden="true"], [inert]') !== null,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: /Sonnet · low/ }).click();
    const picker = page.getByRole("dialog", { name: "Select model" });
    await expect(picker).toBeVisible();
    await expect(picker).toBeInViewport();

    if (setting === "model") {
      await page.getByRole("option", { name: "Haiku" }).click();
      await expect(
        page.getByRole("button", { name: /Haiku · low/ }),
      ).toBeVisible();
    } else if (setting === "reasoning") {
      await page.getByRole("button", { name: "High" }).click();
      await expect(
        page.getByRole("button", { name: /Sonnet · high/ }),
      ).toBeVisible();
    } else {
      await page.getByRole("button", { name: "Fast mode" }).click();
      await expect(
        page.getByRole("button", { name: "Fast mode" }),
      ).toHaveAttribute("aria-pressed", "true");
    }

    const point = await centreOf(prompt);
    await page.mouse.click(point.x, point.y);
    await expect(picker).not.toBeVisible();
    await expect(prompt).toBeFocused();
    await page.keyboard.type("Focus stays in the prompt");
    await expect(prompt).toHaveText("Focus stays in the prompt");
    await page.waitForTimeout(600);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });
}

test("keyboard Speed selection does not commit the active model row", async ({
  page,
}) => {
  await page.goto(`${fixture("model-picker-modal-focus")}?dual-tier=1`);
  await page.getByRole("button", { name: /Sonnet · low/ }).click();
  const picker = page.getByRole("dialog", { name: "Select model" });
  await expect(picker).toBeVisible();

  const speed = page.getByRole("button", { name: /Speed: Standard/ });
  await speed.focus();
  await page.keyboard.press("Enter");
  const ultrafast = page.getByRole("menuitemradio", { name: "Ultrafast" });
  await expect(ultrafast).toBeVisible();
  expect(
    await ultrafast.evaluate(
      (element) => element.closest('[data-slot="popover-content"]') === null,
    ),
  ).toBe(true);
  await page.keyboard.press("End");
  await expect(ultrafast).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(
    page.getByRole("button", { name: /Speed: Ultrafast/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Sonnet · low/ }),
  ).toBeVisible();
  await expect(picker).toBeVisible();
});

test("pointer Speed selection and Escape keep the model picker open", async ({
  page,
}) => {
  await page.goto(`${fixture("model-picker-modal-focus")}?dual-tier=1`);
  await page.getByRole("button", { name: /Sonnet · low/ }).click();
  const picker = page.getByRole("dialog", { name: "Select model" });
  await expect(picker).toBeVisible();

  await page.getByRole("button", { name: /Speed: Standard/ }).click();
  const ultrafast = page.getByRole("menuitemradio", { name: "Ultrafast" });
  await expect(ultrafast).toBeVisible();
  await ultrafast.click();
  await expect(
    page.getByRole("button", { name: /Speed: Ultrafast/ }),
  ).toBeVisible();
  await expect(picker).toBeVisible();

  await page.getByRole("button", { name: /Speed: Ultrafast/ }).click();
  await expect(ultrafast).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ultrafast).not.toBeVisible();
  await expect(picker).toBeVisible();
});
