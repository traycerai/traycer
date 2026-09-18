import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { JsonContent } from "@traycer/protocol/common/registry";
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
  inlineImageHashesFromSession,
  inlineLocalImageHashes,
} from "@/lib/composer/composer-image-inlining";
import {
  planAttachmentsByHash,
  resolveSendContentByHash,
  sendAttachmentsByHashSupported,
} from "@/lib/composer/attachments-by-hash";
import { useHostBinding } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
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
  const sendContent = useSeededSendContent(handoff);

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
      sendContent,
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
    sendContent,
    snapshotLoaded,
  ]);
}

/**
 * The handoff's content in the shape THIS HOST takes.
 *
 * The composers register the hash-only document — that is what keeps base64 out
 * of `localStorage` under this key and what lets the handoff root those bytes
 * against GC — so deciding the wire shape has to happen somewhere, and the
 * resend is the only place that knows the message is actually going out.
 *
 * TWO SHAPES, and the negotiated `chat.subscribe` minor picks between them. At
 * `@1.11` the host materializes a hash-only node out of this account's draft
 * blob tier before the dangling-hash guard runs, so the resend ships hashes and
 * the image never crosses the relay a second time; below it the bytes go back
 * inline, exactly as before.
 *
 * DELIBERATELY NOT the same gate the create used, and it must not be read as
 * one: the create asked about `epic.create@1.2` and this asks about
 * `chat.subscribe@1.11`. They are different methods on different lines, so a
 * host can advertise one and not the other, and a create that shipped hashes
 * can be followed by a resend that inlines. That asymmetry is harmless in the
 * direction it actually occurs, because inlining always works — what would not
 * be harmless is assuming the create's answer here and shipping hashes to a
 * `@1.10` stream on the strength of it.
 *
 * The hashes this resend sees are ALSO not only the ones the create sent by
 * hash. The handoff records the fully hash-only document on purpose (see
 * above), so it names the images the create INLINED as well; those are hashes
 * whose bytes the create could not confirm on the host, and this resend simply
 * asks again. `resolveSendContentByHash` is best effort, so a hash that is
 * still unconfirmable is inlined from this window if it can be and left
 * hash-only if it cannot.
 *
 * `null` means "not ready yet, do not send": the shape needs an await — a
 * session-cold byte read, or the upload that puts the hashes where the host can
 * find them. That await settling is what re-renders this hook and lets the
 * transition fire, so the send is delayed rather than dropped.
 *
 * A legacy v3 handoff — already fully inlined, written before this change —
 * takes the fast path unchanged: it has no hash-only node, so there is nothing
 * to resolve, nothing to upload and nothing to wait for.
 */
function useSeededSendContent(
  handoff: InitialChatHandoff | null,
): JsonContent | null {
  const content = handoff?.content ?? null;
  const key = handoff?.key ?? null;
  // The handoff's OWN host - the machine the chat was created on and is bound
  // to for life - not the window's effective one. The gate asks about that
  // host's stream, and the upload has to land in that host's blob tier.
  const hostId = handoff?.hostId ?? null;
  // Resolved through the binding directly rather than through
  // `useHostClientForHostId`, whose `null` branch falls back to
  // `useHostClient()` and THROWS where no host runtime is mounted. This driver
  // legitimately renders bare - a chat tile under test, a shell the layout
  // mounts without a provider - and the image seam is the only thing here that
  // wants a client, so it must not make the whole driver's mountability a
  // property of its own data needs. A handoff always names a host, so the
  // `null` branch is only ever the no-handoff render.
  const binding = useHostBinding();
  const client = useMemo(
    () => (hostId === null ? null : resolveNamedHostClient(binding, hostId)),
    [binding, hostId],
  );
  const plan = useMemo(
    () => (content === null ? null : planAttachmentsByHash(content)),
    [content],
  );
  const byHash =
    plan !== null &&
    hostId !== null &&
    client !== null &&
    plan.eligible.length > 0 &&
    sendAttachmentsByHashSupported(hostId);
  // Computed in render, not in an effect: the overwhelmingly common case is the
  // create and the resend happening in one session, where every hash is still
  // session-cached and going through state would cost the send an extra render.
  // Skipped entirely on the by-hash path, which has no synchronous answer.
  const fromSession = useMemo(
    () =>
      content === null || byHash ? null : inlineImageHashesFromSession(content),
    [byHash, content],
  );
  const [resolved, setResolved] = useState<{
    readonly key: string;
    readonly content: JsonContent;
  } | null>(null);
  useEffect(() => {
    if (content === null || key === null || fromSession !== null) return;
    let cancelled = false;
    const prepared =
      byHash && hostId !== null && client !== null && plan !== null
        ? resolveSendContentByHash({ hostId, client, content, plan })
        : inlineLocalImageHashes(content);
    // Two-argument `then`, so the failure arm answers only the READ failing.
    void prepared.then(
      (inlined) => {
        if (cancelled) return;
        setResolved({ key, content: inlined });
      },
      () => {
        // The store (or the upload) could not be reached at all. Send what we
        // have rather than stalling the handoff forever: a hash the host cannot
        // resolve comes back as the existing dangling-hash rejection, which
        // surfaces as a failed send and restores the prompt to the composer — a
        // visible failure the user can act on, and the honest outcome when the
        // bytes are genuinely unreachable.
        if (cancelled) return;
        setResolved({ key, content });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [byHash, client, content, fromSession, hostId, key, plan]);
  if (fromSession !== null) return fromSession;
  // Key-matched so a handoff replaced while its read was in flight (a second
  // create in the same epic) can never send the previous one's message.
  return resolved !== null && resolved.key === key ? resolved.content : null;
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
  /**
   * The handoff's content with its image hashes inlined — see
   * {@link useSeededSendContent}. `null` while those bytes are still being read
   * back, which holds the send rather than sending a document the host cannot
   * resolve.
   */
  readonly sendContent: JsonContent | null;
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
      // The handoff is registered hash-only; this send is where those bytes go
      // back inline. `null` means the read has not settled — hold the send, do
      // not fall back to the hash-only document, which the host would reject.
      // The read settling re-renders the driver and this transition fires again.
      if (input.sendContent === null) return;
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
        content: input.sendContent,
        sender,
        settings: input.handoff.settings,
        // The create's own intent. Ignored on the deferred path (this send is a
        // duplicate of the seeded queue item), and load-bearing on every
        // synchronous one, where this resend can beat the host's initial turn:
        // the host then materializes it against the worktree the create already
        // made and adopts it, instead of running the turn in the source
        // checkout.
        worktreeIntent: input.handoff.worktreeIntent,
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
