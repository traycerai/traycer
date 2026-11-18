#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Deterministically regenerates the Linux app icon set that electron-builder
 * installs into the hicolor icon theme, downscaled from the 1024x1024
 * `resources/bundle/icon.png`. Dependency-free (runtime built-ins only) so
 * contributors can rebuild the assets without an image-processing toolchain.
 *
 * Why a set and not the single source PNG: the freedesktop icon theme spec
 * only searches the size directories declared in the theme's `index.theme`,
 * and hicolor tops out at 512x512. Handing electron-builder a lone 1024x1024
 * PNG makes it install exactly one icon, at `hicolor/1024x1024/apps/` - a
 * directory no icon lookup ever visits - so `Icon=traycer-desktop` in the
 * generated `.desktop` entry silently resolves to nothing and the shell falls
 * back to a generic icon. Every size below is one hicolor does declare.
 *
 * Output (under `clients/desktop/resources/bundle/icons/`, consumed via
 * `build.linux.icon` in package.json): `<size>x<size>.png` for each ICON_SIZES
 * entry.
 */

const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { encodePng, decodePng } = require("./png-codec.cjs");

// Kept in sync with `REQUIRED_LINUX_ICON_SIZES` in
// `scripts/prepack/check-bundle-icons.cjs`, which refuses to package without
// them. All are declared in the stock hicolor `index.theme`.
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

/**
 * Box-filter downscale: every destination pixel averages the full source
 * region it covers, weighting partially-covered edge pixels by their exact
 * overlap. A 2-tap bilinear sample would read 4 of the 4096 source pixels
 * behind a 1024 -> 16 destination pixel and alias badly; averaging the whole
 * footprint is both simpler to reason about and correct at every ratio.
 *
 * Color channels are weighted by alpha (i.e. averaged premultiplied, then
 * unpremultiplied) so fully transparent source pixels - whose RGB is
 * arbitrary - cannot bleed into the resampled edges.
 */
function downscale(image, size) {
  const out = new Uint8Array(size * size * 4);
  const scale = image.width / size;

  for (let y = 0; y < size; y++) {
    const top = y * scale;
    const bottom = (y + 1) * scale;
    for (let x = 0; x < size; x++) {
      const left = x * scale;
      const right = (x + 1) * scale;

      let coverage = 0;
      let alphaSum = 0;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (
        let sourceY = Math.floor(top);
        sourceY < Math.ceil(bottom);
        sourceY++
      ) {
        const overlapY = Math.min(bottom, sourceY + 1) - Math.max(top, sourceY);
        for (
          let sourceX = Math.floor(left);
          sourceX < Math.ceil(right);
          sourceX++
        ) {
          const overlapX =
            Math.min(right, sourceX + 1) - Math.max(left, sourceX);
          const weight = overlapX * overlapY;
          const offset = (sourceY * image.width + sourceX) * 4;
          const alphaWeight = weight * image.rgba[offset + 3];

          red += image.rgba[offset] * alphaWeight;
          green += image.rgba[offset + 1] * alphaWeight;
          blue += image.rgba[offset + 2] * alphaWeight;
          alphaSum += alphaWeight;
          coverage += weight;
        }
      }

      const offset = (y * size + x) * 4;
      out[offset] = alphaSum === 0 ? 0 : Math.round(red / alphaSum);
      out[offset + 1] = alphaSum === 0 ? 0 : Math.round(green / alphaSum);
      out[offset + 2] = alphaSum === 0 ? 0 : Math.round(blue / alphaSum);
      out[offset + 3] = Math.round(alphaSum / coverage);
    }
  }

  return out;
}

const bundleDir = resolve(__dirname, "..", "..", "resources", "bundle");
const outDir = resolve(bundleDir, "icons");
const source = decodePng(readFileSync(resolve(bundleDir, "icon.png")));

if (source.width !== source.height) {
  throw new Error(
    `source icon must be square, got ${source.width}x${source.height}`,
  );
}

const largest = ICON_SIZES[ICON_SIZES.length - 1];
if (source.width < largest) {
  throw new Error(
    `source icon is ${source.width}x${source.width}, need at least ${largest}x${largest}`,
  );
}

mkdirSync(outDir, { recursive: true });

for (const size of ICON_SIZES) {
  writeFileSync(
    resolve(outDir, `${size}x${size}.png`),
    encodePng(size, size, downscale(source, size)),
  );
}

console.log(
  `[desktop] generated Linux app icon set (${ICON_SIZES.join(", ")}) at ${outDir}`,
);
