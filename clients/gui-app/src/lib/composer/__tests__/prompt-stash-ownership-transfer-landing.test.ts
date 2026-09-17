/** prompt-stash ownership transfer: landing */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { pngBytesOfSize } from "./prompt-stash-image-fixtures";
import {
  awaitStashComplete,
  emptyDoc,
  expectBytesEqual,
  findImageAttrs,
  firstSetContent,
  loadHarness,
  makeEditorHandle,
  multiImageDoc,
  requireEntry,
} from "./prompt-stash-ownership-transfer-test-helpers";

const originalCreateImageBitmap = globalThis.createImageBitmap;

function installBitmapMocks(): void {
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: vi.fn(() =>
      Promise.resolve({
        width: 16,
        height: 16,
        close: () => undefined,
      }),
    ),
  });
  URL.createObjectURL = vi.fn(
    (_obj: Blob | MediaSource) => `blob:mock/${Math.random()}`,
  );
  URL.revokeObjectURL = vi.fn((_url: string) => undefined);
}

function annotationRecord(imageHash: string): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: "ann-landing-refusal",
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

function restoreBitmapMocks(): void {
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
  Reflect.deleteProperty(globalThis, "runnerHost");
  vi.restoreAllMocks();
}

describe("prompt-stash ownership transfer: landing", () => {
  beforeEach(() => {
    installBitmapMocks();
  });

  afterEach(() => {
    restoreBitmapMocks();
  });

  it("landing A→A: stash and restore through real landing adapters + usePromptStash", async () => {
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const draftId = "landing-a";
    h.landingDraft.useLandingDraftStore
      .getState()
      .createDraftWithId(draftId, null);
    const runtime = h.draftRuntime.draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");
    const png = pngBytesOfSize(48);
    const selection = { from: 1, to: 4 };
    const content = multiImageDoc([
      {
        id: "src-a",
        fileName: "a.png",
        hash: null,
        b64content: bytesToBase64(png),
        mimeType: "image/png",
        size: png.byteLength,
      },
    ]);
    runtime.setSnapshot(content, selection);

    const editor = makeEditorHandle({ content });
    const identity = h.landing.landingStashIdentity(draftId, null);

    const { result: sourceHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editor.editorRef,
        readHashImage: () => Promise.resolve(null),
        source: h.landing.useLandingPromptStashSource({
          stashIdentity: identity,
          runtimeStore: runtime.store,
          draftId,
          unboundRuntime: runtime.store,
          editorRef: editor.editorRef,
        }),
        destination: h.landing.useLandingPromptStashDestination({
          stashIdentity: identity,
          draftId,
          runtimeStore: runtime.store,
          editorRef: editor.editorRef,
        }),
        hostId: null,
      }),
    );

    const priorEpoch = sourceHook.current.pulseEpoch;
    act(() => {
      sourceHook.current.stashCurrent();
    });
    await awaitStashComplete(h.testing, sourceHook, priorEpoch);

    // Reload after stash - repository durable re-read.
    const reloaded = await h.repo.loadPromptStashSnapshot();
    expect(reloaded.rows).toHaveLength(1);
    const entry = requireEntry(reloaded.rows, "landing A→A");
    expect(entry.blobHashes).toHaveLength(1);

    // Clear landing draft so restore is into an empty destination. Restore
    // intentionally places the caret at the end.
    runtime.setSnapshot(emptyDoc(), null);
    editor.setContents.length = 0;

    let ok = false;
    await act(async () => {
      ok = await sourceHook.current.restore(entry);
    });
    expect(ok).toBe(true);
    const restored = firstSetContent(editor.setContents).content;
    expect(firstSetContent(editor.setContents).method).toBe("setContent");
    const attrs = findImageAttrs(restored);
    expect(attrs).toHaveLength(1);
    expect(attrs[0]?.id).not.toBe("src-a");
    expect(attrs[0]?.hash).toBe(entry.blobHashes[0]);
    expect(attrs[0]?.mimeType).toBe("image/png");
    expect(attrs[0]?.size).toBe(png.byteLength);
    expect(attrs[0]?.b64content).toBeNull();
    // Landing-owned bytes, not stash-only.
    expectBytesEqual(
      await h.landingImages.getImageBytes(String(attrs[0]?.hash)),
      png,
    );
    expect(firstSetContent(editor.setContents).selection).toBeNull();
    // Accepted consume.
    expect((await h.repo.loadPromptStashSnapshot()).rows).toHaveLength(0);

    cleanup();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
    h.landingBudget.resetLandingImageBudgetReservationsForTesting();
  });

  it("landing refuses an annotated entry without writing its images into the partition", async () => {
    // The landing composer cannot hold an annotation sidecar, and refusing
    // is already right. What this pins down is the COST of the refusal: it
    // used to be delivered by `importAndInsert`, which the restore hook
    // reaches only AFTER `materialize` - and landing's materializer resolves
    // every blob the entry owns and writes it into this window's partition.
    // So an entry that was never inserted still left its megabytes behind,
    // holding budget until the next reconcile sweep. The refusal is now
    // answered from the entry alone, before any of that.
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const draftId = "landing-annotated";
    h.landingDraft.useLandingDraftStore
      .getState()
      .createDraftWithId(draftId, null);
    const runtime = h.draftRuntime.draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");

    // An entry as a CHAT composer would have stashed it: content images plus
    // an annotation record whose crop is a sidecar the entry owns. Built
    // through the production snapshot builder so the record is re-pointed at
    // the canonical blob exactly as a real capture leaves it.
    const png = pngBytesOfSize(48);
    const crop = pngBytesOfSize(96);
    const cropSourceHash = "crop-source-hash";
    const snapshot = await h.content.buildPromptStashSnapshot({
      id: "annotated-entry",
      createdAt: 1,
      content: multiImageDoc([
        {
          id: "src-a",
          fileName: "a.png",
          hash: null,
          b64content: bytesToBase64(png),
          mimeType: "image/png",
          size: png.byteLength,
        },
      ]),
      annotations: [annotationRecord(cropSourceHash)],
      readHashImage: (hash) =>
        Promise.resolve(hash === cropSourceHash ? crop : null),
    });
    expect(snapshot.entry.annotations).toHaveLength(1);
    expect(snapshot.entry.blobHashes.length).toBeGreaterThan(1);
    await h.repo.savePromptStashSnapshot(snapshot);
    const entry = requireEntry(
      (await h.repo.loadPromptStashSnapshot()).rows,
      "annotated-entry",
    );

    runtime.setSnapshot(emptyDoc(), null);
    // Nothing of this window's own yet, so every key below is something the
    // refused restore put there.
    expect(await h.landingImages.imageHashKeys()).toEqual([]);

    const editor = makeEditorHandle({ content: emptyDoc() });
    const identity = h.landing.landingStashIdentity(draftId, null);
    const { result: hook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editor.editorRef,
        readHashImage: () => Promise.resolve(null),
        source: h.landing.useLandingPromptStashSource({
          stashIdentity: identity,
          runtimeStore: runtime.store,
          draftId,
          unboundRuntime: runtime.store,
          editorRef: editor.editorRef,
        }),
        destination: h.landing.useLandingPromptStashDestination({
          stashIdentity: identity,
          draftId,
          runtimeStore: runtime.store,
          editorRef: editor.editorRef,
        }),
        hostId: null,
      }),
    );

    let ok = true;
    await act(async () => {
      ok = await hook.current.restore(entry);
    });

    expect(ok).toBe(false);
    // The half that already worked: refusing keeps the entry intact, because
    // the crops it names exist nowhere else.
    expect((await h.repo.loadPromptStashSnapshot()).rows).toHaveLength(1);
    expect(editor.setContents).toEqual([]);
    // The half this test is for.
    expect(await h.landingImages.imageHashKeys()).toEqual([]);

    cleanup();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
    h.landingBudget.resetLandingImageBudgetReservationsForTesting();
  });

  it("landing A→different window partition (modeled via runnerHost.windowId)", async () => {
    // LIMITATION: not a true multi-Electron-renderer test. Models the
    // production partition boundary by flipping globalThis.runnerHost.windows
    // .windowId between stash/source (window-a) and restore/destination
    // (window-b). Real multi-window would also involve separate JS heaps and
    // BroadcastChannel - only the landing-image DB name partition is covered.
    //
    // Starts from landing's native HASH-ONLY representation in window-A's
    // real partitioned store, stashes with the production getImageBytes
    // resolver, then deletes window-A's source before restore so window-B
    // can only succeed from stash-owned durable bytes.
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const draftId = "landing-window-a";
    Reflect.set(globalThis, "runnerHost", {
      windows: { windowId: "window-a" },
    });
    expect(h.landingImages.landingImagePartition()).toBe("window-a");

    const png = pngBytesOfSize(40);
    // Seed window-A's real partitioned landing-image store (not inline base64).
    const hashA = await h.landingImages.putImage(png);
    expectBytesEqual(await h.landingImages.getImageBytes(hashA), png);

    h.landingDraft.useLandingDraftStore
      .getState()
      .createDraftWithId(draftId, null);
    const runtime = h.draftRuntime.draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");
    runtime.setSnapshot(
      multiImageDoc([
        {
          id: "win-src",
          fileName: "w.png",
          hash: hashA,
          b64content: null,
          mimeType: "image/png",
          size: png.byteLength,
        },
      ]),
      null,
    );
    const editorA = makeEditorHandle({
      content: runtime.store.getState().content,
    });
    const identityA = h.landing.landingStashIdentity(draftId, null);
    // Production landing resolver: resolve hash-only nodes against this
    // window's real landing-image store during capture.
    const landingReadHashImage = (
      hash: string,
    ): Promise<Uint8Array<ArrayBuffer> | null> =>
      h.landingImages
        .getImageBytes(hash)
        .then((bytes) => (bytes === undefined ? null : bytes));

    const { result: stashHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorA.editorRef,
        readHashImage: landingReadHashImage,
        source: h.landing.useLandingPromptStashSource({
          stashIdentity: identityA,
          runtimeStore: runtime.store,
          draftId,
          unboundRuntime: runtime.store,
          editorRef: editorA.editorRef,
        }),
        destination: h.landing.useLandingPromptStashDestination({
          stashIdentity: identityA,
          draftId,
          runtimeStore: runtime.store,
          editorRef: editorA.editorRef,
        }),
        hostId: null,
      }),
    );

    const priorEpoch = stashHook.current.pulseEpoch;
    act(() => {
      stashHook.current.stashCurrent();
    });
    await awaitStashComplete(h.testing, stashHook, priorEpoch);
    const entry = requireEntry(
      (await h.repo.loadPromptStashSnapshot()).rows,
      "window partition",
    );
    // Capture re-owned the landing hash into stash-owned blobHashes.
    expect(entry.blobHashes).toHaveLength(1);
    expect(entry.blobHashes[0]).toBeTruthy();

    // Make window-A's source bytes UNAVAILABLE before restore. Session is
    // process-global (not window-partitioned), so both durable delete and
    // releaseSession are required - otherwise getImageBytes still hits the
    // in-memory session cache.
    await h.landingImages.deleteImageBytesUnchecked(hashA);
    h.landingImages.releaseSession(hashA);
    expect(await h.landingImages.getImageBytes(hashA)).toBeUndefined();

    // Destination in a different window partition.
    Reflect.set(globalThis, "runnerHost", {
      windows: { windowId: "window-b" },
    });
    expect(h.landingImages.landingImagePartition()).toBe("window-b");

    const draftB = "landing-window-b";
    h.landingDraft.useLandingDraftStore
      .getState()
      .createDraftWithId(draftB, null);
    const runtimeB = h.draftRuntime.draftRuntimeRegistry.attach(draftB);
    if (runtimeB === null) throw new Error("expected runtime B");
    runtimeB.setSnapshot(emptyDoc(), null);
    const editorB = makeEditorHandle({ content: emptyDoc() });
    const identityB = h.landing.landingStashIdentity(draftB, null);

    const { result: restoreHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorB.editorRef,
        // Restore destination materialize does not need source-window hashes -
        // landing adoption reads stash blobs, then putImage into window-b.
        readHashImage: () => Promise.resolve(null),
        source: h.landing.useLandingPromptStashSource({
          stashIdentity: identityB,
          runtimeStore: runtimeB.store,
          draftId: draftB,
          unboundRuntime: runtimeB.store,
          editorRef: editorB.editorRef,
        }),
        destination: h.landing.useLandingPromptStashDestination({
          stashIdentity: identityB,
          draftId: draftB,
          runtimeStore: runtimeB.store,
          editorRef: editorB.editorRef,
        }),
        hostId: null,
      }),
    );

    let ok = false;
    await act(async () => {
      ok = await restoreHook.current.restore(entry);
    });
    // Succeeds only because stash owns durable bytes independently of
    // window-A's now-deleted landing store.
    expect(ok).toBe(true);
    const written = firstSetContent(editorB.setContents).content;
    const attrs = findImageAttrs(written);
    expect(attrs).toHaveLength(1);
    expect(attrs[0]?.id).not.toBe("win-src");
    expect(attrs[0]?.b64content).toBeNull();
    expect(attrs[0]?.hash).toBeTruthy();
    const landingHashB = String(attrs[0]?.hash);
    // Window-b partition owns the restored bytes.
    expectBytesEqual(await h.landingImages.getImageBytes(landingHashB), png);

    cleanup();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
    h.landingBudget.resetLandingImageBudgetReservationsForTesting();
  });
});
