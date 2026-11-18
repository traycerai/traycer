/**
 * The viewer and the build step agree on where pdf.js's data files live only
 * by convention - one names a directory in a URL, the other copies into it -
 * and a mismatch is invisible: pdf.js 404s the file and renders the document
 * WRONG rather than failing, which is the whole class of bug this pairing
 * exists to close.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PDFJS_ASSET_DIR,
  pdfjsDistRoot,
} from "../../../../../vite/pdfjs-assets";
import { pdfDataFileUrls } from "../pdf-asset-urls";

describe("pdf.js data file urls", () => {
  it("points at the directory the build step copies into", () => {
    const urls = pdfDataFileUrls();
    const base = new URL(`${PDFJS_ASSET_DIR}/`, document.baseURI).href;

    expect(urls.cMapUrl).toBe(`${base}cmaps/`);
    expect(urls.standardFontDataUrl).toBe(`${base}standard_fonts/`);
    expect(urls.wasmUrl).toBe(`${base}wasm/`);
    expect(urls.iccUrl).toBe(`${base}iccs/`);
  });

  it("names directories that exist in the installed pdfjs-dist", () => {
    // A pdfjs-dist upgrade that renames or drops one of these would otherwise
    // land silently: the copy step keeps working, the fetches 404.
    for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
      expect(existsSync(join(pdfjsDistRoot, directory))).toBe(true);
    }
  });

  it("ends every base url in a slash, as pdf.js requires", () => {
    // `getDocument` throws on a base without one rather than appending it.
    const urls = pdfDataFileUrls();
    expect(urls.cMapUrl.endsWith("/")).toBe(true);
    expect(urls.standardFontDataUrl.endsWith("/")).toBe(true);
    expect(urls.wasmUrl.endsWith("/")).toBe(true);
    expect(urls.iccUrl.endsWith("/")).toBe(true);
  });
});
