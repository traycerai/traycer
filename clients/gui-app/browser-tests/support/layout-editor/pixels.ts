import type { Page } from "@playwright/test";

import type { Rect } from "./dom.ts";

/**
 * Painted pixels, read the way a person sees them: off a screenshot. A
 * computed style says what the cascade resolved, not what reached the screen
 * (a `light-dark()` colour, an opaque descendant painting over a stroke, an
 * anti-aliased edge), so the paint claims here go through the same screenshot
 * pipeline and are decoded by the browser's own PNG decoder in the page
 * (`PAGE_TOOLS` in `pages.ts`), so pixels never cross the wire except as the
 * few numbers a check asks for.
 */

export type Rgb = readonly [number, number, number];

/** A screenshot clip, in whole CSS pixels (the fixtures run at a device scale of 1). */
async function shotOf(page: Page, clip: Rect): Promise<string> {
  const buffer = await page.screenshot({
    type: "png",
    clip: {
      x: Math.floor(clip.x),
      y: Math.floor(clip.y),
      width: Math.max(1, Math.ceil(clip.width)),
      height: Math.max(1, Math.ceil(clip.height)),
    },
  });
  return buffer.toString("base64");
}

/** One painted pixel, read off a 1x1 screenshot. */
export async function samplePixelAt(
  page: Page,
  x: number,
  y: number,
): Promise<Rgb> {
  const base64 = await shotOf(page, { x, y, width: 1, height: 1 });
  return page.evaluate<Rgb>(`(async () => {
    const shot = await window.__decodePng(${JSON.stringify(base64)});
    return [shot.data[0], shot.data[1], shot.data[2]];
  })()`);
}

/** A region's pixels as a flat `r, g, b, r, g, b...` array. */
export async function regionPixels(
  page: Page,
  clip: Rect,
): Promise<readonly number[]> {
  const base64 = await shotOf(page, clip);
  return page.evaluate<readonly number[]>(`(async () => {
    const shot = await window.__decodePng(${JSON.stringify(base64)});
    const rgb = [];
    for (let i = 0; i < shot.data.length; i += 4) rgb.push(shot.data[i], shot.data[i + 1], shot.data[i + 2]);
    return rgb;
  })()`);
}

/**
 * A computed colour as the rgb triple the screen would paint it, through a
 * swatch: parsing an `oklch()` behind a `light-dark()` in a test would go
 * wrong silently, and a black that was never the colour would make every
 * comparison below read as "unlit". The swatch sits in the window's own
 * corner so it is on screen whatever the viewport has been resized to.
 */
export async function resolveRgb(page: Page, cssColor: string): Promise<Rgb> {
  await page.evaluate(`(() => {
    const node = document.createElement("div");
    node.setAttribute("data-colour-swatch", "");
    Object.assign(node.style, {
      position: "fixed", left: "0px", top: "0px", width: "8px", height: "8px",
      zIndex: "2147483000", background: ${JSON.stringify(cssColor)},
    });
    document.body.append(node);
  })()`);
  const pixel = await samplePixelAt(page, 4, 4);
  await page.evaluate(
    'document.querySelector("[data-colour-swatch]")?.remove()',
  );
  return pixel;
}

/** The editing colour, `--warning-foreground`, as it paints. */
export function sampleAmber(page: Page): Promise<Rgb> {
  return resolveRgb(page, "var(--warning-foreground)");
}

export function sameRgb(
  left: Rgb | null,
  right: Rgb | null,
  tolerance: number,
): boolean {
  if (left === null || right === null) return false;
  return left.every(
    (channel, index) => Math.abs(channel - right[index]) <= tolerance,
  );
}

export function rgbText(rgb: Rgb | null): string {
  return rgb === null ? "null" : `rgb(${rgb.join(",")})`;
}

export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio between two colours (1 for the same colour). */
export function contrastRatio(left: Rgb, right: Rgb): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Middle-half ink pixels against `fill`, or a padding sample when `null`. */
export async function inkInside(
  page: Page,
  rect: Rect,
  fill: Rgb | null,
): Promise<number> {
  const base64 = await shotOf(page, rect);
  return page.evaluate<number>(`(async () => {
    const { data, width, height } = await window.__decodePng(${JSON.stringify(base64)});
    const at = (x, y) => { const i = (y * width + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    const fill = ${fill === null ? "at(4, Math.floor(height / 2))" : JSON.stringify(fill)};
    let ink = 0;
    for (let y = Math.floor(height / 4); y < Math.ceil((height * 3) / 4); y += 1) {
      for (let x = Math.floor(width / 4); x < Math.ceil((width * 3) / 4); x += 1) {
        const p = at(x, y);
        if (Math.abs(p[0] - fill[0]) + Math.abs(p[1] - fill[1]) + Math.abs(p[2] - fill[2]) > 90) ink += 1;
      }
    }
    return ink;
  })()`);
}

export interface LitCount {
  /** Positions along the run where some pixel across it is the target colour. */
  readonly lit: number;
  readonly along: number;
  /** The same, per quarter of the run. */
  readonly quarters: ReadonlyArray<{
    readonly lit: number;
    readonly along: number;
  }>;
}

/**
 * How many positions ALONG a clip hold a pixel within `tolerance` (the sum of
 * the three channel differences) of `target` somewhere ACROSS it, in total and
 * per quarter of the run. One number for a whole edge cannot fail for an edge
 * that is half covered, which is the defect class the editing frame was
 * rebuilt for (L-130): an opaque descendant covers a CONTIGUOUS stretch, so it
 * empties whole quarters.
 *
 * `horizontal` runs along x (the band is a row of columns), otherwise along y.
 */
export async function countLit(
  page: Page,
  clip: Rect,
  run: {
    readonly horizontal: boolean;
    readonly target: Rgb;
    readonly tolerance: number;
  },
): Promise<LitCount> {
  const { horizontal, target, tolerance } = run;
  const base64 = await shotOf(page, clip);
  return page.evaluate<LitCount>(`(async () => {
    const { width, height, data } = await window.__decodePng(${JSON.stringify(base64)});
    const target = ${JSON.stringify(target)};
    const horizontal = ${String(horizontal)};
    const along = horizontal ? width : height;
    const across = horizontal ? height : width;
    let lit = 0;
    const quarters = [0, 0, 0, 0];
    const quarterAlong = [0, 0, 0, 0];
    for (let a = 0; a < along; a += 1) {
      let hit = false;
      for (let b = 0; b < across && !hit; b += 1) {
        const x = horizontal ? a : b;
        const y = horizontal ? b : a;
        const i = (y * width + x) * 4;
        const distance =
          Math.abs(data[i] - target[0]) +
          Math.abs(data[i + 1] - target[1]) +
          Math.abs(data[i + 2] - target[2]);
        if (distance <= ${String(tolerance)} && data[i + 3] > 200) hit = true;
      }
      const quarter = Math.min(3, Math.floor((a * 4) / Math.max(1, along)));
      quarterAlong[quarter] += 1;
      if (hit) {
        lit += 1;
        quarters[quarter] += 1;
      }
    }
    return {
      lit,
      along,
      quarters: quarters.map((count, index) => ({ lit: count, along: quarterAlong[index] })),
    };
  })()`);
}
