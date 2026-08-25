import "../../../../../__tests__/test-browser-apis";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  createBrowserDebugContextAttachment,
  mintBrowserObserveGrant,
} from "@/lib/browser-view/browser-context-attachments";
import type { BrowserViewCapturePageResult } from "@traycer-clients/shared/platform/browser-view";

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const CAPTURE: BrowserViewCapturePageResult = {
  viewTabId: "view-tab",
  paneId: "browser-pane",
  tileInstanceId: "browser-instance",
  pageSessionId: "browser-page",
  mediaType: "image/png",
  base64: "aGVsbG8=",
  byteLength: 5,
  sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  capturedAt: 2000,
};

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
});

describe("useChatComposerSubmit", () => {
  it("submits browser context as structured attachments from the draft store", () => {
    const taskId = "chat-1";
    const browserPayload = mintBrowserObserveGrant(
      createBrowserDebugContextAttachment({
        tile: {
          viewTabId: "view-tab",
          paneId: "browser-pane",
          tileInstanceId: "browser-instance",
          pageSessionId: "browser-page",
        },
        pageUrl: "https://example.com/page",
        dataLevel: "debug-snapshot",
        capture: CAPTURE,
        consoleEntries: [],
        networkEntries: [],
      }),
      { chatId: taskId, expiresAt: 605000 },
    );
    useComposerDraftStore
      .getState()
      .addBrowserContextAttachment(taskId, browserPayload);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const editor = fakeEditor(EMPTY_DOC);
    const toolbarStore = createComposerToolbarStore({
      seedKey: "test",
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
      hostId: null,
    });

    const { result } = renderHook(() =>
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
        onSubmitMessage: submit,
      }),
    );

    result.current.submitDraft("enter");

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      content: EMPTY_DOC,
      contentText: "",
      attachments: [
        {
          kind: "browser-context",
          payload: {
            kind: "browser-debug-context",
            observeGrant: {
              chatId: taskId,
              tileInstanceId: "browser-instance",
              origin: "https://example.com",
              dataLevel: "debug-snapshot",
              expiresAt: 605000,
            },
          },
        },
      ],
    });
  });
});

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
