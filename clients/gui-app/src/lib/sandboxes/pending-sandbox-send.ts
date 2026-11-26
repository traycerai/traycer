import { appendPromptQualification } from "@/lib/drafts/unrecorded-prompt-handoff";
import { collectAnnotationImageHashes } from "@/lib/browser-view/annotation/browser-annotation-record";
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
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { z } from "zod";
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
  preparePendingSandboxHandoff,
  readStagedSandbox,
  stagedCreateAttemptKey,
  stagedCreateRetryPayload,
  stagedCreateRetryRow,
  stagedRetryKey,
  useStagedSandboxStore,
  type PendingSandboxHandoffReservation,
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
  returnedTaskStageCurrent,
} from "@/stores/epics/new-conversation-modal-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  returnedLandingStageCurrent,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  consumeDraftAuthorityOutboxSource,
  readDraftAuthorityOutbox,
  readDraftAuthorityRestoredIssue,
  type DraftAuthorityOutbox,
  type DraftAuthorityOutboxSubmission,
  type DraftAuthorityPendingEpicPrerequisite,
  type DraftAuthorityReturnDisposition,
  type DraftAuthorityReturnReceipt,
  type DraftAuthorityRestoredPredecessor,
} from "@/lib/drafts/draft-authority-pending";
import { readDraftAuthoritySlot } from "@/lib/drafts/draft-authority";
import { isMobileApp } from "@/lib/mobile-app";
import { readPendingCanvasReturnTarget } from "@/lib/sandboxes/pending-canvas-return-target";
import {
  pendingCanvasReturnAdmissionIsCurrent,
  readPendingCanvasReturnAdmission,
  subscribeToPendingCanvasAdmission,
} from "@/lib/sandboxes/pending-canvas-return-admission";
import {
  captureDraftAuthorityActor,
  draftAuthorityActorIsCurrent,
  subscribeToDraftAuthoritySessionChanges,
} from "@/lib/drafts/draft-authority-session";
import type {
  DraftAuthorityActor,
  DraftAuthorityEditReceipt,
  DraftAuthorityExpectation,
  DraftAuthorityManifest,
  DraftAuthoritySlot,
  DraftAuthorityVerifiedBlob,
  DraftAuthorityVersion,
} from "@/lib/drafts/draft-authority-types";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import { isJsonContent } from "@/lib/editor/prosemirror-json";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import type {
  BrowserSandboxCancelComposer,
  BrowserSandboxCancelInstallation,
  BrowserSandboxCancelPress,
} from "@/lib/sandboxes/browser-sandbox-cancel-composer";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
import { base64ToBytes } from "@/lib/composer/image-base64";
import {
  getImageBytes,
  sessionImageBytes,
  sha256Hex,
} from "@/lib/composer/landing-image-store";
import { captureRestoredDraftAction } from "@/lib/sandboxes/restored-draft-action";
import {
  acknowledgePendingSandboxBrowserCancel,
  beginPendingSandboxBrowserCancel,
  finishPendingSandboxHandoff,
  loadPendingSandboxOutbox,
  publishPendingSandboxOutbox,
  releasePendingSandboxBrowserCancel,
  returnPendingSandboxOutbox,
} from "@/lib/sandboxes/pending-sandbox-authority";
import {
  storeReturnedSandbox,
  type ReturnedSandbox,
} from "@/lib/sandboxes/returned-sandbox";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { isOpencodeFamilyHarness } from "@/lib/chat/opencode-line";
import type { ComposerToolbarState } from "@/stores/composer/composer-toolbar-store";
import {
  holdPendingSandboxSendOwnership,
  markPendingSandboxSendHanded,
  forgetPendingSandboxSendHanded,
  ownsPendingSandboxSend,
  pendingSandboxSendHandedHere,
} from "@/lib/sandboxes/pending-sandbox-send-ownership";
export { pendingSandboxSendHandedHere };
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
 * harness catalog and provider list (the message
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
  readonly submittedContent?: JsonContent;
  readonly epicPrerequisite?: Omit<DraftAuthorityPendingEpicPrerequisite, "createKey">;
  readonly text: string;
  /** The person's pick, captured as it stands: never re-resolved on the sandbox. */
  readonly settings: ChatRunSettings;
  /** Whether the task already exists (`PendingSandboxSend.epicConfirmed`). */
  readonly epicConfirmed: boolean;
  readonly now: number;
  readonly actor?: DraftAuthorityActor;
  readonly source?: DraftAuthorityVersion;
}

export interface PublishedPendingSandboxHandoff {
  readonly id: string;
  readonly epicId: string;
  readonly consumed: DraftAuthorityEditReceipt | null;
}

interface PendingSandboxPublication {
  readonly actor: DraftAuthorityActor;
  readonly source: DraftAuthorityVersion | null;
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly intent: string;
  readonly submittedContent: JsonContent | undefined;
  readonly epicPrerequisite: DraftAuthorityPendingEpicPrerequisite | undefined;
  assets: {
    readonly content: JsonContent;
    readonly submission?: DraftAuthorityOutboxSubmission;
    readonly manifest: DraftAuthorityManifest;
    readonly verified: readonly DraftAuthorityVerifiedBlob[];
  } | null;
  reservation: PendingSandboxHandoffReservation | null;
  restoredPredecessor: DraftAuthorityRestoredPredecessor | null | undefined;
  inFlight: Promise<PublishedPendingSandboxHandoff | null> | null;
}

const handoffsBySurface = new Map<string, PendingSandboxPublication>();
subscribeToDraftAuthoritySessionChanges(() => handoffsBySurface.clear());

/** Send can take up a create that never reserved a row, or whose reply was lost. */
function takesUpRowlessCreate(stage: StagedSandbox): boolean {
  switch (stage.failure?.kind) {
    case "unavailable":
    case "shape":
    case "unverified":
      return stage.createdSandboxId === null && stage.createdHostId === null;
    default:
      return false;
  }
}

function stageCanBeHandedOff(stage: StagedSandbox): boolean {
  const origin = stage.returnedDraft;
  if (origin?.kind === "task") return returnedTaskStageCurrent(origin, stage);
  if (origin?.kind === "landing")
    return returnedLandingStageCurrent(origin, stage);
  return true;
}

/** Stages the exact send before publishing it and consumes only verified custody. */
export async function handPendingSandboxSend(
  input: PendingSandboxSendInput,
): Promise<PublishedPendingSandboxHandoff | null> {
  const actor = input.actor ?? captureDraftAuthorityActor();
  if (actor === null || !draftAuthorityActorIsCurrent(actor)) return null;
  const { fromSurfaceKey, request, epicId, content, text, settings, epicConfirmed } = input;
  const stage = readStagedSandbox(fromSurfaceKey);
  const restoration = stage?.returnedDraft === undefined
    ? null
    : captureRestoredDraftAction(stage);
  const source = input.source ?? restoration?.source.draft ?? null;
  const intent = JSON.stringify({
    actor,
    request,
    epicId: epicConfirmed ? epicId : null,
    content,
    text,
    settings,
    epicConfirmed,
    epicPrerequisite: input.epicPrerequisite,
    source,
  });
  const previous = handoffsBySurface.get(fromSurfaceKey);
  if (previous !== undefined) {
    if (previous.intent !== intent) return null;
    return previous.inFlight ?? publishReservedSandboxHandoff(fromSurfaceKey, previous);
  }
  if (
    stage === null ||
    stage.phase === "handoff" ||
    (stage.returnedDraft !== undefined && (
      restoration === null ||
      source?.version !== restoration.source.draft.version ||
      source.occurrence !== restoration.source.draft.occurrence ||
      source.slot.kind !== restoration.source.draft.slot.kind ||
      source.slot.id !== restoration.source.draft.slot.id ||
      !stageCanBeHandedOff(stage)
    )) ||
    (source === null && (request.kind === "chat" || request.kind === "message"))
  )
    return null;
  const prepared: PendingSandboxPublication = {
    actor,
    source,
    send: {
      id: uuidv4(),
      userId: actor.accountId,
      epicId,
      request,
      content,
      text,
      settings,
      createdAt: input.now,
      epicConfirmed,
      delivery: null,
      dispatch: null,
    },
    stage,
    intent,
    submittedContent: input.submittedContent,
    epicPrerequisite: input.epicPrerequisite === undefined
      ? undefined
      : { ...input.epicPrerequisite, createKey: epicId },
    assets: null,
    reservation: null,
    restoredPredecessor: undefined,
    inFlight: null,
  };
  handoffsBySurface.set(fromSurfaceKey, prepared);
  return publishReservedSandboxHandoff(fromSurfaceKey, prepared);
}

function publishReservedSandboxHandoff(
  fromSurfaceKey: string,
  prepared: PendingSandboxPublication,
): Promise<PublishedPendingSandboxHandoff | null> {
  const publishing = issueReservedSandboxHandoff(fromSurfaceKey, prepared);
  prepared.inFlight = publishing;
  return publishing.finally(() => {
    prepared.inFlight = null;
    if (prepared.reservation === null && handoffsBySurface.get(fromSurfaceKey) === prepared)
      handoffsBySurface.delete(fromSurfaceKey);
  });
}

async function freezeRestoredSendPredecessor(
  prepared: PendingSandboxPublication,
): Promise<boolean> {
  const { actor, send, source, stage } = prepared;
  if (stage.returnedDraft === undefined || source === null ||
      send.request.kind === "terminal" || send.request.kind === "fork") return true;
  if (prepared.restoredPredecessor !== undefined) return true;

  const read = await readDraftAuthorityRestoredIssue({ actor, draft: source });
  if (!draftAuthorityActorIsCurrent(actor)) return false;
  if (read.kind === "missing") {
    prepared.restoredPredecessor = null;
    return true;
  }
  if (read.kind !== "current") return false;
  const { state, receipt, acceptance } = read.issue;
  const { setupAttempt, effect } = receipt;
  const terminal = state === "terminal" && effect.kind === "terminal";
  const setup = state === "accepted" && (effect.kind === "create" || effect.kind === "wake");
  if ((!terminal && !setup) || setupAttempt === undefined ||
      setupAttempt.attemptId !== stage.attemptId) return false;
  const hostId = terminal ? effect.payload.hostId : acceptance?.hostId;
  const sandboxId = terminal ? effect.payload.sandboxId : acceptance?.sandboxId;
  const targetHostId = stage.createdHostId ??
    (stage.target.kind === "existing" ? stage.target.hostId : null);
  const targetSandboxId = stage.createdSandboxId ??
    (stage.target.kind === "existing" ? stage.target.sandboxId : null);
  if (typeof hostId !== "string" || hostId !== targetHostId ||
      typeof sandboxId !== "string" || sandboxId !== targetSandboxId) return false;
  prepared.restoredPredecessor = {
    kind: "authorized-send",
    claim: receipt,
    hostId,
    sandboxId,
    attemptId: setupAttempt.attemptId,
    observationGeneration: setupAttempt.observationGeneration,
    proofId: send.id,
  };
  return true;
}

async function issueReservedSandboxHandoff(
  fromSurfaceKey: string,
  prepared: PendingSandboxPublication,
): Promise<PublishedPendingSandboxHandoff | null> {
  const { actor, source, send, stage } = prepared;
  const assets = prepared.assets ?? await preparePendingHandoffAssets(send, prepared.submittedContent);
  if (assets === null || !draftAuthorityActorIsCurrent(actor)) return null;
  prepared.assets = assets;
  if (!(await freezeRestoredSendPredecessor(prepared))) return null;
  const reservation = prepared.reservation ?? preparePendingSandboxHandoff({
    fromSurfaceKey,
    sendId: send.id,
    expectedSourceStage: stage,
    pendingStage: pendingHandoffStage(stage, send.request),
  });
  if (reservation === null) return null;
  prepared.reservation = reservation;
  const { restoredPredecessor } = prepared;
  const isSuccessorCurrent = (): boolean =>
    draftAuthorityActorIsCurrent(actor) &&
    handoffsBySurface.get(fromSurfaceKey) === prepared &&
    readStagedSandbox(fromSurfaceKey) === reservation.expectedSourceStage &&
    stageCanBeHandedOff(stage);
  const publication = await publishPendingSandboxOutbox({
    actor,
    actionId: send.id,
    expectedSource: source === null ? null : { kind: "current", draft: source },
    send: { ...send, content: assets.content },
    manifest: assets.manifest,
    verified: assets.verified,
    ...(restoredPredecessor == null ? {} : { restoredPredecessor, isSuccessorCurrent }),
    ...(assets.submission === undefined ? {} : { submission: assets.submission }),
    ...(prepared.epicPrerequisite === undefined
      ? {}
      : { epicPrerequisite: prepared.epicPrerequisite }),
    ...(reservation.pendingStage.target.kind === "existing" &&
      reservation.pendingStage.attemptId !== undefined
      ? {
          setupBinding: {
            attemptId: reservation.pendingStage.attemptId,
            hostId: reservation.pendingStage.target.hostId,
            sandboxId: reservation.pendingStage.target.sandboxId,
            observationGeneration: send.observationRequestedAt ?? send.createdAt,
          },
        }
      : {}),
  }).catch(() => "unverified" as const);
  const outcome = await finishPendingSandboxHandoff({
    actor,
    actionId: send.id,
    reservation,
    publication,
  });
  if (outcome === "held") return null;
  prepared.reservation = null;
  if (outcome === "aborted" || !draftAuthorityActorIsCurrent(actor)) return null;
  markPendingSandboxSendHanded(send.id);
  if (source === null || send.request.kind === "terminal")
    return { id: send.id, epicId: send.epicId, consumed: null };
  const consumed = await consumeDraftAuthorityOutboxSource({
    actor,
    sendId: send.id,
    actionId: send.id,
    draft: source,
  });
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  return {
    id: send.id,
    epicId: send.epicId,
    consumed: consumed.kind === "committed" || consumed.kind === "replayed"
      ? consumed.receipt
      : null,
  };
}

async function preparePendingHandoffAssets(
  send: PendingSandboxSend,
  submittedContent: JsonContent | undefined,
): Promise<PendingSandboxPublication["assets"]> {
  const annotations = send.request.kind === "message"
    ? (send.request.browserAnnotations ?? [])
    : [];
  if (annotations.length === 0) {
    return {
      content: send.content,
      manifest: { digests: blobHashesFromContent(send.content) },
      verified: [],
    };
  }
  if (submittedContent === undefined) return null;

  const blobs = new Map<string, Blob>();
  const wire = await hashOnlyPendingDocument(submittedContent, blobs);
  if (wire === null) return null;
  const content = await hashOnlyPendingDocument(send.content, blobs);
  if (content === null) return null;
  const wireDigests = blobHashesFromContent(wire);
  const digests = [...new Set([
    ...wireDigests,
    ...blobHashesFromContent(content),
    ...collectAnnotationImageHashes(annotations),
  ])];
  const verified: DraftAuthorityVerifiedBlob[] = [];
  for (const digest of digests) {
    const blob = blobs.get(digest) ?? await readPendingImageBlob(digest);
    if (blob === null) return null;
    verified.push({ digest, blob });
  }
  return {
    content,
    manifest: { digests },
    submission: { content: wire, manifest: { digests: wireDigests } },
    verified,
  };
}

async function hashOnlyPendingDocument(
  node: JsonContent,
  blobs: Map<string, Blob>,
): Promise<JsonContent | null> {
  if (node.type === "imageAttachment") {
    const attrs = node.attrs;
    if (attrs === undefined || typeof attrs.id !== "string" || attrs.id.length === 0)
      return null;
    const { b64content, hash, ...rest } = attrs;
    if (typeof b64content === "string" && b64content.length > 0) {
      const bytes = base64ToBytes(b64content);
      if (bytes === null) return null;
      const digest = await sha256Hex(bytes);
      if (typeof hash === "string" && hash.length > 0 && hash !== digest)
        return null;
      blobs.set(digest, new Blob([bytes]));
      return { ...node, attrs: { ...rest, hash: digest } };
    }
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
    return { ...node, attrs: { ...rest, hash } };
  }
  if (node.content === undefined) return node;
  const content: JsonContent[] = [];
  for (const child of node.content) {
    const normalized = await hashOnlyPendingDocument(child, blobs);
    if (normalized === null) return null;
    content.push(normalized);
  }
  return { ...node, content };
}

async function readPendingImageBlob(digest: string): Promise<Blob | null> {
  const bytes = sessionImageBytes(digest) ??
    await getImageBytes(digest).catch(() => undefined);
  return bytes === undefined || await sha256Hex(bytes) !== digest
    ? null
    : new Blob([bytes]);
}

function pendingHandoffStage(
  stage: StagedSandbox,
  request: PendingSandboxSendRequest,
): StagedSandbox {
  const { returnedDraft: _returnedDraft, ...pending } = stage;
  const chosenKey = stage.failure === null ? null : stagedRetryKey(stage);
  const replacing = chosenKey !== null && chosenKey !== stagedCreateAttemptKey(stage);
  const createRetryRow = replacing ? stagedCreateRetryRow(stage, chosenKey) : undefined;
  const runnable = replacing || (chosenKey !== null && takesUpRowlessCreate(stage));
  return {
    ...pending,
    ...(runnable ? { phase: "staged", failure: null } : {}),
    ...(replacing
      ? {
          lastCreateKey: chosenKey,
          lastRetryCreate: createRetryRow === undefined
            ? stagedCreateRetryPayload(stage, chosenKey)
            : undefined,
          createRetryRow,
          createdSandboxId: null,
          createdHostId: null,
          createAttempt: null,
          rateLimit: null,
        }
      : {}),
    ownerId: null,
    sendTaken: true,
    terminalLaunch: null,
    openTerminal: request.kind === "terminal",
  };
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
  if (!plan.effects.includes("end-host") && !plan.effects.includes("remove")) return;
  const actor = captureDraftAuthorityActor();
  if (actor === null || actor.accountId !== send.userId) return;
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (outbox === null || !draftAuthorityActorIsCurrent(actor)) return;
  const stage = readStagedSandbox(pendingSendSurfaceKey(id));
  await returnPendingSandboxWithEvidence({
    actor,
    sendId: id,
    expectedGeneration: outbox.generation,
    saveInDrafts: true,
    pick: stage === null ? null : { kind: "stage", ...stagedSandboxDestination(stage) },
    evidence: { kind: "legacy-task-loss", epicId: send.epicId },
  });
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
  | {
      readonly kind: "landing-draft";
      readonly draftId: string;
      readonly recovery?: DraftAuthorityVersion;
    }
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

export type PendingSandboxReturnReceiptDestination =
  | { readonly kind: "landing-draft"; readonly draftId: string; readonly recovery: boolean }
  | { readonly kind: "chat"; readonly chatId: string; readonly revision: number }
  | {
      readonly kind: "task";
      readonly epicId: string;
      readonly parentId: string | null;
      readonly placement: ExplicitTilePlacement | null;
    };

export function projectPendingSandboxReturnReceipt(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly returnId: string;
  readonly receipt: DraftAuthorityReturnReceipt;
  readonly destination: PendingSandboxReturnReceiptDestination;
}): ReturnedPendingSandboxSend {
  const { actor, sendId, returnId, receipt, destination } = input;
  if (
    !draftAuthorityActorIsCurrent(actor) ||
    receipt.accountId !== actor.accountId ||
    receipt.sendId !== sendId ||
    receipt.returnId !== returnId
  ) return { kind: "none" };
  const { slot } = receipt.draft;
  if (destination.kind === "landing-draft") {
    if (slot.kind !== "landing" || slot.id !== destination.draftId)
      return { kind: "none" };
    return {
      kind: "landing-draft",
      draftId: slot.id,
      ...(destination.recovery ? { recovery: receipt.draft } : {}),
    };
  }
  if (destination.kind === "task")
    return slot.kind === "task" && slot.id === destination.epicId
      ? destination
      : { kind: "none" };
  return slot.kind === "chat" && slot.id === destination.chatId &&
    Number.isSafeInteger(destination.revision) && destination.revision >= 0
    ? destination
    : { kind: "none" };
}

const pendingTaskReturnPlacementSchema = z.object({
  parentId: z.string().min(1).nullable(),
  placement: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tab"), paneId: z.string().min(1), index: z.number().int().nullable() }),
    z.object({
      kind: z.literal("split"),
      paneId: z.string().min(1),
      edge: z.enum(["left", "right", "top", "bottom"]),
    }),
    z.object({
      kind: z.literal("beside"),
      paneId: z.string().min(1),
      category: z.literal("side-chat"),
    }),
  ]).nullable(),
});

/** Rebuild an already-retired return's presentation from its exact live destination. */
export async function readPendingSandboxReturnReceipt(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly returnId: string;
  readonly receipt: DraftAuthorityReturnReceipt;
}): Promise<ReturnedPendingSandboxSend> {
  const { actor, sendId, returnId, receipt } = input;
  if (!draftAuthorityActorIsCurrent(actor) || receipt.accountId !== actor.accountId ||
      receipt.sendId !== sendId || receipt.returnId !== returnId)
    return { kind: "none" };
  const { slot, occurrence, version } = receipt.draft;
  const read = await readDraftAuthoritySlot(slot);
  if (read.kind !== "current" ||
      read.record.kind !== "live" ||
      read.record.draft.occurrence !== occurrence ||
      read.record.draft.version !== version ||
      (read.record.returnAccountId !== null && read.record.returnAccountId !== actor.accountId) ||
      (read.record.recoveryAccountId !== null && read.record.recoveryAccountId !== actor.accountId))
    return { kind: "none" };

  let destination: PendingSandboxReturnReceiptDestination;
  if (slot.kind === "landing") {
    destination = {
      kind: "landing-draft",
      draftId: slot.id,
      recovery: read.record.recoveryAccountId === actor.accountId,
    };
  } else if (slot.kind === "chat") {
    const revision = read.record.payload.revision;
    if (typeof revision !== "number") return { kind: "none" };
    destination = { kind: "chat", chatId: slot.id, revision };
  } else {
    const placement = pendingTaskReturnPlacementSchema.safeParse(
      read.record.payload.pendingReturnPlacement,
    );
    if (!placement.success) return { kind: "none" };
    destination = { kind: "task", epicId: slot.id, ...placement.data };
  }
  return projectPendingSandboxReturnReceipt({ ...input, destination });
}

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
): Promise<ReturnedPendingSandboxSend> {
  return returnPendingMessage(id, false, null, null);
}

/**
 * The sandbox a new agent's message stays on once it is back in its task's
 * composer, as that composer's own pick would have it.
 */
export type ReturnedSandboxPick =
  /**
   * Resting, or not created yet: recorded to stage, so the composer's Send
   * wakes or creates it. The stage identity and any later create key travel
   * with the draft so a resumed create can join the last attempt.
   */
  | (ReturnedSandbox & { readonly kind: "stage" })
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
export async function returnPendingSandboxSendToSandbox(
  id: string,
  pick: ReturnedSandboxPick,
): Promise<ReturnedPendingSandboxSend> {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return { kind: "none" };
  const { epicId } = sends[id];
  const { kind: _kind, ...destination } =
    pick.kind === "stage" ? pick : { ...pick, clientRequestId: null };
  const surfaceKey = newConversationSurfaceKey(epicId);
  const awakePin = pick.kind === "host"
    ? {
        surfaceKey,
        stage: readStagedSandbox(surfaceKey),
        hostId: pick.target.hostId,
        previousHostId: useSurfaceHostSelectionStore.getState().selections[surfaceKey],
      }
    : null;
  return returnPendingMessage(
    id,
    anotherSandboxStaged(epicId, pick),
    destination,
    awakePin,
  );
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
): Promise<ReturnedPendingSandboxSend> {
  return returnPendingMessage(id, true, null, null);
}

/**
 * A send withdrawn on its own (its window gone before its task was
 * confirmed, or its task deleted) keeps the sandbox its stage names, and
 * the create's key while that create may have been accepted. With no stage
 * there is nothing to keep.
 */
export async function returnPendingSandboxSendOnItsSandbox(
  id: string,
): Promise<ReturnedPendingSandboxSend> {
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
 * the stage itself with its create key; created, that sandbox, to wake (the wake
 * reads the sandbox's own state). A created stage is always named: its
 * create names a blank one first.
 */
export function stagedSandboxDestination(
  stage: StagedSandbox,
): ReturnedSandbox {
  const { createdSandboxId, createdHostId, target } = stage;
  const { lastCreateKey, lastRetryCreate, createRetryRow } = stage;
  if (createdSandboxId === null || createdHostId === null)
    return {
      target,
      clientRequestId: target.kind === "new" ? stage.clientRequestId : null,
      ...(target.kind === "new" &&
      lastCreateKey !== undefined &&
      (lastCreateKey !== stage.clientRequestId || lastRetryCreate !== undefined)
        ? {
            lastCreateKey,
            ...(lastRetryCreate?.clientRequestId === lastCreateKey
              ? { lastRetryCreate }
              : {}),
            ...(lastRetryCreate === undefined && createRetryRow !== undefined
              ? { createRetryRowId: createRetryRow.sandboxId }
              : {}),
          }
        : {}),
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

/** Gives an undelivered bound message back through its durable outbox. */
export function returnPendingSandboxMessage(
  id: string,
  saveInDrafts: boolean,
  keepsSandbox: boolean,
  options?: {
    readonly onStorageRefused?: () => void;
    readonly browserComposer?: BrowserSandboxCancelComposer | null;
  },
): Promise<ReturnedPendingSandboxSend> {
  const send = usePendingSandboxSendStore.getState().sends[id];
  const destination = keepsSandbox && send !== undefined
    ? liveSendDestination(send)
    : null;
  return returnPendingMessage(
    id, saveInDrafts, destination, null, options?.onStorageRefused, options?.browserComposer,
  );
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

/** Resumes the immutable destination recorded before a previous exit. */
export function resumePendingSandboxMessageReturn(
  id: string,
): Promise<ReturnedPendingSandboxSend> {
  const send = usePendingSandboxSendStore.getState().sends[id];
  if (send?.returnRequested === undefined && send?.outboxReturnId === undefined)
    return Promise.resolve({ kind: "none" });
  return returnPendingMessage(
    id,
    send.returnRequested?.saveInDrafts ?? false,
    send.returnRequested?.destination ?? null,
    null,
  );
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

type ReturnEvidence = Pick<
  DraftAuthorityReturnDisposition,
  "evidence" | "stopOperationId" | "legacyTaskLoss"
>;

type PendingReturnEvidence = NonNullable<DraftAuthorityReturnDisposition["evidence"]>;
type LegacyStopRestEvidence = Extract<PendingReturnEvidence, { kind: "legacy-stop-rest" }>;

function samePendingReturnEvidence(
  recorded: DraftAuthorityReturnDisposition["evidence"],
  incoming: PendingReturnEvidence,
): boolean {
  if (
    recorded === undefined ||
    recorded.kind !== incoming.kind ||
    recorded.hostId !== incoming.hostId ||
    recorded.sandboxId !== incoming.sandboxId ||
    recorded.attemptId !== incoming.attemptId ||
    recorded.observationGeneration !== incoming.observationGeneration
  ) return false;
  if (incoming.kind !== "legacy-stop-rest") return true;
  return recorded.kind === "legacy-stop-rest" &&
    recorded.state === incoming.state &&
    recorded.proofId === incoming.proofId;
}

interface PendingReturnAwakePin {
  readonly surfaceKey: string;
  readonly stage: StagedSandbox | null;
  readonly hostId: string;
  readonly previousHostId: string | undefined;
}

interface PressedBrowserCancel {
  readonly chatId: string;
  readonly hostId: string;
  readonly originStage: StagedSandbox | null;
  readonly annotations: string;
  readonly crops: ReadonlyMap<string, ImageBytes>;
  readonly expectation: Promise<DraftAuthorityExpectation | null>;
  readonly press: BrowserSandboxCancelPress;
}

function capturePressedBrowserCancel(
  actor: DraftAuthorityActor,
  send: PendingSandboxSend | undefined,
  composer: BrowserSandboxCancelComposer | null | undefined,
): PressedBrowserCancel | null {
  if (
    composer == null ||
    !isBrowserDraftRecoveryRuntime() ||
    send?.request.kind !== "message" ||
    send.userId !== actor.accountId ||
    send.ended === true || send.stopRequested === true ||
    !pendingSandboxSendHandedHere(send.id) || !ownsPendingSandboxSend(send.id)
  ) return null;
  const annotations = send.request.browserAnnotations ?? [];
  const hostId = boundMessageHostId(send);
  const originStage = readStagedSandbox(pendingSendSurfaceKey(send.id));
  if (annotations.length === 0 || hostId === null || originStage?.failure != null)
    return null;
  const { chatId } = send.request;
  const press = composer({ actor, sendId: send.id, chatId, hostId });
  if (press === null) return null;

  const crops = new Map<string, ImageBytes>();
  for (const digest of collectAnnotationImageHashes(annotations)) {
    const bytes = sessionImageBytes(digest);
    if (bytes !== null) crops.set(digest, new Uint8Array(bytes));
  }
  return {
    chatId,
    hostId,
    originStage,
    annotations: JSON.stringify(annotations),
    crops,
    expectation: captureBrowserReturnChatExpectation(chatId, actor),
    press,
  };
}

async function captureBrowserReturnChatExpectation(
  chatId: string,
  actor: DraftAuthorityActor,
): Promise<DraftAuthorityExpectation | null> {
  const slot: DraftAuthoritySlot = { kind: "chat", id: chatId };
  const read = await readDraftAuthoritySlot(slot);
  if (!draftAuthorityActorIsCurrent(actor) || read.kind === "unavailable") return null;
  if (read.kind === "missing") return { kind: "absent", slot };
  const { record } = read;
  if (record.kind === "live") {
    const { content, browserAnnotations } = record.payload;
    if (
      (record.returnAccountId !== null && record.returnAccountId !== actor.accountId) ||
      record.recoveryAccountId !== null ||
      (content != null && (!isJsonContent(content, 0) || !isEmptyLandingDraftContent(content))) ||
      (browserAnnotations != null &&
        (!Array.isArray(browserAnnotations) || browserAnnotations.length !== 0))
    ) return null;
  }
  // A admits a tombstone only with the exact same-send clearance receipt.
  return { kind: "current", draft: record.draft };
}

type BrowserCancelOutcome = "installed" | "fallback" | "unverified";

interface BrowserCancelCompletion {
  readonly outcome: BrowserCancelOutcome;
  readonly returned: ReturnedPendingSandboxSend;
}

interface PendingBrowserInstallation {
  readonly actor: DraftAuthorityActor;
  readonly send: PendingSandboxSend;
  readonly chatId: string;
  readonly returnId: string;
  readonly generation: number;
  readonly installation: BrowserSandboxCancelInstallation;
  running: Promise<BrowserCancelCompletion> | null;
}

const pendingBrowserInstallations = new Map<string, PendingBrowserInstallation>();
subscribeToDraftAuthoritySessionChanges(() => pendingBrowserInstallations.clear());

async function completeBrowserCancelFallback(
  actor: DraftAuthorityActor,
  send: PendingSandboxSend,
  returnId: string,
): Promise<ReturnedPendingSandboxSend> {
  const result = await releasePendingSandboxBrowserCancel({ actor, sendId: send.id, returnId });
  if (result === null || !result.retired || !draftAuthorityActorIsCurrent(actor))
    return { kind: "dispatching" };
  const { publication } = result;
  if (publication.kind !== "committed" && publication.kind !== "replayed")
    return { kind: "dispatching" };
  const returned = await readPendingSandboxReturnReceipt({
    actor, sendId: send.id, returnId, receipt: publication.receipt,
  });
  if (returned.kind !== "none") recordCancelledSandboxSend(send, returned);
  return returned;
}

async function finishPressedBrowserCancel(
  input: PendingBrowserInstallation,
): Promise<BrowserCancelCompletion> {
  const { actor, send, chatId, returnId, generation, installation } = input;
  const outcome = await acknowledgePendingSandboxBrowserCancel({
    actor,
    sendId: send.id,
    returnId,
    expectedGeneration: generation,
    chatId,
    expectedChat: installation.expectedChat,
    isInstallationCurrent: installation.isCurrent,
  }).catch((): BrowserCancelOutcome => "unverified");
  if (outcome === "unverified") return { outcome, returned: { kind: "dispatching" } };

  const revision = await installation.finish(outcome);
  if (outcome === "fallback") {
    return { outcome, returned: await completeBrowserCancelFallback(actor, send, returnId) };
  }
  if (revision === null || !draftAuthorityActorIsCurrent(actor))
    return { outcome, returned: { kind: "none" } };
  const returned: ReturnedPendingSandboxSend = { kind: "chat", chatId, revision };
  recordCancelledSandboxSend(send, returned);
  return { outcome, returned };
}

function settlePressedBrowserCancel(
  input: PendingBrowserInstallation,
): Promise<BrowserCancelCompletion> {
  if (input.running !== null) return input.running;
  input.running = finishPressedBrowserCancel(input).then((result) => {
    if (result.outcome !== "unverified" &&
        pendingBrowserInstallations.get(input.send.id) === input)
      pendingBrowserInstallations.delete(input.send.id);
    return result;
  }).finally(() => { input.running = null; });
  return input.running;
}

export async function resolvePendingSandboxBrowserCancel(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly returnId: string;
  readonly expectedGeneration: number;
}): Promise<BrowserCancelOutcome> {
  const { actor, sendId, returnId, expectedGeneration } = input;
  const press = pendingBrowserInstallations.get(sendId);
  if (
    press === undefined || !draftAuthorityActorIsCurrent(actor) ||
    press.actor.accountId !== actor.accountId ||
    press.actor.sessionGeneration !== actor.sessionGeneration ||
    press.returnId !== returnId || press.generation !== expectedGeneration
  ) return "unverified";
  return (await settlePressedBrowserCancel(press)).outcome;
}

async function returnPressedBrowserCancel(
  actor: DraftAuthorityActor,
  outbox: DraftAuthorityOutbox,
  destination: ReturnedSandbox | null,
  captured: PressedBrowserCancel,
  onStorageRefused: (() => void) | undefined,
): Promise<ReturnedPendingSandboxSend | null> {
  const { send } = outbox;
  const { chatId, press, crops } = captured;
  if (send.request.kind !== "message" || send.request.chatId !== chatId ||
      outbox.decision.kind === "returning") return null;

  const annotations = send.request.browserAnnotations ?? [];
  const digests = collectAnnotationImageHashes(annotations);
  const stillEligible = (): boolean =>
    draftAuthorityActorIsCurrent(actor) &&
    pendingSandboxSendHandedHere(send.id) && ownsPendingSandboxSend(send.id) &&
    readStagedSandbox(pendingSendSurfaceKey(send.id)) === captured.originStage &&
    press.isCurrent();
  if (
    outbox.send.ended === true || outbox.send.stopRequested === true ||
    boundMessageHostId(send) !== captured.hostId ||
    JSON.stringify(annotations) !== captured.annotations ||
    digests.some((digest) => !crops.has(digest)) ||
    !stillEligible()
  ) return null;
  const [expectedChat, hashesMatch] = await Promise.all([
    captured.expectation,
    Promise.all([...crops].map(async ([digest, bytes]) => await sha256Hex(bytes) === digest))
      .then((checks) => checks.every(Boolean), () => false),
  ]);
  if (expectedChat === null || !hashesMatch || !stillEligible()) return null;
  if (
    expectedChat.kind === "current" && outbox.source?.slot.kind === "chat" &&
    outbox.source.slot.id === chatId &&
    expectedChat.draft.occurrence !== outbox.source.occurrence
  ) return null;

  const prepared = await preparePendingReturn(actor, outbox, false, destination, {});
  if (prepared === null || !stillEligible() || prepared.disposition.primary !== null ||
      prepared.disposition.fallback === null || !prepared.disposition.recoveryBytes)
    return null;
  const begin = await beginPendingSandboxBrowserCancel({
    actor,
    sendId: send.id,
    expectedGeneration: outbox.generation,
    disposition: prepared.disposition,
    isAdmissionCurrent: stillEligible,
    ...(onStorageRefused === undefined ? {} : { onStorageRefused }),
  });
  if (begin.kind === "held") {
    if (!draftAuthorityActorIsCurrent(actor) || stillEligible())
      return { kind: "dispatching" };
    // A lost the pressing scope before installation. Join the unchanged row only.
    const current = await readDraftAuthorityOutbox({ actor, sendId: send.id });
    return current.kind === "current" && current.outbox.generation === outbox.generation
      ? null
      : { kind: "dispatching" };
  }
  const { returnId, generation } = begin;
  const bytes = new Map(begin.bytes);
  for (const [digest, original] of crops) {
    const owned = bytes.get(digest);
    if (owned !== undefined) bytes.set(digest, new Blob([original], { type: owned.type }));
  }
  const installation = await press.install({
    returnId,
    generation,
    expectedChat,
    content: begin.content,
    browserAnnotations: begin.browserAnnotations,
    bytes,
  }).catch(() => null);
  if (installation === null) return completeBrowserCancelFallback(actor, send, returnId);
  const live: PendingBrowserInstallation = {
    actor, send, chatId, returnId, generation, installation, running: null,
  };
  pendingBrowserInstallations.set(send.id, live);
  return (await settlePressedBrowserCancel(live)).returned;
}

async function returnPendingMessage(
  sendId: string,
  saveInDrafts: boolean,
  destination: ReturnedSandbox | null,
  awakePin: PendingReturnAwakePin | null,
  onStorageRefused?: () => void,
  browserComposer?: BrowserSandboxCancelComposer | null,
): Promise<ReturnedPendingSandboxSend> {
  const actor = captureDraftAuthorityActor();
  if (actor === null) return { kind: "none" };
  const send = usePendingSandboxSendStore.getState().sends[sendId];
  const captured = saveInDrafts ? null : capturePressedBrowserCancel(actor, send, browserComposer);
  const read = await readDraftAuthorityOutbox({ actor, sendId });
  if (read.kind === "unavailable" && draftAuthorityActorIsCurrent(actor)) {
    onStorageRefused?.();
    return { kind: "none" };
  }
  let outbox: DraftAuthorityOutbox | null = null;
  if (read.kind === "current") {
    outbox = read.outbox;
  } else if (read.kind === "missing" && send?.userId === actor.accountId) {
    outbox = await loadPendingSandboxOutbox(actor, send);
  }
  if (outbox === null || !draftAuthorityActorIsCurrent(actor)) return { kind: "none" };
  const requested = outbox.send.returnRequested;
  if (captured !== null && requested?.saveInDrafts !== true) {
    const result = await returnPressedBrowserCancel(
      actor, outbox, requested === undefined ? destination : (requested.destination ?? null),
      captured, onStorageRefused,
    );
    if (result !== null) return result;
  }
  return returnExactPendingMessage(
    actor,
    outbox,
    requested?.saveInDrafts ?? saveInDrafts,
    requested === undefined ? destination : (requested.destination ?? null),
    {},
    awakePin,
    onStorageRefused,
  );
}

export async function returnPendingSandboxWithEvidence(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly expectedGeneration: number;
  readonly saveInDrafts: boolean;
  readonly pick: ReturnedSandboxPick | null;
  readonly evidence:
    | { readonly kind: "stop"; readonly operationId: string }
    | { readonly kind: "legacy-task-loss"; readonly epicId: string }
    | LegacyStopRestEvidence;
}): Promise<ReturnedPendingSandboxSend> {
  const { actor, sendId, expectedGeneration, pick, evidence } = input;
  const read = await readDraftAuthorityOutbox({ actor, sendId });
  if (
    read.kind !== "current" ||
    !draftAuthorityActorIsCurrent(actor) ||
    (read.outbox.generation !== expectedGeneration &&
      read.outbox.decision.kind !== "returning")
  )
    return { kind: "none" };
  const destination = pick === null || pick.kind === "stage"
    ? pick
    : { target: pick.target, clientRequestId: null };
  return returnExactPendingMessage(
    actor,
    read.outbox,
    input.saveInDrafts,
    destination,
    evidence.kind === "stop"
      ? { stopOperationId: evidence.operationId }
      : evidence.kind === "legacy-task-loss"
        ? { legacyTaskLoss: { epicId: evidence.epicId } }
        : { evidence },
    null,
  );
}

/** The watcher already proved the exact row and attempt for this outbox. */
export async function returnPendingSandboxAfterSetupEnd(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly expectedGeneration: number;
  readonly evidence: Exclude<PendingReturnEvidence, LegacyStopRestEvidence>;
}): Promise<ReturnedPendingSandboxSend> {
  const { actor, sendId, expectedGeneration, evidence } = input;
  const read = await readDraftAuthorityOutbox({ actor, sendId });
  if (
    read.kind !== "current" ||
    !draftAuthorityActorIsCurrent(actor) ||
    (read.outbox.generation !== expectedGeneration &&
      read.outbox.decision.kind !== "returning")
  )
    return { kind: "none" };
  return returnExactPendingMessage(actor, read.outbox, true, null, { evidence }, null);
}

export function subscribeToPendingSandboxReturnTargetAdmission(
  input: { readonly accountId: string; readonly sendId: string },
  listener: () => void,
): () => void {
  const send = usePendingSandboxSendStore.getState().sends[input.sendId];
  if (send?.request.kind !== "message" || send.userId !== input.accountId)
    return () => undefined;
  const hostId = boundMessageHostId(send);
  if (hostId === null) return () => undefined;
  return subscribeToPendingCanvasAdmission({
    accountId: input.accountId,
    chatId: send.request.chatId,
    hostId,
  }, listener);
}

export async function returnPendingSandboxAfterHeldHostEnd(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly expectedGeneration: number;
}): Promise<ReturnedPendingSandboxSend> {
  const { actor, sendId, expectedGeneration } = input;
  const read = await readDraftAuthorityOutbox({ actor, sendId });
  if (read.kind !== "current" || !draftAuthorityActorIsCurrent(actor))
    return { kind: "none" };
  const { outbox } = read;
  const { decision } = outbox;
  if (
    outbox.generation !== expectedGeneration ||
    decision.kind !== "held" ||
    decision.reason !== "host-end"
  )
    return { kind: "none" };
  const {
    kind: proofKind,
    ownership,
    attemptId,
    hostId,
    sandboxId,
    observationGeneration,
  } = decision.evidence;
  const kind = ownership === "dispatch"
    ? "dispatch-host-end"
    : proofKind === "settled-destroy"
      ? "setup-destroy"
      : "setup-host-end";
  return returnExactPendingMessage(
    actor,
    outbox,
    false,
    null,
    { evidence: { kind, attemptId, hostId, sandboxId, observationGeneration } },
    null,
  );
}

interface PreparedPendingReturn {
  readonly disposition: DraftAuthorityReturnDisposition;
  readonly isAdmissionCurrent?: () => boolean;
}

async function returnExactPendingMessage(
  actor: DraftAuthorityActor,
  outbox: DraftAuthorityOutbox,
  saveInDrafts: boolean,
  destination: ReturnedSandbox | null,
  evidence: ReturnEvidence,
  awakePin: PendingReturnAwakePin | null,
  onStorageRefused?: () => void,
): Promise<ReturnedPendingSandboxSend> {
  const { send, decision } = outbox;
  const { request } = send;
  if (request.kind !== "chat" && request.kind !== "message") return { kind: "none" };
  const prepared: PreparedPendingReturn | null = decision.kind === "returning"
    ? { disposition: decision.disposition }
    : await preparePendingReturn(actor, outbox, saveInDrafts, destination, evidence);
  if (prepared === null || !draftAuthorityActorIsCurrent(actor))
    return { kind: "none" };
  const { disposition } = prepared;
  if (
    (evidence.evidence !== undefined &&
      !samePendingReturnEvidence(disposition.evidence, evidence.evidence)) ||
    (evidence.stopOperationId !== undefined &&
      disposition.stopOperationId !== evidence.stopOperationId) ||
    (evidence.legacyTaskLoss !== undefined &&
      disposition.legacyTaskLoss?.epicId !== evidence.legacyTaskLoss.epicId)
  )
    return { kind: "none" };

  const result = await returnPendingSandboxOutbox({
    actor,
    sendId: send.id,
    expectedGeneration: outbox.generation,
    ...prepared,
    ...(decision.kind === "returning" || onStorageRefused === undefined
      ? {}
      : { onStorageRefused: () => {
          if (draftAuthorityActorIsCurrent(actor)) onStorageRefused();
        } }),
  });
  if (result === null) return { kind: "dispatching" };
  if (!result.retired || !draftAuthorityActorIsCurrent(actor)) return { kind: "none" };
  const { publication } = result;
  if (publication.kind !== "committed" && publication.kind !== "replayed")
    return { kind: "none" };
  const { slot } = publication.receipt.draft;
  let receiptDestination: PendingSandboxReturnReceiptDestination;
  if (slot.kind === "landing") {
    receiptDestination = {
      kind: "landing-draft",
      draftId: slot.id,
      recovery: disposition.recoveryBytes &&
        disposition.fallback?.expected.kind === "absent" &&
        disposition.fallback.expected.slot.id === slot.id,
    };
  } else if (slot.kind === "task" && request.kind === "chat") {
    receiptDestination = {
      kind: "task",
      epicId: send.epicId,
      parentId: request.parentId,
      placement: request.placement,
    };
  } else {
    const revision = disposition.primary?.payload.revision;
    if (request.kind !== "message" || typeof revision !== "number") return { kind: "none" };
    receiptDestination = { kind: "chat", chatId: request.chatId, revision };
  }

  const returned = projectPendingSandboxReturnReceipt({
    actor,
    sendId: send.id,
    returnId: disposition.returnId,
    receipt: publication.receipt,
    destination: receiptDestination,
  });
  if (returned.kind === "none") return returned;
  if (returned.kind === "task" && awakePin !== null) {
    const active = await readDraftAuthoritySlot(slot);
    if (
      active.kind === "current" &&
      active.record.kind === "live" &&
      active.record.draft.version === publication.receipt.draft.version &&
      readStagedSandbox(awakePin.surfaceKey) === awakePin.stage &&
      useSurfaceHostSelectionStore.getState().selections[awakePin.surfaceKey] ===
        awakePin.previousHostId &&
      draftAuthorityActorIsCurrent(actor)
    ) {
      useSurfaceHostSelectionStore.getState().setSelection(
        awakePin.surfaceKey,
        awakePin.hostId,
      );
    }
    if (!draftAuthorityActorIsCurrent(actor)) return { kind: "none" };
  }
  if (request.kind === "message") recordCancelledSandboxSend(send, returned);
  return returned;
}

export function isBrowserDraftRecoveryRuntime(): boolean {
  return typeof window !== "undefined" &&
    !isMobileApp() &&
    Reflect.get(globalThis, "runnerHost") === undefined;
}

async function preparePendingReturn(
  actor: DraftAuthorityActor,
  outbox: DraftAuthorityOutbox,
  saveInDrafts: boolean,
  destination: ReturnedSandbox | null,
  evidence: ReturnEvidence,
): Promise<PreparedPendingReturn | null> {
  const { send } = outbox;
  const { request } = send;
  const annotations =
    request.kind === "message" ? (request.browserAnnotations ?? []) : [];
  const canvas = annotations.filter(
    (annotation) => annotation.source.kind === "canvas",
  );
  const hostId =
    evidence.evidence?.hostId ??
    outbox.dispatch?.input.hostId ??
    (request.kind === "message" ? request.hostId : null) ??
    null;
  const browserRecovery = annotations.length > 0 && isBrowserDraftRecoveryRuntime();
  const nativeAdmission =
    !browserRecovery && canvas.length > 0 && request.kind === "message" && hostId !== null
      ? readPendingCanvasReturnAdmission(actor, request.chatId, hostId)
      : null;
  if (
    !browserRecovery && nativeAdmission === null &&
    (canvas.length > 0 || (outbox.byteCustody && annotations.length > 0))
  ) return null;
  const content = request.kind === "message"
    ? qualifyBoundReturn(send, request)
    : send.content;
  const id = pendingSandboxRecoveryDraftId(send.id);
  const stored = destination === null
    ? null
    : storeReturnedSandbox({ ...destination, userId: actor.accountId });
  const manifest = {
    digests: [...new Set([
      ...blobHashesFromContent(content),
      ...collectAnnotationImageHashes(annotations),
    ])],
  };
  const slot: DraftAuthoritySlot | null =
    browserRecovery || ((saveInDrafts || send.ended === true) && nativeAdmission === null)
      ? null
      : request.kind === "message"
        ? { kind: "chat", id: request.chatId }
        : request.kind === "chat" && send.epicConfirmed
          ? { kind: "task", id: send.epicId }
          : null;
  let primary = slot === null
    ? null
    : await readPendingReturnTarget(outbox, slot, {
        content,
        selection: null,
        ...(slot.kind === "chat"
          ? {
              browserAnnotations: annotations.filter((record) => record.source.kind === "browser"),
              targetEpicId: send.epicId,
            }
          : {
              settings: send.settings,
              returnedSandbox: stored,
              ...(request.kind === "chat" ? {
                pendingReturnPlacement: { parentId: request.parentId, placement: request.placement },
              } : {}),
            }),
      }, manifest, slot.kind === "task" ? stored?.userId ?? null : null);
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  const isAdmissionCurrent = nativeAdmission === null
    ? undefined
    : (): boolean => draftAuthorityActorIsCurrent(actor) &&
        pendingCanvasReturnAdmissionIsCurrent(nativeAdmission);
  if (nativeAdmission !== null) {
    if (primary === null) return null;
    const target = await readPendingCanvasReturnTarget({
      actor,
      hostId: nativeAdmission.hostId,
      expected: primary.expected,
      occurrence: primary.occurrence,
      admission: nativeAdmission,
      annotations: canvas,
    });
    if (target.kind === "held" || isAdmissionCurrent?.() === false)
      return null;
    primary = { ...primary, canvasSidecar: target.canvasSidecar };
  }
  if (primary === null && annotations.length > 0 && !browserRecovery) return null;
  const disposition: DraftAuthorityReturnDisposition = {
    ...evidence,
    returnId: id,
    primary,
    fallback: annotations.length > 0 && !browserRecovery ? null : {
      expected: { kind: "absent", slot: { kind: "landing", id } },
      occurrence: id,
      payload: {
        id,
        content,
        selection: null,
        lastTouchedAt: send.createdAt,
        settings: send.settings,
        composerMode: "chat",
        workspace: emptyLandingDraftWorkspaceSnapshot(),
        closed: true,
        returnedSandbox: stored,
        namedHostId: null,
        ...(browserRecovery ? { browserAnnotations: annotations } : {}),
      },
      manifest,
      returnAccountId: browserRecovery ? actor.accountId : stored?.userId ?? null,
    },
    recoveryBytes: browserRecovery || nativeAdmission !== null,
  };
  return isAdmissionCurrent === undefined
    ? { disposition }
    : { disposition, isAdmissionCurrent };
}

function qualifyBoundReturn(
  send: PendingSandboxSend,
  request: Extract<PendingSandboxSendRequest, { kind: "message" }>,
): JsonContent {
  const reason = boundMessageReturnReason(send, request);
  return reason === "Your message wasn't sent."
    ? send.content
    : appendPromptQualification(send.content, `Unsent — ${reason}`);
}

async function readPendingReturnTarget(
  outbox: DraftAuthorityOutbox,
  slot: DraftAuthoritySlot,
  payload: Readonly<Record<string, unknown>>,
  manifest: { readonly digests: readonly string[] },
  returnAccountId: string | null,
): Promise<DraftAuthorityReturnDisposition["primary"]> {
  const read = await readDraftAuthoritySlot(slot);
  if (read.kind === "unavailable") return null;
  const record = read.kind === "current" ? read.record : null;
  if (
    record?.kind === "live" &&
    outbox.source?.slot.kind === slot.kind &&
    outbox.source.slot.id === slot.id &&
    record.draft.version !== outbox.source.version
  ) return null;
  const current = record?.kind === "live" ? record.payload : {};
  const occurrence = record?.kind === "live"
    ? record.draft.occurrence
    : uuidv5(`pending-sandbox-return:${outbox.sendId}:${slot.kind}:${slot.id}`, uuidv5.URL);
  return {
    expected: record === null
      ? { kind: "absent", slot }
      : { kind: "current", draft: record.draft },
    occurrence,
    payload: {
      ...current,
      ...payload,
      lastTouchedAt: outbox.send.createdAt,
      revision: (typeof current.revision === "number" ? current.revision : 0) + 1,
      resetEpoch: (typeof current.resetEpoch === "number" ? current.resetEpoch : 0) + 1,
    },
    manifest,
    returnAccountId,
    ...(outbox.source?.slot.kind === slot.kind && outbox.source.slot.id === slot.id
      ? { clearanceOperationId: outbox.actionId }
      : {}),
  };
}

/** The saved recovery draft remains addressable after its pending record is removed. */
export function pendingSandboxRecoveryDraftId(id: string): string {
  return uuidv5(`pending-sandbox-send:${id}:recovered`, uuidv5.URL);
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
    | "values"
    | "selection"
    | "permission"
    | "reasoning"
    | "serviceTier"
    | "ultracode"
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
    ultracode: shown ? toolbar.ultracode : toolbar.values.ultracode,
  });
}
