import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A staged sandbox's shape gear has to stay inside a narrow composer row,
// and the trigger has to cut a long shape name rather than push the gear
// out. jsdom has no boxes, so the class tokens that used to stand in for
// this live here. The fixture mounts the real HostSwitcher at 330px.

const VIEWPORT = { width: 1280, height: 720 } as const;

interface GearBoxes {
  readonly containerLeft: number;
  readonly containerRight: number;
  readonly gearLeft: number;
  readonly gearRight: number;
  readonly triggerRight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

async function stagedLabel(page: Page): Promise<string> {
  const label = await page
    .getByTestId("host-switcher-staged-gear-stage")
    .getAttribute("data-staged-label");
  if (label === null || label.length === 0) {
    throw new Error("the fixture did not name its staged label");
  }
  return label;
}

async function readGear(page: Page, label: string): Promise<GearBoxes> {
  return page.evaluate((staged: string) => {
    const stage = document.querySelector(
      '[data-testid="host-switcher-staged-gear-stage"]',
    );
    const gear = document.querySelector(
      '[data-testid="host-switcher-staged-gear"]',
    );
    const trigger = document.querySelector(
      '[data-testid="settings-host-switcher"]',
    );
    if (
      !(stage instanceof HTMLElement) ||
      !(gear instanceof HTMLElement) ||
      !(trigger instanceof HTMLElement)
    ) {
      throw new Error("the staged gear row is missing a box");
    }
    const name = [...trigger.querySelectorAll("span")].find(
      (span) => span.childElementCount === 0 && span.textContent === staged,
    );
    if (!(name instanceof HTMLElement)) {
      throw new Error("the staged trigger label is missing");
    }
    const stageBox = stage.getBoundingClientRect();
    const gearBox = gear.getBoundingClientRect();
    const triggerBox = trigger.getBoundingClientRect();
    return {
      containerLeft: stageBox.left,
      containerRight: stageBox.right,
      gearLeft: gearBox.left,
      gearRight: gearBox.right,
      triggerRight: triggerBox.right,
      scrollWidth: name.scrollWidth,
      clientWidth: name.clientWidth,
    };
  }, label);
}

test.use({ viewport: VIEWPORT });

test("a long staged label truncates beside the gear, which stays inside the row", async ({
  page,
}) => {
  await page.goto(fixture("host-switcher-staged-gear"));
  const label = await stagedLabel(page);
  const trigger = page.getByRole("button", { name: `Host: ${label}` });
  await expect(trigger).toBeVisible();
  await nextFrames(page, 2);

  await expect
    .poll(async () => {
      const boxes = await readGear(page, label);
      return (
        boxes.gearLeft >= boxes.containerLeft &&
        boxes.gearRight <= boxes.containerRight &&
        boxes.triggerRight <= boxes.gearLeft &&
        boxes.scrollWidth > boxes.clientWidth
      );
    })
    .toBe(true);

  const boxes = await readGear(page, label);
  expect(boxes.gearLeft).toBeGreaterThanOrEqual(boxes.containerLeft);
  expect(boxes.gearRight).toBeLessThanOrEqual(boxes.containerRight);
  expect(boxes.triggerRight).toBeLessThanOrEqual(boxes.gearLeft);
  expect(boxes.scrollWidth).toBeGreaterThan(boxes.clientWidth);

  await expect(trigger).toHaveAccessibleName(`Host: ${label}`);
  await trigger.hover();
  await expect(page.getByRole("tooltip")).toHaveText(label);
});
