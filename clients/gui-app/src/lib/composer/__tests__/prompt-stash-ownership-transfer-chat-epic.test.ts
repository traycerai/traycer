/** prompt-stash ownership transfer: chat/epic */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  pngBytesOfSize,
  twoFrameGifBytesOfSize,
} from "./prompt-stash-image-fixtures";
import {
  assertLandingAdoptedPngGifPair,
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

function restoreBitmapMocks(): void {
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
  Reflect.deleteProperty(globalThis, "runnerHost");
  vi.restoreAllMocks();
}

describe("prompt-stash ownership transfer: chat/epic", () => {
  beforeEach(() => {
    installBitmapMocks();
  });

  afterEach(() => {
    restoreBitmapMocks();
  });

  it("landing→chat other epic: stash from landing, restore into chat with different readHashImage epic", async () => {
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const draftId = "landing-to-chat";
    h.landingDraft.useLandingDraftStore
      .getState()
      .createDraftWithId(draftId, null);
    const runtime = h.draftRuntime.draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");
    const png = pngBytesOfSize(36);
    runtime.setSnapshot(
      multiImageDoc([
        {
          id: "l-src",
          fileName: "l.png",
          hash: null,
          b64content: bytesToBase64(png),
          mimeType: "image/png",
          size: png.byteLength,
        },
      ]),
      { from: 2, to: 2 },
    );
    const editorLanding = makeEditorHandle({
      content: runtime.store.getState().content,
    });
    const identity = h.landing.landingStashIdentity(draftId, null);

    const { result: stashHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorLanding.editorRef,
        readHashImage: () => Promise.resolve(null),
        source: h.landing.useLandingPromptStashSource({
          stashIdentity: identity,
          runtimeStore: runtime.store,
          draftId,
          unboundRuntime: runtime.store,
          editorRef: editorLanding.editorRef,
        }),
        destination: h.landing.useLandingPromptStashDestination({
          stashIdentity: identity,
          draftId,
          runtimeStore: runtime.store,
          editorRef: editorLanding.editorRef,
        }),
      }),
    );

    const priorEpoch = stashHook.current.pulseEpoch;
    act(() => {
      stashHook.current.stashCurrent();
    });
    await awaitStashComplete(h.testing, stashHook, priorEpoch);
    const entry = requireEntry(
      (await h.repo.loadPromptStashSnapshot()).rows,
      "landing→chat",
    );

    const taskId = "chat-other-epic-task";
    h.composerDraft.useComposerDraftStore
      .getState()
      .setSnapshot(taskId, emptyDoc(), null);
    const editorChat = makeEditorHandle({ content: emptyDoc() });
    // Chat epic B resolver: epic-A hashes would not resolve here.
    const epicBReadHashImage = vi.fn(() => Promise.resolve(null));

    const { result: restoreHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorChat.editorRef,
        readHashImage: epicBReadHashImage,
        source: h.chat.useChatPromptStashSource(taskId, null),
        destination: h.chat.useChatPromptStashDestination(
          taskId,
          editorChat.editorRef,
        ),
      }),
    );

    let ok = false;
    await act(async () => {
      ok = await restoreHook.current.restore(entry);
    });
    expect(ok).toBe(true);
    const restoredDraft =
      h.composerDraft.useComposerDraftStore.getState().drafts[taskId];
    if (restoredDraft === undefined) {
      throw new Error("expected chat content");
    }
    const restored = restoredDraft.content;
    const attrs = findImageAttrs(restored);
    expect(attrs[0]?.hash).toBeNull();
    expect(attrs[0]?.b64content).toBe(bytesToBase64(png));
    expect(attrs[0]?.id).not.toBe("l-src");
    // Chat materialization never consulted the other-epic hash resolver for
    // stash-owned blobs (stash re-owns at capture).
    expect(epicBReadHashImage).not.toHaveBeenCalled();
    expect((await h.repo.loadPromptStashSnapshot()).rows).toHaveLength(0);

    cleanup();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
  });

  it("chat inline→landing: landing adopts hash-addressed bytes (not inline base64)", async () => {
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const taskId = "chat-inline-src";
    const png = pngBytesOfSize(44);
    const gif = twoFrameGifBytesOfSize(80);
    const content = multiImageDoc([
      {
        id: "src-a",
        fileName: "a.png",
        hash: null,
        b64content: bytesToBase64(png),
        mimeType: "image/png",
        size: png.byteLength,
      },
      {
        id: "src-b",
        fileName: "b.gif",
        hash: null,
        b64content: bytesToBase64(gif),
        mimeType: "image/gif",
        size: gif.byteLength,
      },
    ]);
    h.composerDraft.useComposerDraftStore
      .getState()
      .setSnapshot(taskId, content, { from: 1, to: 5 });
    const editorChat = makeEditorHandle({ content });

    const { result: stashHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorChat.editorRef,
        readHashImage: () => Promise.resolve(null),
        source: h.chat.useChatPromptStashSource(taskId, null),
        destination: h.chat.useChatPromptStashDestination(
          taskId,
          editorChat.editorRef,
        ),
      }),
    );

    const priorEpoch = stashHook.current.pulseEpoch;
    act(() => {
      stashHook.current.stashCurrent();
    });
    await awaitStashComplete(h.testing, stashHook, priorEpoch);
    const entry = requireEntry(
      (await h.repo.loadPromptStashSnapshot()).rows,
      "chat inline",
    );
    expect(entry.blobHashes).toHaveLength(2);

    const draftId = "landing-from-chat-inline";
    h.landingDraft.useLandingDraftStore
      .getState()
      .createDraftWithId(draftId, null);
    const runtime = h.draftRuntime.draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");
    runtime.setSnapshot(emptyDoc(), null);
    const editorLanding = makeEditorHandle({ content: emptyDoc() });
    const identity = h.landing.landingStashIdentity(draftId, null);

    const { result: restoreHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorLanding.editorRef,
        readHashImage: () => Promise.resolve(null),
        source: h.landing.useLandingPromptStashSource({
          stashIdentity: identity,
          runtimeStore: runtime.store,
          draftId,
          unboundRuntime: runtime.store,
          editorRef: editorLanding.editorRef,
        }),
        destination: h.landing.useLandingPromptStashDestination({
          stashIdentity: identity,
          draftId,
          runtimeStore: runtime.store,
          editorRef: editorLanding.editorRef,
        }),
      }),
    );

    let ok = false;
    await act(async () => {
      ok = await restoreHook.current.restore(entry);
    });
    expect(ok).toBe(true);
    const written = firstSetContent(editorLanding.setContents);
    // Landing adoption: hash-addressed, not inline base64; structure preserved.
    await assertLandingAdoptedPngGifPair(
      written.content,
      h.landingImages,
      png,
      gif,
    );
    expect(written.selection).toBeNull();

    cleanup();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
    h.landingBudget.resetLandingImageBudgetReservationsForTesting();
  });

  it("chat current-epic hash→landing: stash re-owns epic hash, landing adopts", async () => {
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const taskId = "chat-epic-hash";
    const bytes = pngBytesOfSize(32);
    const epicHash = "epic-current-hash-not-stash";
    const content = multiImageDoc([
      {
        id: "epic-img",
        fileName: "from-epic.png",
        hash: epicHash,
        b64content: null,
        mimeType: "image/png",
        size: bytes.byteLength,
      },
    ]);
    h.composerDraft.useComposerDraftStore
      .getState()
      .setSnapshot(taskId, content, null);
    const editorChat = makeEditorHandle({ content });

    const { result: stashHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorChat.editorRef,
        readHashImage: (hash) =>
          Promise.resolve(hash === epicHash ? bytes : null),
        source: h.chat.useChatPromptStashSource(taskId, null),
        destination: h.chat.useChatPromptStashDestination(
          taskId,
          editorChat.editorRef,
        ),
      }),
    );

    const priorEpoch = stashHook.current.pulseEpoch;
    act(() => {
      stashHook.current.stashCurrent();
    });
    await awaitStashComplete(h.testing, stashHook, priorEpoch);
    const entry = requireEntry(
      (await h.repo.loadPromptStashSnapshot()).rows,
      "chat epic hash",
    );
    expect(entry.blobHashes).toHaveLength(1);
    expect(entry.blobHashes[0]).not.toBe(epicHash);

    const draftId = "landing-from-epic-hash";
    h.landingDraft.useLandingDraftStore
      .getState()
      .createDraftWithId(draftId, null);
    const runtime = h.draftRuntime.draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");
    runtime.setSnapshot(emptyDoc(), null);
    const editorLanding = makeEditorHandle({ content: emptyDoc() });
    const identity = h.landing.landingStashIdentity(draftId, null);

    const { result: restoreHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorLanding.editorRef,
        readHashImage: () => Promise.resolve(null),
        source: h.landing.useLandingPromptStashSource({
          stashIdentity: identity,
          runtimeStore: runtime.store,
          draftId,
          unboundRuntime: runtime.store,
          editorRef: editorLanding.editorRef,
        }),
        destination: h.landing.useLandingPromptStashDestination({
          stashIdentity: identity,
          draftId,
          runtimeStore: runtime.store,
          editorRef: editorLanding.editorRef,
        }),
      }),
    );

    let ok = false;
    await act(async () => {
      ok = await restoreHook.current.restore(entry);
    });
    expect(ok).toBe(true);
    const attrs = findImageAttrs(
      firstSetContent(editorLanding.setContents).content,
    );
    expect(attrs[0]?.hash).not.toBe(epicHash);
    expect(attrs[0]?.b64content).toBeNull();
    expect(attrs[0]?.id).not.toBe("epic-img");
    expectBytesEqual(
      await h.landingImages.getImageBytes(String(attrs[0]?.hash)),
      bytes,
    );

    cleanup();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
    h.landingBudget.resetLandingImageBudgetReservationsForTesting();
  });

  it("epic A hash→chat epic B: restored content never references epic A hash", async () => {
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const taskA = "chat-epic-a";
    const bytes = pngBytesOfSize(28);
    const epicAHash = "epic-a-hash-not-a-stash-hash";
    const content = multiImageDoc([
      {
        id: "epic-img",
        fileName: "from-epic.png",
        hash: epicAHash,
        b64content: null,
        mimeType: "image/png",
        size: bytes.byteLength,
      },
    ]);
    h.composerDraft.useComposerDraftStore
      .getState()
      .setSnapshot(taskA, content, null);
    const editorA = makeEditorHandle({ content });

    const { result: stashHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorA.editorRef,
        readHashImage: (hash) =>
          Promise.resolve(hash === epicAHash ? bytes : null),
        source: h.chat.useChatPromptStashSource(taskA, null),
        destination: h.chat.useChatPromptStashDestination(
          taskA,
          editorA.editorRef,
        ),
      }),
    );

    const priorEpoch = stashHook.current.pulseEpoch;
    act(() => {
      stashHook.current.stashCurrent();
    });
    await awaitStashComplete(h.testing, stashHook, priorEpoch);
    const entry = requireEntry(
      (await h.repo.loadPromptStashSnapshot()).rows,
      "epic A→B",
    );
    expect(entry.blobHashes[0]).not.toBe(epicAHash);

    const taskB = "chat-epic-b";
    h.composerDraft.useComposerDraftStore
      .getState()
      .setSnapshot(taskB, emptyDoc(), null);
    const editorB = makeEditorHandle({ content: emptyDoc() });
    const epicBResolver = vi.fn((_hash: string) => Promise.resolve(null));

    const { result: restoreHook } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editorB.editorRef,
        readHashImage: epicBResolver,
        source: h.chat.useChatPromptStashSource(taskB, null),
        destination: h.chat.useChatPromptStashDestination(
          taskB,
          editorB.editorRef,
        ),
      }),
    );

    let ok = false;
    await act(async () => {
      ok = await restoreHook.current.restore(entry);
    });
    expect(ok).toBe(true);
    const restoredDraft =
      h.composerDraft.useComposerDraftStore.getState().drafts[taskB];
    if (restoredDraft === undefined) {
      throw new Error("expected restored");
    }
    const restored = restoredDraft.content;
    const attrs = findImageAttrs(restored);
    expect(attrs[0]?.hash).toBeNull();
    expect(attrs[0]?.b64content).toBe(bytesToBase64(bytes));
    expect(attrs[0]?.id).not.toBe("epic-img");
    // Epic A hash never appears on the restored node.
    expect(JSON.stringify(restored)).not.toContain(epicAHash);
    expect(epicBResolver).not.toHaveBeenCalled();

    cleanup();
  });
});
