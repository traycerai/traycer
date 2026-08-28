/** prompt-stash ownership transfer: modal/reload/residual */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  pngBytesOfSize,
  twoFrameGifBytesOfSize,
} from "./prompt-stash-image-fixtures";
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
  textDoc,
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

describe("prompt-stash ownership transfer: modal/reload/residual", () => {
  beforeEach(() => {
    installBitmapMocks();
  });

  afterEach(() => {
    restoreBitmapMocks();
  });

  for (const caseSpec of [
    {
      name: "modal inline→landing",
      source: "modal" as const,
      dest: "landing" as const,
      image: "inline" as const,
    },
    {
      name: "modal current-epic hash→landing",
      source: "modal" as const,
      dest: "landing" as const,
      image: "hash" as const,
    },
    {
      name: "modal inline→chat",
      source: "modal" as const,
      dest: "chat" as const,
      image: "inline" as const,
    },
    {
      name: "modal current-epic hash→chat",
      source: "modal" as const,
      dest: "chat" as const,
      image: "hash" as const,
    },
  ]) {
    it(caseSpec.name, async () => {
      const h = await loadHarness();
      const { act, cleanup, renderHook } = h.testing;
      const epicId = "epic-modal-src";
      const seed = h.modalStore.createEmptyNewConversationContent();
      const bytes = pngBytesOfSize(30);
      const epicHash = "modal-epic-hash";
      const imageAttrs =
        caseSpec.image === "inline"
          ? {
              id: "modal-img",
              fileName: "m.png",
              hash: null as string | null,
              b64content: bytesToBase64(bytes),
              mimeType: "image/png",
              size: bytes.byteLength,
            }
          : {
              id: "modal-img",
              fileName: "m.png",
              hash: epicHash,
              b64content: null as string | null,
              mimeType: "image/png",
              size: bytes.byteLength,
            };
      const content = multiImageDoc([imageAttrs]);
      h.modalStore.useNewConversationModalStore
        .getState()
        .setContent(epicId, content);
      h.modalStore.useNewConversationModalStore
        .getState()
        .setSelection(epicId, { from: 1, to: 2 });
      const editorModal = makeEditorHandle({ content });

      const { result: stashHook } = renderHook(() =>
        h.usePromptStash({
          active: true,
          disabled: false,
          editorRef: editorModal.editorRef,
          readHashImage: (hash) =>
            Promise.resolve(hash === epicHash ? bytes : null),
          source: h.modal.useNewConversationPromptStashSource({
            epicId,
            seedContent: seed,
            editorRef: editorModal.editorRef,
          }),
          destination: h.modal.useNewConversationPromptStashDestination({
            epicId,
            seedContent: seed,
            editorRef: editorModal.editorRef,
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
        caseSpec.name,
      );
      expect(entry.blobHashes).toHaveLength(1);
      if (caseSpec.image === "hash") {
        expect(entry.blobHashes[0]).not.toBe(epicHash);
      }

      if (caseSpec.dest === "landing") {
        const draftId = `landing-from-modal-${caseSpec.image}`;
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
        expect(attrs[0]?.b64content).toBeNull();
        expect(attrs[0]?.hash).toBeTruthy();
        expect(attrs[0]?.id).not.toBe("modal-img");
        expectBytesEqual(
          await h.landingImages.getImageBytes(String(attrs[0]?.hash)),
          bytes,
        );
        h.landingBudget.resetLandingImageBudgetReservationsForTesting();
        h.draftRuntime.draftRuntimeRegistry.resetForTesting();
      } else {
        const taskId = `chat-from-modal-${caseSpec.image}`;
        h.composerDraft.useComposerDraftStore
          .getState()
          .setSnapshot(taskId, emptyDoc(), null);
        const editorChat = makeEditorHandle({ content: emptyDoc() });
        const { result: restoreHook } = renderHook(() =>
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
        let ok = false;
        await act(async () => {
          ok = await restoreHook.current.restore(entry);
        });
        expect(ok).toBe(true);
        const restoredDraft =
          h.composerDraft.useComposerDraftStore.getState().drafts[taskId];
        if (restoredDraft === undefined) {
          throw new Error("expected chat restore");
        }
        const restored = restoredDraft.content;
        const attrs = findImageAttrs(restored);
        expect(attrs[0]?.hash).toBeNull();
        expect(attrs[0]?.b64content).toBe(bytesToBase64(bytes));
        expect(attrs[0]?.id).not.toBe("modal-img");
        if (caseSpec.image === "hash") {
          expect(JSON.stringify(restored)).not.toContain(epicHash);
        }
      }

      cleanup();
      h.modalStore.useNewConversationModalStore.getState().resetForTests();
    });
  }

  it("reload after landing adoption: landing store owns bytes; stash entry consumed", async () => {
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const taskId = "chat-for-adoption-reload";
    const png = pngBytesOfSize(24);
    h.composerDraft.useComposerDraftStore.getState().setSnapshot(
      taskId,
      multiImageDoc([
        {
          id: "src",
          fileName: "a.png",
          hash: null,
          b64content: bytesToBase64(png),
          mimeType: "image/png",
          size: png.byteLength,
        },
      ]),
      null,
    );
    const editorChat = makeEditorHandle({
      content:
        h.composerDraft.useComposerDraftStore.getState().drafts[taskId]
          ?.content ?? emptyDoc(),
    });
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
      "adoption reload",
    );

    const draftId = "landing-adoption-reload";
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
    await act(async () => {
      await restoreHook.current.restore(entry);
    });
    const landingHash = String(
      findImageAttrs(firstSetContent(editorLanding.setContents).content)[0]
        ?.hash,
    );
    expectBytesEqual(await h.landingImages.getImageBytes(landingHash), png);

    // Reload repository after adoption: stash consumed; landing still owns bytes.
    const after = await h.repo.loadPromptStashSnapshot();
    expect(after.rows).toHaveLength(0);
    // Re-hydrate store and re-read landing bytes (landing store is durable).
    await h.promptStashStore.usePromptStashStore.getState().hydrate();
    expect(h.promptStashStore.usePromptStashStore.getState().rows).toHaveLength(
      0,
    );
    expectBytesEqual(await h.landingImages.getImageBytes(landingHash), png);

    cleanup();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
    h.landingBudget.resetLandingImageBudgetReservationsForTesting();
  });

  it("source owner disposed before restore still restores via real destination hook", async () => {
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const taskId = "chat-source-dispose";
    const png = pngBytesOfSize(20);
    h.composerDraft.useComposerDraftStore.getState().setSnapshot(
      taskId,
      multiImageDoc([
        {
          id: "src",
          fileName: "kept.png",
          hash: null,
          b64content: bytesToBase64(png),
          mimeType: "image/png",
          size: png.byteLength,
        },
      ]),
      null,
    );
    const editorChat = makeEditorHandle({
      content:
        h.composerDraft.useComposerDraftStore.getState().drafts[taskId]
          ?.content ?? emptyDoc(),
    });
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
      "source disposed",
    );

    // Dispose source owner (task draft cleared / closed).
    h.composerDraft.useComposerDraftStore.setState({ drafts: {} });
    expect(
      h.composerDraft.useComposerDraftStore.getState().drafts[taskId],
    ).toBeUndefined();
    // Stash remains independently durable.
    expect((await h.repo.loadPromptStashSnapshot()).rows).toHaveLength(1);

    // Restore into a different destination via real landing destination hook.
    const draftId = "landing-after-source-dispose";
    h.landingDraft.useLandingDraftStore
      .getState()
      .createDraftWithId(draftId, null);
    const runtime = h.draftRuntime.draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");
    runtime.setSnapshot(textDoc("destination only"), null);
    const editorLanding = makeEditorHandle({
      content: textDoc("destination only"),
    });
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
    const written = firstSetContent(editorLanding.setContents).content;
    expect(findImageAttrs(written)).toHaveLength(1);
    expect(findImageAttrs(written)[0]?.hash).toBeTruthy();
    expect((await h.repo.loadPromptStashSnapshot()).rows).toHaveLength(0);

    cleanup();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
    h.landingBudget.resetLandingImageBudgetReservationsForTesting();
  });

  it("accepted consume residual: modal accepted-insert-then-close", async () => {
    // Residual: modal is memory-only; close discards the restored draft after
    // the stash has already been consumed (accepted risk, not a stash bug).
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const epicId = "epic-residual-modal";
    const seed = h.modalStore.createEmptyNewConversationContent();
    const body = textDoc("modal residual body");
    h.modalStore.useNewConversationModalStore
      .getState()
      .setContent(epicId, body);
    h.modalStore.useNewConversationModalStore
      .getState()
      .setSelection(epicId, { from: 0, to: 3 });
    // Production importAndInsert writes the editor; onUpdate would re-sync the
    // modal store - mirror that so post-restore store state is real.
    const editor = makeEditorHandle({
      content: body,
      onSetContent: (content, selection) => {
        h.modalStore.useNewConversationModalStore
          .getState()
          .setContent(epicId, content);
        if (selection !== null) {
          h.modalStore.useNewConversationModalStore
            .getState()
            .setSelection(epicId, selection);
        }
      },
    });

    const { result } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editor.editorRef,
        readHashImage: () => Promise.resolve(null),
        source: h.modal.useNewConversationPromptStashSource({
          epicId,
          seedContent: seed,
          editorRef: editor.editorRef,
        }),
        destination: h.modal.useNewConversationPromptStashDestination({
          epicId,
          seedContent: seed,
          editorRef: editor.editorRef,
        }),
      }),
    );

    const priorEpoch = result.current.pulseEpoch;
    act(() => {
      result.current.stashCurrent();
    });
    await awaitStashComplete(h.testing, result, priorEpoch);
    const entry = requireEntry(
      (await h.repo.loadPromptStashSnapshot()).rows,
      "modal residual",
    );

    // Empty destination for restore; the stored selection is not re-applied.
    h.modalStore.useNewConversationModalStore
      .getState()
      .setContent(epicId, emptyDoc());
    editor.setContents.length = 0;
    let ok = false;
    await act(async () => {
      ok = await result.current.restore(entry);
    });
    expect(ok).toBe(true);
    expect(
      h.modalStore.useNewConversationModalStore.getState().draftPatchesByEpicId[
        epicId
      ]?.content,
    ).toEqual(body);
    // Immediate consume after accept.
    expect(
      (await h.repo.loadPromptStashSnapshot()).rows.find(
        (row) => (row.kind === "entry" ? row.entry.id : row.id) === entry.id,
      ),
    ).toBeUndefined();

    // Modal close: memory-only draft discarded.
    h.modalStore.useNewConversationModalStore.getState().resetForTests();
    expect(
      h.modalStore.useNewConversationModalStore.getState().draftPatchesByEpicId[
        epicId
      ],
    ).toBeUndefined();

    cleanup();
  });

  it("accepted consume residual: chat accepted-insert-then-reload-after-localStorage-quota", async () => {
    // Residual: chat draft lost on quota-pressure reload after accepted
    // consume (accepted risk, not a stash bug).
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const taskId = "residual-chat-quota";
    const body = textDoc("chat residual body");
    h.composerDraft.useComposerDraftStore
      .getState()
      .setSnapshot(taskId, body, { from: 0, to: 3 });
    const editor = makeEditorHandle({ content: body });
    const { result } = renderHook(() =>
      h.usePromptStash({
        active: true,
        disabled: false,
        editorRef: editor.editorRef,
        readHashImage: () => Promise.resolve(null),
        source: h.chat.useChatPromptStashSource(taskId, null),
        destination: h.chat.useChatPromptStashDestination(
          taskId,
          editor.editorRef,
        ),
      }),
    );

    const priorEpoch = result.current.pulseEpoch;
    act(() => {
      result.current.stashCurrent();
    });
    await awaitStashComplete(h.testing, result, priorEpoch);
    const entry = requireEntry(
      (await h.repo.loadPromptStashSnapshot()).rows,
      "chat residual",
    );

    h.composerDraft.useComposerDraftStore
      .getState()
      .setSnapshot(taskId, emptyDoc(), null);
    editor.setContents.length = 0;
    let ok = false;
    await act(async () => {
      ok = await result.current.restore(entry);
    });
    expect(ok).toBe(true);
    expect(
      h.composerDraft.useComposerDraftStore.getState().drafts[taskId]?.content,
    ).toEqual(body);
    expect(
      (await h.repo.loadPromptStashSnapshot()).rows.find(
        (row) => (row.kind === "entry" ? row.entry.id : row.id) === entry.id,
      ),
    ).toBeUndefined();

    // Quota-pressure reload: drafts wiped from local store.
    h.composerDraft.useComposerDraftStore.setState({ drafts: {} });
    expect(
      h.composerDraft.useComposerDraftStore.getState().drafts[taskId],
    ).toBeUndefined();

    cleanup();
  });

  it("accepted consume residual: landing accepted-insert-then-crash-before-projection-flush", async () => {
    // Residual: landing destination accepts restore into the live editor
    // (production importAndInsert only calls handle.setContent). Projection
    // into the draft runtime / durable store is a separate async path. Crash
    // before that projection lands loses the restored body even though the
    // stash was already consumed (accepted risk, not a stash bug).
    //
    // Note: `resetForTesting` → runtime.close() flushes pending snapshots, so
    // we deliberately do NOT wire onSetContent→setSnapshot here. That keeps
    // the restore confined to the editor (the destination's actual write),
    // matching "accepted insert, projection never ran".
    const h = await loadHarness();
    const { act, cleanup, renderHook } = h.testing;
    const draftId = "residual-landing-crash";
    const body = textDoc("landing residual body");
    h.landingDraft.useLandingDraftStore
      .getState()
      .createDraftWithId(draftId, null);
    const runtime = h.draftRuntime.draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");
    runtime.setSnapshot(body, { from: 0, to: 3 });
    // Flush the pre-stash body so durable + runtime agree, then we'll empty
    // both before restore.
    runtime.flush();
    const editor = makeEditorHandle({ content: body });
    const identity = h.landing.landingStashIdentity(draftId, null);

    const { result } = renderHook(() =>
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
      }),
    );

    const priorEpoch = result.current.pulseEpoch;
    act(() => {
      result.current.stashCurrent();
    });
    await awaitStashComplete(h.testing, result, priorEpoch);
    const entry = requireEntry(
      (await h.repo.loadPromptStashSnapshot()).rows,
      "landing residual",
    );

    // Empty destination runtime + durable (projection baseline is empty).
    runtime.setSnapshot(emptyDoc(), null);
    runtime.flush();
    editor.setContents.length = 0;
    let ok = false;
    await act(async () => {
      ok = await result.current.restore(entry);
    });
    expect(ok).toBe(true);
    // Destination accepted: editor holds the restored body.
    expect(firstSetContent(editor.setContents).content).toEqual(body);
    // Runtime was NOT projected (no onUpdate/setSnapshot) - still empty.
    expect(runtime.store.getState().content).toEqual(emptyDoc());
    expect(
      (await h.repo.loadPromptStashSnapshot()).rows.find(
        (row) => (row.kind === "entry" ? row.entry.id : row.id) === entry.id,
      ),
    ).toBeUndefined();

    // Crash: drop live editor + in-memory runtimes. Durable draft was never
    // projected with the restore, so re-hydrate is empty.
    editor.unmount();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
    const rehydrated = h.draftRuntime.draftRuntimeRegistry.attach(draftId);
    if (rehydrated === null) throw new Error("expected rehydrated runtime");
    expect(rehydrated.store.getState().content).toEqual(emptyDoc());
    expect(rehydrated.store.getState().content).not.toEqual(body);

    cleanup();
    h.draftRuntime.draftRuntimeRegistry.resetForTesting();
    h.landingBudget.resetLandingImageBudgetReservationsForTesting();
  });

  it("repository layer: rich multi-image structure, order, fresh ids, MIME/size, preview bytes", async () => {
    // Direct repository/content coverage kept as a sibling to the hook matrix.
    const h = await loadHarness();
    const png = pngBytesOfSize(48);
    const gif = twoFrameGifBytesOfSize(96);
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
    const snapshot = await h.content.buildPromptStashSnapshot({
      id: "repo-rich",
      createdAt: 1,
      content,
      readHashImage: () => Promise.resolve(null),
    });
    await h.repo.savePromptStashSnapshot(snapshot);
    const reloaded = await h.repo.loadPromptStashSnapshot();
    expect(reloaded.rows).toHaveLength(1);
    const entry = requireEntry(reloaded.rows, "repo-rich");
    expect(entry.blobHashes).toHaveLength(2);
    const restored = await h.content.materializePromptStashEntry(entry);
    const attrs = findImageAttrs(restored);
    expect(attrs).toHaveLength(2);
    expect(attrs[0]?.id).not.toBe("src-a");
    expect(attrs[1]?.id).not.toBe("src-b");
    expect(attrs[0]?.id).not.toBe(attrs[1]?.id);
    expect(attrs[0]?.hash).toBeNull();
    expect(attrs[1]?.hash).toBeNull();
    expect(attrs[0]?.b64content).toBe(bytesToBase64(png));
    expect(attrs[1]?.b64content).toBe(bytesToBase64(gif));
    expect(attrs[0]?.mimeType).toBe("image/png");
    expect(attrs[1]?.mimeType).toBe("image/gif");
    expect(attrs[0]?.size).toBe(png.byteLength);
    expect(attrs[1]?.size).toBe(gif.byteLength);
    expect(restored.content?.[0]?.content?.[0]).toEqual({
      type: "text",
      text: "prefix ",
    });
  });
});
