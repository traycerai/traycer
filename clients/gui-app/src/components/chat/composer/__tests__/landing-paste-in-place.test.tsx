/**
 * Round-4 landing paste: in-place pending b64 nodes (no anchors).
 *
 * Covers the review findings that the strip+anchor design could not fix cleanly:
 * mixed-content order, non-collapsed selection placement, image-only rapid pastes,
 * and failed ingest (remove node + toast + reconcile). Fake only idb-keyval;
 * putImage / rewrite-by-id run for real.
 */
import "../../../../../__tests__/test-browser-apis";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { v4 as uuidv4 } from "uuid";

import {
  buildComposerClipboardHtml,
  composerClipboardPlainText,
} from "@/lib/composer/composer-clipboard";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  deleteImage,
  imageHashKeys,
  putImage,
  releaseSession,
} from "@/lib/composer/landing-image-store";
import { decodeValidatedPastedImage } from "@/hooks/composer/use-landing-composer-paste";
import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "../editor/extensions/chat-paste-handler";
import { buildComposerExtensions } from "../editor/editor-config";
import { createComposerPickerStore } from "../picker/composer-picker-store";
import * as idb from "idb-keyval";

const mocks = vi.hoisted(() => ({
  reportableErrorToast: vi.fn(),
  scheduleLandingImageReconcile: vi.fn(() => undefined),
}));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: mocks.reportableErrorToast,
}));

vi.mock("@/lib/composer/landing-image-gc", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/composer/landing-image-gc")>();
  return {
    ...actual,
    scheduleLandingImageReconcile: mocks.scheduleLandingImageReconcile,
    // Budget always allows paste fixtures (store tests cover real budget).
    reserveLandingImageBudget: () => true,
  };
});

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

/** Gate durable writes by content hash (not call order) so OOO completion is real. */
const setGates = vi.hoisted(
  () =>
    new Map<string, { release: () => void; reject: (error: Error) => void }>(),
);

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(idbData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      const hash = typeof key === "string" ? key : String(key);
      return new Promise<void>((resolve, reject) => {
        setGates.set(hash, {
          release: () => {
            idbData.set(hash, value);
            setGates.delete(hash);
            resolve();
          },
          reject: (error: Error) => {
            setGates.delete(hash);
            reject(error);
          },
        });
      });
    }),
    del: vi.fn((key: string) => {
      idbData.delete(typeof key === "string" ? key : String(key));
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

const editors: Editor[] = [];
let urlCounter = 0;

beforeEach(async () => {
  URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
  URL.revokeObjectURL = vi.fn();
  // Reinstall working idb (prior cases may have left rejecting overrides).
  vi.mocked(idb.set).mockImplementation((key, value) => {
    const hash = idbStringKey(key);
    return new Promise<void>((resolve, reject) => {
      setGates.set(hash, {
        release: () => {
          idbData.set(hash, value);
          setGates.delete(hash);
          resolve();
        },
        reject: (error: Error) => {
          setGates.delete(hash);
          reject(error);
        },
      });
    });
  });
  vi.mocked(idb.get).mockImplementation((key) =>
    Promise.resolve(idbData.get(idbStringKey(key))),
  );
  vi.mocked(idb.del).mockImplementation((key) => {
    idbData.delete(idbStringKey(key));
    return Promise.resolve();
  });
  vi.mocked(idb.keys).mockImplementation(() =>
    Promise.resolve(Array.from(idbData.keys())),
  );
  for (const hash of await imageHashKeys()) {
    await deleteImage(hash);
    releaseSession(hash);
  }
  idbData.clear();
  setGates.clear();
  mocks.reportableErrorToast.mockClear();
  mocks.scheduleLandingImageReconcile.mockClear();
});

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  vi.useRealTimers();
});

describe("landing paste in-place pending nodes", () => {
  // Finding 1: mixed content keeps exact document order; rewrite flips in place.
  it("structured JSON mixed paste keeps text/image order and rewrites b64→hash in place", async () => {
    const jobs: Array<Promise<void>> = [];
    const editor = makeLandingEditor(jobs);
    const bytes1 = bytesOf([1, 1, 1]);
    const bytes2 = bytesOf([2, 2, 2]);
    const hash1 = await sha256Hex(bytes1);
    const hash2 = await sha256Hex(bytes2);

    pasteComposerContent(
      editor,
      mixedContent(bytesToBase64(bytes1), bytesToBase64(bytes2)),
    );

    // Synchronous insert: A, image1, B, image2 — positions fixed, still b64.
    expect(paragraphInlineKinds(editor)).toEqual([
      "text",
      "image",
      "text",
      "image",
    ]);
    expect(editor.state.doc.textContent).toBe("AB");
    const pending = imageSnapshots(editor);
    expect(pending).toHaveLength(2);
    expect(pending[0]?.b64).not.toBeNull();
    expect(pending[1]?.b64).not.toBeNull();
    expect(pending[0]?.hash).toBeNull();
    expect(pending[1]?.hash).toBeNull();
    expect(pending[0]?.id).not.toBe(pending[1]?.id);
    const positionsBefore = pending.map((image) => image.pos);

    // Release IDB writes out of order (image2 first) — order must not change.
    await waitFor(() => {
      expect(setGates.has(hash2)).toBe(true);
      expect(setGates.has(hash1)).toBe(true);
    });
    setGates.get(hash2)?.release();
    setGates.get(hash1)?.release();
    await Promise.all(jobs);

    await waitFor(() => {
      const after = imageSnapshots(editor);
      expect(after.map((image) => image.hash)).toEqual([hash1, hash2]);
    });
    const after = imageSnapshots(editor);
    expect(after.map((image) => image.pos)).toEqual(positionsBefore);
    expect(after.every((image) => image.b64 === null)).toBe(true);
    expect(paragraphInlineKinds(editor)).toEqual([
      "text",
      "image",
      "text",
      "image",
    ]);
    expect(editor.state.doc.textContent).toBe("AB");
  });

  it("raw HTML mixed paste keeps text/image order and rewrites b64→hash in place", async () => {
    const jobs: Array<Promise<void>> = [];
    const source = makeEditorWithoutIngest();
    const bytes1 = bytesOf([11, 11]);
    const bytes2 = bytesOf([22, 22]);
    const hash1 = await sha256Hex(bytes1);
    const hash2 = await sha256Hex(bytes2);
    source.commands.setContent(
      mixedContent(bytesToBase64(bytes1), bytesToBase64(bytes2)),
    );
    const wrapper = document.createElement("div");
    wrapper.appendChild(
      DOMSerializer.fromSchema(source.schema).serializeFragment(
        source.state.doc.content,
      ),
    );

    const editor = makeLandingEditor(jobs);
    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/html"],
        getData: (type: string) =>
          type === "text/html" ? wrapper.innerHTML : "",
      },
    });

    expect(paragraphInlineKinds(editor)).toEqual([
      "text",
      "image",
      "text",
      "image",
    ]);
    expect(editor.state.doc.textContent).toBe("AB");
    const positionsBefore = imageSnapshots(editor).map((image) => image.pos);

    await waitFor(() => {
      expect(setGates.has(hash1)).toBe(true);
      expect(setGates.has(hash2)).toBe(true);
    });
    // Reverse completion order.
    setGates.get(hash2)?.release();
    setGates.get(hash1)?.release();
    await Promise.all(jobs);

    await waitFor(() => {
      expect(imageSnapshots(editor).map((image) => image.hash)).toEqual([
        hash1,
        hash2,
      ]);
    });
    expect(imageSnapshots(editor).map((image) => image.pos)).toEqual(
      positionsBefore,
    );
    expect(editor.state.doc.textContent).toBe("AB");
  });

  it("raw HTML paste preserves marks while stamping the accepted image id", async () => {
    const jobs: Array<Promise<void>> = [];
    const source = makeEditorWithoutIngest();
    const bytes = bytesOf([41, 42, 43]);
    const hash = await sha256Hex(bytes);
    source.commands.setContent(markedImageOnlyContent(bytesToBase64(bytes)));
    expect(imageMarkNames(source)).toEqual([["bold"]]);
    const wrapper = document.createElement("div");
    wrapper.appendChild(
      DOMSerializer.fromSchema(source.schema).serializeFragment(
        source.state.doc.content,
      ),
    );

    const editor = makeLandingEditor(jobs);
    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/html"],
        getData: (type: string) =>
          type === "text/html" ? wrapper.innerHTML : "",
      },
    });

    expect(imageMarkNames(editor)).toEqual([["bold"]]);
    await waitFor(() => expect(setGates.has(hash)).toBe(true));
    setGates.get(hash)?.release();
    await Promise.all(jobs);
    await waitFor(() => {
      expect(imageSnapshots(editor)[0]?.hash).toBe(hash);
    });
    expect(imageMarkNames(editor)).toEqual([["bold"]]);
  });

  // Finding 2: non-collapsed selection — image-leading paste lands at paste START.
  // Use raw HTML (open slice) so the paste merges inline into the paragraph,
  // matching a mid-paragraph native copy of an image atom + trailing text.
  it("image-leading paste over a non-collapsed selection places the image at the selection start", async () => {
    const jobs: Array<Promise<void>> = [];
    const bytes = bytesOf([9, 9, 9]);
    const hash = await sha256Hex(bytes);
    const source = makeEditorWithoutIngest();
    source.commands.setContent(imageLeadingContent(bytesToBase64(bytes)));
    // Inline-only serialization (no block wrapper) mirrors a mid-paragraph copy.
    const wrapper = document.createElement("div");
    wrapper.appendChild(
      DOMSerializer.fromSchema(source.schema).serializeFragment(
        source.state.doc.firstChild?.content ?? source.state.doc.content,
      ),
    );

    const editor = makeLandingEditor(jobs);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "abcdefgh" }],
        },
      ],
    });
    // Select "cde" (positions 3..6 in a single paragraph).
    editor.commands.setTextSelection({ from: 3, to: 6 });

    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/html"],
        getData: (type: string) =>
          type === "text/html" ? wrapper.innerHTML : "",
      },
    });

    // Selection replaced; image is first among the pasted material (before "tail").
    expect(editor.state.doc.textContent).toBe("abtailfgh");
    const sequence = paragraphInlineSequence(editor);
    expect(sequence.some((part) => part.startsWith("image:"))).toBe(true);
    // Image must sit after "ab", not after "tail" (the old selection.to bug).
    const images = imageSnapshots(editor);
    expect(images).toHaveLength(1);
    expect(images[0]?.b64).not.toBeNull();
    expect(images[0]?.pos).toBe(3);
    // "tail" must follow the image, not precede it.
    const imageIndex = sequence.findIndex((part) => part.startsWith("image:"));
    const tailIndex = sequence.findIndex((part) => part.includes("tail"));
    expect(imageIndex).toBeGreaterThanOrEqual(0);
    expect(tailIndex).toBeGreaterThan(imageIndex);

    await waitFor(() => expect(setGates.has(hash)).toBe(true));
    setGates.get(hash)?.release();
    await Promise.all(jobs);
    await waitFor(() => {
      expect(imageSnapshots(editor)[0]?.hash).toBe(hash);
    });
    expect(imageSnapshots(editor)[0]?.pos).toBe(3);
  });

  // Finding 3: two image-only rapid pastes keep paste order regardless of IDB order.
  it("two rapid image-only pastes keep document order = paste order under reverse IDB completion", async () => {
    const jobs: Array<Promise<void>> = [];
    const editor = makeLandingEditor(jobs);
    const firstBytes = bytesOf([31, 31, 31]);
    const secondBytes = bytesOf([32, 32, 32]);
    const firstHash = await sha256Hex(firstBytes);
    const secondHash = await sha256Hex(secondBytes);

    pasteComposerContent(
      editor,
      imageOnlyContent(bytesToBase64(firstBytes), "first.png"),
    );
    pasteComposerContent(
      editor,
      imageOnlyContent(bytesToBase64(secondBytes), "second.png"),
    );

    const pending = imageSnapshots(editor);
    expect(pending).toHaveLength(2);
    const idsInOrder = pending.map((image) => image.id);
    const positionsBefore = pending.map((image) => image.pos);

    await waitFor(() => {
      expect(setGates.has(firstHash)).toBe(true);
      expect(setGates.has(secondHash)).toBe(true);
    });
    // Second write resolves first (would reverse order under same-anchor design).
    setGates.get(secondHash)?.release();
    setGates.get(firstHash)?.release();
    await Promise.all(jobs);

    await waitFor(() => {
      const after = imageSnapshots(editor);
      expect(after.map((image) => image.hash)).toEqual([firstHash, secondHash]);
    });
    const after = imageSnapshots(editor);
    expect(after.map((image) => image.id)).toEqual(idsInOrder);
    expect(after.map((image) => image.pos)).toEqual(positionsBefore);
  });

  // Failed ingest: putImage rejects → remove pending node + toast + reconcile.
  it("failed putImage removes the pending node, toasts, and schedules reconcile", async () => {
    const jobs: Array<Promise<void>> = [];
    const editor = makeLandingEditor(jobs);
    const bytes = bytesOf([77, 77, 77]);
    const hash = await sha256Hex(bytes);

    pasteComposerContent(
      editor,
      imageOnlyContent(bytesToBase64(bytes), "fail.png"),
    );
    expect(imageSnapshots(editor)).toHaveLength(1);
    expect(editor.state.doc.textContent).toBe("");

    await waitFor(() => expect(setGates.has(hash)).toBe(true));
    setGates.get(hash)?.reject(new Error("idb write failed"));
    await Promise.allSettled(jobs);

    await waitFor(() => {
      expect(imageSnapshots(editor)).toHaveLength(0);
    });
    expect(mocks.reportableErrorToast).toHaveBeenCalledWith(
      "Couldn't attach the image.",
      { description: "Please try adding it again." },
      {
        title: "Could not attach image",
        message: null,
        code: null,
        source: "Chat composer",
      },
    );
    expect(mocks.scheduleLandingImageReconcile).toHaveBeenCalled();
  });
});

/**
 * Landing-shaped ingest: validate, mint id, start background putImage +
 * rewrite-by-id (mirrors landing-composer startPendingImageIngest).
 */
function makeLandingIngest(
  editor: Editor,
  jobs: Array<Promise<void>>,
): (
  images: ReadonlyArray<PastedComposerImage>,
) => ReadonlyArray<PastedComposerImageOutcome> {
  return (images) =>
    images.map((image): PastedComposerImageOutcome => {
      const bytes = decodeValidatedPastedImage(image);
      if (bytes === null) return { kind: "rejected" };
      const id = uuidv4();
      const job = (async () => {
        try {
          const hash = await putImage(bytes);
          if (editor.isDestroyed) {
            mocks.scheduleLandingImageReconcile();
            return;
          }
          editor.commands.rewriteImageAttachmentHashById(id, hash);
        } catch {
          if (!editor.isDestroyed) {
            editor.commands.removeImageAttachmentById(id);
          }
          mocks.reportableErrorToast(
            "Couldn't attach the image.",
            { description: "Please try adding it again." },
            {
              title: "Could not attach image",
              message: null,
              code: null,
              source: "Chat composer",
            },
          );
          mocks.scheduleLandingImageReconcile();
        }
      })();
      jobs.push(job);
      return { kind: "accepted", id };
    });
}

function makeLandingEditor(jobs: Array<Promise<void>>): Editor {
  let editorRef: Editor | null = null;
  const element = document.createElement("div");
  document.body.appendChild(element);
  const pickerStore = createComposerPickerStore();
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore,
      placeholder: "test",
      onSubmit: { current: () => undefined },
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => {
        if (editorRef === null) return null;
        return makeLandingIngest(editorRef, jobs);
      },
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editorRef = editor;
  editors.push(editor);
  return editor;
}

function makeEditorWithoutIngest(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore: createComposerPickerStore(),
      placeholder: "test",
      onSubmit: { current: () => undefined },
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => null,
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return editor;
}

function pasteComposerContent(editor: Editor, content: JsonContent): void {
  const html = buildComposerClipboardHtml(
    content,
    composerClipboardPlainText(content),
  );
  fireEvent.paste(editor.view.dom, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/html"],
      getData: (type: string) => (type === "text/html" ? html : ""),
    },
  });
}

function mixedContent(b64a: string, b64b: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "A" },
          {
            type: "imageAttachment",
            attrs: {
              id: "src-1",
              fileName: "one.png",
              b64content: b64a,
              mimeType: "image/png",
              size: 3,
            },
          },
          { type: "text", text: "B" },
          {
            type: "imageAttachment",
            attrs: {
              id: "src-2",
              fileName: "two.png",
              b64content: b64b,
              mimeType: "image/png",
              size: 3,
            },
          },
        ],
      },
    ],
  };
}

function imageLeadingContent(b64: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "leading",
              fileName: "leading.png",
              b64content: b64,
              mimeType: "image/png",
              size: 3,
            },
          },
          { type: "text", text: "tail" },
        ],
      },
    ],
  };
}

function imageOnlyContent(b64: string, fileName: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: `src-${fileName}`,
              fileName,
              b64content: b64,
              mimeType: "image/png",
              size: 3,
            },
          },
        ],
      },
    ],
  };
}

function markedImageOnlyContent(b64: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "src-marked.png",
              fileName: "marked.png",
              b64content: b64,
              mimeType: "image/png",
              size: 3,
            },
            marks: [{ type: "bold" }],
          },
        ],
      },
    ],
  };
}

function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

interface ImageSnapshot {
  readonly id: string;
  readonly pos: number;
  readonly b64: string | null;
  readonly hash: string | null;
}

function imageSnapshots(editor: Editor): ImageSnapshot[] {
  const images: ImageSnapshot[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "imageAttachment") return true;
    const id = typeof node.attrs.id === "string" ? node.attrs.id : "";
    const b64 =
      typeof node.attrs.b64content === "string" ? node.attrs.b64content : null;
    const hash = typeof node.attrs.hash === "string" ? node.attrs.hash : null;
    images.push({ id, pos, b64, hash });
    return false;
  });
  return images;
}

function imageMarkNames(editor: Editor): string[][] {
  const marks: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "imageAttachment") return true;
    marks.push(node.marks.map((mark) => mark.type.name));
    return false;
  });
  return marks;
}

function paragraphInlineKinds(editor: Editor): string[] {
  const first = editor.state.doc.firstChild;
  if (first === null) return [];
  const kinds: string[] = [];
  first.forEach((node) => {
    if (node.type.name === "imageAttachment") {
      kinds.push("image");
      return;
    }
    if (node.isText) {
      kinds.push("text");
      return;
    }
    kinds.push(node.type.name);
  });
  return kinds;
}

function paragraphInlineSequence(editor: Editor): string[] {
  const first = editor.state.doc.firstChild;
  if (first === null) return [];
  const sequence: string[] = [];
  first.forEach((node) => {
    if (node.type.name === "imageAttachment") {
      sequence.push(`image:${node.attrs.id}`);
      return;
    }
    if (node.isText) {
      sequence.push(`text:${node.text ?? ""}`);
      return;
    }
    sequence.push(node.type.name);
  });
  return sequence;
}
