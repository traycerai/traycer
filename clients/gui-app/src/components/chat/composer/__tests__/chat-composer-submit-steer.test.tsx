import "../../../../../__tests__/test-browser-apis";
import { createRef, type RefObject } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatActiveTurn,
  ChatQueueDeliveryPolicy,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { createComposerPickerStore } from "../picker/composer-picker-store";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import {
  useChatComposerSubmit,
  type ChatComposerSubmitResult,
} from "../use-chat-composer-submit";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { Attachment } from "@/lib/composer/types";

/**
 * Drift-gating branch of `useChatComposerSubmit` (decision 6).
 *
 * A Mod-Enter that would steer opens the settings-conflict dialog when the
 * toolbar settings differ from the running turn on a turn-start-baked field
 * (model/harness/reasoning/tier/agent-mode/profile). permissionMode alone is
 * soft and must not open the dialog. Follows the harness style of
 * chat-composer-submit-gate.test.tsx.
 */

const DIRTY: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "steer me" }] },
  ],
};

const MATCHING_TURN: ChatActiveTurn = {
  agentMode: "regular",
  sameTurnSteeringSupported: true,
  turnId: "turn-1",
  status: "running",
  harnessId: "claude",
  model: "claude-sonnet",
  reasoningEffort: "medium",
  serviceTier: null,
  profileId: null,
  userMessageId: "message-1",
  startedAt: 1,
  updatedAt: 1,
};

interface ChatComposerSubmitInput {
  readonly content: JsonContent;
  readonly contentText: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly settings: ChatRunSettings;
  readonly deliveryPolicy: ChatQueueDeliveryPolicy;
}

function acceptSubmit(_input: ChatComposerSubmitInput): boolean {
  return true;
}

afterEach(() => {
  cleanup();
});

describe("useChatComposerSubmit steer drift gate", () => {
  it("sends after_safe_point immediately when settings match the running turn", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const { result } = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: null,
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: null,
    });

    act(() => {
      result.current.submitDraft("mod-enter");
    });

    expect(result.current.steerConflict.open).toBe(false);
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    const input = onSubmitMessage.mock.calls[0]?.[0];
    expect(input.deliveryPolicy).toBe("after_safe_point");
    expect(input.contentText).toBe("steer me");
  });

  it("sends after_safe_point silently when only permissionMode differs", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const { result } = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: null,
      permission: "full_access",
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: null,
    });

    act(() => {
      result.current.submitDraft("mod-enter");
    });

    expect(result.current.steerConflict.open).toBe(false);
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage.mock.calls[0]?.[0]?.deliveryPolicy).toBe(
      "after_safe_point",
    );
  });

  it("opens the conflict dialog and keeps composer text on model drift (does not send)", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    const clear = vi.fn();
    editorRef.current = {
      ...editorHandle(DIRTY),
      clear,
    };

    const { result } = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef,
      steerCapable: true,
      steerProtocolSupported: null,
    });

    act(() => {
      result.current.submitDraft("mod-enter");
    });

    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(result.current.steerConflict.open).toBe(true);
    expect(result.current.steerConflict.changed).toEqual(["model"]);
    expect(clear).not.toHaveBeenCalled();
  });

  it("sends the staged after_safe_point input with the new settings on restart confirm", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const { result } = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: null,
    });

    act(() => {
      result.current.submitDraft("mod-enter");
    });
    expect(result.current.steerConflict.open).toBe(true);
    expect(onSubmitMessage).not.toHaveBeenCalled();

    act(() => {
      result.current.steerConflict.onRestart();
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    const input = onSubmitMessage.mock.calls[0]?.[0];
    expect(input.deliveryPolicy).toBe("after_safe_point");
    expect(input.settings).toMatchObject({
      harnessId: "claude",
      model: "claude-opus",
      profileId: null,
    } satisfies Partial<ChatRunSettings>);
    expect(result.current.steerConflict.open).toBe(false);
  });

  it("dismisses the staged conflict without sending when the dialog closes", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const { result } = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: null,
    });

    act(() => {
      result.current.submitDraft("mod-enter");
    });
    expect(result.current.steerConflict.open).toBe(true);

    act(() => {
      result.current.steerConflict.onOpenChange(false);
    });

    expect(result.current.steerConflict.open).toBe(false);
    expect(onSubmitMessage).not.toHaveBeenCalled();
  });

  it("does not run the drift gate for plain Enter (queues with auto)", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const { result } = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: null,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(result.current.steerConflict.open).toBe(false);
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage.mock.calls[0]?.[0]?.deliveryPolicy).toBe("auto");
  });

  it("skips the drift dialog on an unsupported harness and sends after_safe_point directly", () => {
    // Capability gates only the confirm dialog. Unsupported harnesses still
    // send after_safe_point so the host can mark a labeled fallback row.
    const onSubmitMessage = vi.fn(acceptSubmit);
    const { result } = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: false,
      steerProtocolSupported: null,
    });

    act(() => {
      result.current.submitDraft("mod-enter");
    });

    expect(result.current.steerConflict.open).toBe(false);
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage.mock.calls[0]?.[0]?.deliveryPolicy).toBe(
      "after_safe_point",
    );
    expect(onSubmitMessage.mock.calls[0]?.[0]?.settings.model).toBe(
      "claude-opus",
    );
  });

  it("re-resolves onRestart to auto when steerProtocolSupported flips false while the dialog is open (F1)", () => {
    // Staged conflict stores INTENT only. Confirm re-runs
    // resolveSubmitDeliveryPolicy against CURRENT connection/turn state so a
    // host downgrade (1.5 → 1.4) while the dialog is open cannot emit a stale
    // after_safe_point.
    const onSubmitMessage = vi.fn(acceptSubmit);
    const mount = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: true,
    });

    act(() => {
      mount.result.current.submitDraft("mod-enter");
    });
    expect(mount.result.current.steerConflict.open).toBe(true);
    expect(onSubmitMessage).not.toHaveBeenCalled();

    act(() => {
      mount.rerender({
        activeTurn: MATCHING_TURN,
        onSubmitMessage,
        modelSlug: "claude-opus",
        permission: null,
        editorRef: null,
        steerCapable: true,
        steerProtocolSupported: false,
      });
    });

    act(() => {
      mount.result.current.steerConflict.onRestart();
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage.mock.calls[0]?.[0]?.deliveryPolicy).toBe("auto");
    expect(onSubmitMessage.mock.calls[0]?.[0]?.settings.model).toBe(
      "claude-opus",
    );
    expect(mount.result.current.steerConflict.open).toBe(false);
  });

  it("keeps after_safe_point onRestart when steerProtocolSupported stays true (F1 mirror)", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const mount = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: true,
      activeTurnStatus: null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
    });

    act(() => {
      mount.result.current.submitDraft("mod-enter");
    });
    expect(mount.result.current.steerConflict.open).toBe(true);

    act(() => {
      mount.rerender({
        activeTurn: MATCHING_TURN,
        onSubmitMessage,
        modelSlug: "claude-opus",
        permission: null,
        editorRef: null,
        steerCapable: true,
        steerProtocolSupported: true,
        activeTurnStatus: null,
        hasPendingApprovals: false,
        sendDisabled: false,
        workspaceBlocked: false,
      });
    });

    act(() => {
      mount.result.current.steerConflict.onRestart();
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage.mock.calls[0]?.[0]?.deliveryPolicy).toBe(
      "after_safe_point",
    );
    expect(mount.result.current.steerConflict.open).toBe(false);
  });

  it("degrades onRestart to auto when the live turn is a successor of the origin turn (T1→T2 stale consent)", () => {
    // Consent is bound to originTurnId. Confirming after T1 is replaced by T2
    // must never interrupt-restart T2 on T1's consent - plain auto queue only.
    const onSubmitMessage = vi.fn(acceptSubmit);
    const turnT1: ChatActiveTurn = { ...MATCHING_TURN, turnId: "T1" };
    const turnT2: ChatActiveTurn = {
      ...MATCHING_TURN,
      turnId: "T2",
      userMessageId: "message-2",
    };
    const mount = mountSubmit({
      activeTurn: turnT1,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: true,
      activeTurnStatus: null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
    });

    act(() => {
      mount.result.current.submitDraft("mod-enter");
    });
    expect(mount.result.current.steerConflict.open).toBe(true);
    expect(onSubmitMessage).not.toHaveBeenCalled();

    act(() => {
      mount.rerender({
        activeTurn: turnT2,
        onSubmitMessage,
        modelSlug: "claude-opus",
        permission: null,
        editorRef: null,
        steerCapable: true,
        steerProtocolSupported: true,
        activeTurnStatus: null,
        hasPendingApprovals: false,
        sendDisabled: false,
        workspaceBlocked: false,
      });
    });

    act(() => {
      mount.result.current.steerConflict.onRestart();
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage.mock.calls[0]?.[0]?.deliveryPolicy).toBe("auto");
    expect(mount.result.current.steerConflict.open).toBe(false);
  });

  it("dismisses the dialog without sending when activeTurnStatus becomes stopping while open", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const mount = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: true,
      activeTurnStatus: null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
    });

    act(() => {
      mount.result.current.submitDraft("mod-enter");
    });
    expect(mount.result.current.steerConflict.open).toBe(true);

    act(() => {
      mount.rerender({
        activeTurn: MATCHING_TURN,
        onSubmitMessage,
        modelSlug: "claude-opus",
        permission: null,
        editorRef: null,
        steerCapable: true,
        steerProtocolSupported: true,
        activeTurnStatus: "stopping",
        hasPendingApprovals: false,
        sendDisabled: false,
        workspaceBlocked: false,
      });
    });

    act(() => {
      mount.result.current.steerConflict.onRestart();
    });

    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(mount.result.current.steerConflict.open).toBe(false);
  });

  it("dismisses the dialog without sending when hasPendingApprovals becomes true while open", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const mount = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: true,
      activeTurnStatus: null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
    });

    act(() => {
      mount.result.current.submitDraft("mod-enter");
    });
    expect(mount.result.current.steerConflict.open).toBe(true);

    act(() => {
      mount.rerender({
        activeTurn: MATCHING_TURN,
        onSubmitMessage,
        modelSlug: "claude-opus",
        permission: null,
        editorRef: null,
        steerCapable: true,
        steerProtocolSupported: true,
        activeTurnStatus: null,
        hasPendingApprovals: true,
        sendDisabled: false,
        workspaceBlocked: false,
      });
    });

    act(() => {
      mount.result.current.steerConflict.onRestart();
    });

    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(mount.result.current.steerConflict.open).toBe(false);
  });

  it("dismisses the dialog without sending when sendDisabled becomes true while open", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const mount = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: true,
      activeTurnStatus: null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
    });

    act(() => {
      mount.result.current.submitDraft("mod-enter");
    });
    expect(mount.result.current.steerConflict.open).toBe(true);

    act(() => {
      mount.rerender({
        activeTurn: MATCHING_TURN,
        onSubmitMessage,
        modelSlug: "claude-opus",
        permission: null,
        editorRef: null,
        steerCapable: true,
        steerProtocolSupported: true,
        activeTurnStatus: null,
        hasPendingApprovals: false,
        sendDisabled: true,
        workspaceBlocked: false,
      });
    });

    act(() => {
      mount.result.current.steerConflict.onRestart();
    });

    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(mount.result.current.steerConflict.open).toBe(false);
  });

  it("keeps after_safe_point onRestart when sameTurn and steerProtocolSupported stay true (positive control)", () => {
    // Same origin turn + protocol still live → re-resolved steer policy.
    const onSubmitMessage = vi.fn(acceptSubmit);
    const mount = mountSubmit({
      activeTurn: MATCHING_TURN,
      onSubmitMessage,
      modelSlug: "claude-opus",
      permission: null,
      editorRef: null,
      steerCapable: true,
      steerProtocolSupported: true,
      activeTurnStatus: null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
    });

    act(() => {
      mount.result.current.submitDraft("mod-enter");
    });
    expect(mount.result.current.steerConflict.open).toBe(true);

    act(() => {
      mount.result.current.steerConflict.onRestart();
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage.mock.calls[0]?.[0]?.deliveryPolicy).toBe(
      "after_safe_point",
    );
    expect(mount.result.current.steerConflict.open).toBe(false);
  });
});

interface MountSubmitInput {
  readonly activeTurn: ChatActiveTurn | null;
  readonly onSubmitMessage: (payload: ChatComposerSubmitInput) => boolean;
  readonly modelSlug: string | null;
  readonly permission: "supervised" | "full_access" | null;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null> | null;
  readonly steerCapable: boolean;
  readonly steerProtocolSupported: boolean | null;
  /**
   * Overrides `activeTurn?.status` for the hook's `activeTurnStatus` prop
   * (e.g. force "stopping" while still exposing the origin turn via
   * getActiveTurnForSteer). Pass `null` or omit to derive from activeTurn.
   */
  readonly activeTurnStatus?: ChatActiveTurn["status"] | null;
  readonly hasPendingApprovals?: boolean;
  readonly sendDisabled?: boolean;
  readonly workspaceBlocked?: boolean;
}

interface MountSubmitHookProps {
  readonly activeTurn: ChatActiveTurn | null;
  readonly onSubmitMessage: (payload: ChatComposerSubmitInput) => boolean;
  readonly steerCapable: boolean;
  readonly steerProtocolSupported: boolean;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly hasPendingApprovals: boolean;
  readonly sendDisabled: boolean;
  readonly workspaceBlocked: boolean;
}

function toHookProps(input: MountSubmitInput): MountSubmitHookProps {
  return {
    activeTurn: input.activeTurn,
    onSubmitMessage: input.onSubmitMessage,
    steerCapable: input.steerCapable,
    steerProtocolSupported:
      input.steerProtocolSupported === null
        ? true
        : input.steerProtocolSupported,
    activeTurnStatus:
      input.activeTurnStatus === undefined ? null : input.activeTurnStatus,
    hasPendingApprovals: input.hasPendingApprovals === true,
    sendDisabled: input.sendDisabled === true,
    workspaceBlocked: input.workspaceBlocked === true,
  };
}

function mountSubmit(input: MountSubmitInput): {
  readonly result: { current: ChatComposerSubmitResult };
  readonly rerender: (next: MountSubmitInput) => void;
} {
  const modelSlug =
    input.modelSlug === null ? "claude-sonnet" : input.modelSlug;
  const permission =
    input.permission === null ? "supervised" : input.permission;
  const editorRef =
    input.editorRef === null
      ? createRef<ComposerPromptEditorHandle | null>()
      : input.editorRef;
  if (editorRef.current === null) {
    editorRef.current = editorHandle(DIRTY);
  }
  const pickerStore = createComposerPickerStore();
  const toolbarStore = createComposerToolbarStore({
    seedKey: "chat-submit-steer-test",
    values: {
      permission,
      selection: {
        harnessId: "claude",
        modelSlug,
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
  });

  function resolveStatus(
    props: MountSubmitHookProps,
  ): ChatActiveTurn["status"] | null {
    if (props.activeTurnStatus !== null) return props.activeTurnStatus;
    if (props.activeTurn === null) return null;
    return props.activeTurn.status;
  }

  const hook = renderHook(
    (props: MountSubmitHookProps) =>
      useChatComposerSubmit({
        taskId: "task-steer-1",
        editorRef,
        pickerStore,
        toolbarStore,
        activeTurnStatus: resolveStatus(props),
        steerCapable: props.steerCapable,
        steerEnabled: true,
        steerProtocolSupported: props.steerProtocolSupported,
        getActiveTurnForSteer: () => props.activeTurn,
        hasPendingApprovals: props.hasPendingApprovals,
        sendDisabled: props.sendDisabled,
        workspaceBlocked: props.workspaceBlocked,
        imagesUnsupported: false,
        attachmentPreparationPending: false,
        onSubmitMessage: props.onSubmitMessage,
      }),
    {
      initialProps: toHookProps(input),
    },
  );

  return {
    result: hook.result,
    rerender: (next) => {
      hook.rerender(toHookProps(next));
    },
  };
}

function editorHandle(content: JsonContent): ComposerPromptEditorHandle {
  return {
    isReady: () => true,
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
