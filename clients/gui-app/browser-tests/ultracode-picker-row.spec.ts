import { expect, test, type Locator, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

/**
 * The picker's Ultracode row, measured in a real browser: one line of hint
 * text whatever the model's name, the switch inside the row, the row directly
 * above the effort footer, nothing wider than the panel or the phone, the
 * picker frame, search, provider rail and effort band unmoved while the row's
 * state or the harness changes, and the request icon inside the model chip.
 */

declare global {
  interface Window {
    __ultracodeRowProbe:
      | {
          readonly setOffered: (offered: "true" | "false" | "unknown") => void;
          readonly setCarried: (carried: boolean) => void;
        }
      | undefined;
  }
}

async function setOffered(
  page: Page,
  offered: "true" | "false" | "unknown",
): Promise<void> {
  await page.evaluate((value) => {
    const probe = window.__ultracodeRowProbe;
    if (probe === undefined) throw new Error("the fixture probe is missing");
    probe.setOffered(value);
  }, offered);
  const toggle = page.getByRole("switch", { name: "Ultracode" });
  if (offered === "true") {
    await expect(toggle).toBeEnabled();
    await expect(
      page.getByText("Multi-agent · uses more of your limits"),
    ).toBeVisible();
    return;
  }
  await expect(toggle).toBeDisabled();
  if (offered === "false") {
    await expect(page.getByText(/^Not offered for /)).toBeVisible();
  } else {
    await expect(
      page.getByText("Multi-agent · uses more of your limits"),
    ).toBeVisible();
  }
}

async function setCarried(page: Page, carried: boolean): Promise<void> {
  await page.evaluate((value) => {
    const probe = window.__ultracodeRowProbe;
    if (probe === undefined) throw new Error("the fixture probe is missing");
    probe.setCarried(value);
  }, carried);
  const toggle = page.getByRole("switch", { name: "Ultracode" });
  if (carried) {
    await expect(toggle).toBeEnabled();
  } else {
    await expect(toggle).toBeDisabled();
  }
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${fixture("ultracode-picker-row")}${query}`);
  await expect(page.getByTestId("picker-ultracode-row")).toBeVisible();
  await nextFrames(page, 2);
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

async function box(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
    };
  });
}

test("the row sits directly above the effort footer", async ({ page }) => {
  await open(page, "");
  const row = page.getByTestId("picker-ultracode-row");
  const effortBand = page
    .getByRole("group", { name: "Thinking effort" })
    .locator("xpath=ancestor::div[contains(@class,'border-t')][1]");

  const rowBox = await box(row);
  const bandBox = await box(effortBand);

  expect(Math.abs(rowBox.bottom - bandBox.top)).toBeLessThanOrEqual(1);
});

test("the hint stays on one line when the model name is very long", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await open(page, "?offered=false&label=long");
  const hint = page.getByText(/^Not offered for /);

  const oneLine = await hint.evaluate((element) => {
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    return element.getBoundingClientRect().height <= lineHeight + 1;
  });

  expect(oneLine).toBe(true);
});

test("the normal hint is one line and the switch lies inside the row", async ({
  page,
}) => {
  await open(page, "");
  const row = page.getByTestId("picker-ultracode-row");
  const hint = page.getByText("Multi-agent · uses more of your limits");
  const toggle = page.getByRole("switch", { name: "Ultracode" });

  const hintOneLine = await hint.evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return element.getBoundingClientRect().height <= lineHeight + 1;
  });
  const rowBox = await box(row);
  const toggleBox = await box(toggle);

  expect(hintOneLine).toBe(true);
  expect(toggleBox.left).toBeGreaterThanOrEqual(rowBox.left);
  expect(toggleBox.right).toBeLessThanOrEqual(rowBox.right);
  expect(toggleBox.top).toBeGreaterThanOrEqual(rowBox.top);
  expect(toggleBox.bottom).toBeLessThanOrEqual(rowBox.bottom);
});

for (const variant of [
  "?offered=true",
  "?offered=false",
  "?offered=unknown",
  "?offered=true&carried=0",
]) {
  test(`the row fits a phone-width viewport (${variant})`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, variant);
    const row = page.getByTestId("picker-ultracode-row");

    const rowBox = await box(row);
    const overflowsPage = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );

    expect(rowBox.left).toBeGreaterThanOrEqual(0);
    expect(rowBox.right).toBeLessThanOrEqual(320);
    expect(overflowsPage).toBe(false);
  });
}

interface Frame {
  readonly dialog: Box;
  readonly search: Box;
  readonly rail: Box;
  readonly effort: Box;
}

function railOf(page: Page): Locator {
  return page
    .getByRole("tablist", { name: "Model providers" })
    .locator("xpath=..");
}

function effortOf(page: Page): Locator {
  return page
    .getByRole("group", { name: "Thinking effort" })
    .locator("xpath=ancestor::div[contains(@class,'border-t')][1]");
}

async function frameOf(page: Page): Promise<Frame> {
  return {
    dialog: await box(page.getByRole("dialog", { name: "Select model" })),
    search: await box(page.getByRole("textbox", { name: /^Search/ })),
    rail: await box(railOf(page)),
    effort: await box(effortOf(page)),
  };
}

function expectSameFrame(actual: Frame, expected: Frame): void {
  for (const part of ["dialog", "search", "rail", "effort"] as const) {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      expect(
        Math.abs(actual[part][edge] - expected[part][edge]),
        `${part}.${edge}`,
      ).toBeLessThanOrEqual(1);
    }
  }
}

test("the provider rail runs the full height of the picker body beside the row", async ({
  page,
}) => {
  await open(page, "");
  const frame = await frameOf(page);

  expect(Math.abs(frame.rail.bottom - frame.effort.bottom)).toBeLessThanOrEqual(
    1,
  );
  expect(frame.rail.top).toBeGreaterThanOrEqual(frame.search.bottom - 1);
});

test("the frame, search, rail and effort band do not move as the row's state changes", async ({
  page,
}) => {
  await open(page, "?offered=true");
  const baseline = await frameOf(page);

  for (const offered of ["false", "unknown", "true"] as const) {
    await setOffered(page, offered);
    await nextFrames(page, 2);
    expectSameFrame(await frameOf(page), baseline);
  }

  for (const carried of [false, true]) {
    await setCarried(page, carried);
    await nextFrames(page, 2);
    expectSameFrame(await frameOf(page), baseline);
  }
});

test("the frame does not move when the harness changes to another and back", async ({
  page,
}) => {
  await open(page, "");
  const baseline = await frameOf(page);

  await page.getByRole("tab", { name: /Codex/ }).click();
  await expect(page.getByTestId("picker-ultracode-row")).toHaveCount(0);
  await nextFrames(page, 2);
  expectSameFrame(await frameOf(page), baseline);

  await page.getByRole("tab", { name: /Claude/ }).click();
  await expect(page.getByTestId("picker-ultracode-row")).toBeVisible();
  await nextFrames(page, 2);
  expectSameFrame(await frameOf(page), baseline);
});

test("the request icon sits inside the model chip while the model is offered", async ({
  page,
}) => {
  await open(page, "?offered=true");
  const chip = page.getByRole("button", { name: /Opus 5\.5/ });
  const icon = chip.getByTestId("model-ultracode-icon");
  await expect(icon).toBeVisible();

  const chipBox = await box(chip);
  const iconBox = await box(icon);

  expect(iconBox.left).toBeGreaterThanOrEqual(chipBox.left);
  expect(iconBox.right).toBeLessThanOrEqual(chipBox.right);
  expect(iconBox.top).toBeGreaterThanOrEqual(chipBox.top);
  expect(iconBox.bottom).toBeLessThanOrEqual(chipBox.bottom);

  await setOffered(page, "false");
  await expect(page.getByTestId("model-ultracode-icon")).toHaveCount(0);
});
