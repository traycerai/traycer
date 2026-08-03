import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { createFakeComposerPromptEditorHandle } from "@/components/chat/composer/__tests__/composer-prompt-editor-handle-fixtures";
import { useChatComposerDraft } from "@/components/chat/composer/use-chat-composer-draft";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

beforeEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
  useComposerDraftStore.setState({ drafts: {} });
});

describe("composer revision event contract", () => {
  it("does not double-count an external draft replacement echoed into the editor", () => {
    const taskId = "task-bridge-double";
    const { handle, syncContent } = createFakeComposerPromptEditorHandle({
      ready: true,
      content: { type: "doc", content: [{ type: "paragraph" }] },
      selection: null,
      isEmpty: true,
      onFocus: null,
      onClear: null,
    });

    renderHook(() =>
      useChatComposerDraft({
        taskId,
        editorRef: { current: handle },
        editorReadyTick: 1,
      }),
    );

    act(() => {
      useComposerDraftStore
        .getState()
        .setSnapshot(taskId, textDoc("before"), null);
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, textDoc("restored"), null);
    });

    expect(useComposerDraftStore.getState().drafts[taskId]?.revision).toBe(2);
    expect(syncContent).toHaveBeenCalledTimes(1);
    expect(syncContent).toHaveBeenCalledWith(textDoc("restored"), null);

    act(() => {
      useComposerDraftStore.getState().setSelection(taskId, { from: 3, to: 3 });
    });
    expect(useComposerDraftStore.getState().drafts[taskId]?.revision).toBe(2);
  });
});
