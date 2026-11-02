import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { sessionAnnotationImageAtoms } from "../annotation-image-atoms";

const session = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("@/lib/composer/landing-image-store", () => ({
  sessionImageBytes: (hash: string) => session.get(hash) ?? null,
  getImageBytes: () => Promise.resolve(undefined),
}));

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

function record(
  annotationId: string,
  image: { readonly fileName: string; readonly hash: string } | null,
): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId,
    source: {
      kind: "canvas",
      artifactId: "canvas-1",
      artifactTitle: "Canvas",
      boardPath: "boards/home.html",
      canvasPage: null,
    },
    capturedAt: 1,
    comment: "",
    counts: { elements: 1, regions: 0, strokes: 0 },
    elements: [],
    imageFileName: image?.fileName ?? null,
    imageHash: image?.hash ?? null,
    droppedElementCount: 0,
  };
}

beforeEach(() => {
  session.clear();
});

describe("sessionAnnotationImageAtoms", () => {
  it("shapes each cached crop as an image atom keyed by the record's hash", () => {
    session.set("hash-a", PNG_BYTES);

    const atoms = sessionAnnotationImageAtoms([
      record("a", { fileName: "crop.png", hash: "hash-a" }),
      record("no-image", null),
    ]);

    expect(atoms).toHaveLength(1);
    expect(atoms?.[0]).toMatchObject({
      fileName: "crop.png",
      mimeType: "image/png",
      size: PNG_BYTES.byteLength,
      hash: "hash-a",
      b64content: btoa(String.fromCharCode(...PNG_BYTES)),
    });
  });

  it("is null when one crop's bytes are not in the session", () => {
    session.set("hash-a", PNG_BYTES);

    expect(
      sessionAnnotationImageAtoms([
        record("a", { fileName: "a.png", hash: "hash-a" }),
        record("b", { fileName: "b.png", hash: "hash-b" }),
      ]),
    ).toBeNull();
  });
});
