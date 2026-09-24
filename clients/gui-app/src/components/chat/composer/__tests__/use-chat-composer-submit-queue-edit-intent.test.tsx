/**
 * F1 (batch-1 review, P1): canceling a queue edit during byte resolution could
 * submit into the WRONG destination and clear the restored draft. The
 * incarnation guard alone cannot catch this - `restoreQueuedEditDraft` swaps
 * the document via `replaceDraft` (which bumps `resetEpoch`), NOT by
 * recreating the editor. The fix captures the submit INTENT
 * `{ queueEditTargetId, resetEpoch }` at preparation start and re-checks both,
 * live, before the final send.
 *
 * `bumpResetEpoch` is the load-bearing distinction: `replaceDraft` (a
 * document REPLACEMENT - queue-edit cancel, failed-send restore) bumps it;
 * `setSnapshot` (an ordinary keystroke) does not. So this suite proves both
 * halves - the replacement invalidates, and plain typing still reaches the
 * live re-read unharmed.
 */
import "../../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { __resetHostHeldImageHashesForTests } from "@/lib/composer/host-held-image-hashes";

const resolveMocks = vi.hoisted(() => ({
  resolveDraftImageBytes: vi.fn<
    (hash: string, target: unknown) => Promise<Uint8Array | null>
  >(() => Promise.resolve(null)),
}));

vi.mock("@/lib/drafts/resolve-draft-image-bytes", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/drafts/resolve-draft-image-bytes")
    >();
  return {
    ...actual,
    resolveDraftImageBytes: resolveMocks.resolveDraftImageBytes,
  };
});

const IMAGE_HASH = "a".repeat(64);
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function docWithHashOnlyImage(hash: string, text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: `img-${hash.slice(0, 6)}`,
          fileName: "screenshot.png",
          mimeType: "image/png",
          size: 128,
          hash,
        },
      },
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

function docWithText(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** A mutable handle whose document AND `clear()` call count can be observed. */
function mutableFakeEditor(initial: JsonContent): {
  readonly handle: ComposerPromptEditorHandle;
  readonly setJSON: (next: JsonContent) => void;
  clearCount: number;
} {
  let content = initial;
  const state = {
    handle: {
      isReady: () => true,
      getEditorIncarnation: () => null,
      hasFocus: () => false,
      focus: () => undefined,
      focusAtEnd: () => undefined,
      getJSON: () => content,
      isEmpty: () => false,
      clear: () => {
        state.clearCount += 1;
      },
      setContent: () => undefined,
      syncContent: () => undefined,
      insertImageAttachments: () => undefined,
      insertMentionAttachment: () => false,
      beginPathInsertion: () => null,
      removeImageAttachmentById: () => undefined,
      rewriteImageAttachmentHashById: () => false,
      insertDictatedText: () => undefined,
      dismissActiveSuggestion: () => false,
    },
    setJSON: (next: JsonContent) => {
      content = next;
    },
    clearCount: 0,
  };
  return state;
}

interface MountProps {
  readonly queueEditTargetId: string | null;
}

function mountSubmit(
  taskId: string,
  editor: ComposerPromptEditorHandle,
  onSubmitMessage: (input: ChatComposerSubmitInput) => boolean,
  initialProps: MountProps,
) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "queue-edit-intent-submit",
    values: {
      permission: "supervised",
      selection: { harnessId: "codex", modelSlug: "gpt-5", profileId: null },
      reasoning: "medium",
      serviceTier: "auto",
      identityId: null,
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
  return renderHook(
    (props: MountProps) =>
      useChatComposerSubmit({
        taskId,
        editorRef: { current: editor },
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
        onSubmitMessage,
        onSideChat: null,
        targetHostId: null,
        queueEditTargetId: props.queueEditTargetId,
        // T5's gate is off in this fixture: it predates the gate and asserts the
        // inline behaviour, which is what `false` preserves exactly.
        getDraftBlobBridgeSupported: () => false,
      }),
    { initialProps },
  );
}

beforeEach(() => {
  resolveMocks.resolveDraftImageBytes.mockReset();
  resolveMocks.resolveDraftImageBytes.mockResolvedValue(null);
  __resetHostHeldImageHashesForTests();
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
});

describe("F1: queue-edit submit intent invalidation", () => {
  it("abandons the send when the draft is REPLACED (resetEpoch bump) mid-resolution, even with queueEditTargetId unchanged", async () => {
    const taskId = "chat-queue-edit-replaced";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        }),
    );
    const editor = mutableFakeEditor(
      docWithHashOnlyImage(IMAGE_HASH, "queued item Q"),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit(taskId, editor.handle, submit, {
      queueEditTargetId: "Q",
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // The cancel button restores the original composer draft via
    // `replaceDraft` - a document REPLACEMENT, not an editor recreation - and
    // the composer's own document is put back to match (as `syncContent`
    // would do). `queueEditTargetId` has not moved yet at this instant, which
    // is exactly what made the incarnation-only guard blind to this case.
    const restoredDraft = docWithText("original unrelated draft");
    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, restoredDraft, null);
      editor.setJSON(restoredDraft);
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    expect(submit).not.toHaveBeenCalled();
    expect(editor.clearCount).toBe(0);
  });

  it("abandons the send when queueEditTargetId itself changes mid-resolution", async () => {
    const taskId = "chat-queue-edit-target-switch";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        }),
    );
    const editor = mutableFakeEditor(
      docWithHashOnlyImage(IMAGE_HASH, "queued item Q"),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result, rerender } = mountSubmit(taskId, editor.handle, submit, {
      queueEditTargetId: "Q",
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // Switched to editing a different queued item (or cancelled to no
    // queue-edit at all) while the read was in flight.
    act(() => {
      rerender({ queueEditTargetId: null });
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    expect(submit).not.toHaveBeenCalled();
    expect(editor.clearCount).toBe(0);
  });

  it("positive control: ordinary typing (setSnapshot, no resetEpoch bump) still reaches the live re-read and sends", async () => {
    const taskId = "chat-queue-edit-plain-typing";
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(() => {
      // Only the FIRST read is held open. `setSnapshot` bumps `revision`, which
      // is the submit generation's carrier, so the keystroke below RE-ENTERS the
      // submit and resolves the live document from scratch. A mock that held
      // every read open would leave that second pass pending forever and this
      // control would read as a send that never goes out - a fact about the
      // harness driving one handoff, not about the re-read.
      if (release !== null) return Promise.resolve(IMAGE_BYTES);
      return new Promise<Uint8Array | null>((resolve) => {
        release = () => resolve(IMAGE_BYTES);
      });
    });
    const editor = mutableFakeEditor(
      docWithHashOnlyImage(IMAGE_HASH, "typing"),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit(taskId, editor.handle, submit, {
      queueEditTargetId: null,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // A keystroke: `setSnapshot` bumps `revision`, never `resetEpoch`.
    const typedDoc = docWithHashOnlyImage(IMAGE_HASH, "typing more");
    act(() => {
      editor.setJSON(typedDoc);
      useComposerDraftStore.getState().setSnapshot(taskId, typedDoc, {
        from: 1,
        to: 2,
      });
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const input = submit.mock.calls[0][0];
    expect(input.contentText).toBe("typing more");
    const atoms = collectImageAtoms(input.content);
    expect(atoms).toHaveLength(1);
    expect(typeof atoms[0]?.b64content).toBe("string");
    expect(editor.clearCount).toBe(1);
  });
});
