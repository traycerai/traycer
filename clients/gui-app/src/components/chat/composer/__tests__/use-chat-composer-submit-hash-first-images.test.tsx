import "../../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";

const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...actual,
    sessionImageBytes: imageStoreMocks.sessionImageBytes,
    getImageBytes: imageStoreMocks.getImageBytes,
  };
});

const HASH = "hash-in-epic-image-1";
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);

function hashOnlyImageDoc(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "node-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 4,
              byHashEligible: true,
              hash: HASH,
            },
          },
          { type: "text", text: "look" },
        ],
      },
    ],
  };
}

/** A hash-only doc whose text can be changed, standing in for the user typing. */
function hashOnlyImageDocWithText(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "node-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 4,
              byHashEligible: true,
              hash: HASH,
            },
          },
          { type: "text", text },
        ],
      },
    ],
  };
}

/** Every `text` node in a document, joined - enough to identify which one it is. */
function extractParagraphText(content: JsonContent): string {
  const parts: string[] = [];
  const walk = (node: JsonContent): void => {
    if (typeof node.text === "string") parts.push(node.text);
    for (const child of node.content ?? []) walk(child);
  };
  walk(content);
  return parts.join("");
}

/**
 * An editor whose document can change AFTER the submit has read it - which is
 * the whole situation the generation guard exists for. The real editor stays
 * editable across the image read; a fixed-content stub cannot express that.
 */
function mutableEditor(initial: JsonContent): {
  readonly handle: ComposerPromptEditorHandle;
  readonly setJSON: (next: JsonContent) => void;
  readonly clearCalls: () => number;
} {
  let current = initial;
  let clears = 0;
  const handle = fakeEditor(initial);
  return {
    handle: {
      ...handle,
      getJSON: () => current,
      clear: () => {
        clears += 1;
      },
    },
    setJSON: (next) => {
      current = next;
    },
    clearCalls: () => clears,
  };
}

function fakeEditor(content: JsonContent): ComposerPromptEditorHandle {
  return {
    isReady: () => true,
    getEditorIncarnation: () => null,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

/**
 * Mounts the hook for the INLINE arm.
 *
 * `targetHostId: null` and a bridge that answers `false` keep
 * `submitHostHeldImageHashes` at its inherited set, so every hash-only node
 * these cases carry still owes bytes and the resolution path runs - which is
 * the path this file is about. It no longer takes a host client: the hook
 * itself never uploads (see the retirement note at the bottom of this file).
 */
function mountSubmit(args: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
}) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "hash-first-image-submit",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "codex",
        modelSlug: "gpt-5",
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "auto",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
  return renderHook(() =>
    useChatComposerSubmit({
      taskId: args.taskId,
      editorRef: { current: args.editor },
      pickerStore: createComposerPickerStore(),
      toolbarStore,
      activeTurnStatus: null,
      steerCapable: false,
      steerEnabled: true,
      steerProtocolSupported: true,
      getActiveTurnForSteer: () => null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
      imagesUnsupported: false,
      attachmentPreparationPending: false,
      onSubmitMessage: args.onSubmitMessage,
      onSideChat: null,
      targetHostId: null,
      queueEditTargetId: null,
      getDraftBlobBridgeSupported: () => false,
    }),
  );
}

beforeEach(() => {
  imageStoreMocks.sessionImageBytes.mockReset();
  imageStoreMocks.sessionImageBytes.mockReturnValue(null);
  imageStoreMocks.getImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
  resetDraftBlobTransportForTests();
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  resetDraftBlobTransportForTests();
});

describe("useChatComposerSubmit: hash-first image inline-at-submit", () => {
  // NOT `async`, and that is the claim rather than a lint concession: this
  // path dispatches in the same stack frame as `submitDraft`, so there is
  // nothing to await and a signature saying otherwise weakens the assertion
  // below.
  it("(a) synchronous session-cache fast path - submitted payload carries b64content", () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(IMAGE_BYTES);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: "chat-fast-path",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // The fast path never awaits: the send is dispatched synchronously in the
    // same stack frame, before any microtask can run.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(imageStoreMocks.getImageBytes).not.toHaveBeenCalled();

    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.b64content).toBe(
      btoa(String.fromCharCode(...IMAGE_BYTES)),
    );
    expect(atoms[0]?.hash).toBeNull();
  });

  it("(b) async IndexedDB fallback when the hash is session-cold - payload still carries b64content", async () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: "chat-cold-hash",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    // Not sent yet - the session cache missed and the store read is async.
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.annotationPreparationPending).toBe(true);

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith(HASH);

    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.b64content).toBe(
      btoa(String.fromCharCode(...IMAGE_BYTES)),
    );
    expect(result.current.annotationPreparationPending).toBe(false);
  });

  it("(c) non-refusal: a hash with NO local bytes anywhere is left hash-only and the send STILL goes out", async () => {
    // Neither the session cache nor this window's IndexedDB has the bytes -
    // the shape of a hash that only the host's epic attachment store can
    // resolve. Unlike the landing composer, a chat surface never refuses this
    // send; it is best-effort.
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(undefined);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: "chat-host-only-hash",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    // Left HASH-ONLY - never dropped from the document, never a b64content.
    expect(atoms[0]?.hash).toBe(HASH);
    expect(atoms[0]?.b64content).toBeNull();
    expect(result.current.annotationPreparationPending).toBe(false);
  });

  // The async arm used to be `.then(dispatch).catch(() => dispatch(original))`.
  // A `catch` CHAINED after the success arm catches rejections from the success
  // HANDLER too, so a dispatch that threw was caught by its own error arm and
  // the message went out a SECOND time - un-inlined, and after the first send
  // had already been accepted. The arm is now a two-argument `then`, whose
  // failure handler answers only the READ failing. This pins that: a dispatch
  // that throws must be attempted exactly once.
  it("does not dispatch twice when the send handler itself throws on the async path", async () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    const submit = vi.fn<(input: ChatComposerSubmitInput) => boolean>(() => {
      throw new Error("send blew up");
    });
    const { result } = mountSubmit({
      taskId: "chat-double-dispatch",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // Let every remaining microtask drain: with the old chained `.catch`, the
    // second dispatch landed here, one tick after the first one threw.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    // The in-flight latch must still clear, or the composer would refuse every
    // later send after one throwing dispatch.
    await waitFor(() => {
      expect(result.current.annotationPreparationPending).toBe(false);
    });
  });

  // The editor is NOT disabled across the image read, so the user can keep
  // typing between pressing Enter and the send going out. The arm used to
  // dispatch the document it had captured and then clear the CURRENT one, so
  // whatever was typed during the read was destroyed - never sent, never shown
  // again, and invisible to any test that does not type during the await.
  it("typing during the await is preserved: the send carries the NEW document, not the captured one", async () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    let releaseRead: ((bytes: Uint8Array) => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation(() => {
      // Only the FIRST read is held open; the re-resolution after the edit
      // resolves at once so the test does not have to drive two handoffs.
      if (releaseRead !== null) return Promise.resolve(IMAGE_BYTES);
      return new Promise<Uint8Array | undefined>((resolve) => {
        releaseRead = resolve;
      });
    });

    const taskId = "chat-typing-during-await";
    const editor = mutableEditor(hashOnlyImageDocWithText("first"));
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();

    // Both halves of what a real keystroke does: the document changes, and the
    // editor boundary records the mutation in the draft store (which bumps the
    // `revision` the submit generation is read from).
    const typed = hashOnlyImageDocWithText("first and then more");
    act(() => {
      editor.setJSON(typed);
      useComposerDraftStore.getState().setSnapshot(taskId, typed, null);
    });

    act(() => {
      releaseRead?.(IMAGE_BYTES);
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // The send carries the text typed DURING the read. With the captured
    // document this reads "first".
    expect(submit.mock.calls[0][0].contentText).toContain("and then more");
    // And the restore payload - what a refused send puts back - is the live
    // document too, not the stale capture.
    expect(
      extractParagraphText(submit.mock.calls[0][0].restore.content),
    ).toContain("and then more");
    // The stale capture was not sent and then patched up: the submit was
    // re-entered and the CURRENT document resolved from scratch.
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(2);
    const atoms = collectImageAtoms(submit.mock.calls[0][0].content);
    expect(atoms[0]?.b64content).toBe(
      btoa(String.fromCharCode(...IMAGE_BYTES)),
    );
    await waitFor(() => {
      expect(result.current.annotationPreparationPending).toBe(false);
    });
  });

  // The guard used to sit INSIDE each async arm, which left the synchronous
  // path open: a first submit goes async on a session-cold hash, the paste then
  // warms the session cache, and a second Enter takes the synchronous fast path
  // and sends immediately - after which the first arm settles and sends the
  // same message a second time.
  it("a second submit during the await is a no-op, including via the synchronous fast path", async () => {
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    let releaseRead: ((bytes: Uint8Array) => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation(
      () =>
        new Promise<Uint8Array | undefined>((resolve) => {
          releaseRead = resolve;
        }),
    );

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: "chat-second-submit-during-await",
      editor: fakeEditor(hashOnlyImageDoc()),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(1);

    // The hash is session-warm by the time the user presses Enter again, so
    // this second submit would take the SYNCHRONOUS fast path - the one the
    // per-arm guard never covered.
    imageStoreMocks.sessionImageBytes.mockReturnValue(IMAGE_BYTES);
    act(() => {
      result.current.submitDraft("enter");
    });
    expect(submit).not.toHaveBeenCalled();

    act(() => {
      releaseRead?.(IMAGE_BYTES);
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // Drain every remaining microtask: a second dispatch would land here.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    // The second submit never started a read of its own either.
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(1);
  });
});

// RETIRED: "useChatComposerSubmit: by-hash upload arm - generation guard and
// no-double-upload" (three cases, plus the `createGatedByHashHostFixture` that
// drove them through a real `HostClient`).
//
// They pinned a `drafts.putBlob` issued BY THIS HOOK at submit. The hook no
// longer uploads anything: `chat.subscribe@1.12` moved send-path
// materialization behind the bridge capability, and the bytes get to the host
// from `lib/drafts/draft-mirror-coordinator.ts` while the user types. All this
// hook does now is ask `submitHostHeldImageHashes` what the host already holds.
// With no upload in the unit, "not re-uploaded on retry", "a second submit
// during the upload await is a no-op" and "a stale-generation retry DOES
// re-upload" have nothing to observe - a fixture counting `putBlob` calls here
// would assert zero and pass whatever the hook did.
//
// Where each claim lives now:
//  - the upload itself, its de-duplication and its epoch fence: the mirror
//    coordinator's own suites, over `putDraftBlobs`.
//  - upload-at-submit with a generation guard across it: the inline EDIT
//    composer is the one surface that still does this (it has no mirror), and
//    `use-chat-message-actions-edit-by-hash.test.tsx` drives the real
//    `putDraftBlobs` against a faked `drafts.putBlob`.
//  - "typing during the await is preserved" for THIS hook: still pinned above,
//    over the byte-resolution await, which is the only await it has left.
