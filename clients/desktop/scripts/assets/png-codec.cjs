/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Minimal PNG encode/decode shared by the asset generators in this directory
 * (`generate-tray-icons.cjs`, `generate-linux-icons.cjs`).
 *
 * Intentionally dependency-free (runtime built-ins only) so contributors can
 * rebuild the shipped icon assets without installing an image-processing
 * toolchain. Scope is deliberately narrow: 8-bit non-interlaced RGBA, which is
 * what every source asset under `resources/` already is.
 */

const { deflateSync, inflateSync } = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
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

module.exports = { PNG_SIGNATURE, encodePng, decodePng };
