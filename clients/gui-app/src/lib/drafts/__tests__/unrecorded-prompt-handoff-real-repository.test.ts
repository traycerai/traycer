/**
 * R5F1: `buildUnrecordedPromptHandoff` through the REAL prompt-stash
 * repository (fake-indexeddb), not a mocked `save`. A mocked repository
 * cannot see the defect this round fixed: the old handoff passed
 * `imagesByHash: new Map()` alongside real `blobHashes`, and
 * `savePromptStashSnapshot` throws for any hash it cannot find in either its
 * own blob table or `snapshot.imagesByHash` - so the fire-and-forget `.catch`
 * swallowed the rejection and NOTHING was ever written, the text included.
 * Only a save that actually runs against IndexedDB observes that throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";

import {
  buildUnrecordedPromptHandoff,
  HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS,
} from "@/lib/drafts/unrecorded-prompt-handoff";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  materializePromptStashEntry,
  type PromptStashImageResolver,
} from "@/lib/composer/prompt-stash-content";
import {
  loadPromptStashSnapshot,
  savePromptStashSnapshot,
} from "@/lib/composer/prompt-stash-repository";
import {
  promptStashRowId,
  type PromptStashRow,
} from "@/lib/composer/prompt-stash-codec";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { pngBytesOfSize } from "@/lib/composer/__tests__/prompt-stash-image-fixtures";

const originalCreateImageBitmap = globalThis.createImageBitmap;

beforeEach(() => {
  installFreshIndexedDb();
  // Static images under the threshold are kept verbatim by the preparation
  // pipeline, but it still decodes once to validate dimensions - give the
  // codec stub real ones so preparation does not fail on that check alone
  // (mirrors `prompt-stash-content.test.ts`'s own stub).
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: vi.fn(() =>
      Promise.resolve({ width: 16, height: 16, close: () => undefined }),
    ),
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
  vi.useRealTimers();
});

function hashOnlyDoc(hash: string, text: string): JsonContent {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-1",
              fileName: "shot.png",
              hash,
              b64content: null,
              mimeType: "image/png",
              size: 32,
            },
          },
        ],
      },
    ],
  };
}

function annotationRecord(imageHash: string): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: "ann-handoff",
    tabId: "tab-1",
    sessionId: "session-1",
    origin: "https://example.test",
    pageUrl: "https://example.test/checkout",
    pageTitle: "Checkout",
    capturedAt: 1_700_000_000_000,
    comment: "the button is misaligned",
    counts: { elements: 1, regions: 0, strokes: 2 },
    elements: [],
    imageFileName: "crop.png",
    imageHash,
    droppedElementCount: 0,
  };
}

async function findRow(id: string): Promise<PromptStashRow> {
  const manifest = await loadPromptStashSnapshot();
  const row = manifest.rows.find(
    (candidate) => promptStashRowId(candidate) === id,
  );
  if (row === undefined) throw new Error(`expected a stashed row for ${id}`);
  return row;
}

function contentText(content: JsonContent): string {
  return JSON.stringify(content);
}

function findImageAttrs(
  node: JsonContent,
): Record<string, unknown> | undefined {
  if (node.type === "imageAttachment") return node.attrs;
  for (const child of node.content ?? []) {
    const found = findImageAttrs(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe("unrecorded prompt handoff - real repository round trip (R5F1)", () => {
  it("a hash-only prompt whose bytes ARE resolvable locally survives save -> restore, text and image both", async () => {
    const hash = "source-hash-resolvable";
    const bytes = pngBytesOfSize(32);
    const text = "keep this text safe";
    const readHashImage: PromptStashImageResolver = (candidate) =>
      Promise.resolve(candidate === hash ? bytes : null);

    const snapshot = await buildUnrecordedPromptHandoff({
      id: "entry-resolvable",
      createdAt: 1_000,
      content: hashOnlyDoc(hash, text),
      browserAnnotations: [],
      reason: "The chat closed before the host confirmed this message.",
      readHashImage,
    });

    await savePromptStashSnapshot(snapshot);

    const row = await findRow("entry-resolvable");
    expect(row.kind).toBe("entry");
    if (row.kind !== "entry") throw new Error("expected an entry row");

    const restored = await materializePromptStashEntry(row.entry);
    const restoredText = contentText(restored);
    expect(restoredText).toContain(text);
    expect(restoredText).toContain("Unsent");
    // The image survived too: the canonical hash is present, and restoring
    // pulled the SAME bytes back out of the blob store.
    expect(row.entry.blobHashes.length).toBe(1);
    const [canonicalHash] = row.entry.blobHashes;
    const imageNode = findImageAttrs(restored);
    expect(imageNode?.hash).toBeNull();
    expect(imageNode?.b64content).toBe(bytesToBase64(bytes));
    expect(restoredText).not.toContain("not saved with it");
    expect(canonicalHash).not.toBe(hash); // re-hashed by the capture pipeline
  });

  it("carries the annotation sidecar into the entry, crop bytes and all (DRIVE RED)", async () => {
    // A disposal's handoff is the LAST copy of the prompt. The sidecar does
    // not travel inside the document - the records name crops stored under
    // their own hashes - so a handoff built from `content` alone destroys the
    // records AND orphans their bytes for the next sweep, on the one path
    // whose entire purpose is that nothing is lost when the session goes.
    // The builder used to pass `annotations: []` outright, reasoning that
    // submit detaches the sidecar; the send's own restore state keeps it,
    // which is why `collectPendingAnnotationImageHashes` roots those crops.
    const cropHash = "annotation-crop-source-hash";
    const cropBytes = pngBytesOfSize(48);
    const text = "the annotated prompt";
    const readHashImage: PromptStashImageResolver = (candidate) =>
      Promise.resolve(candidate === cropHash ? cropBytes : null);

    const snapshot = await buildUnrecordedPromptHandoff({
      id: "entry-annotated",
      createdAt: 1_000,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      browserAnnotations: [annotationRecord(cropHash)],
      reason: "The chat closed before the host confirmed this message.",
      readHashImage,
    });

    await savePromptStashSnapshot(snapshot);

    const row = await findRow("entry-annotated");
    expect(row.kind).toBe("entry");
    if (row.kind !== "entry") throw new Error("expected an entry row");

    expect(row.entry.annotations.length).toBe(1);
    const [record] = row.entry.annotations;
    expect(record.comment).toBe("the button is misaligned");
    // The crop came with it: the record names a blob this entry owns, under
    // the canonical hash the capture pipeline re-encoded it to.
    expect(record.imageHash).not.toBe(cropHash);
    expect(row.entry.blobHashes).toContain(record.imageHash);
  });

  it("says so when a crop cannot be read, rather than stashing a partial capture as a complete one (DRIVE RED)", async () => {
    // `buildPromptStashSnapshot` leaves out a record whose crop it cannot
    // resolve and hands back the COUNT, and its contract is that the caller
    // keeps the source instead of destroying what the entry could not carry.
    // The composer path honours that: it declines to clear and warns. Teardown
    // has no source to keep - the session is going - so the entry itself has
    // to say it. Otherwise the comment, the page it was taken on and which
    // elements were marked are gone, and what is left LOOKS like a complete
    // stash of the prompt.
    const cropHash = "annotation-crop-unreadable";
    const text = "the annotated prompt";
    const readHashImage: PromptStashImageResolver = () => Promise.resolve(null);

    const snapshot = await buildUnrecordedPromptHandoff({
      id: "entry-annotation-dropped",
      createdAt: 1_000,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      browserAnnotations: [annotationRecord(cropHash)],
      reason: "The chat closed before the host confirmed this message.",
      readHashImage,
    });

    // The record could not be carried, and the snapshot reports that.
    expect(snapshot.droppedAnnotations).toBe(1);
    expect(snapshot.entry.annotations).toEqual([]);
    // The words survive, and the entry states the loss rather than hiding it.
    const rendered = contentText(snapshot.entry.content);
    expect(rendered).toContain(text);
    expect(rendered).toContain("A browser annotation was not saved with it");
  });

  it("a hash-only prompt whose bytes are NOT resolvable survives save -> restore as text-only, with a qualification saying the image was dropped", async () => {
    const hash = "source-hash-unresolvable";
    const text = "the words must survive";
    const readHashImage: PromptStashImageResolver = () => Promise.resolve(null);

    const snapshot = await buildUnrecordedPromptHandoff({
      id: "entry-unresolvable",
      createdAt: 1_000,
      content: hashOnlyDoc(hash, text),
      browserAnnotations: [],
      reason: "The chat closed before the host confirmed this message.",
      readHashImage,
    });

    await savePromptStashSnapshot(snapshot);

    const row = await findRow("entry-unresolvable");
    expect(row.kind).toBe("entry");
    if (row.kind !== "entry") throw new Error("expected an entry row");
    // The image node was dropped entirely - nothing left to restore.
    expect(row.entry.blobHashes).toEqual([]);

    const restored = await materializePromptStashEntry(row.entry);
    const restoredText = contentText(restored);
    expect(restoredText).toContain(text);
    expect(restoredText).toContain("not saved with it");
    expect(restoredText).toContain("the bytes are no longer on this device");
  });

  it("a hanging image resolver is bounded by HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS and still stashes the text", async () => {
    vi.useFakeTimers();
    const text = "text must outlive a stalled image read";
    const readHashImage: PromptStashImageResolver = () =>
      new Promise<Uint8Array<ArrayBuffer> | null>(() => {
        // never settles
      });

    const pending = buildUnrecordedPromptHandoff({
      id: "entry-timeout",
      createdAt: 1_000,
      content: hashOnlyDoc("source-hash-stalled", text),
      browserAnnotations: [],
      reason: "The chat closed before the host confirmed this message.",
      readHashImage,
    });

    await vi.advanceTimersByTimeAsync(HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 50);
    const snapshot = await pending;
    vi.useRealTimers();

    await savePromptStashSnapshot(snapshot);
    const row = await findRow("entry-timeout");
    expect(row.kind).toBe("entry");
    if (row.kind !== "entry") throw new Error("expected an entry row");
    expect(row.entry.blobHashes).toEqual([]);
    const restored = await materializePromptStashEntry(row.entry);
    const restoredText = contentText(restored);
    expect(restoredText).toContain(text);
    expect(restoredText).toContain("not saved with it");
  });
});
