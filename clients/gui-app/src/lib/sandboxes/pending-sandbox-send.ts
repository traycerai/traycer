import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  GuiHarnessId,
  GuiHarnessOption,
} from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  providerPackBlocksExecution,
  providerPackPreparingByHarnessId,
  providerPackPreparingLabel,
} from "@/components/providers/provider-pack-readiness";
import {
  guiHarnessIdToProviderId,
  providerDisplayName,
} from "@/lib/provider-ordering";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import {
  pendingSendSurfaceKey,
  pendingSandboxSendFacts,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
  type PendingSandboxSendRequest,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import type { ComposerToolbarState } from "@/stores/composer/composer-toolbar-store";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import {
  reservePendingSandboxSendOwnership,
  holdPendingSandboxSendOwnership,
  markPendingSandboxSendHanded,
  forgetPendingSandboxSendHanded,
} from "@/lib/sandboxes/pending-sandbox-send-ownership";
export { pendingSandboxSendHandedHere } from "@/lib/sandboxes/pending-sandbox-send-ownership";
import {
  pendingSendState,
  transitionPendingSend,
  UNKNOWN_PENDING_SEND_FACTS,
  type PendingSendTransition,
} from "@/lib/sandboxes/pending-sandbox-send-transition";

/** Whether the agent the person asked for can take the message on the sandbox. */
export type RequestedAgentReadiness =
  /** Its availability is still being probed, or its install is in flight. */
  | { readonly kind: "waiting" }
  | { readonly kind: "ready" }
  /** It cannot run there: no sign-in on the configuration, or not offered. */
  | { readonly kind: "unusable" }
  /** Its install there failed; `detail` is the host's sentence for it. */
  | { readonly kind: "setup-failed"; readonly detail: string };

type HarnessRow = Pick<
  GuiHarnessOption,
  "id" | "enabled" | "available" | "availabilityPending"
>;

/**
 * The requested agent's readiness on the sandbox, from the sandbox host's own
 * harness catalog and provider list (sandboxes redesign Flow 1: the message
 * is delivered when the setup the requested agent needs is ready, not merely
 * when the control plane says awake). A install in flight or an availability
 * still being probed is a wait; a failed install and an agent that cannot run
 * there are refusals. Never another agent: the model the person picked is the
 * one the message runs on.
 */
export function requestedAgentReadiness(
  harnessId: GuiHarnessId,
  harnesses: ReadonlyArray<HarnessRow> | undefined,
  providers: ReadonlyArray<ProviderCliState> | undefined,
): RequestedAgentReadiness {
  if (harnesses === undefined || providers === undefined) {
    return { kind: "waiting" };
  }
  const preparing = providerPackPreparingByHarnessId(providers, null).get(
    harnessId,
  );
  if (preparing !== undefined && providerPackBlocksExecution(preparing)) {
    if (preparing.kind === "downloading") return { kind: "waiting" };
    const providerId = guiHarnessIdToProviderId(harnessId);
    return {
      kind: "setup-failed",
      detail: providerPackPreparingLabel(
        preparing,
        providerId === null ? harnessId : providerDisplayName(providerId),
      ),
    };
  }
  const harness = harnesses.find((row) => row.id === harnessId);
  if (harness === undefined || !harness.enabled) return { kind: "unusable" };
  if (harness.available) return { kind: "ready" };
  return harness.availabilityPending
    ? { kind: "waiting" }
    : { kind: "unusable" };
}

/** What a surface's send hands to its task. */
export interface PendingSandboxSendInput {
  /** The surface whose stage the send takes. */
  readonly fromSurfaceKey: string;
  readonly epicId: string;
  readonly request: PendingSandboxSendRequest;
  readonly content: JsonContent;
  readonly text: string;
  /** The person's pick, captured as it stands: never re-resolved on the sandbox. */
  readonly settings: ChatRunSettings;
  /** Whether the task already exists (`PendingSandboxSend.epicConfirmed`). */
  readonly epicConfirmed: boolean;
  readonly now: number;
}

/**
 * Hands a surface's staged send to its task: the stage moves, its create key
 * with it, under a pending send's key, and the message and its settings are
 * recorded beside it. The surface stages nothing after; the pending send's
 * driver runs the create, joining one already on its way under that key.
 * Returns the send's id, or `null` when the surface has no stage or its stage
 * is already in its handoff.
 */
export function handPendingSandboxSend(
  input: PendingSandboxSendInput,
): string | null {
  const stage = readStagedSandbox(input.fromSurfaceKey);
  if (stage === null || stage.phase === "handoff") return null;
  const id = uuidv4();
  const surfaceKey = pendingSendSurfaceKey(id);
  reservePendingSandboxSendOwnership(id);
  markPendingSandboxSendHanded(id);
  const store = useStagedSandboxStore.getState();
  store.adopt(input.fromSurfaceKey, surfaceKey);
  // Publish the stage first: a different window must never see a send with
  // its stage missing, nor mint a different sandbox create key for it.
  store.report(surfaceKey, {
    clientRequestId: stage.clientRequestId ?? id,
    ownerId: null,
    sendTaken: true,
    terminalLaunch: null,
    openTerminal: input.request.kind === "terminal",
  });
  usePendingSandboxSendStore.getState().add({
    id,
    userId: useAuthStore.getState().profile?.userId ?? null,
    epicId: input.epicId,
    request: input.request,
    content: input.content,
    text: input.text,
    settings: input.settings,
    createdAt: input.now,
    epicConfirmed: input.epicConfirmed,
    delivery: null,
    dispatch: null,
  });
  return id;
}

/** Confirms the task only while owning its send, so withdrawal cannot race it. */
export function confirmPendingSandboxSendEpic(id: string): void {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return;
  const ownership = holdPendingSandboxSendOwnership(id);
  void ownership.ready
    .then((granted) => {
      if (granted) {
        usePendingSandboxSendStore.getState().confirmEpic(id);
      }
    })
    .finally(() => ownership.release());
}

/** Authoritative task loss releases the pending copy even if its host might still run it. */
export function recoverPendingSandboxSendsAfterTaskLoss(
  epicIds: readonly string[],
  userId: string | null,
): void {
  if (
    userId === null ||
    (useAuthStore.getState().profile?.userId ?? null) !== userId
  )
    return;
  const lost = new Set(epicIds);
  const affected = Object.values(
    usePendingSandboxSendStore.getState().sends,
  ).filter(
    (send) =>
      send.userId === userId && lost.has(send.epicId) && send.delivery === null,
  );
  for (const send of affected) {
    const ownership = holdPendingSandboxSendOwnership(send.id);
    void ownership.ready
      .then((granted) => {
        if (!granted) return;
        return recoverTaskLostSend(send.id);
      })
      .catch(() => {
        // A failed replacement-draft write retains the durable pending copy for recovery.
      })
      .finally(() => ownership.release());
  }
}

/** Re-read a newer durable claim before recovering; never overwrite a changing record. */
async function recoverTaskLostSend(id: string): Promise<void> {
  let recovery = taskLossRecovery(id);
  if (recovery?.plan.effects.includes("rehydrate")) {
    await usePendingSandboxSendStore.persist.rehydrate();
    recovery = taskLossRecovery(id);
  }
  if (recovery === null) return;
  const { send, plan } = recovery;
  if (
    plan.effects.includes("end-host") &&
    !usePendingSandboxSendStore
      .getState()
      .endDispatch(
        id,
        send.dispatch ?? null,
        "task-deleted",
        UNKNOWN_PENDING_SEND_FACTS,
      )
  )
    return;
  if (plan.effects.includes("end-host") || plan.effects.includes("remove"))
    returnPendingSandboxSend(id);
}

/** Captures a record with its authority before executing any recovery effects. */
function taskLossRecovery(id: string): {
  readonly send: PendingSandboxSend;
  readonly plan: PendingSendTransition;
} | null {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return null;
  const send = sends[id];
  const plan = transitionPendingSend(
    pendingSendState(send, "none"),
    "task-deleted",
    pendingSandboxSendFacts(id, UNKNOWN_PENDING_SEND_FACTS),
  );
  return { send, plan };
}

/**
 * Withdrawal is safe only before dispatch. Once its task exists, this window
 * must hold the exclusive lock; a no-lock fallback can deliver using stable
 * IDs, but cannot serialize cancellation against another window's dispatch.
 */
export function canWithdrawPendingSandboxSend(id: string): boolean {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return false;
  return transitionPendingSend(
    pendingSendState(sends[id], "none"),
    "return",
    pendingSandboxSendFacts(id, UNKNOWN_PENDING_SEND_FACTS),
  ).effects.includes("remove");
}

/** Ends an undispatched send; a host request already sent remains accountable. */
export function endPendingSandboxSend(id: string): void {
  if (!canWithdrawPendingSandboxSend(id)) return;
  removePendingSandboxSend(id);
}

/** A terminal opened with its stable identity completes even without Web Locks. */
export function completePendingSandboxTerminal(id: string): void {
  usePendingSandboxSendStore.getState().completeTerminal(id);
  clearEndedPendingStage(id);
}

function removePendingSandboxSend(id: string): void {
  usePendingSandboxSendStore.getState().remove(id);
  clearEndedPendingStage(id);
}

function clearEndedPendingStage(id: string): void {
  if (Object.hasOwn(usePendingSandboxSendStore.getState().sends, id)) return;
  useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(id));
  forgetPendingSandboxSendHanded(id);
}

/** Where an undelivered send's message went back to. */
export type ReturnedPendingSandboxSend =
  /** A request may already be running; its only copy stays with that request. */
  | { readonly kind: "dispatching" }
  /** Nothing to give back: a terminal ask, a fork (its chat is still there), or a send already gone. */
  | { readonly kind: "none" }
  /** A put-away start-task draft holds it, preserving any occupied task draft. */
  | { readonly kind: "landing-draft"; readonly draftId: string }
  /** Its task's new-agent composer holds it now, for the pane it named. */
  | {
      readonly kind: "task";
      readonly epicId: string;
      readonly parentId: string | null;
      readonly placement: ExplicitTilePlacement | null;
    };

/**
 * Ends an undispatched send and gives its whole message back, as
 * the person wrote it: once handed, the send is the message's only copy, so
 * no exit drops it. Its text, mentions and images, and the agent, model and
 * mode it was sent with, go back to the task's empty new-agent composer when
 * available, and to a fresh start-task draft otherwise: put away,
 * at the top of the Drafts list, so a give-back on a reload or a sign-in
 * never takes over the composer; a caller with the person's attention opens
 * it. A dispatched or uncertain request stays with its original identity and
 * cannot be returned as a second copy.
 */
export function returnPendingSandboxSend(
  id: string,
): ReturnedPendingSandboxSend {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return { kind: "none" };
  const send = sends[id];
  const plan = transitionPendingSend(
    pendingSendState(send, "none"),
    "return",
    pendingSandboxSendFacts(id, UNKNOWN_PENDING_SEND_FACTS),
  );
  if (plan.effects.includes("rehydrate"))
    void usePendingSandboxSendStore.persist.rehydrate();
  if (plan.outcome === "denied-claim") return { kind: "dispatching" };
  if (!plan.effects.includes("remove")) return { kind: "none" };
  const { request } = send;
  const returned =
    request.kind === "chat"
      ? restorePendingMessage(send, request)
      : { kind: "none" as const };
  endPendingSandboxSend(id);
  return returned;
}

/** A stable closed draft makes terminal recovery repeatable across fallback windows. */
function restoreEndedSandboxMessage(
  send: PendingSandboxSend,
): ReturnedPendingSandboxSend {
  const draftId = uuidv5(
    `pending-sandbox-send:${send.id}:recovered`,
    uuidv5.URL,
  );
  useLandingDraftStore.getState().installLandingDraft({
    id: draftId,
    content: send.content,
    selection: null,
    lastTouchedAt: Date.now(),
    settings: send.settings,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    closed: true,
  });
  return { kind: "landing-draft", draftId };
}

/** Preserves an occupied task draft by putting this message in its own closed draft. */
function restorePendingMessage(
  send: PendingSandboxSend,
  request: Extract<PendingSandboxSendRequest, { kind: "chat" }>,
): ReturnedPendingSandboxSend {
  if (send.ended === true) return restoreEndedSandboxMessage(send);
  // Write the replacement before removing the image roots in the pending record.
  let returned: ReturnedPendingSandboxSend;
  const modal = useNewConversationModalStore.getState();
  const draft = modal.draftPatchesByEpicId[send.epicId];
  // Settings, workspace and selection can be a draft even before its first
  // character. Never replace a person's intervening choice on a give-back.
  const occupied =
    draft !== undefined &&
    ((draft.content !== null && !isEmptyLandingDraftContent(draft.content)) ||
      draft.settings !== null ||
      draft.workspace !== null ||
      draft.composerMode !== null ||
      draft.selection !== null);
  if (send.epicConfirmed && !occupied) {
    modal.setContent(send.epicId, send.content);
    modal.setSettings(send.epicId, send.settings);
    modal.clearSelection(send.epicId);
    returned = {
      kind: "task",
      epicId: send.epicId,
      parentId: request.parentId,
      placement: request.placement,
    };
  } else {
    // A fresh draft every time: never another draft's text written over.
    const draftId = mintDraftId();
    useLandingDraftStore.getState().installLandingDraft({
      id: draftId,
      content: send.content,
      selection: null,
      lastTouchedAt: Date.now(),
      settings: send.settings,
      composerMode: "chat",
      // The task's sandbox started empty: the message named no folder here.
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      closed: true,
    });
    returned = { kind: "landing-draft", draftId };
  }
  return returned;
}

/**
 * The run settings of the agent the person picked, as the toolbar holds them.
 * The toolbar shows the first runnable agent in place of one this host cannot
 * run (`presentedHarnessSelection`), but a send to a sandbox runs there, not
 * here: it carries the person's own pick, and the sandbox says whether that
 * agent can run.
 */
export function pickedRunSettings(
  toolbar: Pick<
    ComposerToolbarState,
    "values" | "selection" | "permission" | "reasoning" | "serviceTier"
  >,
): ChatRunSettings {
  const picked = toolbar.values.selection;
  const shown = toolbar.selection.harnessId === picked.harnessId;
  return buildChatRunSettings({
    // A pick with no model yet takes the model shown for the same agent.
    selection:
      shown && picked.modelSlug.length === 0 ? toolbar.selection : picked,
    permission: shown ? toolbar.permission : toolbar.values.permission,
    reasoning: shown ? toolbar.reasoning : toolbar.values.reasoning,
    serviceTier: shown ? toolbar.serviceTier : toolbar.values.serviceTier,
  });
}
