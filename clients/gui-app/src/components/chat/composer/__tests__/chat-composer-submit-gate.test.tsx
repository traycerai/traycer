import "../../../../../__tests__/test-browser-apis";
import { createRef } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { createComposerPickerStore } from "../picker/composer-picker-store";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { useChatComposerSubmit } from "../use-chat-composer-submit";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  isAttachmentIngestPending,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";

/**
 * Chat-composer submit gate (finding 3).
 *
 * `chat-composer.tsx` feeds `attachmentPreparationPending` into
 * `useChatComposerSubmit` from `isAttachmentIngestPending({isIngestingImages,
 * isResolvingFilePaths})`. Mounting the full ChatComposer surface is heavy;
 * this tests the exact submit path the surface uses, plus the pure-path
 * composition of the pending helper.
 */

const DIRTY: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

afterEach(() => {
  cleanup();
});

describe("chat-composer submit gate (path resolution)", () => {
  it("blocks useChatComposerSubmit while attachmentPreparationPending is true", () => {
    const onSubmitMessage = vi.fn(() => true);
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editorHandle(DIRTY);
    const pickerStore = createComposerPickerStore();
    const toolbarStore = createComposerToolbarStore({
      seedKey: "chat-submit-gate-test",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "claude-sonnet",
          profileId: null,
        },
        reasoning: "medium",
        serviceTier: "",
        agentMode: "regular",
      },
      onSettingsChange: null,
      tuiOnly: false,
    });

    const { result, rerender } = renderHook(
      (pending: boolean) =>
        useChatComposerSubmit({
          taskId: "task-1",
          editorRef,
          pickerStore,
          toolbarStore,
          activeTurnStatus: null,
          hasPendingApprovals: false,
          sendDisabled: false,
          workspaceBlocked: false,
          imagesUnsupported: false,
          attachmentPreparationPending: pending,
          onSubmitMessage,
        }),
      { initialProps: true },
    );

    result.current();
    expect(onSubmitMessage).not.toHaveBeenCalled();

    rerender(false);
    result.current();
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
  });

  it("treats pure isResolvingFilePaths as attachment-pending (chat-composer composition)", () => {
    const paste: Pick<
      UseComposerPasteResult,
      "isIngestingImages" | "isResolvingFilePaths"
    > = {
      isIngestingImages: false,
      isResolvingFilePaths: true,
    };
    // Mirrors chat-composer.tsx:
    //   isAttachmentIngestPending({ isIngestingImages, isResolvingFilePaths })
    expect(isAttachmentIngestPending(paste)).toBe(true);
  });
});

function editorHandle(content: JsonContent): ComposerPromptEditorHandle {
  return {
    isReady: () => true,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    insertImageAttachments: () => undefined,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}
