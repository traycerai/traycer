/**
 * `projectArtifact`'s handling of the html/canvas/file kinds: the optional
 * object-shaped fields (`head`, `sha256`/`byteLength`/`mediaType`), the
 * `layout` default, and the null-return gate for a kind whose required shape
 * fails to parse - a stray/partial write must drop the whole entry rather
 * than surface a half-built artifact the tile cannot render.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getEpicMap,
  ensureMap,
  artifactHeadsEqual,
} from "@/stores/epics/open-epic/projection-helpers";
import { projectArtifactsSliceForTests } from "./projection-helpers-test-shims";
import type { ArtifactHead } from "@traycer/protocol/persistence/epic/artifacts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function newDoc(): Y.Doc {
  return new Y.Doc();
}

function setArtifact(
  doc: Y.Doc,
  id: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  doc.transact(() => {
    const artifacts = ensureMap(getEpicMap(doc), "artifacts");
    const entry = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(fields)) {
      entry.set(key, value);
    }
    artifacts.set(id, entry);
  });
}

const BASE_FIELDS = {
  title: "Title",
  folderName: "folder",
  parentId: null,
  createdAt: 1,
  updatedAt: 2,
  createdManually: true,
};

const VALID_HEAD = {
  files: {
    "index.html": {
      sha256: SHA_A,
      byteLength: 10,
      mediaType: "text/html",
      status: "published",
    },
  },
  capturedAt: 5,
};

describe("projectArtifact - html, canvas and file kinds", () => {
  it("projects a markdown artifact with layout always defaulted to folder", () => {
    const doc = newDoc();
    setArtifact(doc, "spec-1", { kind: "spec", ...BASE_FIELDS });

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.allIds).toEqual(["spec-1"]);
    expect(slice.byId["spec-1"]).toMatchObject({
      id: "spec-1",
      kind: "spec",
      layout: "folder",
    });
    expect(slice.byId["spec-1"].head).toBeUndefined();
    expect(slice.byId["spec-1"].sha256).toBeUndefined();
    expect(slice.byId["spec-1"].relativePath).toBeUndefined();
  });

  it("projects an html artifact with a valid head and defaults layout to folder", () => {
    const doc = newDoc();
    setArtifact(doc, "html-1", { kind: "html", ...BASE_FIELDS, head: VALID_HEAD });

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.allIds).toEqual(["html-1"]);
    expect(slice.byId["html-1"]).toMatchObject({ kind: "html", layout: "folder" });
    expect(slice.byId["html-1"].head).toEqual(VALID_HEAD);
  });

  it("drops an html artifact whose head is missing entirely", () => {
    const doc = newDoc();
    setArtifact(doc, "html-1", { kind: "html", ...BASE_FIELDS });

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.allIds).toEqual([]);
    expect(Object.hasOwn(slice.byId, "html-1")).toBe(false);
  });

  it("drops an html artifact whose head fails schema validation", () => {
    const doc = newDoc();
    setArtifact(doc, "html-1", {
      kind: "html",
      ...BASE_FIELDS,
      head: { files: { "index.html": { sha256: SHA_A, mediaType: "text/html" } }, capturedAt: 5 }, // missing byteLength/status
    });

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.allIds).toEqual([]);
  });

  it("drops a canvas artifact with no head, the same as html", () => {
    const doc = newDoc();
    setArtifact(doc, "canvas-1", { kind: "canvas", ...BASE_FIELDS });

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.allIds).toEqual([]);
  });

  it("projects a canvas artifact's head alongside its artifactRoomId", () => {
    const doc = newDoc();
    setArtifact(doc, "canvas-1", {
      kind: "canvas",
      ...BASE_FIELDS,
      head: VALID_HEAD,
      artifactRoomId: "artifact-body:canvas-1",
    });

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.byId["canvas-1"]).toMatchObject({
      kind: "canvas",
      head: VALID_HEAD,
      artifactRoomId: "artifact-body:canvas-1",
    });
  });

  it("projects a file artifact's object fields and defaults layout to file even if a stray 'folder' is stored", () => {
    const doc = newDoc();
    setArtifact(doc, "file-1", {
      kind: "file",
      ...BASE_FIELDS,
      layout: "folder",
      sha256: SHA_B,
      byteLength: 42,
      mediaType: "application/pdf",
      status: "published",
    });

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.byId["file-1"]).toMatchObject({
      kind: "file",
      layout: "file",
      sha256: SHA_B,
      byteLength: 42,
      mediaType: "application/pdf",
      objectStatus: "published",
    });
    expect(slice.byId["file-1"].head).toBeUndefined();
  });

  it("drops a file artifact whose object ref fails schema validation", () => {
    const doc = newDoc();
    setArtifact(doc, "file-1", {
      kind: "file",
      ...BASE_FIELDS,
      sha256: SHA_B,
      byteLength: 42,
      // mediaType intentionally missing - artifactObjectRefSchema requires it.
      status: "published",
    });

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.allIds).toEqual([]);
  });

  it("projects a loose (file-layout) html artifact's relativePath beside its head", () => {
    const doc = newDoc();
    setArtifact(doc, "parent", { kind: "spec", ...BASE_FIELDS, folderName: "docs" });
    setArtifact(doc, "weather", {
      kind: "html",
      ...BASE_FIELDS,
      folderName: "",
      parentId: "parent",
      layout: "file",
      relativePath: "weather.html",
      head: VALID_HEAD,
    });

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.byId["weather"]).toMatchObject({
      kind: "html",
      layout: "file",
      relativePath: "weather.html",
      head: VALID_HEAD,
    });
  });

  it("lists every valid kind without skipping html, canvas or file, and drops only the malformed ones", () => {
    const doc = newDoc();
    setArtifact(doc, "spec-1", { kind: "spec", ...BASE_FIELDS });
    setArtifact(doc, "ticket-1", { kind: "ticket", ...BASE_FIELDS, assignee: "", status: 0 });
    setArtifact(doc, "html-ok", { kind: "html", ...BASE_FIELDS, head: VALID_HEAD });
    setArtifact(doc, "html-bad", { kind: "html", ...BASE_FIELDS }); // no head
    setArtifact(doc, "canvas-ok", { kind: "canvas", ...BASE_FIELDS, head: VALID_HEAD });
    setArtifact(doc, "file-ok", {
      kind: "file",
      ...BASE_FIELDS,
      sha256: SHA_A,
      byteLength: 1,
      mediaType: "image/png",
      status: "published",
    });
    setArtifact(doc, "file-bad", { kind: "file", ...BASE_FIELDS, sha256: SHA_A }); // incomplete

    const slice = projectArtifactsSliceForTests(doc);

    expect(slice.allIds.slice().sort()).toEqual(
      ["spec-1", "ticket-1", "html-ok", "canvas-ok", "file-ok"].slice().sort(),
    );
    expect(Object.hasOwn(slice.byId, "html-bad")).toBe(false);
    expect(Object.hasOwn(slice.byId, "file-bad")).toBe(false);
    expect(slice.byId["ticket-1"].status).toBe(0);
  });
});

describe("artifactHeadsEqual", () => {
  const headA: ArtifactHead = VALID_HEAD;

  it("is true for the same reference", () => {
    expect(artifactHeadsEqual(headA, headA)).toBe(true);
  });

  it("is true for both undefined", () => {
    expect(artifactHeadsEqual(undefined, undefined)).toBe(true);
  });

  it("is false when only one side is undefined", () => {
    expect(artifactHeadsEqual(headA, undefined)).toBe(false);
    expect(artifactHeadsEqual(undefined, headA)).toBe(false);
  });

  it("is true for two distinct objects with identical content", () => {
    const headB: ArtifactHead = structuredClone(headA);
    expect(artifactHeadsEqual(headA, headB)).toBe(true);
  });

  it("is false when capturedAt differs", () => {
    const headB: ArtifactHead = { ...headA, capturedAt: headA.capturedAt + 1 };
    expect(artifactHeadsEqual(headA, headB)).toBe(false);
  });

  it("is false when a file's sha256 differs", () => {
    const headB: ArtifactHead = {
      ...headA,
      files: {
        "index.html": { ...headA.files["index.html"], sha256: SHA_B },
      },
    };
    expect(artifactHeadsEqual(headA, headB)).toBe(false);
  });

  it("is false when the file sets have different sizes", () => {
    const headB: ArtifactHead = {
      ...headA,
      files: {
        ...headA.files,
        "styles.css": { sha256: SHA_B, byteLength: 1, mediaType: "text/css", status: "published" },
      },
    };
    expect(artifactHeadsEqual(headA, headB)).toBe(false);
  });
});
