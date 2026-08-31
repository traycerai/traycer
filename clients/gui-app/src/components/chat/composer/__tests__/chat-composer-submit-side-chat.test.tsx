import { createRef, type RefObject } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatQueueDeliveryPolicy,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { createComposerPickerStore } from "../picker/composer-picker-store";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import {
  useChatComposerSubmit,
  type ChatComposerSideChatInput,
} from "../use-chat-composer-submit";
import { createPromptTextEditorHandle } from "./composer-prompt-editor-handle-fixtures";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import type { Attachment } from "@/lib/composer/types";

/**
 * `/btw` interception inside `useChatComposerSubmit`, modeled on
 * `chat-composer-submit-gate.test.tsx`'s `mountSubmitHook` helper.
 */

interface ChatComposerSubmitInput {
  readonly content: JsonContent;
  readonly contentText: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly settings: ChatRunSettings;
  readonly deliveryPolicy: ChatQueueDeliveryPolicy;
}

afterEach(() => {
  cleanup();
  useComposerDraftStore.setState({ drafts: {} });
});

function mountSubmit(args: {
  readonly taskId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly onSubmitMessage:
    | ((input: ChatComposerSubmitInput) => boolean)
    | null;
  readonly onSideChat: ((input: ChatComposerSideChatInput) => boolean) | null;
}) {
  const pickerStore = createComposerPickerStore();
  const toolbarStore = createComposerToolbarStore({
    seedKey: `side-chat-submit-test-${args.taskId}`,
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: "claude-sonnet",
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    hostId: null,
  });

  return renderHook(() =>
    useChatComposerSubmit({
      taskId: args.taskId,
      editorRef: args.editorRef,
      pickerStore,
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
      onSideChat: args.onSideChat,
    }),
  );
}

describe("useChatComposerSubmit: /btw side-chat interception", () => {
  it("routes a leading /btw to onSideChat, clears the draft, and never calls onSubmitMessage", () => {
    const taskId = "task-btw-1";
    const editor = createPromptTextEditorHandle("/btw why is it slow?");
    const clear = vi.fn(editor.clear);
    const handle: ComposerPromptEditorHandle = { ...editor, clear };
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = handle;

    const onSubmitMessage = vi.fn((_input: ChatComposerSubmitInput) => true);
    const onSideChat = vi.fn((input: ChatComposerSideChatInput) => {
      expect(extractPlainTextFromComposerJSONContent(input.content)).toBe(
        "why is it slow?",
      );
      return true;
    });

    const { result } = mountSubmit({
      taskId,
      editorRef,
      onSubmitMessage,
      onSideChat,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSideChat).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft when onSideChat refuses (returns false)", () => {
    const taskId = "task-btw-2";
    const editor = createPromptTextEditorHandle("/btw why is it slow?");
    const clear = vi.fn(editor.clear);
    const handle: ComposerPromptEditorHandle = { ...editor, clear };
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = handle;

    const onSubmitMessage = vi.fn((_input: ChatComposerSubmitInput) => true);
    const onSideChat = vi.fn((_input: ChatComposerSideChatInput) => false);

    const { result } = mountSubmit({
      taskId,
      editorRef,
      onSubmitMessage,
      onSideChat,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSideChat).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("falls through to onSubmitMessage untouched when onSideChat is null", () => {
    const taskId = "task-btw-3";
    const editor = createPromptTextEditorHandle("/btw why is it slow?");
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editor;

    const onSubmitMessage = vi.fn((_input: ChatComposerSubmitInput) => true);

    const { result } = mountSubmit({
      taskId,
      editorRef,
      onSubmitMessage,
      onSideChat: null,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage.mock.calls[0][0].contentText).toBe(
      "/btw why is it slow?",
    );
  });

  it("recognizes the /side alias", () => {
    const taskId = "task-side-1";
    const editor = createPromptTextEditorHandle("/side what about this?");
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editor;

    const onSubmitMessage = vi.fn((_input: ChatComposerSubmitInput) => true);
    const onSideChat = vi.fn((_input: ChatComposerSideChatInput) => true);

    const { result } = mountSubmit({
      taskId,
      editorRef,
      onSubmitMessage,
      onSideChat,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSideChat).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage).not.toHaveBeenCalled();
  });

  it("does not intercept a near-miss command like /btwx", () => {
    const taskId = "task-btwx-1";
    const editor = createPromptTextEditorHandle("/btwx hello there");
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editor;

    const onSubmitMessage = vi.fn((_input: ChatComposerSubmitInput) => true);
    const onSideChat = vi.fn((_input: ChatComposerSideChatInput) => true);

    const { result } = mountSubmit({
      taskId,
      editorRef,
      onSubmitMessage,
      onSideChat,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSideChat).not.toHaveBeenCalled();
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
  });
});
