#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Precheck for native app icons consumed by electron-builder. These are distinct
 * from the runtime tray PNGs: Windows Start menu and desktop shortcuts resolve
 * their image from the icon resource embedded in the packaged executable, so a
 * missing `icon.ico` silently falls back to Electron's generic executable icon.
 */

const { openSync, fstatSync, readSync, closeSync } = require("node:fs");
const { resolve } = require("node:path");

const bundleDir = resolve(__dirname, "..", "..", "resources", "bundle");

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const ICNS_SIGNATURE = Buffer.from("icns", "ascii");
const REQUIRED_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const problems = [];

function readAsset(name) {
  const path = resolve(bundleDir, name);
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    problems.push(`missing: ${name}`);
    return null;
  }

  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size === 0) {
      problems.push(`empty or non-file: ${name}`);
      return null;
    }
    const buffer = Buffer.alloc(info.size);
    readSync(fd, buffer, 0, info.size, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function checkPng(name) {
  const buffer = readAsset(name);
  if (buffer === null) return;
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    problems.push(`not a valid PNG (bad signature): ${name}`);
  }
}

function checkIcns(name) {
  const buffer = readAsset(name);
  if (buffer === null) return;
  if (buffer.length < 8 || !buffer.subarray(0, 4).equals(ICNS_SIGNATURE)) {
    problems.push(`not a valid ICNS (bad signature): ${name}`);
    return;
  }
  const declaredLength = buffer.readUInt32BE(4);
  if (declaredLength !== buffer.length) {
    problems.push(
      `ICNS length mismatch: ${name} declares ${declaredLength} bytes, file is ${buffer.length} bytes`,
    );
  }
}

function readIcoSize(value) {
  return value === 0 ? 256 : value;
}

function checkIco(name) {
  const buffer = readAsset(name);
  if (buffer === null) return;
  if (buffer.length < 6) {
    problems.push(`not a valid ICO (too small): ${name}`);
    return;
  }

  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  if (reserved !== 0 || type !== 1 || count === 0) {
    problems.push(`not a valid ICO header: ${name}`);
    return;
  }

  const directoryLength = 6 + count * 16;
  if (directoryLength > buffer.length) {
    problems.push(`ICO directory extends past end of file: ${name}`);
    return;
  }

  const sizes = new Set();
  for (let index = 0; index < count; index++) {
    const entryOffset = 6 + index * 16;
    const width = readIcoSize(buffer[entryOffset]);
    const height = readIcoSize(buffer[entryOffset + 1]);
    const bitCount = buffer.readUInt16LE(entryOffset + 6);
    const imageLength = buffer.readUInt32LE(entryOffset + 8);
    const imageOffset = buffer.readUInt32LE(entryOffset + 12);

    if (width !== height) {
      problems.push(`ICO frame ${index} is not square in ${name}`);
      continue;
    }
    if (bitCount !== 32) {
      problems.push(`ICO frame ${index} is ${bitCount}-bit, expected 32-bit`);
    }
    if (imageOffset + imageLength > buffer.length) {
      problems.push(`ICO frame ${index} extends past end of file: ${name}`);
      continue;
    }
    if (
      !buffer
        .subarray(imageOffset, imageOffset + PNG_SIGNATURE.length)
        .equals(PNG_SIGNATURE)
    ) {
      problems.push(`ICO frame ${index} is not PNG-backed: ${name}`);
    }
    sizes.add(width);
  }

  for (const size of REQUIRED_ICO_SIZES) {
    if (!sizes.has(size)) {
      problems.push(`ICO missing ${size}x${size} frame: ${name}`);
    }
  }
}

checkPng("icon.png");
checkIcns("icon.icns");
checkIco("icon.ico");

if (problems.length > 0) {
  console.error(
    `[desktop] app icon precheck failed under ${bundleDir}:\n` +
      problems.map((p) => `         - ${p}`).join("\n") +
      "\n\n" +
      "         The desktop build refuses to package without native app icons.\n" +
      "         Windows requires resources/bundle/icon.ico so Start menu and\n" +
      "         desktop shortcuts use the Traycer icon instead of Electron's\n" +
      "         default executable icon.",
  );
  process.exit(1);
}

console.log(
  `[desktop] app icon precheck ok - icon.png, icon.icns, and icon.ico present at ${bundleDir}.`,
);
