#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Precheck for native app icons consumed by electron-builder. These are distinct
 * from the runtime tray PNGs: Windows Start menu and desktop shortcuts resolve
 * their image from the icon resource embedded in the packaged executable, so a
 * missing `icon.ico` silently falls back to Electron's generic executable icon.
 *
 * Linux fails the same way for a subtler reason: the freedesktop icon theme
 * spec only searches size directories declared in the theme's `index.theme`,
 * and hicolor stops at 512x512. Given a lone 1024x1024 source PNG,
 * electron-builder installs exactly one icon at `hicolor/1024x1024/apps/` -
 * which no icon lookup visits - so the `.desktop` entry's `Icon=` key resolves
 * to nothing. The `icons/` set below is what `build.linux.icon` points at.
 */

const { openSync, fstatSync, readSync, closeSync } = require("node:fs");
const { resolve } = require("node:path");
const { PNG_SIGNATURE } = require("../assets/png-codec.cjs");

const bundleDir = resolve(__dirname, "..", "..", "resources", "bundle");

const ICNS_SIGNATURE = Buffer.from("icns", "ascii");
const REQUIRED_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// Kept in sync with `ICON_SIZES` in `scripts/assets/generate-linux-icons.cjs`.
// Every entry must be a size hicolor's `index.theme` declares.
const REQUIRED_LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

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

function checkLinuxIconSet() {
  for (const size of REQUIRED_LINUX_ICON_SIZES) {
    const name = `icons/${size}x${size}.png`;
    const buffer = readAsset(name);
    if (buffer === null) continue;
    if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      problems.push(`not a valid PNG (bad signature): ${name}`);
      continue;
    }
    // electron-builder maps each file to a hicolor size directory, so a
    // filename that disagrees with its IHDR installs the icon under the
    // wrong size and renders blurry (or not at all).
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width !== size || height !== size) {
      problems.push(`${name} is ${width}x${height}, expected ${size}x${size}`);
    }
  }
}

checkPng("icon.png");
checkIcns("icon.icns");
checkIco("icon.ico");
checkLinuxIconSet();

if (problems.length > 0) {
  console.error(
    `[desktop] app icon precheck failed under ${bundleDir}:\n` +
      problems.map((p) => `         - ${p}`).join("\n") +
      "\n\n" +
      "         The desktop build refuses to package without native app icons.\n" +
      "         Windows requires resources/bundle/icon.ico so Start menu and\n" +
      "         desktop shortcuts use the Traycer icon instead of Electron's\n" +
      "         default executable icon.\n" +
      "         Linux requires the resources/bundle/icons set so the hicolor\n" +
      "         theme can resolve the .desktop entry's Icon= key - regenerate\n" +
      "         it via 'bun scripts/assets/generate-linux-icons.cjs'.",
  );
  process.exit(1);
}

console.log(
  `[desktop] app icon precheck ok - icon.png, icon.icns, icon.ico, and the ` +
    `${REQUIRED_LINUX_ICON_SIZES.length}-size Linux icons set present at ${bundleDir}.`,
);
