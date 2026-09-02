/**
 * Guards the #1 field bug of every comparable pdf.js integration: a broken
 * worker URL does not error - pdf.js silently falls back to parsing on the
 * MAIN thread, which "works" in every casual test while janking the app on
 * real documents. Importing the component module must leave
 * `GlobalWorkerOptions.workerSrc` pointing at a real emitted asset, not
 * empty and not a bare module specifier that only a bundler could resolve.
 */
import { describe, expect, it, vi } from "vitest";

// pdf.js touches canvas-adjacent globals at import time that jsdom does not
// implement; the worker-src contract under test never exercises them.
vi.stubGlobal("DOMMatrix", class DOMMatrixStub {});
vi.stubGlobal("Path2D", class Path2DStub {});

describe("pdf-preview worker configuration", () => {
  it("assigns a resolved same-origin worker URL at module load", async () => {
    const { GlobalWorkerOptions } = await import("pdfjs-dist");
    await import("../pdf-preview");

    expect(GlobalWorkerOptions.workerSrc).toBeTruthy();
    expect(GlobalWorkerOptions.workerSrc).not.toBe(
      "pdfjs-dist/build/pdf.worker.min.mjs",
    );
    expect(GlobalWorkerOptions.workerSrc.endsWith(".mjs")).toBe(true);
  });
});
