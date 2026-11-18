import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import {
  buildDocxFixture,
  buildStoredZip,
  type ZipEntrySpec,
} from "../docx-document";

const encoder = new TextEncoder();

describe("docx test fixture ZIP builders", () => {
  it("builds a deterministic stored Word package with text and image entries", () => {
    const image = Uint8Array.from([137, 80, 78, 71, 13, 10]);
    const spec = {
      pages: [{ paragraphs: [["Hel", "lo report"]] }],
      inlineImagePng: image,
    } as const;

    const first = buildDocxFixture(spec);
    const second = buildDocxFixture(spec);
    const files = unzipSync(first);

    expect(first).toEqual(second);
    expect(files["[Content_Types].xml"]).toBeDefined();
    expect(files["word/document.xml"]).toBeDefined();
    expect(new TextDecoder().decode(files["word/document.xml"])).toContain(
      "Hel",
    );
    expect(new TextDecoder().decode(files["word/document.xml"])).toContain(
      "lo report",
    );
    expect(files["word/media/image1.png"]).toEqual(image);
  });

  it("builds and unpacks a valid non-Word ZIP for renderer rejection cases", () => {
    const entries: readonly ZipEntrySpec[] = [
      { name: "notes.txt", bytes: encoder.encode("not a Word package") },
      { name: "word/media/image1.png", bytes: Uint8Array.from([1, 2, 3]) },
    ];

    const first = buildStoredZip(entries);
    const second = buildStoredZip(entries);
    const files = unzipSync(first);

    expect(first).toEqual(second);
    expect(new TextDecoder().decode(files["notes.txt"])).toBe(
      "not a Word package",
    );
    expect(files["word/media/image1.png"]).toEqual(Uint8Array.from([1, 2, 3]));
    expect(files["word/document.xml"]).toBeUndefined();
  });
});
