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
const { deflateSync, inflateSync } = require("node:zlib");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * stride + 1 + x * 4;
      raw[dst] = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none
  const idat = deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodePng(buffer) {
  if (
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("source icon is not a PNG");
  }

  const chunks = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (
        data[8] !== 8 ||
        data[9] !== 6 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        throw new Error("source icon must be an 8-bit non-interlaced RGBA PNG");
      }
    }
    if (type === "IDAT") {
      chunks.push(data);
    }
    if (type === "IEND") {
      break;
    }
  }

  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  let rawOffset = 0;
  let previous = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const row = Uint8Array.from(raw.subarray(rawOffset, rawOffset + stride));
    rawOffset += stride;

    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? row[i - 4] : 0;
      const up = previous[i];
      const upperLeft = i >= 4 ? previous[i - 4] : 0;
      if (filter === 1) {
        row[i] = (row[i] + left) & 0xff;
      } else if (filter === 2) {
        row[i] = (row[i] + up) & 0xff;
      } else if (filter === 3) {
        row[i] = (row[i] + Math.floor((left + up) / 2)) & 0xff;
      } else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - upperLeft);
        row[i] =
          (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) &
          0xff;
      } else if (filter !== 0) {
        throw new Error(`unsupported PNG filter type: ${filter}`);
      }
    }

    rgba.set(row, y * stride);
    previous = row;
  }

  return { width, height, rgba };
}

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
