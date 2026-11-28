#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Deterministically regenerates the Windows taskbar overlay badges that ship
 * with the desktop shell: a red disc with the count in white, for 1-9 and
 * "9+". Dependency-free, like `generate-tray-icons.cjs`.
 *
 * Output (under `clients/desktop/resources/badge/`), each 16x16 RGBA:
 *   - badge-1.png ... badge-9.png
 *   - badge-9-plus.png   any count above 9
 *
 * `src/electron-main/app/app-icon-badge.ts` picks the file by count.
 */

const { mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { encodePng } = require("./png-codec.cjs");

const SIZE = 16;
const DISC = [220, 38, 38];
const INK = [255, 255, 255];
const SUPERSAMPLE = 4;

// 5x7 pixel glyphs, "#" inked.
const GLYPHS = {
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  9: [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  "+": [".....", ".....", "..#..", ".###.", "..#..", ".....", "....."],
};
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_GAP = 1;

/** Fraction of the pixel at (x, y) inside the disc filling the canvas. */
function discCoverage(x, y) {
  const radius = SIZE / 2;
  let inside = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const dx = x + (sx + 0.5) / SUPERSAMPLE - radius;
      const dy = y + (sy + 0.5) / SUPERSAMPLE - radius;
      if (dx * dx + dy * dy <= radius * radius) inside++;
    }
  }
  return inside / (SUPERSAMPLE * SUPERSAMPLE);
}

/** The inked pixels of `text`, centred on the canvas, as "x,y" keys. */
function inkedPixels(text) {
  const glyphs = [...text].map((character) => GLYPHS[character]);
  const width = glyphs.length * GLYPH_WIDTH + (glyphs.length - 1) * GLYPH_GAP;
  const left = Math.floor((SIZE - width) / 2);
  const top = Math.floor((SIZE - GLYPH_HEIGHT) / 2);
  const inked = new Set();
  glyphs.forEach((rows, index) => {
    const glyphLeft = left + index * (GLYPH_WIDTH + GLYPH_GAP);
    rows.forEach((row, rowIndex) => {
      [...row].forEach((cell, column) => {
        if (cell === "#") inked.add(`${glyphLeft + column},${top + rowIndex}`);
      });
    });
  });
  return inked;
}

function paintBadge(text) {
  const inked = inkedPixels(text);
  const px = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const color = inked.has(`${x},${y}`) ? INK : DISC;
      const off = (y * SIZE + x) * 4;
      px[off] = color[0];
      px[off + 1] = color[1];
      px[off + 2] = color[2];
      px[off + 3] = Math.round(discCoverage(x, y) * 255);
    }
  }
  return encodePng(SIZE, SIZE, px);
}

const outDir = resolve(__dirname, "..", "..", "resources", "badge");
mkdirSync(outDir, { recursive: true });

for (let count = 1; count <= 9; count++) {
  writeFileSync(resolve(outDir, `badge-${count}.png`), paintBadge(`${count}`));
}
writeFileSync(resolve(outDir, "badge-9-plus.png"), paintBadge("9+"));

console.log(`[desktop] generated badge icon assets at ${outDir}`);
