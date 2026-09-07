/**
 * Without these the viewer renders CJK documents and scanned pages incorrectly rather than failing - see that plugin's comment.
 */

/** Mirrors `PDFJS_ASSET_DIR`; `pdf-asset-urls.test.ts` holds the two together. */
const PDFJS_ASSET_DIR = "pdfjs";

export interface PdfDataFileUrls {
  readonly cMapUrl: string;
  readonly cMapPacked: boolean;
  readonly standardFontDataUrl: string;
  readonly wasmUrl: string;
  readonly iccUrl: string;
}

/**
 * The trailing slash is load-bearing - pdf.js appends filenames to these and rejects a base without one.
 */
function dataFileUrl(directory: string): string {
  return new URL(`${PDFJS_ASSET_DIR}/${directory}/`, document.baseURI).href;
}

export function pdfDataFileUrls(): PdfDataFileUrls {
  return {
    cMapUrl: dataFileUrl("cmaps"),
    // The shipped CMaps are the binary `.bcmap` form, not the ASCII originals.
    cMapPacked: true,
    standardFontDataUrl: dataFileUrl("standard_fonts"),
    wasmUrl: dataFileUrl("wasm"),
    iccUrl: dataFileUrl("iccs"),
  };
}
