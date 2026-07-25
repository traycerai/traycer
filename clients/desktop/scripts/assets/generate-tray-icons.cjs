#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Deterministically regenerates the tray icon PNGs that ship with the desktop
 * shell from `resources/tray/logo-source.png`. The generator is intentionally
 * dependency-free (only runtime built-ins) so contributors can rebuild the assets
 * without installing an image-processing toolchain.
 *
 * Output (under `clients/desktop/resources/tray/`):
 *   - trayTemplate.png      16x16  black + alpha, macOS template image
 *   - trayTemplate@2x.png   32x32  black + alpha, macOS retina template
 *   - tray.png              16x16  white + alpha, Windows / Linux fallback
 *   - tray@2x.png           32x32  white + alpha, retina variant
 *
 * The macOS variants use only black pixels with alpha so AppKit can invert
 * them automatically against light/dark menu bars when
 * `nativeImage.setTemplateImage(true)` is set (see `src/electron-main/tray/tray.ts`).
 * The non-mac variants use white pixels so the icon stays visible against
 * the dark default tray backgrounds on Windows 10/11 and most Linux DEs.
 */

const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { encodePng, decodePng } = require("./png-codec.cjs");

function alphaBounds(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.rgba[(y * image.width + x) * 4 + 3] === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error("source icon has no visible pixels");
  }

  return { minX, minY, maxX, maxY };
}

function sourceAlphaAt(image, sourceX, sourceY) {
  if (
    sourceX < 0 ||
    sourceX >= image.width - 1 ||
    sourceY < 0 ||
    sourceY >= image.height - 1
  ) {
    return 0;
  }

  const x0 = Math.floor(sourceX);
  const y0 = Math.floor(sourceY);
  const tx = sourceX - x0;
  const ty = sourceY - y0;
  const sample = (x, y) => image.rgba[(y * image.width + x) * 4 + 3];
  return (
    sample(x0, y0) * (1 - tx) * (1 - ty) +
    sample(x0 + 1, y0) * tx * (1 - ty) +
    sample(x0, y0 + 1) * (1 - tx) * ty +
    sample(x0 + 1, y0 + 1) * tx * ty
  );
}

function paintGlyph(image, outputSize, contentSize, color) {
  const bounds = alphaBounds(image);
  const sourceWidth = bounds.maxX - bounds.minX + 1;
  const sourceHeight = bounds.maxY - bounds.minY + 1;
  const scale = Math.min(contentSize / sourceWidth, contentSize / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const left = (outputSize - renderedWidth) / 2;
  const top = (outputSize - renderedHeight) / 2;
  const px = new Uint8Array(outputSize * outputSize * 4);

  for (let y = 0; y < outputSize; y++) {
    for (let x = 0; x < outputSize; x++) {
      const sourceX = bounds.minX + (x + 0.5 - left) / scale;
      const sourceY = bounds.minY + (y + 0.5 - top) / scale;
      const alpha = Math.round(sourceAlphaAt(image, sourceX, sourceY));
      const off = (y * outputSize + x) * 4;
      px[off] = color[0];
      px[off + 1] = color[1];
      px[off + 2] = color[2];
      px[off + 3] = alpha;
    }
  }

  return encodePng(outputSize, outputSize, px);
}

const outDir = resolve(__dirname, "..", "..", "resources", "tray");
const source = decodePng(readFileSync(resolve(outDir, "logo-source.png")));
mkdirSync(outDir, { recursive: true });

writeFileSync(
  resolve(outDir, "trayTemplate.png"),
  paintGlyph(source, 16, 15, [0, 0, 0]),
);
writeFileSync(
  resolve(outDir, "trayTemplate@2x.png"),
  paintGlyph(source, 32, 30, [0, 0, 0]),
);
writeFileSync(
  resolve(outDir, "tray.png"),
  paintGlyph(source, 16, 15, [255, 255, 255]),
);
writeFileSync(
  resolve(outDir, "tray@2x.png"),
  paintGlyph(source, 32, 30, [255, 255, 255]),
);

console.log(`[desktop] generated tray icon assets at ${outDir}`);
