import { expect, test } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The Tracy channel pane's connecting spinner sits in the middle of the
// content pane. The pane is a flex row, so the wrapper's width is decided by
// real flex layout (a wrapper without a width shrinks to the spinner and pins
// to the left edge), which jsdom does not compute. The snapshot is held back
// so the pane stays connecting; the claim is measured on the spinner glyph,
// since a full-size wrapper is trivially centred.

// The intended offset is zero: flex centring puts the glyph's centre on the
// pane's centre. The half pixel allows for layout rounding and pixel snapping
// of an odd free space.
const CENTRE_TOLERANCE_PX = 0.5;

interface Case {
  readonly name: string;
  readonly query: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
}

const CASES: readonly Case[] = [
  {
    name: "wide desktop",
    query: "?snapshot=held&form=desktop",
    width: 1280,
    height: 800,
    phone: false,
  },
  {
    name: "narrow phone",
    query: "?snapshot=held",
    width: 390,
    height: 844,
    phone: true,
  },
];

for (const { name, query, width, height, phone } of CASES) {
  test.describe(name, () => {
    test.use({
      viewport: { width, height },
      hasTouch: phone,
      isMobile: phone,
    });

    test("the connecting spinner is centred in the content pane", async ({
      page,
    }) => {
      await page.goto(`${fixture("bot-compact-actions-menu")}${query}`);
      const pane = page.getByTestId("bot-tab-content-pane");
      const spinner = pane
        .getByTestId("bot-tab-connecting")
        .locator(":scope > *")
        .first();
      await expect(spinner).toBeVisible();
      await nextFrames(page, 3);

      const paneBox = await pane.boundingBox();
      const spinnerBox = await spinner.boundingBox();
      if (paneBox === null || spinnerBox === null)
        throw new Error("pane and spinner must have geometry");

      if (!phone) {
        expect(paneBox.x).toBeGreaterThan(0);
      }
      const paneCentre = {
        x: paneBox.x + paneBox.width / 2,
        y: paneBox.y + paneBox.height / 2,
      };
      const spinnerCentre = {
        x: spinnerBox.x + spinnerBox.width / 2,
        y: spinnerBox.y + spinnerBox.height / 2,
      };
      expect(
        Math.abs(spinnerCentre.x - paneCentre.x),
        `spinner centre x ${String(spinnerCentre.x)} vs pane centre x ${String(paneCentre.x)}`,
      ).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
      expect(
        Math.abs(spinnerCentre.y - paneCentre.y),
        `spinner centre y ${String(spinnerCentre.y)} vs pane centre y ${String(paneCentre.y)}`,
      ).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
    });
  });
}
