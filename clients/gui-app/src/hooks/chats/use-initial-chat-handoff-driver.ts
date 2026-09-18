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
  hashOnlyImageHashes,
  inlineHashOnlyImageBytes,
} from "@/lib/composer/image-atoms";
import { submitHostHeldImageHashes } from "@/lib/composer/submit-host-held-image-hashes";
import { currentDraftBlobOwnerId } from "@/lib/drafts/draft-blob-transport";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import {
  draftImageInliningNeeded,
  prepareDraftImageInlining,
} from "@/lib/drafts/draft-image-inlining";
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
  /**
   * This chat's own live stream's draft-blob bridge capability, as a GETTER.
   *
   * A getter rather than a boolean for the same reason `useChatComposerSubmit`
   * takes one: the flag is a property of the stream at the moment the message
   * is dispatched, and the resend's dispatch can be several renders after this
   * hook was called - the handoff waits for `snapshotLoaded`, for `canAct`, and
   * for its own byte resolution. A boolean captured at mount would answer for
   * the session as it was before any of that.
   */
  readonly getDraftBlobBridgeSupported: () => boolean;
}

export function useInitialChatHandoffDriver(
  options: InitialChatHandoffDriverOptions,
): void {
  const { handle, nodeId, scope, profileUserId, getDraftBlobBridgeSupported } =
    options;
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
  const sendContent = useSeededSendContent(
    handoff,
    nodeId,
    getDraftBlobBridgeSupported,
  );

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
 * The handoff's content in the shape THIS stream takes.
 *
 * The landing composer registers the HASH-ONLY document - that is what keeps
 * base64 out of `localStorage` under this key and what lets the handoff root
 * those bytes against GC - so the wire shape has to be decided somewhere, and
 * the resend is the only place that knows the message is actually going out.
 *
 * TWO SHAPES, and `getDraftBlobBridgeSupported()` plus this host's confirmed
 * blob custody pick between them, through exactly the seam an ordinary send
 * uses ({@link submitHostHeldImageHashes} + {@link draftImageInliningNeeded}).
 * A hash the bridge can carry AND this host is confirmed to hold for THIS
 * account ships bare, and the image never crosses the relay a second time;
 * everything else is resolved back to `b64content`, exactly as before.
 *
 * WHY THE CUSTODY CHECK AND NOT THE FLAG ALONE. The hashes this resend sees are
 * not only the ones the create sent by hash - the handoff records the fully
 * hash-only document on purpose, so it also names images the create INLINED,
 * whose bytes the host was never given. Shipping one of those bare because the
 * stream *could* have carried it is a dangling hash, and the custody set is what
 * separates the two. It is owner-keyed: a `null` owner (no signed-in account in
 * this window) confirms nothing, so every node inlines - which is the correct
 * answer rather than a degenerate one.
 *
 * `null` means "not ready yet, do not send": the inline shape needs an await -
 * a partition read, a `drafts.readBlob`, a cloud fetch. That await settling is
 * what re-renders this hook and lets the transition fire, so the send is delayed
 * rather than dropped.
 *
 * A legacy v3 handoff - already fully inlined, written before any of this - and
 * an image-free prompt both take the FAST PATH below: no hash-only node means
 * nothing to decide, no state, no extra render.
 */
function useSeededSendContent(
  handoff: InitialChatHandoff | null,
  nodeId: string,
  getDraftBlobBridgeSupported: () => boolean,
): JsonContent | null {
  const content = handoff?.content ?? null;
  const key = handoff?.key ?? null;
  // The handoff's OWN host - the machine the chat was created on and is bound
  // to for life - not the window's effective one. Both the custody memo and the
  // host byte leg are per host, and this is the host the resend goes to.
  const hostId = handoff?.hostId ?? null;
  // Structural, so memoizing is safe: it asks about the recorded document's
  // shape, never about custody. The live questions are all inside the effect.
  const nothingToDecide = useMemo(
    () => content === null || hashOnlyImageHashes(content).length === 0,
    [content],
  );
  const [resolved, setResolved] = useState<{
    readonly key: string;
    readonly content: JsonContent;
  } | null>(null);
  useEffect(() => {
    if (content === null || key === null || nothingToDecide) return;
    // Recomputed, never captured - the same contract the submit path states.
    // A `drafts.putBlob` confirmed while this resolution runs should let its
    // node travel bare; a confirmation invalidated in that window must not.
    const readHeld = (): ReadonlySet<string> =>
      submitHostHeldImageHashes({
        surfaceKey: nodeId,
        incarnation: null,
        content,
        hostId,
        bridgeSupported: getDraftBlobBridgeSupported(),
        ownerUserId: currentDraftBlobOwnerId(),
      });
    const needed = draftImageInliningNeeded(content, readHeld());
    if (needed.length === 0) {
      // Every hash-only node is in the host's custody: the recorded document IS
      // the wire shape, and no byte ever leaves this window.
      setResolved({ key, content });
      return;
    }
    let cancelled = false;
    void prepareDraftImageInlining({
      initialHashes: needed,
      target: draftImageByteTargetForHost(hostId),
      // The handoff's content is FROZEN - no editor owns it, nothing appends to
      // it while the reads run - so this re-read is constant and the reconcile
      // loop settles in one pass. The shared function is still the right one:
      // its other half, the synchronous `commit` contract, is what keeps this
      // rewrite in the same step as the final custody read.
      readRequiredHashes: () => draftImageInliningNeeded(content, readHeld()),
      commit: (base64ByHash) => {
        if (cancelled) return;
        setResolved({
          key,
          content: inlineHashOnlyImageBytes(content, base64ByHash),
        });
      },
    }).catch(() => {
      // No byte source could be reached at all. Send what we have rather than
      // stalling the handoff forever: a hash the host cannot resolve comes back
      // as the existing dangling-hash rejection, which surfaces as a failed send
      // and restores the prompt to the composer - a visible failure the user can
      // act on, and the honest outcome when the bytes are genuinely unreachable.
      if (cancelled) return;
      setResolved({ key, content });
    });
    return () => {
      cancelled = true;
    };
  }, [
    content,
    getDraftBlobBridgeSupported,
    hostId,
    key,
    nodeId,
    nothingToDecide,
  ]);
  if (nothingToDecide) return content;
  // Key-matched so a handoff replaced while its reads were in flight (a second
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
   * The handoff's content in the shape this stream takes - see
   * {@link useSeededSendContent}. `null` while its bytes are still being
   * resolved, which HOLDS the send rather than shipping a document the host
   * cannot resolve.
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
      // Its images are still being resolved. Holding is the whole point of the
      // `null`: the transition fires again when that settles.
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
