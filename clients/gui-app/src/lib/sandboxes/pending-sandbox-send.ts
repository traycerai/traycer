import {
  appendPromptQualification,
  buildUnrecordedPromptHandoff,
} from "@/lib/drafts/unrecorded-prompt-handoff";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import { resolveDraftImageBytes } from "@/lib/drafts/resolve-draft-image-bytes";
import {
  deadSendAccountClauses,
  worktreeSweepFor,
} from "@/stores/chats/chat-queue-reconciler";
import {
  partitionSweptIntent,
  stagedWorktreeIntentDiffersFrom,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { recordCancelledSandboxSend } from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";
import {
  useComposerDraftStore,
  type DraftState,
} from "@/stores/composer/composer-draft-store";
import { contentIsSubmittable } from "@/lib/composer/composer-content";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { OpencodeLine } from "@traycer/protocol/common/opencode-line";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  GuiHarnessId,
  GuiHarnessOption,
} from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  newChatOpencodeLineFromProviders,
  providerPackPreparingForSandboxAgent,
  providerPackPreparingLabel,
} from "@/components/providers/provider-pack-readiness";
import {
  guiHarnessIdToProviderId,
  providerDisplayName,
} from "@/lib/provider-ordering";
import {
  readStagedSandbox,
  stagedCreateNeedsFreshKey,
  useStagedSandboxStore,
  type StagedSandbox,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import {
  newConversationSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import {
  pendingSendSurfaceKey,
  pendingSandboxSendFacts,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
  type PendingSandboxSendRequest,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  isNewConversationDraftOccupied,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import type { ReturnedSandbox } from "@/lib/sandboxes/returned-sandbox";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { isOpencodeFamilyHarness } from "@/lib/chat/opencode-line";
import type { ComposerToolbarState } from "@/stores/composer/composer-toolbar-store";
import {
  reservePendingSandboxSendOwnership,
  ownsPendingSandboxSend,
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
  | { readonly kind: "ready"; readonly opencodeLine: OpencodeLine | null }
  /** Sandbox hosts do not offer this agent. */
  | { readonly kind: "not-offered" }
  /** The sandbox's own Traycer Inference switch is off, so no agent runs there. */
  | { readonly kind: "traycer-off" }
  /** Offered, but the sandbox cannot run it. */
  | { readonly kind: "unusable" }
  /** Its install there failed; `detail` is the host's sentence for it. */
  | { readonly kind: "setup-failed"; readonly detail: string };

type HarnessRow = Pick<
  GuiHarnessOption,
  "id" | "enabled" | "available" | "availabilityPending"
>;

/** A settled catalog refusal stays actionable when no install is in flight. */
function catalogRefusesWithoutSetup(
  harness: HarnessRow,
  provider: ProviderCliState | undefined,
  opencodeFamily: boolean,
): boolean {
  if (harness.available || harness.availabilityPending) return false;
  if (provider === undefined) return true;
  return (
    !opencodeFamily &&
    !provider.availabilityPending &&
    (provider.managedInstallState === null ||
      provider.managedInstallState === undefined)
  );
}

/**
 * Whether a host's own providers list has Traycer Inference switched off.
 * The switch is that computer's own: a sandbox seeds it on, and turning it
 * off there leaves nothing a sandbox runs. `false` while the list is unread.
 */
export function traycerInferenceOff(
  providers: ReadonlyArray<ProviderCliState> | undefined,
): boolean {
  return (
    providers?.find((row) => row.providerId === "traycer")?.enabled === false
  );
}

/**
 * The requested agent's readiness on the sandbox, from the sandbox host's own
 * harness catalog and provider list (sandboxes redesign Flow 1: the message
 * is delivered when the setup the requested agent needs is ready, not merely
 * when the control plane says awake). A install in flight or an availability
 * still being probed is a wait; Traycer Inference switched off there, a failed
 * install and an agent that cannot run there are refusals, the switch first.
 * Never another agent: the model the person picked is the one the message
 * runs on. Bound chats pass their recorded line; a new chat gets the
 * destination's resolved line back with its ready result and carries that
 * same line in the create.
 */
export function requestedAgentReadiness(
  harnessId: GuiHarnessId,
  harnesses: ReadonlyArray<HarnessRow> | undefined,
  providers: ReadonlyArray<ProviderCliState> | undefined,
  boundOpencodeLine: OpencodeLine | null,
): RequestedAgentReadiness {
  if (harnesses === undefined || providers === undefined) {
    return { kind: "waiting" };
  }
  if (traycerInferenceOff(providers)) return { kind: "traycer-off" };
  const harness = harnesses.find((row) => row.id === harnessId);
  if (harness === undefined) return { kind: "not-offered" };
  if (!harness.enabled) return { kind: "unusable" };
  const family = isOpencodeFamilyHarness(harnessId);
  const opencodeLine = family
    ? (boundOpencodeLine ?? newChatOpencodeLineFromProviders(providers))
    : null;
  const providerId = family ? "opencode" : guiHarnessIdToProviderId(harnessId);
  const provider = providers.find((row) => row.providerId === providerId);
  if (catalogRefusesWithoutSetup(harness, provider, family))
    return { kind: "unusable" };
  const preparing = providerPackPreparingForSandboxAgent(
    harnessId,
    providers,
    opencodeLine,
  );
  if (preparing !== null) {
    if (preparing.kind === "downloading") return { kind: "waiting" };
    const labelProviderId = guiHarnessIdToProviderId(harnessId);
    return {
      kind: "setup-failed",
      detail: providerPackPreparingLabel(
        preparing,
        labelProviderId === null
          ? harnessId
          : providerDisplayName(labelProviderId),
      ),
    };
  }
  if (harness.availabilityPending) return { kind: "waiting" };
  if (harness.available) return { kind: "ready", opencodeLine };
  return { kind: "unusable" };
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

/** The durable pending record retains a rejected bound send until its line returns it. */
export function pendingSandboxMessageOwnsAction(
  clientActionId: string,
): boolean {
  return Object.values(usePendingSandboxSendStore.getState().sends).some(
    (send) =>
      send.request.kind === "message" &&
      send.delivery === null &&
      send.dispatch?.input.initialMessage?.clientActionId === clientActionId,
  );
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
    returnPendingSandboxSendOnItsSandbox(id);
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
  /** The bound chat's composer holds it; the revision fences its receipt. */
  | {
      readonly kind: "chat";
      readonly chatId: string;
      readonly revision: number;
    }
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
  return returnPendingMessage(id, false, null);
}

/**
 * The sandbox a new agent's message stays on once it is back in its task's
 * composer, as that composer's own pick would have it.
 */
export type ReturnedSandboxPick =
  /**
   * Resting, or not created yet: recorded to stage, so the composer's Send
   * wakes or creates it. `clientRequestId` is a create the server may have accepted,
   * kept so that Send names it again rather than billing a second sandbox.
   */
  | {
      readonly kind: "stage";
      readonly target: StagedSandboxTarget;
      readonly clientRequestId: string | null;
    }
  /**
   * Awake: recorded, and the task composer's host. `target` names the
   * sandbox; the composer showing the draft decides whether to stage it.
   */
  | {
      readonly kind: "host";
      readonly target: Extract<StagedSandboxTarget, { kind: "existing" }>;
    };

/**
 * `returnPendingSandboxSend`, keeping the message on the sandbox it was sent
 * to: the draft that takes it, its task's or its own, records the sandbox
 * (`pick`) and its create key, and the composer showing that draft stages
 * it, so its Send goes there again, never to the composer's default host.
 * A composer that already holds another sandbox the person staged, or
 * another message, keeps it: the message is put in its own draft instead.
 */
export function returnPendingSandboxSendToSandbox(
  id: string,
  pick: ReturnedSandboxPick,
): ReturnedPendingSandboxSend {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return { kind: "none" };
  const returned = returnPendingMessage(
    id,
    anotherSandboxStaged(sends[id].epicId, pick),
    {
      target: pick.target,
      clientRequestId: pick.kind === "stage" ? pick.clientRequestId : null,
    },
  );
  // The task draft holds the destination; its composer stages it when shown
  // (`useReturnedSandboxStage`). An awake sandbox is also the composer's
  // host, as every create there records.
  if (returned.kind === "task" && pick.kind === "host")
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(
        newConversationSurfaceKey(returned.epicId),
        pick.target.hostId,
      );
  return returned;
}

/**
 * Whether the task's new-agent composer holds a stage the person picked
 * there that is not this send's own sandbox. Only a stage counts: the
 * composer's host pin is also recorded by every ordinary create, so it says
 * where the last agent went, not what the person chose for the next one. A
 * sandbox not yet created is this send's own only by its create key: the
 * person can pick one with the same name and shape, and that is a new one.
 */
function anotherSandboxStaged(
  epicId: string,
  pick: ReturnedSandboxPick,
): boolean {
  const stage = readStagedSandbox(newConversationSurfaceKey(epicId));
  if (stage === null) return false;
  const { target } = stage;
  if (pick.kind === "host")
    return target.kind !== "existing" || target.hostId !== pick.target.hostId;
  if (pick.target.kind === "existing")
    return (
      target.kind !== "existing" || target.sandboxId !== pick.target.sandboxId
    );
  return (
    pick.clientRequestId === null ||
    stage.clientRequestId !== pick.clientRequestId
  );
}

/** A background Stop leaves an explicit saved draft for its receipt to open. */
export function returnPendingSandboxSendToDraft(
  id: string,
): ReturnedPendingSandboxSend {
  return returnPendingMessage(id, true, null);
}

/**
 * A send withdrawn on its own (its window gone before its task was
 * confirmed, or its task deleted) keeps the sandbox its stage names, and
 * the create's key while that create may have been accepted. With no stage
 * there is nothing to keep.
 */
export function returnPendingSandboxSendOnItsSandbox(
  id: string,
): ReturnedPendingSandboxSend {
  if (!Object.hasOwn(usePendingSandboxSendStore.getState().sends, id))
    return { kind: "none" };
  const stage = readStagedSandbox(pendingSendSurfaceKey(id));
  if (stage === null) return returnPendingSandboxSend(id);
  return returnPendingSandboxSendToSandbox(id, {
    kind: "stage",
    ...stagedSandboxDestination(stage),
  });
}

/**
 * The sandbox a send's stage names, as a draft keeps it: not created yet,
 * the stage itself with the create's key whenever Cancel would keep it (an
 * existing sandbox needs no key); created, that sandbox, to wake (the wake
 * reads the sandbox's own state). A created stage is always named: its
 * create names a blank one first.
 */
export function stagedSandboxDestination(
  stage: StagedSandbox,
): ReturnedSandbox {
  const { createdSandboxId, createdHostId, target } = stage;
  if (createdSandboxId === null || createdHostId === null)
    return {
      target,
      clientRequestId:
        target.kind === "existing" || stagedCreateNeedsFreshKey(stage)
          ? null
          : stage.clientRequestId,
    };
  return {
    target: {
      kind: "existing",
      hostId: createdHostId,
      sandboxId: createdSandboxId,
      name: target.name,
      configuration: target.configuration,
      verb: "resume",
    },
    clientRequestId: null,
  };
}

/** `destination`: the sandbox any draft this message lands in keeps. */
function returnPendingMessage(
  id: string,
  saveInDrafts: boolean,
  destination: ReturnedSandbox | null,
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
  let returned: ReturnedPendingSandboxSend = { kind: "none" };
  if (request.kind === "chat") {
    returned = restorePendingMessage(send, request, saveInDrafts, destination);
  } else if (request.kind === "message") {
    void returnBoundMessageOnce(
      id,
      saveInDrafts,
      destination ?? liveSendDestination(send),
    ).catch(() => undefined);
    return { kind: "dispatching" };
  }
  endPendingSandboxSend(id);
  return returned;
}

const messageReturnsInFlight = new Map<
  string,
  Promise<ReturnedPendingSandboxSend>
>();

/**
 * Gives a message to an existing chat back. `keepsSandbox`: a draft it
 * lands in, when the chat's composer can't take it, keeps the sandbox the
 * send was on; never after a Stop, nor once the sandbox is gone.
 */
export function returnPendingSandboxMessage(
  id: string,
  saveInDrafts: boolean,
  keepsSandbox: boolean,
): Promise<ReturnedPendingSandboxSend> {
  const { sends } = usePendingSandboxSendStore.getState();
  const destination =
    keepsSandbox && Object.hasOwn(sends, id)
      ? liveSendDestination(sends[id])
      : null;
  return returnBoundMessageOnce(id, saveInDrafts, destination);
}

/**
 * The sandbox a live send is on, as a draft keeps it. None after a Stop, or
 * once the send ended: its sandbox gone, or its task.
 */
function liveSendDestination(send: PendingSandboxSend): ReturnedSandbox | null {
  if (send.stopRequested === true || send.ended === true) return null;
  const stage = readStagedSandbox(pendingSendSurfaceKey(send.id));
  return stage === null ? null : stagedSandboxDestination(stage);
}

/** One async hand-back owns the source until the replacement and its reads settle. */
function returnBoundMessageOnce(
  id: string,
  saveInDrafts: boolean,
  destination: ReturnedSandbox | null,
): Promise<ReturnedPendingSandboxSend> {
  const existing = messageReturnsInFlight.get(id);
  if (existing !== undefined) return existing;
  const ownership = holdPendingSandboxSendOwnership(id);
  const returning = ownsPendingSandboxSend(id)
    ? returnBoundMessage(id, saveInDrafts, destination)
    : ownership.ready.then(
        (
          granted,
        ): Promise<ReturnedPendingSandboxSend> | ReturnedPendingSandboxSend =>
          granted
            ? returnBoundMessage(id, saveInDrafts, destination)
            : { kind: "dispatching" },
      );
  messageReturnsInFlight.set(id, returning);
  void returning
    .finally(() => {
      if (messageReturnsInFlight.get(id) === returning)
        messageReturnsInFlight.delete(id);
      ownership.release();
    })
    .catch(() => undefined);
  return returning;
}

function boundMessageHostId(send: PendingSandboxSend): string | null {
  if (send.request.kind !== "message") return null;
  const stage =
    readStagedSandbox(pendingSendSurfaceKey(send.id)) ?? send.stopStage;
  return (
    send.request.hostId ??
    send.dispatch?.input.hostId ??
    stage?.createdHostId ??
    (stage?.target.kind === "existing" ? stage.target.hostId : null)
  );
}

function boundReturnCurrent(send: PendingSandboxSend): boolean {
  const facts = pendingSandboxSendFacts(send.id, UNKNOWN_PENDING_SEND_FACTS);
  return facts.current && facts.accountActive && facts.owns;
}

function boundMessageReturnReason(
  send: PendingSandboxSend,
  request: Extract<PendingSandboxSendRequest, { readonly kind: "message" }>,
): string {
  const intent = request.worktreeIntent ?? null;
  const key: WorktreeStagingKey = {
    surface: "owner",
    hostId: boundMessageHostId(send),
    epicId: send.epicId,
    ownerKind: "chat",
    ownerId: request.chatId,
  };
  const worktree =
    send.ended === true
      ? { survivors: null, swept: intent, superseded: false }
      : worktreeSweepFor(
          intent,
          (value) => partitionSweptIntent(key, value),
          intent !== null && stagedWorktreeIntentDiffersFrom(key, intent),
        );
  return (
    "Your message wasn't sent." +
    deadSendAccountClauses(
      {
        worktree: { ...worktree, nameWorkspaces: true },
        sentSettings: send.settings,
        currentSettings: null,
        sentAccountContext: null,
        currentAccountContext: null,
        sentDeliveryPolicy: request.deliveryPolicy ?? null,
      },
      false,
    )
  );
}

/** A saved draft remains accessible when the chat or its composer cannot take it. */
function boundMessageNeedsSavedDraft(
  send: PendingSandboxSend,
  chatId: string,
  saveInDrafts: boolean,
): boolean {
  const current = useComposerDraftStore.getState().drafts[chatId];
  return (
    send.ended === true ||
    send.returnRequested?.saveInDrafts === true ||
    saveInDrafts ||
    (current !== undefined &&
      (contentIsSubmittable(current.content) ||
        current.browserAnnotations.length > 0)) ||
    useLandingDraftStore
      .getState()
      .drafts.some(
        (draft) => draft.id === pendingSandboxRecoveryDraftId(send.id),
      )
  );
}

async function returnBoundMessage(
  id: string,
  saveInDrafts: boolean,
  destination: ReturnedSandbox | null,
): Promise<ReturnedPendingSandboxSend> {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return { kind: "none" };
  const send = sends[id];
  const request = send.request;
  if (request.kind !== "message") return { kind: "none" };
  const drafts = useComposerDraftStore.getState();
  const toDraft = boundMessageNeedsSavedDraft(
    send,
    request.chatId,
    saveInDrafts,
  );
  if (!usePendingSandboxSendStore.getState().beginReturn(id, toDraft))
    return { kind: "dispatching" };
  const reason = boundMessageReturnReason(send, request);
  let returned: ReturnedPendingSandboxSend;
  if (toDraft) {
    const recoveryId = pendingSandboxRecoveryDraftId(id);
    const target = draftImageByteTargetForHost(boundMessageHostId(send));
    const outcome = await buildUnrecordedPromptHandoff({
      recovery: { draftId: recoveryId, settings: send.settings },
      content: send.content,
      browserAnnotations: request.browserAnnotations ?? [],
      reason,
      readHashImage: (hash) => resolveDraftImageBytes(hash, target),
      stillCurrent: () => boundReturnCurrent(send),
    });
    await outcome.readsSettled;
    if (outcome.draftId === null || !boundReturnCurrent(send))
      return { kind: "none" };
    // Stamped before the pending copy ends: the draft is where it goes now.
    if (destination !== null)
      useLandingDraftStore
        .getState()
        .setDraftReturnedSandbox(outcome.draftId, destination);
    returned = { kind: "landing-draft", draftId: outcome.draftId };
  } else {
    const qualified =
      reason === "Your message wasn't sent."
        ? send.content
        : appendPromptQualification(send.content, `Unsent — ${reason}`);
    drafts.replaceDraft(request.chatId, qualified, null);
    drafts.restoreBrowserAnnotations(
      request.chatId,
      request.browserAnnotations ?? [],
    );
    const restoredDrafts: Readonly<Partial<Record<string, DraftState>>> =
      useComposerDraftStore.getState().drafts;
    const restored = restoredDrafts[request.chatId];
    if (restored === undefined) return { kind: "none" };
    returned = {
      kind: "chat",
      chatId: request.chatId,
      revision: restored.revision,
    };
  }
  endPendingSandboxSend(id);
  if (Object.hasOwn(usePendingSandboxSendStore.getState().sends, id))
    return { kind: "none" };
  recordCancelledSandboxSend(send, returned);
  return returned;
}

/** The saved recovery draft remains addressable after its pending record is removed. */
export function pendingSandboxRecoveryDraftId(id: string): string {
  return uuidv5(`pending-sandbox-send:${id}:recovered`, uuidv5.URL);
}

/** A stable closed draft makes background give-back repeatable across fallback windows. */
function restoreSavedPendingMessage(
  send: PendingSandboxSend,
  destination: ReturnedSandbox | null,
): ReturnedPendingSandboxSend {
  const draftId = pendingSandboxRecoveryDraftId(send.id);
  installReturnedLandingDraft(draftId, send, destination);
  return { kind: "landing-draft", draftId };
}

/** A closed start-task draft holding the message, on its sandbox when it has one. */
function installReturnedLandingDraft(
  draftId: string,
  send: PendingSandboxSend,
  destination: ReturnedSandbox | null,
): void {
  const drafts = useLandingDraftStore.getState();
  drafts.installLandingDraft({
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
  if (destination !== null)
    drafts.setDraftReturnedSandbox(draftId, destination);
}

/** Preserves an occupied task draft by putting this message in its own closed draft. */
function restorePendingMessage(
  send: PendingSandboxSend,
  request: Extract<PendingSandboxSendRequest, { kind: "chat" }>,
  saveInDrafts: boolean,
  destination: ReturnedSandbox | null,
): ReturnedPendingSandboxSend {
  if (send.ended === true || saveInDrafts)
    return restoreSavedPendingMessage(send, destination);
  // Write the replacement before removing the image roots in the pending record.
  let returned: ReturnedPendingSandboxSend;
  const modal = useNewConversationModalStore.getState();
  const draft = modal.draftPatchesByEpicId[send.epicId];
  const occupied = isNewConversationDraftOccupied(draft);
  if (send.epicConfirmed && !occupied) {
    modal.setContent(send.epicId, send.content);
    modal.setSettings(send.epicId, send.settings);
    modal.clearSelection(send.epicId);
    modal.setReturnedSandbox(send.epicId, destination);
    returned = {
      kind: "task",
      epicId: send.epicId,
      parentId: request.parentId,
      placement: request.placement,
    };
  } else {
    // A fresh draft every time: never another draft's text written over.
    const draftId = mintDraftId();
    installReturnedLandingDraft(draftId, send, destination);
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
