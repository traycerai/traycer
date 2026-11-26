import type { JsonContent } from "@traycer/protocol/common/registry";
import { bytesToBase64Async } from "@/lib/composer/image-base64";
import { stripBase64ImageNodes } from "@/lib/composer/strip-base64-image-nodes";
import {
  acknowledgeDraftAuthorityBrowserReturn,
  admitLegacyDraftAuthorityOutbox,
  cancelDraftAuthorityIdleOutbox,
  claimDraftAuthorityEffect,
  confirmDraftAuthorityOutboxEpic,
  holdDraftAuthorityStop,
  holdDraftAuthorityOutboxEnd,
  listDraftAuthorityOutboxes,
  publishDraftAuthorityOutbox,
  publishDraftAuthorityReturn,
  readDraftAuthorityBrowserReturn,
  readDraftAuthorityCompletedReturn,
  readDraftAuthorityOutbox,
  readDraftAuthorityOutboxSubmission,
  readDraftAuthorityIssueGrant,
  readDraftAuthorityStopGrant,
  recordDraftAuthorityReturn,
  retireDraftAuthorityPendingSource,
  settleDraftAuthorityEffect,
  settleDraftAuthorityStop,
  subscribeToDraftAuthorityOutboxChanges,
  transferDraftAuthorityOutbox,
  type DraftAuthorityEffectIntent,
  type DraftAuthorityIssueReceipt,
  type DraftAuthorityHostEndEvidence,
  type DraftAuthorityPendingSetupBinding,
  type DraftAuthoritySetupAttempt,
  type DraftAuthorityOutbox,
  type DraftAuthorityOutboxSubmission,
  type DraftAuthorityPendingEpicEvidence,
  type DraftAuthorityPendingEpicPrerequisite,
  type DraftAuthorityReturnDisposition,
  type DraftAuthorityRestoredPredecessor,
  type DraftAuthorityStopOutcome,
  type DraftAuthorityStopReceipt,
} from "@/lib/drafts/draft-authority-pending";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
import {
  captureDraftAuthorityActor,
  draftAuthorityActorIsCurrent,
} from "@/lib/drafts/draft-authority-session";
import type {
  DraftAuthorityActor,
  DraftAuthorityExpectation,
  DraftAuthorityManifest,
  DraftAuthorityMutationResult,
  DraftAuthorityVerifiedBlob,
} from "@/lib/drafts/draft-authority-types";
import {
  collectAnnotationImageHashes,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import {
  ownsPendingSandboxSend,
  pendingSandboxSendHandedHere,
} from "@/lib/sandboxes/pending-sandbox-send-ownership";
import {
  pendingSandboxLegacyProjectionCurrent,
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
  type PendingSandboxSendDispatch,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  releasePendingSandboxHandoffReservation,
  useStagedSandboxStore,
  type PendingSandboxHandoffReservation,
} from "@/stores/composer/staged-sandbox-store";

interface PendingSandboxOutboxPublication {
  readonly actor: DraftAuthorityActor;
  readonly actionId: string;
  readonly expectedSource: DraftAuthorityExpectation | null;
  readonly send: PendingSandboxSend;
  readonly manifest: DraftAuthorityManifest;
  readonly verified: readonly DraftAuthorityVerifiedBlob[];
  readonly setupBinding?: DraftAuthorityPendingSetupBinding;
  readonly submission?: DraftAuthorityOutboxSubmission;
  readonly epicPrerequisite?: DraftAuthorityPendingEpicPrerequisite;
  readonly restoredPredecessor?: DraftAuthorityRestoredPredecessor;
  readonly isSuccessorCurrent?: () => boolean;
}

export async function publishPendingSandboxOutbox(
  input: PendingSandboxOutboxPublication,
): Promise<DraftAuthorityMutationResult<DraftAuthorityOutbox, DraftAuthorityOutbox>> {
  const result = await publishDraftAuthorityOutbox({
    ...input,
    send: { ...input.send, content: stripBase64ImageNodes(input.send.content) },
  });
  if (result.kind === "committed" || result.kind === "replayed")
    void refreshPendingSandboxOutbox(input.actor, input.send.id).catch(
      () => undefined,
    );
  return result;
}

export async function confirmPendingSandboxOutboxEpic(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly actionId: string;
  readonly expectedGeneration: number;
  readonly evidence: DraftAuthorityPendingEpicEvidence;
}): Promise<boolean> {
  if (!draftAuthorityActorIsCurrent(input.actor)) return false;
  const result = await confirmDraftAuthorityOutboxEpic(input);
  if (result.kind !== "committed" && result.kind !== "replayed")
    return false;
  const current = await readDraftAuthorityOutbox({
    actor: input.actor,
    sendId: input.sendId,
  });
  if (
    current.kind !== "current" ||
    !draftAuthorityActorIsCurrent(input.actor) ||
    current.outbox.accountId !== input.actor.accountId ||
    current.outbox.actionId !== input.actionId ||
    current.outbox.send.epicId !== input.evidence.epicId ||
    !current.outbox.send.epicConfirmed
  )
    return false;
  projectPendingSandboxOutbox(current.outbox);
  return true;
}

export async function finishPendingSandboxHandoff(input: {
  readonly actor: DraftAuthorityActor;
  readonly actionId: string;
  readonly reservation: PendingSandboxHandoffReservation;
  readonly publication:
    | DraftAuthorityMutationResult<DraftAuthorityOutbox, DraftAuthorityOutbox>
    | "unverified";
}): Promise<"published" | "aborted" | "held"> {
  const { actor, actionId, reservation, publication } = input;
  const { sendId } = reservation;
  const read = await readDraftAuthorityOutbox({ actor, sendId }).catch(() => null);
  if (!draftAuthorityActorIsCurrent(actor) || read === null) return "held";
  const matches = (outbox: DraftAuthorityOutbox): boolean =>
    outbox.accountId === actor.accountId &&
    outbox.actionId === actionId &&
    outbox.sendId === sendId;
  const verified =
    publication !== "unverified" &&
    (publication.kind === "committed" || publication.kind === "replayed") &&
    matches(publication.receipt);
  if (
    (read.kind === "current" && matches(read.outbox)) ||
    (read.kind === "retired" &&
      read.marker.accountId === actor.accountId &&
      read.marker.sendId === sendId &&
      verified)
  ) {
    releasePendingSandboxHandoffReservation(reservation, "published");
    return "published";
  }
  if (
    read.kind !== "missing" ||
    publication === "unverified" ||
    publication.kind === "unverified" ||
    publication.kind === "committed" ||
    publication.kind === "replayed"
  )
    return "held";
  releasePendingSandboxHandoffReservation(reservation, "aborted");
  return "aborted";
}

export async function readPendingSandboxBoundSubmission(
  actor: DraftAuthorityActor,
  sendId: string,
  expectedGeneration: number,
): Promise<DraftAuthorityOutboxSubmission | null> {
  const read = await readDraftAuthorityOutboxSubmission({
    actor,
    sendId,
    expectedGeneration,
  });
  return read.kind === "current" && draftAuthorityActorIsCurrent(actor)
    ? read.submission
    : null;
}

export interface PendingSandboxBoundWire {
  readonly content: JsonContent;
  readonly restoreContent: JsonContent;
}

export async function materializePendingSandboxBoundWire(input: {
  readonly actor: DraftAuthorityActor;
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly claim: DraftAuthorityIssueReceipt;
}): Promise<PendingSandboxBoundWire | null> {
  const { actor, send, dispatch, claim } = input;
  const { outboxInlineHashes, input: request } = dispatch;
  if (outboxInlineHashes === undefined || request.initialMessage == null)
    return null;
  const read = await readDraftAuthorityOutbox({ actor, sendId: send.id });
  if (
    read.kind !== "current" ||
    read.outbox.accountId !== actor.accountId ||
    read.outbox.send.request.kind !== "message" ||
    !read.outbox.send.epicConfirmed ||
    !draftAuthorityActorIsCurrent(actor)
  )
    return null;
  const scoped = await readDraftAuthorityOutboxSubmission({
    actor,
    sendId: send.id,
    expectedGeneration: read.outbox.generation,
    claim,
  });
  if (
    scoped.kind !== "current" ||
    !draftAuthorityActorIsCurrent(actor) ||
    JSON.stringify(scoped.submission.content) !==
      JSON.stringify(request.initialMessage.content) ||
    JSON.stringify(scoped.submission.manifest.digests) !==
      JSON.stringify(outboxInlineHashes)
  )
    return null;
  const base64 = new Map<string, string>();
  for (const hash of outboxInlineHashes) {
    const blob = scoped.bytes.get(hash);
    if (blob === undefined || !draftAuthorityActorIsCurrent(actor)) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!draftAuthorityActorIsCurrent(actor)) return null;
    base64.set(hash, await bytesToBase64Async(bytes));
  }
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  const cropHashes = new Set(
    collectAnnotationImageHashes(read.outbox.send.request.browserAnnotations ?? []),
  );
  return {
    content: inlinePendingSandboxWire(scoped.submission.content, base64, cropHashes),
    restoreContent: read.outbox.send.content,
  };
}

function inlinePendingSandboxWire(
  node: JsonContent,
  base64: ReadonlyMap<string, string>,
  cropHashes: ReadonlySet<string>,
): JsonContent {
  if (node.type === "imageAttachment" && typeof node.attrs?.hash === "string") {
    const { hash, ...attrs } = node.attrs;
    const b64content = base64.get(hash);
    if (b64content !== undefined)
      return {
        ...node,
        attrs: { ...attrs, ...(cropHashes.has(hash) ? { hash } : {}), b64content },
      };
  }
  return node.content === undefined
    ? node
    : {
        ...node,
        content: node.content.map((child) =>
          inlinePendingSandboxWire(child, base64, cropHashes),
        ),
      };
}

export function pendingSandboxDispatchEffect(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
): DraftAuthorityEffectIntent {
  const { hostId, chatId, initialMessage } = dispatch.input;
  return {
    kind: send.request.kind === "message" ? "send" : "create",
    phase: "dispatch",
    identity: JSON.stringify([
      hostId,
      chatId,
      initialMessage?.messageId ?? null,
      initialMessage?.clientActionId ?? null,
    ]),
    payload: { input: dispatch.input, request: send.request },
  };
}

export async function transferPendingSandboxOutbox(input: {
  readonly actor: DraftAuthorityActor;
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly canTransfer: () => boolean;
}): Promise<void> {
  const { actor, send, dispatch } = input;
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (
    outbox === null ||
    outbox.ownership !== "setup" ||
    outbox.decision.kind !== "waiting" ||
    !outbox.send.epicConfirmed ||
    (send.outboxGeneration !== undefined &&
      send.outboxGeneration !== outbox.generation) ||
    (outbox.submission === undefined) !==
      (dispatch.outboxInlineHashes === undefined) ||
    !input.canTransfer()
  )
    return;
  const result = await transferDraftAuthorityOutbox({
    actor,
    operationId: `${send.id}:prepared-dispatch`,
    sendId: send.id,
    expectedGeneration: outbox.generation,
    dispatch,
  });
  if (result.kind === "committed" || result.kind === "replayed")
    await refreshPendingSandboxOutbox(actor, send.id);
}

interface PendingSandboxEffectClaim {
  readonly actor: DraftAuthorityActor;
  readonly send: PendingSandboxSend;
  readonly operationId: string;
  readonly effect: DraftAuthorityEffectIntent;
  readonly expectedOutboxGeneration?: number;
  readonly retryRefusedSetupCreate?: boolean;
  readonly setupAttempt?: DraftAuthoritySetupAttempt;
  readonly canIssue: () => boolean;
}

export async function claimPendingSandboxOutboxEffect(
  input: PendingSandboxEffectClaim,
): Promise<DraftAuthorityIssueReceipt | null> {
  const { actor, send, effect } = input;
  const expectedGeneration = input.expectedOutboxGeneration ?? send.outboxGeneration;
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (
    outbox === null ||
    outbox.ownership !== effect.phase ||
    !outbox.send.epicConfirmed ||
    (expectedGeneration !== undefined && expectedGeneration !== outbox.generation) ||
    !draftAuthorityActorIsCurrent(actor) ||
    !input.canIssue()
  )
    return null;
  const { decision } = outbox;
  let issue = outbox.setupIssue;
  let auxiliaryFor: DraftAuthorityIssueReceipt | null | undefined;
  const manualTerminal =
    effect.kind === "terminal" && outbox.send.request.kind !== "terminal";
  if (manualTerminal) {
    if (decision.kind !== "waiting") return null;
    issue = outbox.manualTerminalIssue;
  } else if (effect.phase === "dispatch") {
    if (effect.kind === "wake") {
      if (
        decision.kind !== "waiting" &&
        decision.kind !== "refused" &&
        decision.kind !== "uncertain"
      )
        return null;
      auxiliaryFor = decision.kind === "waiting" ? null : decision.claim;
      issue = outbox.dispatchWakeIssue;
    } else {
      if (
        outbox.dispatch === null ||
        JSON.stringify(pendingSandboxDispatchEffect(outbox.send, outbox.dispatch)) !==
          JSON.stringify(effect) ||
        (decision.kind !== "waiting" &&
          decision.kind !== "refused" &&
          decision.kind !== "uncertain")
      )
        return null;
      issue = decision.kind === "waiting" ? null : decision.claim;
    }
  } else if (decision.kind !== "waiting") {
    return null;
  }

  let recovery: "initial" | "exact-replay" | "explicit-retry" = "initial";
  let operationId = input.operationId;
  let expectedIssueGeneration: number | null = null;
  if (
    !manualTerminal &&
    effect.phase === "dispatch" &&
    effect.kind !== "wake" &&
    issue !== null
  ) {
    const current = usePendingSandboxSendStore.getState().sends[send.id];
    if (
      current?.retryRequest === undefined ||
      current.retryRequest.id !== current.retryHandledId ||
      current.retryRequest.observedOutboxGeneration !== outbox.generation ||
      JSON.stringify(issue.effect) !== JSON.stringify(effect)
    )
      return null;
    recovery = decision.kind === "refused" ? "explicit-retry" : "exact-replay";
    operationId = issue.operationId;
    expectedIssueGeneration = issue.issueGeneration;
  } else if (
    effect.phase === "setup" &&
    effect.kind === "create" &&
    issue?.operationId === operationId
  ) {
    if (JSON.stringify(issue.effect) !== JSON.stringify(effect)) return null;
    recovery = input.retryRefusedSetupCreate === true
      ? "explicit-retry"
      : "exact-replay";
    expectedIssueGeneration = issue.issueGeneration;
  }
  const previousSetupAttempt = outbox.setupIssue?.setupAttempt ?? outbox.setupBinding;
  const setupAttempt = recovery === "exact-replay" && effect.phase === "setup"
    ? issue?.setupAttempt
    : input.setupAttempt;
  const result = await claimDraftAuthorityEffect({
    actor,
    operationId,
    source: {
      kind: "pending-outbox",
      sendId: send.id,
      generation: outbox.generation,
    },
    effect,
    expectedIssueGeneration,
    recovery,
    ...(auxiliaryFor === undefined ? {} : { auxiliaryFor }),
    ...(setupAttempt === undefined ? {} : { setupAttempt }),
    ...(setupAttempt === undefined || previousSetupAttempt === undefined || previousSetupAttempt === null
      ? {}
      : { previousSetupAttempt }),
  });
  if (result.kind !== "committed") return null;
  const claim = result.receipt;
  if (await verifyPendingSandboxOutboxGrant(actor, claim) && input.canIssue())
    return claim;
  if (draftAuthorityActorIsCurrent(actor))
    await settleDraftAuthorityEffect({ actor, claim, outcome: "uncertain" });
  return null;
}

export async function verifyPendingSandboxOutboxGrant(
  actor: DraftAuthorityActor,
  claim: DraftAuthorityIssueReceipt,
): Promise<boolean> {
  return (
    draftAuthorityActorIsCurrent(actor) &&
    (await readDraftAuthorityIssueGrant({ actor, claim })) &&
    draftAuthorityActorIsCurrent(actor)
  );
}

export async function settlePendingSandboxOutboxEffect(
  actor: DraftAuthorityActor,
  claim: DraftAuthorityIssueReceipt,
  outcome: "accepted" | "refused" | "uncertain" | "terminal",
): Promise<boolean> {
  if (!draftAuthorityActorIsCurrent(actor)) return false;
  const result = await settleDraftAuthorityEffect({ actor, claim, outcome });
  return (
    (result.kind === "committed" || result.kind === "replayed") &&
    draftAuthorityActorIsCurrent(actor)
  );
}

export async function restorePendingSandboxOutboxCustody(
  actor: DraftAuthorityActor,
  send: PendingSandboxSend,
  stillExclusive: () => boolean,
): Promise<void> {
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (
    outbox === null ||
    !draftAuthorityActorIsCurrent(actor) ||
    !stillExclusive()
  )
    return;
  const claim =
    outbox.decision.kind === "issuing"
      ? outbox.decision.claim
      : outbox.decision.kind === "waiting" &&
          outbox.setupIssue?.effect.kind === "create"
        ? outbox.setupIssue
        : null;
  if (claim !== null)
    await settlePendingSandboxOutboxEffect(actor, claim, "uncertain");
  await refreshPendingSandboxOutbox(actor, send.id);
}

export async function reconcilePendingSandboxDispatch(
  actor: DraftAuthorityActor,
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
  outcome: "accepted" | "refused" | "uncertain" | "terminal",
): Promise<boolean> {
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (outbox === null || outbox.generation !== send.outboxGeneration) return false;
  const { decision } = outbox;
  if (decision.kind !== "issuing" && decision.kind !== "uncertain") return false;
  const effect = pendingSandboxDispatchEffect(send, dispatch);
  if (JSON.stringify(decision.claim.effect) !== JSON.stringify(effect)) return false;
  return settlePendingSandboxOutboxEffect(actor, decision.claim, outcome);
}

export async function holdPendingSandboxOutboxStop(input: {
  readonly actor: DraftAuthorityActor;
  readonly send: PendingSandboxSend;
  readonly operationId: string;
  readonly hostId: string;
  readonly sandboxId: string;
  readonly attemptId: string;
  readonly observationBoundary: number;
  readonly isCurrent: () => boolean;
}): Promise<DraftAuthorityStopReceipt | null> {
  const {
    actor,
    send,
    operationId,
    hostId,
    sandboxId,
    attemptId,
    observationBoundary,
  } = input;
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (
    outbox === null ||
    outbox.ownership !== "setup" ||
    (outbox.decision.kind !== "waiting" &&
      (outbox.decision.kind !== "stopping" ||
        outbox.decision.outcome?.kind !== "failed")) ||
    (send.outboxGeneration !== undefined &&
      send.outboxGeneration !== outbox.generation) ||
    !input.isCurrent()
  )
    return null;
  const result = await holdDraftAuthorityStop({
    actor,
    operationId,
    sendId: send.id,
    expectedGeneration: outbox.generation,
    hostId,
    sandboxId,
    attemptId,
    observationBoundary,
    ...(outbox.decision.kind === "stopping"
      ? { retryOf: outbox.decision.stop }
      : {}),
  });
  return result.kind === "committed" && draftAuthorityActorIsCurrent(actor)
    ? result.receipt
    : null;
}

export function pendingSandboxStopSettlement(
  outbox: DraftAuthorityOutbox,
): "stopped" | "suspended" | "gone" | undefined {
  if (outbox.decision.kind !== "stopping") return undefined;
  const { outcome } = outbox.decision;
  if (outcome?.kind === "settled") return outcome.state;
  return outcome?.kind === "gone" ? "gone" : undefined;
}

export async function verifyPendingSandboxOutboxStop(
  actor: DraftAuthorityActor,
  stop: DraftAuthorityStopReceipt,
): Promise<boolean> {
  return (
    draftAuthorityActorIsCurrent(actor) &&
    (await readDraftAuthorityStopGrant({ actor, stop })) &&
    draftAuthorityActorIsCurrent(actor)
  );
}

export async function settlePendingSandboxOutboxStop(
  actor: DraftAuthorityActor,
  stop: DraftAuthorityStopReceipt,
  outcome: DraftAuthorityStopOutcome,
): Promise<boolean> {
  if (!draftAuthorityActorIsCurrent(actor)) return false;
  const result = await settleDraftAuthorityStop({ actor, stop, outcome });
  return (
    (result.kind === "committed" || result.kind === "replayed") &&
    draftAuthorityActorIsCurrent(actor)
  );
}

interface PendingSandboxDestroyReceipt {
  readonly actor: DraftAuthorityActor;
  readonly hostId: string;
  readonly sandboxId: string;
  readonly proofId: string;
}

type PendingSandboxDestroyCapture =
  (receipt: PendingSandboxDestroyReceipt) => (() => void) | null;

const destroyCaptures = new Map<string, Set<PendingSandboxDestroyCapture>>();

export function subscribeToPendingSandboxDestroy(
  accountId: string,
  hostId: string,
  sandboxId: string,
  capture: PendingSandboxDestroyCapture,
): () => void {
  const key = JSON.stringify([accountId, hostId, sandboxId]);
  const entries = destroyCaptures.get(key) ?? new Set<PendingSandboxDestroyCapture>();
  entries.add(capture);
  destroyCaptures.set(key, entries);
  return () => {
    entries.delete(capture);
    if (entries.size === 0 && destroyCaptures.get(key) === entries)
      destroyCaptures.delete(key);
  };
}

/** Capture the current pending generations before the exact Destroy issues. */
export function capturePendingSandboxDestroy(
  receipt: PendingSandboxDestroyReceipt,
): () => void {
  const { actor, hostId, sandboxId } = receipt;
  const key = JSON.stringify([actor.accountId, hostId, sandboxId]);
  const settled: Array<() => void> = [];
  for (const capture of destroyCaptures.get(key) ?? []) {
    try {
      const listener = capture(receipt);
      if (listener !== null) settled.push(listener);
    } catch {
      // Pending-send observation is independent of ordinary Destroy.
    }
  }
  return () => {
    if (!draftAuthorityActorIsCurrent(actor)) return;
    for (const listener of settled) {
      try {
        listener();
      } catch {
        // A pending listener cannot change the settled Destroy result.
      }
    }
  };
}

export async function settlePendingSandboxOutboxEnd(input: {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityIssueReceipt;
  readonly evidence: DraftAuthorityHostEndEvidence;
  readonly undeliveredProofId: string;
}): Promise<boolean> {
  const { actor, claim, evidence, undeliveredProofId } = input;
  if (!draftAuthorityActorIsCurrent(actor) || claim.source.kind !== "pending-outbox")
    return false;
  const { sendId } = claim.source;
  const read = await readDraftAuthorityOutbox({ actor, sendId });
  if (
    !draftAuthorityActorIsCurrent(actor) ||
    read.kind !== "current" ||
    read.outbox.ownership !== "dispatch"
  )
    return false;
  const { decision, generation } = read.outbox;
  if (decision.kind === "held" && decision.reason === "host-end") {
    const settled = decision.settlement;
    return settled?.kind === "terminal-undelivered" &&
      settled.proofId === undeliveredProofId &&
      JSON.stringify(settled.issue) === JSON.stringify(claim) &&
      JSON.stringify(decision.evidence) === JSON.stringify(evidence);
  }
  if (
    (decision.kind !== "issuing" && decision.kind !== "uncertain") ||
    decision.claim.operationId !== claim.operationId ||
    decision.claim.issueGeneration !== claim.issueGeneration ||
    decision.claim.executorId !== claim.executorId
  )
    return false;
  const result = await settleDraftAuthorityEffect({
    actor,
    claim,
    outcome: "terminal",
    pendingHostEnd: {
      expectedGeneration: generation,
      evidence,
      undeliveredProofId,
    },
  });
  if (result.kind !== "committed" && result.kind !== "replayed") return false;
  await refreshPendingSandboxOutbox(actor, sendId);
  return draftAuthorityActorIsCurrent(actor);
}

export async function holdPendingSandboxOutboxEnd(input: {
  readonly actor: DraftAuthorityActor;
  readonly send: PendingSandboxSend;
  readonly evidence: DraftAuthorityHostEndEvidence;
  readonly isCurrent: () => boolean;
}): Promise<void> {
  const { actor, send, evidence } = input;
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (
    outbox === null ||
    outbox.generation !== send.outboxGeneration ||
    outbox.ownership !== evidence.ownership ||
    (outbox.decision.kind !== "waiting" && outbox.decision.kind !== "refused") ||
    !input.isCurrent()
  )
    return;
  const result = await holdDraftAuthorityOutboxEnd({
    actor,
    sendId: send.id,
    expectedGeneration: outbox.generation,
    evidence,
  });
  if (result.kind === "committed" || result.kind === "replayed")
    await refreshPendingSandboxOutbox(actor, send.id);
}

export async function cancelPendingSandboxIdleOutbox(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly expectedGeneration: number;
}): Promise<boolean> {
  const { actor, sendId } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return false;
  const result = await cancelDraftAuthorityIdleOutbox(input);
  if (
    (result.kind !== "committed" && result.kind !== "replayed") ||
    !draftAuthorityActorIsCurrent(actor)
  )
    return false;
  const read = await readDraftAuthorityOutbox({ actor, sendId });
  if (
    !draftAuthorityActorIsCurrent(actor) ||
    read.kind !== "retired" ||
    read.marker.accountId !== actor.accountId ||
    read.marker.sendId !== sendId ||
    read.marker.returnId !== null ||
    read.marker.idleCancelled !== true
  )
    return false;
  forgetRetiredProjection(actor.accountId, sendId, null);
  return true;
}

export async function returnPendingSandboxOutbox(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly expectedGeneration: number;
  readonly disposition: DraftAuthorityReturnDisposition;
  readonly isAdmissionCurrent?: () => boolean;
  readonly onStorageRefused?: () => void;
}) {
  const { actor, sendId, expectedGeneration, disposition, isAdmissionCurrent } = input;
  const read = await readDraftAuthorityOutbox({ actor, sendId });
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  // A recorded return retains its authority after the admitting pane closes.
  if (
    read.kind === "current" &&
    read.outbox.generation === expectedGeneration &&
    read.outbox.decision.kind !== "returning" &&
    isAdmissionCurrent?.() === false
  )
    return null;
  const held = read.kind === "current" &&
    read.outbox.generation === expectedGeneration &&
    read.outbox.decision.kind === "held" &&
    read.outbox.decision.reason === "host-end"
      ? read.outbox.decision
      : undefined;
  const recorded = await recordDraftAuthorityReturn({
    actor,
    sendId,
    expectedGeneration,
    disposition,
    ...(held === undefined ? {} : { heldHostEnd: held }),
    ...(isAdmissionCurrent === undefined ? {} : { isAdmissionCurrent }),
  });
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  if (recorded.kind !== "committed" && recorded.kind !== "replayed") {
    if (
      recorded.kind === "unavailable" &&
      read.kind === "current" &&
      read.outbox.generation === expectedGeneration &&
      read.outbox.decision.kind !== "returning" &&
      isAdmissionCurrent?.() !== false
    )
      input.onStorageRefused?.();
    return null;
  }
  return resumePendingSandboxOutboxReturn(actor, sendId, disposition.returnId);
}

interface PendingBrowserCancelAttempt {
  readonly actor: DraftAuthorityActor;
  readonly returnId: string;
  prepared: { readonly generation: number; readonly chatId: string } | null;
  ackUnverified: boolean;
}

const browserCancelAttempts = new Map<string, PendingBrowserCancelAttempt>();
const browserCancelListeners = new Map<string, Set<() => void>>();

export function subscribeToPendingSandboxBrowserCancel(
  sendId: string,
  listener: () => void,
): () => void {
  const listeners = browserCancelListeners.get(sendId) ?? new Set<() => void>();
  listeners.add(listener);
  browserCancelListeners.set(sendId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) browserCancelListeners.delete(sendId);
  };
}

function notifyBrowserCancel(sendId: string): void {
  for (const listener of browserCancelListeners.get(sendId) ?? []) listener();
}

function clearBrowserCancel(sendId: string, attempt: PendingBrowserCancelAttempt): void {
  if (browserCancelAttempts.get(sendId) !== attempt) return;
  browserCancelAttempts.delete(sendId);
  notifyBrowserCancel(sendId);
}

export function pendingSandboxBrowserCancelInFlight(
  actor: DraftAuthorityActor,
  sendId: string,
  returnId: string,
): boolean {
  const attempt = browserCancelAttempts.get(sendId);
  return attempt?.returnId === returnId &&
    attempt.actor.accountId === actor.accountId &&
    attempt.actor.sessionGeneration === actor.sessionGeneration &&
    draftAuthorityActorIsCurrent(actor);
}

export function pendingSandboxBrowserCancelCanRetry(
  actor: DraftAuthorityActor,
  sendId: string,
  returnId: string,
  expectedGeneration: number,
): boolean {
  const attempt = browserCancelAttempts.get(sendId);
  return attempt?.ackUnverified === true &&
    attempt.prepared?.generation === expectedGeneration &&
    pendingSandboxBrowserCancelInFlight(actor, sendId, returnId);
}

type BrowserCancelPreparation =
  | {
      readonly kind: "prepared";
      readonly returnId: string;
      readonly generation: number;
      readonly content: JsonContent;
      readonly browserAnnotations: readonly BrowserAnnotationRecord[];
      readonly bytes: ReadonlyMap<string, Blob>;
    }
  | { readonly kind: "held" };

export async function beginPendingSandboxBrowserCancel(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly expectedGeneration: number;
  readonly disposition: DraftAuthorityReturnDisposition;
  readonly isAdmissionCurrent: () => boolean;
  readonly onStorageRefused?: () => void;
}): Promise<BrowserCancelPreparation> {
  const { actor, sendId, expectedGeneration, disposition } = input;
  const { returnId } = disposition;
  const live = (): boolean =>
    draftAuthorityActorIsCurrent(actor) &&
    pendingSandboxSendHandedHere(sendId) &&
    ownsPendingSandboxSend(sendId) &&
    input.isAdmissionCurrent();
  const previous = browserCancelAttempts.get(sendId);
  if (
    !live() ||
    (previous !== undefined && draftAuthorityActorIsCurrent(previous.actor)) ||
    disposition.primary !== null
  )
    return { kind: "held" };
  const attempt: PendingBrowserCancelAttempt = {
    actor, returnId, prepared: null, ackUnverified: false,
  };
  browserCancelAttempts.set(sendId, attempt);
  let prepared = false;
  let mayHaveRecorded = false;
  try {
    const original = await readDraftAuthorityOutbox({ actor, sendId });
    if (
      !live() ||
      original.kind !== "current" ||
      original.outbox.send.request.kind !== "message" ||
      original.outbox.generation !== expectedGeneration ||
      original.outbox.decision.kind === "returning"
    )
      return { kind: "held" };
    const { chatId } = original.outbox.send.request;
    const recorded = await recordDraftAuthorityReturn({
      actor, sendId, expectedGeneration, disposition, isAdmissionCurrent: live,
    });
    if (recorded.kind === "unavailable" && live()) input.onStorageRefused?.();
    if (
      recorded.kind !== "committed" &&
      recorded.kind !== "replayed" &&
      recorded.kind !== "unverified"
    )
      return { kind: "held" };
    mayHaveRecorded = true;
    const current = recorded.kind === "unverified"
      ? await readDraftAuthorityOutbox({ actor, sendId })
      : { kind: "current" as const, outbox: recorded.receipt };
    if (
      !live() ||
      current.kind !== "current" ||
      current.outbox.decision.kind !== "returning" ||
      current.outbox.decision.disposition.returnId !== returnId
    )
      return { kind: "held" };
    const { generation } = current.outbox;
    const read = await readDraftAuthorityBrowserReturn({
      actor, sendId, returnId, expectedGeneration: generation, chatId,
    });
    if (!live() || read.kind !== "current") return { kind: "held" };
    attempt.prepared = { generation, chatId };
    projectPendingSandboxOutbox(current.outbox);
    prepared = true;
    return {
      kind: "prepared",
      returnId,
      generation,
      content: read.content,
      browserAnnotations: read.browserAnnotations,
      bytes: read.bytes,
    };
  } finally {
    if (!prepared && browserCancelAttempts.get(sendId) === attempt) {
      clearBrowserCancel(sendId, attempt);
      if (mayHaveRecorded && draftAuthorityActorIsCurrent(actor))
        void resumePendingSandboxOutboxReturn(actor, sendId, returnId)
          .catch(() => undefined);
    }
  }
}

export async function acknowledgePendingSandboxBrowserCancel(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly returnId: string;
  readonly expectedGeneration: number;
  readonly chatId: string;
  readonly expectedChat: DraftAuthorityExpectation;
  readonly isInstallationCurrent: () => boolean;
}): Promise<"installed" | "fallback" | "unverified"> {
  const { actor, sendId, returnId, expectedGeneration, chatId } = input;
  const matchesMarker = (marker: {
    readonly accountId: string;
    readonly sendId: string;
    readonly returnId: string | null;
    readonly generation: number;
    readonly browserInstalled?: true;
    readonly browserChatId?: string;
  }): boolean =>
    marker.accountId === actor.accountId &&
    marker.sendId === sendId &&
    marker.returnId === returnId &&
    marker.generation === expectedGeneration + 1 &&
    marker.browserInstalled === true &&
    marker.browserChatId === chatId;

  const candidate = browserCancelAttempts.get(sendId);
  const attempt =
    candidate?.prepared?.generation === expectedGeneration &&
    candidate.prepared.chatId === chatId &&
    pendingSandboxBrowserCancelInFlight(actor, sendId, returnId)
      ? candidate : undefined;
  if (attempt !== undefined) {
    const result = await acknowledgeDraftAuthorityBrowserReturn({
      ...input,
      isInstallationCurrent: () =>
        browserCancelAttempts.get(sendId) === attempt &&
        ownsPendingSandboxSend(sendId) &&
        draftAuthorityActorIsCurrent(actor) &&
        input.isInstallationCurrent(),
    }).catch(() => null);
    if (
      draftAuthorityActorIsCurrent(actor) &&
      (result?.kind === "committed" || result?.kind === "replayed") &&
      matchesMarker(result.receipt)
    ) {
      clearBrowserCancel(sendId, attempt);
      forgetRetiredProjection(actor.accountId, sendId, returnId);
      return "installed";
    }
  }
  const read = await readDraftAuthorityOutbox({ actor, sendId }).catch(() => null);
  if (!draftAuthorityActorIsCurrent(actor)) return "unverified";
  if (read?.kind === "retired" && matchesMarker(read.marker)) {
    if (attempt !== undefined) clearBrowserCancel(sendId, attempt);
    forgetRetiredProjection(actor.accountId, sendId, returnId);
    return "installed";
  }
  const unverified = read?.kind !== "current" && read?.kind !== "retired";
  if (
    attempt !== undefined &&
    browserCancelAttempts.get(sendId) === attempt &&
    attempt.ackUnverified !== unverified
  ) {
    attempt.ackUnverified = unverified;
    notifyBrowserCancel(sendId);
  }
  return unverified ? "unverified" : "fallback";
}

export async function releasePendingSandboxBrowserCancel(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly returnId: string;
}) {
  const { actor, sendId, returnId } = input;
  const attempt = browserCancelAttempts.get(sendId);
  if (
    attempt === undefined ||
    attempt.ackUnverified ||
    !pendingSandboxBrowserCancelInFlight(actor, sendId, returnId)
  )
    return null;
  clearBrowserCancel(sendId, attempt);
  const result = await resumePendingSandboxOutboxReturn(actor, sendId, returnId)
    .catch(() => null);
  if (result?.retired === true && draftAuthorityActorIsCurrent(actor))
    forgetRetiredProjection(actor.accountId, sendId, returnId);
  return result;
}

export async function resumePendingSandboxOutboxReturn(
  actor: DraftAuthorityActor,
  sendId: string,
  returnId: string,
) {
  const prior = await readDraftAuthorityOutbox({ actor, sendId });
  if (!draftAuthorityActorIsCurrent(actor))
    return { publication: { kind: "denied" } as const, retired: false };
  if (pendingSandboxBrowserCancelInFlight(actor, sendId, returnId))
    return { publication: { kind: "unavailable" } as const, retired: false };
  if (prior.kind === "retired") {
    if (prior.marker.returnId !== returnId)
      return { publication: { kind: "denied" } as const, retired: false };
    const completed = await readDraftAuthorityCompletedReturn({
      actor, sendId, returnId,
    });
    if (completed.kind !== "current" || !draftAuthorityActorIsCurrent(actor))
      return { publication: { kind: "unavailable" } as const, retired: false };
    return {
      publication: { kind: "replayed", receipt: completed.receipt } as const,
      retired: true,
    };
  }
  const publication = await publishDraftAuthorityReturn({
    actor,
    sendId,
    returnId,
  });
  if (
    (publication.kind !== "committed" && publication.kind !== "replayed") ||
    !draftAuthorityActorIsCurrent(actor)
  )
    return { publication, retired: false };
  const read = await readDraftAuthorityOutbox({ actor, sendId });
  if (!draftAuthorityActorIsCurrent(actor))
    return { publication, retired: false };
  if (read.kind === "retired")
    return { publication, retired: read.marker.returnId === returnId };
  if (
    read.kind !== "current" ||
    read.outbox.decision.kind !== "returning" ||
    read.outbox.decision.disposition.returnId !== returnId
  )
    return { publication, retired: false };
  const retired = await retireDraftAuthorityPendingSource({
    actor,
    sendId,
    expectedGeneration: read.outbox.generation,
    returnId,
    terminalClaim: null,
  });
  return {
    publication,
    retired:
      (retired.kind === "committed" || retired.kind === "replayed") &&
      draftAuthorityActorIsCurrent(actor),
  };
}

export async function finishPendingSandboxTerminal(
  actor: DraftAuthorityActor,
  send: PendingSandboxSend,
  canSettle: (effect: DraftAuthorityEffectIntent) => Promise<boolean>,
): Promise<boolean> {
  let outbox = await loadPendingSandboxOutbox(actor, send);
  if (outbox === null || send.request.kind !== "terminal") return false;
  const claim =
    outbox.decision.kind === "terminal"
      ? outbox.decision.claim
      : outbox.setupIssue;
  if (claim?.effect.kind !== "terminal") return false;
  if (outbox.decision.kind !== "terminal") {
    if (!(await canSettle(claim.effect)) || !draftAuthorityActorIsCurrent(actor))
      return false;
    if (!(await settlePendingSandboxOutboxEffect(actor, claim, "terminal")))
      return false;
    outbox = await loadPendingSandboxOutbox(actor, send);
    if (outbox?.decision.kind !== "terminal") return false;
  }
  const retired = await retireDraftAuthorityPendingSource({
    actor,
    sendId: send.id,
    expectedGeneration: outbox.generation,
    returnId: null,
    terminalClaim: outbox.decision.claim,
  });
  return (
    (retired.kind === "committed" || retired.kind === "replayed") &&
    draftAuthorityActorIsCurrent(actor)
  );
}

function legacyManifest(send: PendingSandboxSend): DraftAuthorityManifest {
  const digests = new Set(blobHashesFromContent(send.content));
  if (send.request.kind === "message")
    for (const hash of collectAnnotationImageHashes(
      send.request.browserAnnotations ?? [],
    ))
      digests.add(hash);
  return { digests: [...digests] };
}

export async function loadPendingSandboxOutbox(
  actor: DraftAuthorityActor,
  send: PendingSandboxSend,
): Promise<DraftAuthorityOutbox | null> {
  const read = await readDraftAuthorityOutbox({ actor, sendId: send.id });
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  if (read.kind === "current") return read.outbox;
  if (read.kind === "retired") {
    forgetRetiredProjection(actor.accountId, send.id, read.marker.returnId);
    return null;
  }
  if (
    read.kind !== "missing" ||
    send.userId !== actor.accountId ||
    send.delivery !== null ||
    !pendingSandboxLegacyProjectionCurrent(send)
  )
    return null;
  const dispatch = send.dispatch ?? null;
  const actionId = dispatch?.input.initialMessage?.clientActionId ?? send.id;
  const state = await admitLegacyDraftAuthorityOutbox({
    actor,
    actionId,
    send,
    manifest: legacyManifest(send),
    legacyState: legacyPendingState(send, dispatch),
  });
  if (
    (state.kind !== "committed" && state.kind !== "replayed") ||
    !draftAuthorityActorIsCurrent(actor)
  )
    return null;
  return refreshPendingSandboxOutbox(actor, send.id);
}

function legacyPendingState(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch | null,
) {
  if (send.returnRequested !== undefined)
    return { kind: "held" as const, reason: "return" as const };
  if (send.stopRequested === true)
    return { kind: "held" as const, reason: "stop" as const };
  if (dispatch !== null) {
    if (
      dispatch.input.hostId.length === 0 ||
      dispatch.input.chatId.length === 0 ||
      (send.request.kind !== "fork" &&
        (!dispatch.input.initialMessage?.clientActionId ||
          !dispatch.input.initialMessage.messageId)) ||
      (send.request.kind === "message" &&
        (send.request.chatId !== dispatch.input.chatId ||
          (send.request.hostId !== undefined &&
            send.request.hostId !== dispatch.input.hostId)))
    )
      return { kind: "held" as const, reason: "uncertain" as const };
    return {
      kind: "uncertain" as const,
      effect: pendingSandboxDispatchEffect(send, dispatch),
    };
  }
  if (send.ended === true)
    return { kind: "held" as const, reason: "return" as const };
  return { kind: "waiting" as const };
}

function projectPendingSandboxOutbox(outbox: DraftAuthorityOutbox): void {
  const store = usePendingSandboxSendStore.getState();
  if (outbox.decision.kind === "retired") {
    forgetRetiredProjection(outbox.accountId, outbox.sendId, outbox.decision.returnId);
    return;
  }
  const current = store.sends[outbox.sendId];
  if (
    current?.outboxGeneration !== undefined &&
    current.outboxGeneration > outbox.generation
  )
    return;
  const dispatch = outbox.dispatch;
  const delivered =
    outbox.decision.kind === "accepted" && dispatch !== null
      ? dispatch.delivery
      : outbox.send.delivery;
  const next: PendingSandboxSend = {
    ...outbox.send,
    ...current,
    userId: outbox.accountId,
    request: outbox.send.request,
    settings: outbox.send.settings,
    epicConfirmed: outbox.send.epicConfirmed,
    content: outbox.send.content,
    outboxGeneration: outbox.generation,
    outboxSetupBinding: outbox.setupBinding ?? undefined,
    outboxHeldHostEnd: outbox.decision.kind === "held" &&
      outbox.decision.reason === "host-end" ? true : undefined,
    outboxPrimaryIssuing: outbox.decision.kind === "issuing" ? true : undefined,
    outboxStopSettlement: pendingSandboxStopSettlement(outbox),
    ...(outbox.decision.kind === "stopping"
      ? {
          stopRequested: true,
          stopRequestedAt: outbox.decision.stop.observationBoundary,
          stopOperationId: outbox.decision.stop.operationId,
          stopStage: current?.stopStage ??
            useStagedSandboxStore.getState().bySurface[pendingSendSurfaceKey(outbox.sendId)],
        }
      : {}),
    outboxReturnId:
      outbox.decision.kind === "returning"
        ? outbox.decision.disposition.returnId
        : undefined,
    dispatch:
      delivered === null && dispatch !== null
        ? {
            ...dispatch,
            ...(outbox.decision.kind === "refused"
              ? { blocker: "not-sent" as const }
              : {}),
            status:
              outbox.decision.kind === "refused" ||
              outbox.decision.kind === "uncertain"
                ? "uncertain"
                : (current?.dispatch?.status ?? dispatch.status),
          }
        : null,
    delivery: delivered,
  };
  if (JSON.stringify(current) !== JSON.stringify(next)) store.add(next);
}

function forgetRetiredProjection(
  accountId: string,
  sendId: string,
  returnId: string | null,
): void {
  const attempt = browserCancelAttempts.get(sendId);
  // Keep the exact Retry mounted until the pressing renderer resolves its ACK.
  if (
    attempt?.returnId === returnId &&
    attempt.actor.accountId === accountId &&
    draftAuthorityActorIsCurrent(attempt.actor)
  )
    return;
  const store = usePendingSandboxSendStore.getState();
  const send = store.sends[sendId];
  if (send !== undefined && send.userId !== accountId) return;
  store.forgetProjection(sendId);
  useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(sendId));
}

async function refreshPendingSandboxOutbox(
  actor: DraftAuthorityActor,
  sendId: string,
): Promise<DraftAuthorityOutbox | null> {
  const read = await readDraftAuthorityOutbox({ actor, sendId });
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  if (read.kind === "retired")
    forgetRetiredProjection(actor.accountId, sendId, read.marker.returnId);
  if (read.kind !== "current") return null;
  projectPendingSandboxOutbox(read.outbox);
  return read.outbox;
}

export function startPendingSandboxOutboxProjection(accountId: string): () => void {
  function activeActor(): DraftAuthorityActor | null {
    const actor = captureDraftAuthorityActor();
    return actor?.accountId === accountId ? actor : null;
  }
  async function refresh(): Promise<void> {
    const actor = activeActor();
    if (actor === null) return;
    const result = await listDraftAuthorityOutboxes(actor);
    if (result.kind !== "current" || !draftAuthorityActorIsCurrent(actor)) return;
    await Promise.all(
      result.outboxes.map((outbox) =>
        refreshPendingSandboxOutbox(actor, outbox.sendId),
      ),
    );
  }
  const unsubscribe = subscribeToDraftAuthorityOutboxChanges(accountId, (sendId) => {
    const actor = activeActor();
    if (actor !== null)
      void refreshPendingSandboxOutbox(actor, sendId).catch(() => undefined);
  });
  const refreshOnFocus = (): void => void refresh().catch(() => undefined);
  window.addEventListener("focus", refreshOnFocus);
  refreshOnFocus();
  return () => {
    unsubscribe();
    window.removeEventListener("focus", refreshOnFocus);
  };
}
