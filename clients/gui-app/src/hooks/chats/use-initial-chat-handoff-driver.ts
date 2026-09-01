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

/**
 * Whether the composer for this node has nothing the user would miss.
 *
 * `contentIsSubmittable` is the canonical answer - text OR image atoms - and
 * it is deliberately shared so the rule stays in lockstep across surfaces. A
 * plain-text reading of this question calls an attachment-only draft empty,
 * and this guard would then overwrite images the user could have SENT with
 * the restored prompt: the very loss it exists to prevent, on content that
 * cannot be retyped at all.
 *
 * Read live rather than through a subscription: this runs inside an effect
 * that fires on the transition, and a stale read would decide the question
 * with the wrong draft.
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
      // THE consumption point for every restoration path - the pending pass,
      // the settled pass, the rejection winner and the accepted-send pass all
      // arrive here - so the newer-draft rule belongs here rather than at any
      // one of them. `replaceDraftContent` is unconditional, and a queued send
      // followed by more typing is the ordinary way to use a queue, so an
      // unguarded restore overwrites work the user can still see themselves
      // doing.
      //
      // The newer draft wins the composer and the older prompt is STATED with
      // its text inlined. That keeps the founding invariant intact - restored
      // XOR stated, never neither - with the composer going to whichever text
      // the user is actually looking at.
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
      // The worktree hand-back already ran at RECONCILE time, so the stated
      // prompt's binding is now staged under the user's newer draft. Left
      // deliberately: a staged pick is VISIBLE in the composer's worktree
      // picker, which makes it a wrong-looking choice rather than a silent
      // local run - and the notice's own worktree clause names the binding. -
      // Unwinding it here would mean a blind clear from a seam that does not
      // know whose pick it is, re-opening exactly the cross-dispatch
      // sweep-evidence lifecycle `restoreIntentForDispatch` exists to protect.
      input.state.stateFailedSendRestoration(input.step.clientActionId);
      return;
    }
  }
}
