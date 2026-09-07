import { useEffect } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { UserMessageSender } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  selectInitialChatHandoff,
  useInitialChatHandoffStore,
  type InitialChatHandoff,
  type InitialChatHandoffScope,
} from "@/stores/epics/initial-chat-handoff-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { contentIsSubmittable } from "@/lib/composer/composer-content";
import {
  nextHandoffTransition,
  type HandoffStep,
} from "@/lib/chats/next-handoff-transition";

/**
 * Single owner for the chat-tile initial-chat handoff. Policy lives in `nextHandoffTransition`.
 */
export interface InitialChatHandoffDriverOptions {
  readonly handle: ChatSessionStoreHandle;
  readonly nodeId: string;
  readonly scope: InitialChatHandoffScope;
  readonly profileUserId: string | null;
}

export function useInitialChatHandoffDriver(
  options: InitialChatHandoffDriverOptions,
): void {
  const { handle, nodeId, scope, profileUserId } = options;
  const handoff = useInitialChatHandoffStore((state) =>
    selectInitialChatHandoff(state, scope),
  );
  const replaceDraftContent = useComposerDraftStore(
    (state) => state.replaceDraft,
  );
  // Without this subscription the effect would only re-run when `handoff` or `scope` change, missing state-change-driven transitions like waitingChat → send.
  const chatSnapshot = useStore(
    handle.store,
    useShallow((s) => ({
      connectionStatus: s.connectionStatus,
      snapshotLoaded: s.snapshotLoaded,
      canAct: s.access?.canAct === true,
      acceptedActions: s.acceptedActions,
      messages: s.messages,
      failedSendRestoration: s.failedSendRestoration,
    })),
  );
  const {
    acceptedActions,
    canAct,
    connectionStatus,
    failedSendRestoration,
    messages,
    snapshotLoaded,
  } = chatSnapshot;

  useEffect(() => {
    const state = handle.store.getState();
    const step = nextHandoffTransition(handoff, {
      nodeId,
      snapshotLoaded,
      canAct: connectionStatus === "open" && canAct && profileUserId !== null,
      acceptedActions,
      messages,
      failedSendRestoration,
    });
    applyInitialChatHandoffStep({
      handoff,
      nodeId,
      profileUserId,
      replaceDraftContent,
      scope,
      state,
      step,
    });
  }, [
    acceptedActions,
    canAct,
    connectionStatus,
    failedSendRestoration,
    handle.store,
    handoff,
    messages,
    nodeId,
    profileUserId,
    replaceDraftContent,
    scope,
    snapshotLoaded,
  ]);
}

interface ApplyInitialChatHandoffStepInput {
  readonly handoff: InitialChatHandoff | null;
  readonly nodeId: string;
  readonly profileUserId: string | null;
  readonly replaceDraftContent: (
    taskId: string,
    content: InitialChatHandoff["content"],
    selection: null,
  ) => void;
  readonly scope: InitialChatHandoffScope;
  readonly state: ChatSessionState;
  readonly step: HandoffStep;
}

/**
 * Empty means `contentIsSubmittable` is false (text or image). A text-only read would overwrite an attachment-only draft. Read live; a stale subscription would decide on the wrong draft.
 */
function composerDraftIsEmpty(nodeId: string): boolean {
  const draft = useComposerDraftStore.getState().drafts[nodeId];
  if (draft === undefined) return true;
  return !contentIsSubmittable(draft.content);
}

function applyInitialChatHandoffStep(
  input: ApplyInitialChatHandoffStepInput,
): void {
  switch (input.step.kind) {
    case "noop":
      return;
    case "send": {
      if (input.handoff === null || input.profileUserId === null) return;
      if (
        input.handoff.messageId === null ||
        input.handoff.clientActionId === null
      ) {
        return;
      }
      const sender: UserMessageSender = {
        type: "user",
        userId: input.profileUserId,
      };
      // Reuse the handoff's pre-minted ids so this send reconciles the
      // optimistic seed in place (and matches the host turn-overlap
      // idempotency gate) rather than rendering a second user message.
      const sent = input.state.sendSeededUserMessage({
        messageId: input.handoff.messageId,
        clientActionId: input.handoff.clientActionId,
        content: input.handoff.content,
        sender,
        settings: input.handoff.settings,
      });
      if (sent === null) return;
      useInitialChatHandoffStore
        .getState()
        .markSending(
          input.scope,
          input.nodeId,
          sent.clientActionId,
          sent.messageId,
        );
      return;
    }
    case "consume": {
      useInitialChatHandoffStore.getState().consume(input.scope);
      if (input.step.clientActionId !== null) {
        input.state.ackAcceptedAction(input.step.clientActionId);
      }
      return;
    }
    case "markFailedByAction": {
      useInitialChatHandoffStore
        .getState()
        .markFailedByAction(
          input.scope,
          input.nodeId,
          input.step.clientActionId,
          input.step.reason,
        );
      return;
    }
    case "restoreAndAckFailed": {
      // Every restoration path lands here. A newer draft wins the composer; the older prompt is stated. Restored XOR stated, never neither.
      if (composerDraftIsEmpty(input.nodeId)) {
        input.replaceDraftContent(input.nodeId, input.step.content, null);
        useComposerDraftStore
          .getState()
          .restoreBrowserAnnotations(
            input.nodeId,
            input.step.browserAnnotations,
          );
        input.state.ackFailedSendRestoration(input.step.clientActionId);
        return;
      }
      // Left deliberately: a staged pick is VISIBLE in the composer's worktree picker, which makes it a wrong-looking choice rather than a silent local run - and the notice's own worktree clause names the binding.
      input.state.stateFailedSendRestoration(input.step.clientActionId);
      return;
    }
  }
}
