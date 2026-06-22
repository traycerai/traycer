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
import {
  nextHandoffTransition,
  type HandoffStep,
} from "@/lib/chats/next-handoff-transition";

/**
 * Single owner for the chat-tile's initial-chat handoff lifecycle.
 *
 * Replaces the four sibling effects in chat-tile.tsx that previously
 * coordinated:
 *  - handoff failure detection (markFailedByAction)
 *  - failed-send restoration (restorePromptContent + ackFailedSendRestoration)
 *  - sending → consumed via acceptedActions
 *  - sending → consumed via messages
 *
 * The fifth side-effect - `waitingChat → sendMessage → markSending` - is
 * also collapsed into this hook. The decision policy lives in the pure
 * `nextHandoffTransition` function so each transition is unit-testable
 * without rendering React.
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
  // Subscribe to the chat-session pieces the driver actually reads so the
  // effect re-runs when any of them transitions (e.g. snapshotLoaded flips
  // from false to true, a new accepted action arrives, the persisted
  // messages array gains the user message). Without this subscription the
  // effect would only re-run when `handoff` or `scope` change, missing
  // state-change-driven transitions like waitingChat → send.
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
      input.replaceDraftContent(input.nodeId, input.step.content, null);
      input.state.ackFailedSendRestoration(input.step.clientActionId);
      return;
    }
  }
}
