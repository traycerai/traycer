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
// across two pixels. What the squircle clips is left out, because there the
// clip's edge — not the art — decides the colour: the avatar's outermost ring
// always, and at 24 px, where the grid fills the box, the pixel diagonally
// inside each corner as well ({@link clipGaps}). Which colour a browser paints
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

/**
 * The avatar's squircle in bounding-box units, as `components/ui/avatar.tsx`
 * declares it. The test asserts the page still declares this exact path, so a
 * change to the clip reddens here instead of quietly moving the sample.
 */
const SQUIRCLE_PATH =
  "M .5 0 C .92 0 1 .08 1 .5 C 1 .92 .92 1 .5 1 C .08 1 0 .92 0 .5 C 0 .08 .08 0 .5 0 Z";

/** The squircle's four cubics at `size`, flattened to one closed polygon. */
function squircleOutline(size: number): Array<readonly [number, number]> {
  const corners: ReadonlyArray<
    readonly [
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
    ]
  > = [
    [
      [0.5, 0],
      [0.92, 0],
      [1, 0.08],
      [1, 0.5],
    ],
    [
      [1, 0.5],
      [1, 0.92],
      [0.92, 1],
      [0.5, 1],
    ],
    [
      [0.5, 1],
      [0.08, 1],
      [0, 0.92],
      [0, 0.5],
    ],
    [
      [0, 0.5],
      [0, 0.08],
      [0.08, 0],
      [0.5, 0],
    ],
  ];
  const steps = 512;
  const points: Array<readonly [number, number]> = [];
  for (const [p0, p1, p2, p3] of corners) {
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      const u = 1 - t;
      const at = (axis: 0 | 1): number =>
        u * u * u * p0[axis] +
        3 * u * u * t * p1[axis] +
        3 * u * t * t * p2[axis] +
        t * t * t * p3[axis];
      points.push([at(0) * size, at(1) * size]);
    }
  }
  return points;
}

/** Whether `point` is inside the outline. The squircle is convex. */
function within(
  outline: ReadonlyArray<readonly [number, number]>,
  point: readonly [number, number],
): boolean {
  let inside = false;
  for (let at = 0; at < outline.length; at++) {
    const [x1, y1] = outline[at];
    const [x2, y2] = outline[(at + 1) % outline.length];
    if (y1 > point[1] !== y2 > point[1]) {
      const crossing = x1 + ((point[1] - y1) / (y2 - y1)) * (x2 - x1);
      if (point[0] < crossing) inside = !inside;
    }
  }
  return inside;
}

/**
 * The pixels of a `size` box that the squircle does not wholly cover, less
 * the outermost ring the check already leaves out.
 *
 * At 24 px the mascot's grid fills the avatar (`CELL[24] * 12 === 24`), and
 * the squircle's corner reaches about 2.2 px in along the diagonal — further
 * than one ring. So the pixel diagonally inside each corner is part under the
 * clip's own edge, and the browser paints it blended however exactly the art
 * drew it. The art is allowed to fill the cell it belongs to: the shapes keep
 * columns 1 to 10 on rows 1, 2, 9 and 10, which `mascot-mark.test.ts` pins.
 * At every other size the grid is inset, so there is nothing here to skip.
 */
function clipGaps(size: number): string[] {
  const outline = squircleOutline(size);
  const gaps: string[] = [];
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const whole = [
        [x, y],
        [x + 1, y],
        [x, y + 1],
        [x + 1, y + 1],
      ].every((corner) => within(outline, [corner[0], corner[1]]));
      if (!whole) gaps.push(`${String(x)},${String(y)}`);
    }
  }
  return gaps;
}

/**
 * The pixels of `square` the check samples: not in the outermost ring of a
 * `size` box, and wholly covered by the squircle.
 */
function sampled(
  square: Square,
  size: number,
  gaps: ReadonlySet<string>,
): number {
  let count = 0;
  for (let y = square.y; y < square.y + square.side; y++) {
    for (let x = square.x; x < square.x + square.side; x++) {
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) continue;
      if (gaps.has(`${String(x)},${String(y)}`)) continue;
      count += 1;
    }
  }
  return count;
}

interface PixelCheck {
  readonly checked: number;
  readonly off: number;
}

/**
 * Each avatar's pixels inside the squares its mascot draws, less the avatar's
 * outermost ring and the pixels its squircle only part covers, counted, and
 * how many are not their layer's colour.
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
  gaps: ReadonlyArray<readonly string[]>,
): Promise<PixelCheck[]> {
  const shot = await page.screenshot({ type: "png", fullPage: true });
  return page.evaluate(
    async ({ base64, drawings, boxes, skips }) => {
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
        const skip = new Set(skips[index]);
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
              if (skip.has(`${String(px)},${String(py)}`)) continue;
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
      skips: gaps.map((gap) => [...gap]),
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
    // The third premise: the clip whose edge decides which pixels can be
    // sampled is the squircle this test models.
    const clips = await page
      .locator(`[data-testid="${sheet}"] clipPath > path`)
      .evaluateAll((paths) =>
        paths.map((path) => path.getAttribute("d") ?? ""),
      );
    expect(clips.length).toBeGreaterThan(0);
    expect([...new Set(clips)]).toEqual([SQUIRCLE_PATH]);

    const gaps = avatars.map((avatar) => clipGaps(avatar.size));
    const checks = await checkPixels(
      page,
      avatars.map((avatar) =>
        avatar.drawn.map((layer) => ({
          squares: squaresOf(layer.path),
          rgb: layer.rgb,
        })),
      ),
      avatars,
      gaps,
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
          .reduce(
            (sum, square) =>
              sum + sampled(square, avatar.size, new Set(gaps[index])),
            0,
          ),
        off: 0,
      })),
    );
  });
}
