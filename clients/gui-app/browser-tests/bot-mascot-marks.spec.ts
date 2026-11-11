import { expect, test, type Page } from "@playwright/test";

import {
  botMascot,
  drawMascotMark,
  type MascotMarkSize,
} from "../src/lib/bots/mascot-mark.ts";
import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's mascot is drawn on whole CSS pixels at every avatar size, so at a
// device pixel ratio of 1 each pixel inside a drawn square is exactly its
// layer's colour: no edge of the art is anti-aliased and no cell is smeared
// across two pixels. The avatar's outermost ring of pixels is left out: at 24
// px the mascot's grid fills the box, and the squircle's own edge sets how
// much of a pixel there is covered. Which colour a browser paints at a pixel
// is what jsdom cannot decide. The fixture is the contact sheet
// (`bot-mascot-marks.html`), every picture on it the production
// `NamedBotAvatar`, and its twenty bots draw all ten shapes.

test.use({
  viewport: { width: 1200, height: 900 },
  deviceScaleFactor: 1,
});

const SIZE_PX: Readonly<Record<string, MascotMarkSize>> = {
  xs: 16,
  sm: 24,
  default: 32,
  lg: 40,
};

interface Square {
  readonly x: number;
  readonly y: number;
  readonly side: number;
}

interface PaintedAvatar {
  readonly botId: string;
  readonly size: MascotMarkSize;
  /** The avatar's top left on the page. */
  readonly x: number;
  readonly y: number;
  /** The path text and fill colour of each layer, as the page draws them. */
  readonly drawn: ReadonlyArray<{
    readonly path: string;
    readonly rgb: readonly [number, number, number];
  }>;
}

/** The bot avatars of one sheet: where each sits and what it draws. */
async function readAvatars(
  page: Page,
  sheet: string,
): Promise<Array<Omit<PaintedAvatar, "size"> & { readonly sizeName: string }>> {
  return page.locator(`[data-testid="${sheet}"]`).evaluate((root) => {
    // A fill may be `hsl(…)`: a canvas resolves any CSS colour to the sRGB
    // bytes the screenshot holds.
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
        const row = avatar.closest<HTMLElement>("[data-bot-id]");
        if (row === null) throw new Error("a bot avatar outside a sheet row");
        const rect = avatar.getBoundingClientRect();
        return {
          botId: row.dataset.botId ?? "",
          sizeName: avatar.dataset.size ?? "",
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          drawn: [
            ...avatar.querySelectorAll<SVGPathElement>(
              '[data-slot="bot-mascot"] path',
            ),
          ].map((path) => ({
            path: path.getAttribute("d") ?? "",
            rgb: rgb(path.getAttribute("fill") ?? ""),
          })),
        };
      },
    );
  });
}

/** The path's `M x y h a v a h -a z` squares. */
function squaresOf(path: string): Square[] {
  return [...path.matchAll(/M(\d+) (\d+)h(\d+)v/g)].map(([, x, y, side]) => ({
    x: Number(x),
    y: Number(y),
    side: Number(side),
  }));
}

/** The pixels of `square` that are not in the outermost ring of a `size` box. */
function insideRing(square: Square, size: number): number {
  const across = (from: number): number =>
    Math.min(from + square.side, size - 1) - Math.max(from, 1);
  return Math.max(across(square.x), 0) * Math.max(across(square.y), 0);
}

interface PixelCheck {
  readonly checked: number;
  readonly off: number;
}

/**
 * Each avatar's pixels inside the squares its mascot draws, less the
 * avatar's outermost ring, counted, and how many are not their layer's
 * colour.
 */
async function checkPixels(
  page: Page,
  layers: ReadonlyArray<
    ReadonlyArray<{
      readonly squares: readonly Square[];
      readonly rgb: readonly [number, number, number];
    }>
  >,
  origins: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly size: number;
  }>,
): Promise<PixelCheck[]> {
  const shot = await page.screenshot({ type: "png", fullPage: true });
  return page.evaluate(
    async ({ base64, drawings, boxes }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx === null) throw new Error("no 2d canvas to decode pixels with");
      ctx.drawImage(image, 0, 0);
      return drawings.map((drawing, index) => {
        const box = boxes[index];
        let checked = 0;
        let off = 0;
        for (const layer of drawing) {
          for (const square of layer.squares) {
            const { data } = ctx.getImageData(
              box.x + square.x,
              box.y + square.y,
              square.side,
              square.side,
            );
            for (let at = 0; at < data.length; at += 4) {
              const px = square.x + ((at / 4) % square.side);
              const py = square.y + Math.floor(at / 4 / square.side);
              if (
                px === 0 ||
                py === 0 ||
                px === box.size - 1 ||
                py === box.size - 1
              ) {
                continue;
              }
              checked += 1;
              if (
                Math.abs(data[at] - layer.rgb[0]) > 2 ||
                Math.abs(data[at + 1] - layer.rgb[1]) > 2 ||
                Math.abs(data[at + 2] - layer.rgb[2]) > 2
              ) {
                off += 1;
              }
            }
          }
        }
        return { checked, off };
      });
    },
    {
      base64: shot.toString("base64"),
      drawings: layers.map((layer) => [...layer]),
      boxes: [...origins],
    },
  );
}

for (const theme of ["light", "dark"]) {
  test(`every mascot in the ${theme} theme paints each square its layer's colour, pixel for pixel`, async ({
    page,
  }) => {
    await page.goto(`${fixture("bot-mascot-marks")}?theme=${theme}`);
    const sheet = "sheet-colour";
    await expect(
      page.locator(`[data-testid="${sheet}"] [data-slot="bot-mascot"]`),
    ).toHaveCount(80);
    await nextFrames(page, 2);

    const avatars = (await readAvatars(page, sheet)).map(
      ({ sizeName, ...avatar }) => ({ ...avatar, size: SIZE_PX[sizeName] }),
    );
    // The premise: the sheet puts every avatar on whole pixels, as a row of
    // the app does.
    for (const avatar of avatars) {
      expect(Number.isInteger(avatar.x) && Number.isInteger(avatar.y)).toBe(
        true,
      );
    }
    // The other premise: the page draws the squares the generator gives.
    const expected = avatars.map(
      (avatar) =>
        drawMascotMark(botMascot(avatar.botId, null), avatar.size).layers,
    );
    expect(avatars.map((avatar) => avatar.drawn.map((l) => l.path))).toEqual(
      expected.map((layers) => layers.map((layer) => layer.path)),
    );

    const checks = await checkPixels(
      page,
      avatars.map((avatar) =>
        avatar.drawn.map((layer) => ({
          squares: squaresOf(layer.path),
          rgb: layer.rgb,
        })),
      ),
      avatars,
    );
    const painted = avatars.map((avatar, index) => ({
      bot: `${avatar.botId}@${String(avatar.size)}`,
      ...checks[index],
    }));
    expect(painted).toEqual(
      avatars.map((avatar, index) => ({
        bot: `${avatar.botId}@${String(avatar.size)}`,
        checked: expected[index]
          .flatMap((layer) => squaresOf(layer.path))
          .reduce((sum, square) => sum + insideRing(square, avatar.size), 0),
        off: 0,
      })),
    );
  });
}
