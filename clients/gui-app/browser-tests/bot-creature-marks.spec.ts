import { expect, test, type Page } from "@playwright/test";

import {
  creatureMark,
  drawCreatureMark,
  type CreatureMarkSize,
} from "../src/lib/bots/creature-mark.ts";
import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's creature mark is drawn on whole CSS pixels at every avatar size,
// so at a device pixel ratio of 1 each pixel inside the
// creature's frame is either the swatch or the ink: no edge is anti-aliased,
// no cell is smeared across two pixels, and the squircle's clip cuts none of
// it. Which colour a browser paints at a pixel is what jsdom cannot decide.
// The fixture is the contact sheet (`bot-creature-marks.html`), every
// picture on it the production `NamedBotAvatar`.

test.use({
  viewport: { width: 1200, height: 900 },
  deviceScaleFactor: 1,
});

const SIZE_PX: Readonly<Record<string, CreatureMarkSize>> = {
  xs: 16,
  sm: 24,
  default: 32,
  lg: 40,
};

interface PaintedAvatar {
  readonly botId: string;
  readonly size: CreatureMarkSize;
  readonly x: number;
  readonly y: number;
  readonly swatch: readonly [number, number, number];
  readonly ink: readonly [number, number, number];
}

interface PixelCount {
  readonly swatch: number;
  readonly ink: number;
  readonly other: number;
}

/** The bot avatars of one sheet: where each sits and its two colours. */
async function readAvatars(
  page: Page,
  sheet: string,
): Promise<Array<Omit<PaintedAvatar, "size"> & { readonly sizeName: string }>> {
  return page.locator(`[data-testid="${sheet}"]`).evaluate((root) => {
    // A computed colour may be `oklch(…)`: a canvas resolves any CSS colour
    // to the sRGB bytes the screenshot holds.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("no 2d canvas to resolve colours with");
    const rgb = (value: string): [number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    return [...root.querySelectorAll<HTMLElement>('[data-identity="bot"]')].map(
      (avatar) => {
        const fallback = avatar.querySelector<HTMLElement>(
          '[data-slot="avatar-fallback"]',
        );
        const row = avatar.closest<HTMLElement>("[data-bot-id]");
        if (fallback === null || row === null) {
          throw new Error("a bot avatar outside a sheet row, or without art");
        }
        const rect = avatar.getBoundingClientRect();
        const style = getComputedStyle(fallback);
        return {
          botId: row.dataset.botId ?? "",
          sizeName: avatar.dataset.size ?? "",
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          swatch: rgb(style.backgroundColor),
          ink: rgb(style.color),
        };
      },
    );
  });
}

/**
 * Each avatar's pixels inside its creature's frame (one cell in from every
 * edge, where the drawn rows and columns all lie), sorted into the swatch,
 * the ink and anything else.
 */
async function countPixels(
  page: Page,
  avatars: readonly PaintedAvatar[],
): Promise<PixelCount[]> {
  const shot = await page.screenshot({ type: "png", fullPage: true });
  return page.evaluate(
    async ({ base64, boxes }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx === null) throw new Error("no 2d canvas to decode pixels with");
      ctx.drawImage(image, 0, 0);
      const near = (data: Uint8ClampedArray, at: number, rgb: number[]) =>
        Math.abs(data[at] - rgb[0]) <= 2 &&
        Math.abs(data[at + 1] - rgb[1]) <= 2 &&
        Math.abs(data[at + 2] - rgb[2]) <= 2;
      return boxes.map((box) => {
        const cell = box.size / 8;
        const side = box.size - 2 * cell;
        const data = ctx.getImageData(
          box.x + cell,
          box.y + cell,
          side,
          side,
        ).data;
        let swatch = 0;
        let ink = 0;
        let other = 0;
        for (let at = 0; at < data.length; at += 4) {
          if (near(data, at, [...box.swatch])) swatch += 1;
          else if (near(data, at, [...box.ink])) ink += 1;
          else other += 1;
        }
        return { swatch, ink, other };
      });
    },
    { base64: shot.toString("base64"), boxes: [...avatars] },
  );
}

/** The ink pixels the generator's drawing covers at a size. */
function expectedInk(botId: string, size: CreatureMarkSize): number {
  const squares = drawCreatureMark(creatureMark(botId), size).path.matchAll(
    /M\d+ \d+h(\d+)/g,
  );
  const cell = size / 8;
  let ink = 0;
  for (const [, side] of squares) {
    // A square smaller than a cell is an eye's hole inside a body cell.
    ink += Number(side) === cell ? cell * cell : -(Number(side) ** 2);
  }
  return ink;
}

for (const theme of ["light", "dark"]) {
  test(`every creature in the ${theme} theme paints only its swatch and its ink, cell for cell`, async ({
    page,
  }) => {
    await page.goto(`${fixture("bot-creature-marks")}?theme=${theme}`);
    const sheet = "sheet-colour";
    await expect(
      page.locator(`[data-testid="${sheet}"] [data-slot="bot-creature"]`),
    ).toHaveCount(80);
    await nextFrames(page, 2);

    const avatars = (await readAvatars(page, sheet)).map(
      ({ sizeName, ...avatar }) => ({ ...avatar, size: SIZE_PX[sizeName] }),
    );
    // The premise: the sheet puts every avatar on whole pixels, as a row
    // of the app does.
    for (const avatar of avatars) {
      expect(Number.isInteger(avatar.x) && Number.isInteger(avatar.y)).toBe(
        true,
      );
    }

    const counts = await countPixels(page, avatars);
    const painted = avatars.map((avatar, index) => ({
      bot: `${avatar.botId}@${String(avatar.size)}`,
      ...counts[index],
    }));
    expect(painted).toEqual(
      avatars.map((avatar) => {
        const side = avatar.size - (2 * avatar.size) / 8;
        const ink = expectedInk(avatar.botId, avatar.size);
        return {
          bot: `${avatar.botId}@${String(avatar.size)}`,
          swatch: side * side - ink,
          ink,
          other: 0,
        };
      }),
    );
  });
}
