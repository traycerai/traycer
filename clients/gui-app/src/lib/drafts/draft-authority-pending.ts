import { z } from "zod";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  createEpicRequestSchemaV15,
  createEpicResponseSchemaV12,
  createTuiAgentRequestSchema,
  createTuiAgentResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  prepareTuiLaunchRequestSchemaV11,
  prepareTuiLaunchResponseSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import {
  worktreeBindingSchema,
  worktreeCreateRequestSchema,
  worktreeCreateResponseSchema,
} from "@traycer/protocol/host/worktree-schemas";
import type {
  PendingSandboxSend,
  PendingSandboxSendDispatch,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { persistKey } from "@/lib/persist/keys";
import {
  collectAnnotationImageHashes,
  parseBrowserAnnotationRecords,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import {
  draftAuthorityCanvasKey,
  draftAuthorityCanvasScopeSchema,
  readDraftAuthorityCanvasSidecar,
  writeDraftAuthorityCanvasSidecar,
  type DraftAuthorityCanvasScope,
} from "./draft-authority-sidecar";
import { isJsonContent, isRecord } from "@/lib/editor/prosemirror-json";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import {
  parseReturnedSandbox,
  returnedSandboxForDraft,
  type StoredReturnedSandbox,
} from "@/lib/sandboxes/returned-sandbox";
import { LANDING_IMAGE_BUDGET_BYTES } from "@/lib/composer/landing-image-budget";
import {
  draftAuthorityExpectationMatches,
  draftAuthorityIntentDigest,
  draftAuthorityKey,
  notifyDraftAuthorityChange,
  readDraftAuthorityRecord,
  readDraftAuthorityEditReceipt,
  sameDraftAuthoritySlot,
  writeDraftAuthority,
} from "./draft-authority";
import {
  runDraftAuthorityTransaction,
  type DraftAuthorityTransaction,
} from "./draft-authority-db";
import { draftAuthorityActorIsCurrent } from "./draft-authority-session";
import type {
  DraftAuthorityActor,
  DraftAuthorityBorrowedStore,
  DraftAuthorityEditReceipt,
  DraftAuthorityEffectSource,
  DraftAuthorityExpectation,
  DraftAuthorityManifest,
  DraftAuthorityMutationResult,
  DraftAuthorityPayload,
  DraftAuthorityRecord,
  DraftAuthoritySlot,
  DraftAuthorityVerifiedBlob,
  DraftAuthorityVersion,
} from "./draft-authority-types";
import { mintDraftId } from "./draft-ids";
import { applyRecoveryRoots, readRecoveryBlobs, RecoveryBlobError } from "./recovery-blob-store";

export { consumeAcceptedRestoredStart } from "./draft-authority";
export type {
  ConsumeAcceptedRestoredStartInput,
  DraftAuthorityRestoredStartTaskMirrorBinding,
} from "./draft-authority";

export interface DraftAuthorityEffectIntent {
  readonly kind: "create" | "wake" | "terminal" | "send";
  readonly phase: "setup" | "dispatch";
  readonly identity: string;
  readonly payload: DraftAuthorityPayload;
}

interface IssueIdentity {
  readonly operationId: string;
  readonly issueGeneration: number;
  readonly executorId: string;
}

export interface DraftAuthorityIssueReceipt extends IssueIdentity {
  readonly accountId: string;
  readonly sessionGeneration: string;
  readonly auxiliaryFor: IssueIdentity | null;
  readonly linkedPrimary: IssueIdentity | null;
  readonly auxiliaryKind: "dispatch-wake" | "manual-terminal" | null;
  readonly checkpointVersion: DraftAuthorityVersion | null;
  readonly source: DraftAuthorityEffectSource;
  readonly effect: DraftAuthorityEffectIntent;
  readonly outboxGeneration: number | null;
  readonly setupAttempt?: DraftAuthoritySetupAttempt;
  readonly restoredPredecessor?: DraftAuthorityRestoredIssuePredecessor;
}

export interface DraftAuthorityRestoredIssuePredecessor extends IssueIdentity {
  readonly createKey: string;
}

export interface DraftAuthorityRestoredPredecessor {
  readonly kind: "signed-rest" | "authorized-send";
  readonly claim: DraftAuthorityIssueReceipt;
  readonly hostId: string;
  readonly sandboxId: string;
  readonly attemptId: string;
  readonly observationGeneration: number;
  readonly proofId: string;
}

interface ReturnTarget {
  readonly expected: DraftAuthorityExpectation;
  readonly occurrence: string;
  readonly payload: DraftAuthorityPayload;
  readonly manifest: DraftAuthorityManifest;
  readonly returnAccountId: string | null;
  readonly clearanceOperationId?: string;
  readonly canvasSidecar?: {
    readonly scope: DraftAuthorityCanvasScope;
    readonly expectedVersion: string | null;
    readonly annotations: readonly BrowserAnnotationRecord[];
  };
}

export type DraftAuthorityReturnEvidence = Readonly<z.infer<typeof returnEvidenceSchema>>;

export interface DraftAuthorityReturnDisposition {
  readonly returnId: string;
  readonly primary: ReturnTarget | null;
  readonly fallback: ReturnTarget | null;
  readonly recoveryBytes: boolean;
  readonly stopOperationId?: string;
  readonly legacyTaskLoss?: { readonly epicId: string };
  readonly evidence?: DraftAuthorityReturnEvidence;
}

export interface DraftAuthorityReturnReceipt {
  readonly accountId: string;
  readonly sendId: string;
  readonly returnId: string;
  readonly draft: DraftAuthorityVersion;
}

export interface DraftAuthorityStopReceipt {
  readonly accountId: string;
  readonly sessionGeneration: string;
  readonly operationId: string;
  readonly executorId: string;
  readonly sendId: string;
  readonly generation: number;
  readonly attemptId: string;
  readonly hostId: string;
  readonly sandboxId: string;
  readonly observationBoundary: number;
}

export type DraftAuthorityStopOutcome =
  | { readonly kind: "settled"; readonly state: "stopped" | "suspended" }
  | { readonly kind: "gone" | "moving" | "failed" | "unknown" };

export type DraftAuthorityPendingDecision =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "stopping";
      readonly stop: DraftAuthorityStopReceipt;
      readonly outcome: DraftAuthorityStopOutcome | null;
    }
  | { readonly kind: "held"; readonly reason: "stop" | "return" | "uncertain" }
  | DraftAuthorityHostEndHold
  | {
      readonly kind: "issuing" | "uncertain" | "refused" | "accepted" | "terminal";
      readonly claim: DraftAuthorityIssueReceipt;
    }
  | {
      readonly kind: "returning";
      readonly disposition: DraftAuthorityReturnDisposition;
    };

export interface DraftAuthorityOutboxSubmission {
  readonly content: JsonContent;
  readonly manifest: DraftAuthorityManifest;
}

export interface DraftAuthorityOutbox {
  readonly accountId: string;
  readonly actionId: string;
  readonly sendId: string;
  readonly source: DraftAuthorityVersion | null;
  readonly generation: number;
  readonly ownership: "setup" | "dispatch";
  readonly dispatch: PendingSandboxSendDispatch | null;
  readonly setupBinding?: DraftAuthorityPendingSetupBinding;
  readonly setupIssue: DraftAuthorityIssueReceipt | null;
  readonly dispatchWakeIssue: DraftAuthorityIssueReceipt | null;
  readonly manualTerminalIssue: DraftAuthorityIssueReceipt | null;
  readonly decision: DraftAuthorityPendingDecision;
  readonly send: PendingSandboxSend;
  readonly submission?: DraftAuthorityOutboxSubmission;
  readonly epicPrerequisite?: DraftAuthorityPendingEpicPrerequisite;
  readonly epicConfirmation?: DraftAuthorityPendingEpicConfirmation;
  readonly manifest: DraftAuthorityManifest;
  readonly byteCustody: boolean;
}

export interface PublishDraftAuthorityOutboxInput {
  readonly actor: DraftAuthorityActor;
  readonly actionId: string;
  readonly expectedSource: DraftAuthorityExpectation | null;
  readonly send: PendingSandboxSend;
  readonly setupBinding?: DraftAuthorityPendingSetupBinding;
  readonly submission?: DraftAuthorityOutboxSubmission;
  readonly epicPrerequisite?: DraftAuthorityPendingEpicPrerequisite;
  readonly restoredPredecessor?: DraftAuthorityRestoredPredecessor;
  readonly isSuccessorCurrent?: () => boolean;
  readonly manifest: DraftAuthorityManifest;
  readonly verified: readonly DraftAuthorityVerifiedBlob[];
}

export interface TransferDraftAuthorityOutboxInput {
  readonly actor: DraftAuthorityActor;
  readonly operationId: string;
  readonly sendId: string;
  readonly expectedGeneration: number;
  readonly dispatch: PendingSandboxSendDispatch;
}

export interface ClaimDraftAuthorityEffectInput {
  readonly actor: DraftAuthorityActor;
  readonly operationId: string;
  readonly source: DraftAuthorityEffectSource;
  readonly effect: DraftAuthorityEffectIntent;
  readonly expectedIssueGeneration: number | null;
  readonly recovery: "initial" | "exact-replay" | "explicit-retry";
  readonly auxiliaryFor?: DraftAuthorityIssueReceipt | null;
  readonly checkpoint?: StoredReturnedSandbox;
  readonly setupAttempt?: DraftAuthoritySetupAttempt;
  readonly previousSetupAttempt?: DraftAuthoritySetupAttempt;
  readonly restoredPredecessor?: DraftAuthorityRestoredPredecessor;
  readonly isSuccessorCurrent?: () => boolean;
}

type EffectOutcome = "accepted" | "refused" | "uncertain" | "terminal";

export interface SettleDraftAuthorityEffectInput {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityIssueReceipt;
  readonly outcome: EffectOutcome;
  readonly acceptance?: { readonly sandboxId: string; readonly hostId: string | null };
  readonly pendingHostEnd?: DraftAuthorityPendingHostEndSettlement;
}

interface ReadOutboxInput {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
}

export interface DraftAuthorityRetiredOutbox {
  readonly accountId: string;
  readonly sendId: string;
  readonly generation: number;
  readonly returnId: string | null;
  readonly idleCancelled?: true;
  readonly browserInstalled?: true;
  readonly browserChatId?: string;
}

export type DraftAuthorityOutboxRead =
  | { readonly kind: "current"; readonly outbox: DraftAuthorityOutbox }
  | { readonly kind: "retired"; readonly marker: DraftAuthorityRetiredOutbox }
  | { readonly kind: "missing" | "denied" | "unavailable" };

interface OutboxMutationInput extends ReadOutboxInput {
  readonly expectedGeneration: number;
}

type OutboxResult = DraftAuthorityMutationResult<
  DraftAuthorityOutbox,
  DraftAuthorityOutbox
>;

const slot = z.object({
  kind: z.enum(["task", "chat", "landing"]),
  id: z.string().min(1),
});
const version = z.object({
  slot,
  occurrence: z.string().min(1),
  version: z.string().min(1),
});
const manifest = z.object({ digests: z.array(z.string()) });
const expectation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent"), slot }),
  z.object({ kind: z.literal("current"), draft: version }),
]);
const effectSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("restored-draft"),
    draft: version,
    returnAccountId: z.string(),
  }),
  z.object({
    kind: z.literal("pending-outbox"),
    sendId: z.string(),
    generation: z.number().int().positive(),
  }),
]);
const effectIntent = z.object({
  kind: z.enum(["create", "wake", "terminal", "send"]),
  phase: z.enum(["setup", "dispatch"]),
  identity: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
const issueIdentitySchema = z.object({
  operationId: z.string(),
  issueGeneration: z.number().int().positive(),
  executorId: z.string(),
});
const setupAttemptSchema = z.object({
  attemptId: z.string().min(1),
  observationGeneration: z.number().int().nonnegative(),
});
export type DraftAuthoritySetupAttempt = Readonly<z.infer<typeof setupAttemptSchema>>;

const issueReceipt = z.object({
  accountId: z.string(),
  sessionGeneration: z.string(),
  operationId: z.string(),
  issueGeneration: z.number().int().positive(),
  executorId: z.string(),
  auxiliaryKind: z.enum(["dispatch-wake", "manual-terminal"]).nullable(),
  auxiliaryFor: issueIdentitySchema.nullable(),
  linkedPrimary: issueIdentitySchema.nullable(),
  source: effectSource,
  effect: effectIntent,
  outboxGeneration: z.number().int().positive().nullable(),
  checkpointVersion: version.nullable(),
  setupAttempt: setupAttemptSchema.optional(),
  restoredPredecessor: issueIdentitySchema.extend({ createKey: z.string().min(1) }).optional(),
});
const returnTarget = z.object({
  expected: expectation,
  occurrence: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  manifest,
  returnAccountId: z.string().nullable(),
  clearanceOperationId: z.string().min(1).optional(),
  canvasSidecar: z.object({
    scope: draftAuthorityCanvasScopeSchema,
    expectedVersion: z.string().nullable(),
    annotations: z.array(z.unknown()).transform((values, context) => {
      const annotations = parseBrowserAnnotationRecords(values);
      if (annotations.length !== values.length ||
        annotations.some((annotation) => annotation.source.kind !== "canvas")) {
        context.addIssue({ code: "custom", message: "Invalid canvas annotations" });
        return z.NEVER;
      }
      return annotations;
    }),
  }).optional(),
});
const returnEvidenceBinding = setupAttemptSchema.extend({
  hostId: z.string().min(1),
  sandboxId: z.string().min(1),
});
const returnEvidenceSchema = z.discriminatedUnion("kind", [
  returnEvidenceBinding.extend({
    kind: z.enum(["setup-destroy", "setup-host-end", "dispatch-host-end"]),
  }),
  returnEvidenceBinding.extend({
    kind: z.literal("legacy-stop-rest"),
    state: z.enum(["stopped", "suspended"]),
    proofId: z.string().min(1),
  }),
]);
const dispositionSchema = z.object({
  returnId: z.string().min(1),
  primary: returnTarget.nullable(),
  fallback: returnTarget.nullable(),
  recoveryBytes: z.boolean(),
  stopOperationId: z.string().min(1).optional(),
  legacyTaskLoss: z.object({ epicId: z.string().min(1) }).optional(),
  evidence: returnEvidenceSchema.optional(),
});
function hasReturnTarget(disposition: DraftAuthorityReturnDisposition): boolean {
  return disposition.primary !== null || disposition.fallback !== null;
}

const returnReceiptSchema = z.object({
  accountId: z.string(),
  sendId: z.string(),
  returnId: z.string(),
  draft: version,
});
const dispatchSchema = z.custom<PendingSandboxSendDispatch>(
  (value) =>
    isRecord(value) &&
    isRecord(value.input) &&
    isRecord(value.delivery) &&
    (value.status === "sending" || value.status === "uncertain"),
);
const sendSchema = z.custom<PendingSandboxSend>(
  (value) =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.userId === "string" &&
    typeof value.epicId === "string" &&
    isRecord(value.request) &&
    isRecord(value.content) &&
    isRecord(value.settings),
);
const stopReceiptSchema = z.object({
  accountId: z.string(),
  sessionGeneration: z.string(),
  operationId: z.string(),
  executorId: z.string(),
  sendId: z.string(),
  generation: z.number().int().positive(),
  attemptId: z.string().min(1),
  hostId: z.string().min(1),
  sandboxId: z.string().min(1),
  observationBoundary: z.number().nonnegative(),
});
const stopOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settled"), state: z.enum(["stopped", "suspended"]) }),
  z.object({ kind: z.enum(["gone", "moving", "failed", "unknown"]) }),
]);
const setupBindingSchema = setupAttemptSchema.extend({
  hostId: z.string().min(1),
  sandboxId: z.string().min(1),
});
export type DraftAuthorityPendingSetupBinding = Readonly<z.infer<typeof setupBindingSchema>>;

const hostEndEvidenceSchema = setupBindingSchema.extend({
  kind: z.enum(["signed-terminal", "settled-destroy"]),
  ownership: z.enum(["setup", "dispatch"]),
  proofId: z.string().min(1),
});
export type DraftAuthorityHostEndEvidence = Readonly<z.infer<typeof hostEndEvidenceSchema>>;

export interface DraftAuthorityPendingHostEndSettlement {
  readonly expectedGeneration: number;
  readonly evidence: DraftAuthorityHostEndEvidence;
  readonly undeliveredProofId: string;
}

const hostEndSettlementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refused"), issue: issueIdentitySchema }),
  z.object({
    kind: z.literal("terminal-undelivered"),
    issue: issueIdentitySchema,
    proofId: z.string().min(1),
  }),
]);
const hostEndHoldSchema = z.object({
  kind: z.literal("held"),
  reason: z.literal("host-end"),
  fromGeneration: z.number().int().positive(),
  evidence: hostEndEvidenceSchema,
  settlement: hostEndSettlementSchema.nullable(),
});
export type DraftAuthorityHostEndHold = Readonly<z.infer<typeof hostEndHoldSchema>>;

const pendingDecision = z.union([
  z.object({ kind: z.literal("waiting") }),
  z.object({
    kind: z.literal("stopping"),
    stop: stopReceiptSchema,
    outcome: stopOutcomeSchema.nullable(),
  }),
  z.object({ kind: z.literal("held"), reason: z.enum(["stop", "return", "uncertain"]) }),
  hostEndHoldSchema,
  z.object({
    kind: z.enum(["issuing", "uncertain", "refused", "accepted", "terminal"]),
    claim: issueReceipt,
  }),
  z.object({ kind: z.literal("returning"), disposition: dispositionSchema }),
]);
const submissionSchema = z.object({
  content: z.custom<JsonContent>((value) => isJsonContent(value, 0) && value.type === "doc"),
  manifest,
});
const pendingEpicPrerequisiteSchema = z.object({
  hostId: z.string().min(1),
  createKey: z.string().min(1),
  sandboxTeamId: z.string().min(1).nullable(),
  attachmentHostId: z.string().min(1).nullable(),
});
export type DraftAuthorityPendingEpicPrerequisite =
  Readonly<z.infer<typeof pendingEpicPrerequisiteSchema>>;

const pendingEpicAttachmentSchema = z.object({
  hostId: z.string().min(1),
  teamId: z.string().min(1),
});
const pendingEpicEvidenceSchema = z.object({
  epicId: z.string().min(1),
  hostId: z.string().min(1),
  createKey: z.string().min(1),
  createdOwnerTeamId: z.string().min(1).nullable(),
  attachment: z.discriminatedUnion("kind", [
    pendingEpicAttachmentSchema.extend({
      kind: z.literal("accepted"),
      environmentId: z.string().min(1),
    }),
    pendingEpicAttachmentSchema.extend({
      kind: z.literal("unsupported"),
    }),
  ]).nullable(),
});
export type DraftAuthorityPendingEpicEvidence = Readonly<z.infer<typeof pendingEpicEvidenceSchema>>;

const pendingEpicConfirmationSchema = z.object({
  fromGeneration: z.number().int().positive(),
  evidence: pendingEpicEvidenceSchema,
});
export type DraftAuthorityPendingEpicConfirmation =
  Readonly<z.infer<typeof pendingEpicConfirmationSchema>>;

const outboxSchema = z.object({
  accountId: z.string(),
  actionId: z.string(),
  sendId: z.string(),
  source: version.nullable(),
  generation: z.number().int().positive(),
  ownership: z.enum(["setup", "dispatch"]),
  dispatch: dispatchSchema.nullable(),
  setupBinding: setupBindingSchema.optional(),
  setupIssue: issueReceipt.nullable(),
  dispatchWakeIssue: issueReceipt.nullable(),
  manualTerminalIssue: issueReceipt.nullable(),
  decision: pendingDecision,
  send: sendSchema,
  submission: submissionSchema.optional(),
  epicPrerequisite: pendingEpicPrerequisiteSchema.optional(),
  epicConfirmation: pendingEpicConfirmationSchema.optional(),
  manifest,
  byteCustody: z.boolean(),
});
const retiredOutboxSchema = z.object({
  kind: z.literal("retired"),
  accountId: z.string(),
  sendId: z.string(),
  generation: z.number().int().positive(),
  returnId: z.string().nullable(),
  idleCancelled: z.literal(true).optional(),
  browserInstalled: z.literal(true).optional(),
  browserChatId: z.string().min(1).optional(),
});
const claimSchema = z.object({
  receipt: issueReceipt,
  state: z.enum(["issuing", "accepted", "refused", "uncertain", "terminal"]),
  intent: z.string(),
  acceptance: z.object({
    sandboxId: z.string().min(1),
    hostId: z.string().nullable(),
  }).nullable(),
});

type PendingStore = DraftAuthorityBorrowedStore<IDBValidKey>;

function outboxKey(accountId: string, sendId: string): IDBValidKey {
  return [accountId, sendId];
}

function primaryKey(draft: DraftAuthorityVersion): IDBValidKey {
  return ["primary", draft.slot.kind, draft.slot.id, draft.occurrence, draft.version];
}

function issueKey(accountId: string, operationId: string): IDBValidKey {
  return ["issue", accountId, operationId];
}

function outboxIssueKey(accountId: string, sendId: string, operationId: string): IDBValidKey {
  return ["outbox-issue", accountId, sendId, operationId];
}

async function readOutbox(
  store: PendingStore,
  accountId: string,
  sendId: string,
): Promise<DraftAuthorityOutbox | null> {
  const saved = await store.read(outboxKey(accountId, sendId));
  if (saved === undefined || retiredOutboxSchema.safeParse(saved).success) return null;
  const outbox = outboxSchema.parse(saved);
  if (
    outbox.accountId !== accountId ||
    outbox.sendId !== sendId ||
    outbox.send.userId !== accountId ||
    outbox.send.id !== sendId
  ) {
    throw new Error("Durable pending record has mismatched identity");
  }
  return outbox;
}

function writeOutbox(store: PendingStore, outbox: DraftAuthorityOutbox): Promise<void> {
  return store.write(outboxKey(outbox.accountId, outbox.sendId), outbox);
}

function expectedSlot(expected: DraftAuthorityExpectation): DraftAuthoritySlot {
  return expected.kind === "absent" ? expected.slot : expected.draft.slot;
}

export async function readDraftAuthorityOutbox(
  input: ReadOutboxInput,
): Promise<DraftAuthorityOutboxRead> {
  const { actor, sendId } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const result = await runDraftAuthorityTransaction(
    ["pending"],
    "readonly",
    async ({ pending }): Promise<DraftAuthorityOutboxRead> => {
      const marker = retiredOutboxSchema.safeParse(
        await pending.read(outboxKey(actor.accountId, sendId)),
      );
      if (marker.success) return { kind: "retired", marker: marker.data };
      const outbox = await readOutbox(pending, actor.accountId, sendId);
      return outbox === null ? { kind: "missing" } : { kind: "current", outbox };
    },
  );
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  return result.kind === "complete" ? result.value : { kind: "unavailable" };
}

function hashOnlyDocumentDigests(content: JsonContent): Set<string> | null {
  const digests = new Set<string>();
  const remaining = [content];
  while (remaining.length > 0) {
    const node = remaining.pop();
    if (node === undefined) break;
    if (node.type === "imageAttachment") {
      const { hash, b64content } = node.attrs ?? {};
      if (typeof hash !== "string" || hash.length === 0 ||
        (b64content != null && b64content !== "")) return null;
      digests.add(hash);
    }
    for (const child of node.content ?? []) remaining.push(child);
  }
  return digests;
}

function manifestMatchesDigests(
  manifest: DraftAuthorityManifest,
  digests: ReadonlySet<string>,
): boolean {
  return manifest.digests.length === digests.size &&
    new Set(manifest.digests).size === digests.size &&
    manifest.digests.every((digest) => digests.has(digest));
}

function requiresOutboxSubmission(send: PendingSandboxSend): boolean {
  return send.request.kind === "message" && (send.request.browserAnnotations?.length ?? 0) > 0;
}

function validOutboxSubmission(
  send: PendingSandboxSend,
  submission: DraftAuthorityOutboxSubmission | undefined,
  roots: DraftAuthorityManifest,
): boolean {
  const raw = send.request.kind === "message" ? send.request.browserAnnotations : undefined;
  if (submission === undefined) return !requiresOutboxSubmission(send);
  if (send.request.kind !== "message" || raw === undefined || raw.length === 0 ||
    !isJsonContent(send.content, 0)) return false;
  const annotations = parseBrowserAnnotationRecords(raw);
  if (annotations.length !== raw.length) return false;
  const wire = hashOnlyDocumentDigests(submission.content);
  const restore = hashOnlyDocumentDigests(send.content);
  if (wire === null || restore === null || !manifestMatchesDigests(submission.manifest, wire) ||
    annotations.some(({ imageHash, imageFileName }) =>
      imageHash !== null && imageFileName !== null && !wire.has(imageHash))) {
    return false;
  }
  return manifestMatchesDigests(roots, new Set([
    ...wire,
    ...restore,
    ...collectAnnotationImageHashes(annotations),
  ]));
}

export type DraftAuthorityOutboxSubmissionRead =
  | {
      readonly kind: "current";
      readonly generation: number;
      readonly submission: DraftAuthorityOutboxSubmission;
      readonly bytes: ReadonlyMap<string, Blob>;
    }
  | { readonly kind: "missing" | "missing-submission" | "stale" | "denied" | "missing-bytes" | "unavailable" };

export async function readDraftAuthorityOutboxSubmission(input: OutboxMutationInput & {
  readonly claim?: DraftAuthorityIssueReceipt;
}): Promise<DraftAuthorityOutboxSubmissionRead> {
  const { actor, sendId, expectedGeneration, claim } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const result = await runDraftAuthorityTransaction(
    ["pending", "claims", "recovery"],
    "readonly",
    async ({ pending, claims, recovery }): Promise<DraftAuthorityOutboxSubmissionRead> => {
      const outbox = await readOutbox(pending, actor.accountId, sendId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (outbox === null) return { kind: "missing" };
      if (outbox.generation !== expectedGeneration) return { kind: "stale" };
      if (outbox.ownership === "setup") {
        if (claim !== undefined || outbox.decision.kind !== "waiting" || !outbox.send.epicConfirmed) {
          return { kind: "stale" };
        }
      } else {
        const decision = outbox.decision;
        if (claim === undefined || claim.accountId !== actor.accountId ||
          (decision.kind !== "issuing" && decision.kind !== "uncertain") ||
          !sameIssue(decision.claim, claim)) return { kind: "stale" };
        const saved = await readIssue(claims, actor.accountId, claim.operationId);
        if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
        if (saved === null || saved.state !== decision.kind || !sameIssue(saved.receipt, decision.claim)) {
          return { kind: "stale" };
        }
      }
      const submission = outbox.submission;
      if (submission === undefined) return { kind: "missing-submission" };
      const digests = submission.manifest.digests;
      if (digests.length > 0 && (!outbox.byteCustody ||
        !digests.every((digest) => outbox.manifest.digests.includes(digest)))) {
        return { kind: "missing-bytes" };
      }
      const bytes = digests.length === 0 ? new Map<string, Blob>() : await readRecoveryBlobs(recovery, {
        accountId: actor.accountId,
        byteLimit: LANDING_IMAGE_BUDGET_BYTES,
        digests,
      });
      return { kind: "current", generation: outbox.generation, submission, bytes };
    },
  );
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  if (result.kind === "complete") return result.value;
  return result.cause instanceof RecoveryBlobError && result.cause.kind === "missing"
    ? { kind: "missing-bytes" }
    : { kind: "unavailable" };
}

function restoredSuccessorIntent(predecessor: DraftAuthorityRestoredPredecessor | undefined):
  readonly (string | number)[] | undefined {
  if (predecessor === undefined) return undefined;
  const { kind, claim, hostId, sandboxId, attemptId, observationGeneration, proofId } = predecessor;
  return [
    kind, claim.accountId, claim.sessionGeneration, claim.operationId, claim.issueGeneration,
    claim.executorId, hostId, sandboxId, attemptId, observationGeneration, proofId,
  ];
}

async function readEligibleRestoredPredecessor(
  claims: PendingStore,
  current: DraftAuthorityRecord | null,
  reserved: unknown,
  actor: DraftAuthorityActor,
  witness: DraftAuthorityRestoredPredecessor,
): Promise<DraftAuthorityIssueReceipt | null> {
  const { claim, hostId, sandboxId, attemptId, observationGeneration, proofId } = witness;
  if (current?.kind !== "live" || current.returnAccountId !== actor.accountId ||
    reserved !== claim.operationId || claim.accountId !== actor.accountId ||
    !Number.isSafeInteger(observationGeneration) || proofId.length === 0) return null;
  const prior = await readIssue(claims, actor.accountId, claim.operationId);
  if (prior === null || !sameIssue(prior.receipt, claim) ||
    prior.receipt.sessionGeneration !== claim.sessionGeneration ||
    prior.receipt.source.kind !== "restored-draft" ||
    prior.receipt.source.returnAccountId !== actor.accountId ||
    prior.receipt.linkedPrimary !== null || prior.receipt.effect.phase !== "setup" ||
    !draftAuthorityExpectationMatches(current, {
      kind: "current",
      draft: prior.receipt.checkpointVersion ?? prior.receipt.source.draft,
    })) return null;
  const attempt = prior.receipt.setupAttempt;
  if (attempt === undefined || attempt.attemptId !== attemptId ||
    observationGeneration < attempt.observationGeneration) return null;

  const effect = prior.receipt.effect;
  if (witness.kind === "signed-rest" &&
    (effect.kind !== "create" || effect.identity.length === 0 ||
      observationGeneration <= attempt.observationGeneration)) return null;
  if (effect.kind === "terminal") {
    if (prior.state !== "terminal" || effect.payload.hostId !== hostId ||
      effect.payload.sandboxId !== sandboxId) return null;
  } else if ((effect.kind !== "create" && effect.kind !== "wake") ||
    prior.state !== "accepted" || prior.acceptance === null ||
    prior.acceptance.hostId !== hostId || prior.acceptance.sandboxId !== sandboxId) {
    return null;
  }

  if (await claims.read(restoredActionKey(actor.accountId, prior.receipt)) !== undefined) {
    return null;
  }
  const linkedId = await claims.read(restoredTerminalKey(actor.accountId, prior.receipt));
  if (linkedId !== undefined) {
    if (typeof linkedId !== "string") return null;
    const linked = await readIssue(claims, actor.accountId, linkedId);
    if (linked?.state !== "terminal" || linked.receipt.source.kind !== "restored-draft" ||
      linked.receipt.linkedPrimary === null ||
      !sameIssueIdentity(linked.receipt.linkedPrimary, prior.receipt) ||
      !draftAuthorityExpectationMatches(current, {
        kind: "current", draft: linked.receipt.source.draft,
      }) ||
      linked.receipt.effect.kind !== "terminal" || linked.receipt.effect.payload.hostId !== hostId ||
      linked.receipt.effect.payload.sandboxId !== sandboxId) return null;
  }
  return prior.receipt;
}

class RestoredSuccessorBecameStale extends Error {}

const outboxPublicationReceiptSchema = z.object({
  intent: z.string(),
  byteCustody: z.boolean(),
});

export async function publishDraftAuthorityOutbox(
  input: PublishDraftAuthorityOutboxInput,
): Promise<OutboxResult> {
  const {
    actor, send, actionId, expectedSource, manifest: roots, verified,
    restoredPredecessor, isSuccessorCurrent,
  } = input;
  if (!draftAuthorityActorIsCurrent(actor) || send.userId !== actor.accountId) {
    return { kind: "denied" };
  }

  if (restoredPredecessor !== undefined &&
    (restoredPredecessor.kind !== "authorized-send" ||
      restoredPredecessor.proofId !== send.id ||
      restoredPredecessor.claim.operationId === actionId ||
      expectedSource?.kind !== "current" || isSuccessorCurrent === undefined ||
      (send.request.kind !== "chat" && send.request.kind !== "message"))) {
    return { kind: "invalid" };
  }
  const binding = setupBindingSchema.optional().safeParse(input.setupBinding);
  if (!binding.success) return { kind: "invalid" };
  const setupBinding = binding.data;
  const parsedSubmission = submissionSchema.optional().safeParse(input.submission);
  if (!parsedSubmission.success || !validOutboxSubmission(send, parsedSubmission.data, roots)) {
    return { kind: "invalid" };
  }
  const submission = parsedSubmission.data;
  const parsedEpic = pendingEpicPrerequisiteSchema.optional().safeParse(input.epicPrerequisite);
  if (!parsedEpic.success || (parsedEpic.data !== undefined && send.epicConfirmed)) {
    return { kind: "invalid" };
  }
  const epicPrerequisite = parsedEpic.data;
  const intent = await draftAuthorityIntentDigest({
    send, actionId, expectedSource, roots, setupBinding, submission, epicPrerequisite,
    restoredSuccessor: restoredSuccessorIntent(restoredPredecessor),
  });
  const key = ["outbox", actor.accountId, send.id];
  const initialByteCustody =
    roots.digests.length > 0 &&
    (verified.length > 0 ||
      (send.request.kind === "message" &&
        (send.request.browserAnnotations?.length ?? 0) > 0));
  const publication: DraftAuthorityOutbox = {
    accountId: actor.accountId,
    actionId,
    sendId: send.id,
    source: expectedSource?.kind === "current" ? expectedSource.draft : null,
    generation: 1,
    ownership: "setup",
    dispatch: null,
    ...(setupBinding === undefined ? {} : { setupBinding }),
    setupIssue: null,
    dispatchWakeIssue: null,
    manualTerminalIssue: null,
    decision: { kind: "waiting" },
    send,
    ...(submission === undefined ? {} : { submission }),
    ...(epicPrerequisite === undefined ? {} : { epicPrerequisite }),
    manifest: roots,
    byteCustody: initialByteCustody,
  };
  const result = await runDraftAuthorityTransaction(
    ["drafts", "pending", "claims", "receipts", "recovery"],
    "readwrite",
    async ({ drafts, pending, claims, receipts, recovery }): Promise<OutboxResult> => {
      const previous = await receipts.read(key);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (previous !== undefined) {
        const saved = outboxPublicationReceiptSchema.parse(previous);
        if (saved.intent !== intent) return { kind: "conflict", current: null };
        return {
          kind: "replayed",
          receipt: { ...publication, byteCustody: saved.byteCustody },
        };
      }
      const current = await readOutbox(pending, actor.accountId, send.id);
      if (
        current !== null ||
        (await pending.read(outboxKey(actor.accountId, send.id))) !== undefined
      ) {
        return { kind: "conflict", current };
      }
      let primary: IDBValidKey | null = null;
      if (expectedSource !== null) {
        const source = await readDraftAuthorityRecord(drafts, expectedSlot(expectedSource));
        if (!draftAuthorityExpectationMatches(source, expectedSource)) {
          return { kind: "conflict", current: null };
        }
        if (source?.kind === "live") {
          primary = primaryKey(source.draft);
          const reserved = await claims.read(primary);
          if (restoredPredecessor !== undefined) {
            if (await readEligibleRestoredPredecessor(
              claims, source, reserved, actor, restoredPredecessor,
            ) === null) return { kind: "conflict", current: null };
          } else if (reserved !== undefined && reserved !== actionId) {
            return { kind: "conflict", current: null };
          }
          if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
        } else if (restoredPredecessor !== undefined) {
          return { kind: "conflict", current: null };
        }
      }

      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (restoredPredecessor !== undefined && isSuccessorCurrent?.() !== true) {
        return { kind: "conflict", current: null };
      }
      if (publication.byteCustody) {
        await applyRecoveryRoots(recovery, {
          accountId: actor.accountId,
          byteLimit: LANDING_IMAGE_BUDGET_BYTES,
          changes: [{ before: [], after: roots.digests }],
          verified,
        });
      }

      if (!draftAuthorityActorIsCurrent(actor)) {
        if (publication.byteCustody) throw new Error("Draft authority session changed during custody write");
        return { kind: "denied" };
      }
      if (restoredPredecessor !== undefined && publication.byteCustody &&
        isSuccessorCurrent?.() !== true) throw new RestoredSuccessorBecameStale();
      await Promise.all([
        writeOutbox(pending, publication),
        receipts.write(key, { intent, byteCustody: publication.byteCustody }),
        ...(primary === null ? [] : [claims.write(primary, actionId)]),
      ]);
      return { kind: "committed", receipt: publication };
    },
  );
  if (result.kind === "unavailable" && result.cause instanceof RestoredSuccessorBecameStale) {
    return { kind: "conflict", current: null };
  }
  return notifyOutboxMutation(result, actor);
}

export async function confirmDraftAuthorityOutboxEpic(input: OutboxMutationInput & {
  readonly actionId: string;
  readonly evidence: DraftAuthorityPendingEpicEvidence;
}): Promise<OutboxResult> {
  const { actor, sendId, actionId, expectedGeneration } = input;
  const parsed = pendingEpicEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) return { kind: "invalid" };
  const evidence = parsed.data;
  const result = await runDraftAuthorityTransaction(
    ["pending"],
    "readwrite",
    async ({ pending }): Promise<OutboxResult> => {
      const current = await readOutbox(pending, actor.accountId, sendId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (current === null || current.actionId !== actionId) {
        return { kind: "conflict", current };
      }
      if (current.epicConfirmation !== undefined) {
        return current.epicConfirmation.fromGeneration === expectedGeneration &&
          JSON.stringify(current.epicConfirmation.evidence) === JSON.stringify(evidence)
          ? { kind: "replayed", receipt: current }
          : { kind: "conflict", current };
      }
      const plan = current.epicPrerequisite;
      if (plan === undefined || current.send.epicConfirmed || current.generation !== expectedGeneration ||
        current.ownership !== "setup" || current.decision.kind !== "waiting" ||
        current.setupIssue !== null || evidence.epicId !== current.send.epicId ||
        evidence.hostId !== plan.hostId || evidence.createKey !== plan.createKey) {
        return { kind: "conflict", current };
      }
      const requiredTeam = plan.sandboxTeamId === evidence.createdOwnerTeamId ? null : plan.sandboxTeamId;
      const attachment = evidence.attachment;
      if (requiredTeam === null ? attachment !== null :
        attachment === null || attachment.teamId !== requiredTeam ||
        attachment.hostId !== plan.attachmentHostId) {
        return { kind: "denied" };
      }
      const receipt: DraftAuthorityOutbox = {
        ...current,
        generation: current.generation + 1,
        send: { ...current.send, epicConfirmed: true },
        epicConfirmation: { fromGeneration: current.generation, evidence },
      };
      await writeOutbox(pending, receipt);
      return { kind: "committed", receipt };
    },
  );
  return notifyOutboxMutation(result, actor);
}

function matchesOutboxSubmission(
  outbox: DraftAuthorityOutbox,
  dispatch: PendingSandboxSendDispatch,
): boolean {
  const candidate: unknown = dispatch;
  const inline = isRecord(candidate) ? candidate.outboxInlineHashes : undefined;
  if (outbox.submission === undefined) {
    return inline === undefined && !requiresOutboxSubmission(outbox.send);
  }
  const { content, manifest } = outbox.submission;
  const initial = dispatch.input.initialMessage;
  return Array.isArray(inline) && inline.length === manifest.digests.length &&
    manifest.digests.every((digest, index) => inline[index] === digest) &&
    initial != null && initial.attachmentsByHash !== true &&
    JSON.stringify(initial.content) === JSON.stringify(content);
}

const transferReceiptSchema = z.object({
  intent: z.string(),
  generation: z.number().int().positive(),
});

export async function transferDraftAuthorityOutbox(
  input: TransferDraftAuthorityOutboxInput,
): Promise<OutboxResult> {
  const { actor, operationId, sendId, expectedGeneration, dispatch } = input;
  const intent = await draftAuthorityIntentDigest({
    sendId,
    expectedGeneration,
    dispatch,
  });
  const key = ["transfer", actor.accountId, operationId];
  const result = await runDraftAuthorityTransaction(
    ["pending", "receipts"],
    "readwrite",
    async ({ pending, receipts }): Promise<OutboxResult> => {
      const saved = await receipts.read(key);
      const current = await readOutbox(pending, actor.accountId, sendId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (saved !== undefined) {
        const previous = transferReceiptSchema.parse(saved);
        return previous.intent === intent && current !== null && current.dispatch !== null
          ? {
              kind: "replayed",
              receipt: {
                ...current,
                generation: previous.generation,
                setupIssue: null,
                dispatchWakeIssue: null,
                manualTerminalIssue: null,
                decision: { kind: "waiting" },
              },
            }
          : { kind: "conflict", current };
      }
      if (
        current === null ||
        current.generation !== expectedGeneration ||
        current.ownership !== "setup" ||
        current.decision.kind !== "waiting" ||
        !current.send.epicConfirmed || !matchesOutboxSubmission(current, dispatch)
      ) {
        return { kind: "conflict", current };
      }
      const receipt: DraftAuthorityOutbox = {
        ...current,
        generation: current.generation + 1,
        ownership: "dispatch",
        dispatch,
        setupIssue: null,
        dispatchWakeIssue: null,
      };
      await Promise.all([
        writeOutbox(pending, receipt),
        receipts.write(key, { intent, generation: receipt.generation }),
      ]);
      return { kind: "committed", receipt };
    },
  );
  return notifyOutboxMutation(result, actor);
}

const PENDING_CHANGE = persistKey("draft-authority-pending-changed");
const pendingChangeSchema = z.object({
  accountId: z.string(),
  sendId: z.string(),
  generation: z.number(),
});
type PendingChange = z.infer<typeof pendingChangeSchema>;
const pendingListeners = new Map<string, Set<(sendId: string) => void>>();

function onPendingStorageChange(event: StorageEvent): void {
  if (event.key !== PENDING_CHANGE || event.newValue === null) return;
  let change: PendingChange;
  try {
    change = pendingChangeSchema.parse(JSON.parse(event.newValue));
  } catch {
    return;
  }
  emitPendingChange(change);
}

function emitPendingChange(change: PendingChange): void {
  for (const listener of pendingListeners.get(change.accountId) ?? []) {
    queueMicrotask(() => listener(change.sendId));
  }
}

function notifyPendingChange(change: PendingChange): void {
  try {
    globalThis.localStorage?.setItem(
      PENDING_CHANGE,
      JSON.stringify({
        accountId: change.accountId,
        sendId: change.sendId,
        generation: change.generation,
        notificationId: mintDraftId(),
      }),
    );
  } catch {
    // The next scoped hydration can pick up a committed record.
  }
  emitPendingChange(change);
}

export function subscribeToDraftAuthorityOutboxChanges(
  accountId: string,
  listener: (sendId: string) => void,
): () => void {
  if (pendingListeners.size === 0) {
    globalThis.window?.addEventListener("storage", onPendingStorageChange);
  }
  const listeners = pendingListeners.get(accountId) ?? new Set();
  listeners.add(listener);
  pendingListeners.set(accountId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) pendingListeners.delete(accountId);
    if (pendingListeners.size === 0) {
      globalThis.window?.removeEventListener("storage", onPendingStorageChange);
    }
  };
}

function notifyOutboxMutation(
  outcome:
    | { readonly kind: "complete"; readonly value: OutboxResult }
    | { readonly kind: "unavailable" | "unverified" },
  actor: DraftAuthorityActor,
): OutboxResult {
  if (outcome.kind !== "complete") return outcome;
  if (outcome.value.kind === "committed") notifyPendingChange(outcome.value.receipt);
  return draftAuthorityActorIsCurrent(actor) ? outcome.value : { kind: "denied" };
}

export async function listDraftAuthorityOutboxes(
  actor: DraftAuthorityActor,
): Promise<
  | { readonly kind: "current"; readonly outboxes: readonly DraftAuthorityOutbox[] }
  | { readonly kind: "denied" | "unavailable" }
> {
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const result = await runDraftAuthorityTransaction(
    ["pending"],
    "readonly",
    async ({ pending }) => {
      const range = IDBKeyRange.bound([actor.accountId], [actor.accountId, []]);
      const rows = await pending.readAll(range);
      return rows.flatMap((row) => {
        const parsed = outboxSchema.safeParse(row);
        return parsed.success && parsed.data.accountId === actor.accountId &&
          parsed.data.send.userId === actor.accountId &&
          parsed.data.send.id === parsed.data.sendId
          ? [parsed.data]
          : [];
      });
    },
  );
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  return result.kind === "complete"
    ? { kind: "current", outboxes: result.value }
    : { kind: "unavailable" };
}

type IssueResult = DraftAuthorityMutationResult<
  DraftAuthorityIssueReceipt,
  DraftAuthorityOutbox
>;

function sameIssue(
  left: DraftAuthorityIssueReceipt | null,
  right: DraftAuthorityIssueReceipt,
): boolean {
  return left !== null &&
    left.accountId === right.accountId &&
    left.operationId === right.operationId &&
    left.issueGeneration === right.issueGeneration &&
    left.executorId === right.executorId;
}

async function readIssue(
  claims: PendingStore,
  accountId: string,
  operationId: string,
): Promise<z.infer<typeof claimSchema> | null> {
  const saved = await claims.read(issueKey(accountId, operationId));
  return saved === undefined ? null : claimSchema.parse(saved);
}

function sameSetupAttempt(
  left: DraftAuthoritySetupAttempt | undefined,
  right: DraftAuthoritySetupAttempt | undefined,
): boolean {
  return left?.attemptId === right?.attemptId &&
    left?.observationGeneration === right?.observationGeneration;
}

export async function claimDraftAuthorityEffect(
  input: ClaimDraftAuthorityEffectInput,
): Promise<IssueResult> {
  const { actor, source, operationId, effect, expectedIssueGeneration, recovery } = input;
  const { setupAttempt, previousSetupAttempt, restoredPredecessor, isSuccessorCurrent } = input;
  const supportsSetupAttempt = effect.phase === "setup" &&
    (effect.kind === "create" || effect.kind === "wake" ||
      (source.kind === "restored-draft" && effect.kind === "terminal"));
  if (setupAttempt === undefined ? previousSetupAttempt !== undefined :
    !supportsSetupAttempt || !setupAttemptSchema.safeParse(setupAttempt).success ||
    !setupAttemptSchema.optional().safeParse(previousSetupAttempt).success) {
    return { kind: "invalid" };
  }
  if (restoredPredecessor !== undefined &&
    (source.kind !== "restored-draft" || effect.phase !== "setup" || effect.kind !== "wake" ||
      recovery !== "initial" || input.checkpoint !== undefined ||
      restoredPredecessor.kind !== "signed-rest" || isSuccessorCurrent === undefined ||
      operationId === restoredPredecessor.claim.operationId ||
      effect.payload.hostId !== restoredPredecessor.hostId ||
      effect.payload.sandboxId !== restoredPredecessor.sandboxId ||
      setupAttempt?.attemptId !== restoredPredecessor.attemptId ||
      setupAttempt?.observationGeneration !== restoredPredecessor.observationGeneration)) {
    return { kind: "invalid" };
  }
  const sourceIdentity = source.kind === "pending-outbox"
    ? { kind: source.kind, sendId: source.sendId }
    : source;
  const auxiliary = effect.phase === "dispatch" && effect.kind === "wake";
  const parent = input.auxiliaryFor == null ? null : {
    operationId: input.auxiliaryFor.operationId,
    issueGeneration: input.auxiliaryFor.issueGeneration,
    executorId: input.auxiliaryFor.executorId,
  };
  if (auxiliary && (source.kind !== "pending-outbox" || input.auxiliaryFor === undefined ||
    recovery !== "initial")) {
    return { kind: "invalid" };
  }
  if (input.checkpoint !== undefined &&
    (source.kind !== "restored-draft" || effect.kind !== "create" ||
      input.checkpoint.userId !== actor.accountId)) {
    return { kind: "invalid" };
  }
  const intent = await draftAuthorityIntentDigest({
    source: sourceIdentity,
    effect,
    parent,
    checkpoint: input.checkpoint,
    restoredSuccessor: restoredSuccessorIntent(restoredPredecessor),
  });
  const result = await runDraftAuthorityTransaction(
    ["drafts", "pending", "claims"],
    "readwrite",
    async ({ drafts, pending, claims }): Promise<IssueResult> => {
      const prior = await readIssue(claims, actor.accountId, operationId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (prior !== null) {
        const restoredReplay = input.checkpoint === undefined &&
          recovery !== "initial" &&
          source.kind === "restored-draft" &&
          prior.receipt.source.kind === "restored-draft" &&
          JSON.stringify(prior.receipt.source) === JSON.stringify(source) &&
          JSON.stringify(prior.receipt.effect) === JSON.stringify(effect);
        if (prior.intent !== intent && !restoredReplay) {
          return { kind: "conflict", current: null };
        }
      }
      if (prior !== null && recovery === "initial") {
        return sameSetupAttempt(prior.receipt.setupAttempt, setupAttempt)
          ? { kind: "replayed", receipt: prior.receipt }
          : { kind: "conflict", current: null };
      }
      if (recovery !== "initial") {
        const recoverable = recovery === "exact-replay"
          ? prior?.state === "uncertain" &&
            (effect.kind === "create" || effect.kind === "send")
          : prior?.state === "refused" &&
            (effect.phase === "dispatch" ||
              effect.kind === "create");
        if (!recoverable ||
          prior?.receipt.issueGeneration !== expectedIssueGeneration) {
          return { kind: "denied" };
        }
      }
      if (prior === null && expectedIssueGeneration !== null) {
        return { kind: "conflict", current: null };
      }

      let outbox: DraftAuthorityOutbox | null = null;
      let manualTerminal = false;
      let primary: IDBValidKey | null = null;
      let predecessor: DraftAuthorityRestoredIssuePredecessor | undefined;
      let checkpoint: Extract<DraftAuthorityRecord, { readonly kind: "live" }> | null = null;
      if (source.kind === "restored-draft") {
        if (source.returnAccountId !== actor.accountId) return { kind: "denied" };
        const expected = prior?.receipt.checkpointVersion ?? source.draft;
        const current = await readDraftAuthorityRecord(drafts, expected.slot);
        if (
          current?.kind !== "live" ||
          current.returnAccountId !== actor.accountId ||
          !draftAuthorityExpectationMatches(current, { kind: "current", draft: expected })
        ) {
          return { kind: "conflict", current: null };
        }
        primary = primaryKey(current.draft);
        const reserved = await claims.read(primary);
        if (restoredPredecessor !== undefined) {
          const saved = await readEligibleRestoredPredecessor(
            claims, current, reserved, actor, restoredPredecessor,
          );
          if (saved === null) return { kind: "conflict", current: null };
          predecessor = { ...hostEndIssueIdentity(saved), createKey: saved.effect.identity };
        } else if ((prior !== null && reserved !== operationId) ||
          (reserved !== undefined && reserved !== operationId)) {
          return { kind: "conflict", current: null };
        }
        if (prior !== null && !sameSetupAttempt(prior.receipt.setupAttempt, setupAttempt)) {
          const previous = prior.receipt.setupAttempt;
          if (recovery !== "explicit-retry" || setupAttempt === undefined ||
            !sameSetupAttempt(previous, previousSetupAttempt) ||
            (previous !== undefined && setupAttempt.observationGeneration < previous.observationGeneration)) {
            return { kind: "conflict", current: null };
          }
        }
        if (input.checkpoint !== undefined) {
          const kind = current.draft.slot.kind;
          const id = kind === "landing" ? current.draft.slot.id
            : typeof current.payload.draftId === "string" ? current.payload.draftId
            : null;
          const before = kind === "chat" ? null : returnedSandboxForDraft(
            parseReturnedSandbox(current.payload.returnedSandbox),
            actor.accountId,
            kind,
            id,
          );
          const request = effect.payload.request;
          if (before === null || !isRecord(request) ||
            JSON.stringify(before.target) !== JSON.stringify(input.checkpoint.target) ||
            before.clientRequestId !== input.checkpoint.clientRequestId ||
            request.clientRequestId !== input.checkpoint.lastCreateKey ||
            JSON.stringify(request) !== JSON.stringify(input.checkpoint.lastRetryCreate)) {
            return { kind: "conflict", current: null };
          }
          checkpoint = {
            ...current,
            draft: { ...current.draft, version: mintDraftId() },
            payload: { ...current.payload, returnedSandbox: input.checkpoint },
          };
        }
      } else {
        outbox = await readOutbox(pending, actor.accountId, source.sendId);
        if (outbox === null || outbox.generation !== source.generation) {
          return { kind: "conflict", current: outbox };
        }
        if (supportsSetupAttempt) {
          const previous = outbox.setupIssue?.setupAttempt ?? outbox.setupBinding;
          if ((previousSetupAttempt !== undefined && !sameSetupAttempt(previous, previousSetupAttempt)) ||
            (recovery === "exact-replay" && !sameSetupAttempt(prior?.receipt.setupAttempt, setupAttempt)) ||
            (previous !== undefined && (setupAttempt === undefined ||
              setupAttempt.observationGeneration < previous.observationGeneration ||
              (setupAttempt.attemptId !== previous.attemptId &&
                (outbox.setupIssue === null || previousSetupAttempt === undefined))))) {
            return { kind: "conflict", current: outbox };
          }
        }
        manualTerminal = effect.kind === "terminal" &&
          (outbox.send.request.kind === "chat" || outbox.send.request.kind === "message");
        if (
          outbox.ownership !== effect.phase ||
          !outbox.send.epicConfirmed ||
          (outbox.submission === undefined && requiresOutboxSubmission(outbox.send)) ||
          (effect.phase === "dispatch" && outbox.dispatch === null) ||
          (!manualTerminal && effect.phase === "setup" &&
            outbox.setupIssue?.effect.kind === "terminal")
        ) {
          return { kind: "denied" };
        }
        if (
          !auxiliary && !manualTerminal && outbox.decision.kind !== "waiting" &&
          (prior === null ||
            (recovery === "exact-replay" && outbox.decision.kind !== "uncertain") ||
            (recovery === "explicit-retry" && outbox.decision.kind !== "refused") ||
            recovery === "initial" ||
            !("claim" in outbox.decision) ||
            !sameIssue(outbox.decision.claim, prior.receipt))
        ) {
          return { kind: "denied" };
        }
        if (manualTerminal) {
          if (recovery !== "initial" || outbox.decision.kind !== "waiting" ||
            !manualTerminalTargetMatches(outbox, effect.payload)) {
            return { kind: "denied" };
          }
          const active = outbox.manualTerminalIssue;
          if (active !== null) {
            const saved = await readIssue(claims, actor.accountId, active.operationId);
            if (saved === null || saved.state === "issuing" || saved.state === "uncertain") {
              return { kind: "denied" };
            }
          }
        } else if (auxiliary) {
          if (!dispatchWakeParentMatches(outbox, parent, effect.payload.hostId)) {
            return { kind: "denied" };
          }
          const active = outbox.dispatchWakeIssue;
          if (active !== null) {
            const saved = await readIssue(claims, actor.accountId, active.operationId);
            if (saved === null ||
              (saved.state === "issuing" || saved.state === "uncertain") &&
                active.outboxGeneration === outbox.generation) {
              return { kind: "denied" };
            }
          }
        } else if (effect.phase === "dispatch" && outbox.dispatchWakeIssue !== null) {
          const wake = outbox.dispatchWakeIssue;
          const saved = await readIssue(claims, actor.accountId, wake.operationId);
          if (wake.outboxGeneration === outbox.generation &&
            (saved === null || saved.state === "issuing" || saved.state === "uncertain")) {
            return { kind: "denied" };
          }
        }
        if (effect.phase === "dispatch" && recovery !== "initial" &&
          outbox.decision.kind === "waiting") {
          return { kind: "denied" };
        }
        if (effect.phase === "setup" && recovery === "explicit-retry" &&
          (prior === null || !sameIssue(outbox.setupIssue, prior.receipt))) {
          return { kind: "denied" };
        }
        if (!manualTerminal && effect.phase === "setup" && outbox.setupIssue !== null) {
          const active = await readIssue(claims, actor.accountId, outbox.setupIssue.operationId);
          if (active === null ||
            ((active.state === "issuing" || active.state === "uncertain") &&
              (recovery !== "exact-replay" || !sameIssue(active.receipt, prior?.receipt ?? active.receipt)))) {
            return { kind: "denied" };
          }
        }
      }
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (restoredPredecessor !== undefined && isSuccessorCurrent?.() !== true) {
        return { kind: "conflict", current: null };
      }
      const receipt: DraftAuthorityIssueReceipt = {
        accountId: actor.accountId,
        sessionGeneration: actor.sessionGeneration,
        operationId,
        issueGeneration: (prior?.receipt.issueGeneration ?? 0) + 1,
        executorId: mintDraftId(),
        auxiliaryFor: parent,
        linkedPrimary: null,
        auxiliaryKind: auxiliary ? "dispatch-wake" : manualTerminal ? "manual-terminal" : null,
        checkpointVersion: checkpoint?.draft ?? prior?.receipt.checkpointVersion ?? null,
        source,
        effect,
        ...(setupAttempt === undefined ? {} : { setupAttempt }),
        ...(predecessor === undefined ? {} : { restoredPredecessor: predecessor }),
        outboxGeneration: outbox === null
          ? null
          : outbox.generation + (effect.phase === "dispatch" && !auxiliary && !manualTerminal ? 1 : 0),
      };

      await claims.write(issueKey(actor.accountId, operationId), {
        receipt,
        state: "issuing",
        intent: prior?.intent ?? intent,
        acceptance: null,
      });
      if (primary !== null) await claims.write(primary, operationId);
      if (checkpoint !== null) {
        await Promise.all([
          drafts.write(draftAuthorityKey(checkpoint.draft.slot), checkpoint),
          claims.write(primaryKey(checkpoint.draft), operationId),
        ]);
      }
      if (outbox !== null) {
        const next = manualTerminal
          ? { ...outbox, manualTerminalIssue: receipt }
          : auxiliary
          ? { ...outbox, dispatchWakeIssue: receipt }
          : effect.phase === "dispatch"
            ? {
                ...outbox,
                generation: outbox.generation + 1,
                decision: { kind: "issuing" as const, claim: receipt },
                dispatchWakeIssue: null,
              }
            : { ...outbox, setupIssue: receipt };
        await Promise.all([
          writeOutbox(pending, next),
          claims.write(
            outboxIssueKey(actor.accountId, outbox.sendId, operationId),
            operationId,
          ),
        ]);
      }
      return { kind: "committed", receipt };
    },
  );
  if (result.kind !== "complete") return result;
  if (result.value.kind === "committed") {
    const receipt = result.value.receipt;
    if (receipt.checkpointVersion !== null) notifyDraftAuthorityChange(receipt.checkpointVersion);
    if (receipt.source.kind === "pending-outbox" && receipt.outboxGeneration !== null) {
      notifyPendingChange({
        accountId: receipt.accountId,
        sendId: receipt.source.sendId,
        generation: receipt.outboxGeneration,
      });
    }
    if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  }
  return result.value;
}

function matchesHostEndBinding(
  binding: DraftAuthorityPendingSetupBinding,
  evidence: DraftAuthorityHostEndEvidence,
): boolean {
  return binding.attemptId === evidence.attemptId &&
    binding.hostId === evidence.hostId &&
    binding.sandboxId === evidence.sandboxId &&
    evidence.observationGeneration >= binding.observationGeneration;
}

function matchesDispatchHostEnd(
  outbox: DraftAuthorityOutbox,
  evidence: DraftAuthorityHostEndEvidence,
): boolean {
  const dispatch: unknown = outbox.dispatch;
  if (outbox.ownership !== "dispatch" || evidence.ownership !== "dispatch" ||
    outbox.dispatch === null || outbox.dispatch.input.hostId !== evidence.hostId ||
    !isRecord(dispatch)) {
    return false;
  }
  const attempt = setupAttemptSchema.safeParse(dispatch.setupAttempt);
  return attempt.success && matchesHostEndBinding(
    {
      ...attempt.data,
      hostId: outbox.dispatch.delivery.hostId,
      sandboxId: outbox.dispatch.delivery.sandboxId,
    },
    evidence,
  );
}

async function matchesSetupHostEnd(
  outbox: DraftAuthorityOutbox,
  claims: PendingStore,
  evidence: DraftAuthorityHostEndEvidence,
): Promise<boolean> {
  if (outbox.ownership !== "setup" || evidence.ownership !== "setup") return false;
  const binding = outbox.setupBinding;
  if (outbox.setupIssue === null) {
    return binding !== undefined && matchesHostEndBinding(binding, evidence);
  }
  const setup = await readIssue(claims, outbox.accountId, outbox.setupIssue.operationId);
  if (setup === null || !sameIssue(setup.receipt, outbox.setupIssue) ||
    (setup.receipt.effect.kind !== "create" && setup.receipt.effect.kind !== "wake")) {
    return false;
  }
  const attempt = setup.receipt.setupAttempt;
  if (attempt === undefined || attempt.attemptId !== evidence.attemptId ||
    evidence.observationGeneration < attempt.observationGeneration) return false;
  if (setup.state === "refused") {
    return binding !== undefined && matchesHostEndBinding(binding, evidence);
  }
  return setup.state === "accepted" &&
    setup.acceptance !== null &&
    setup.acceptance.hostId === evidence.hostId &&
    setup.acceptance.sandboxId === evidence.sandboxId;
}

function sameHostEndEvidence(
  left: DraftAuthorityHostEndEvidence,
  right: DraftAuthorityHostEndEvidence,
): boolean {
  return left.kind === right.kind && left.ownership === right.ownership &&
    left.proofId === right.proofId && left.observationGeneration === right.observationGeneration &&
    left.attemptId === right.attemptId && left.hostId === right.hostId &&
    left.sandboxId === right.sandboxId;
}

function withHostEndHold(
  current: DraftAuthorityOutbox,
  evidence: DraftAuthorityHostEndEvidence,
  settlement: DraftAuthorityHostEndHold["settlement"],
): DraftAuthorityOutbox {
  return {
    ...current,
    generation: current.generation + 1,
    decision: {
      kind: "held",
      reason: "host-end",
      fromGeneration: current.generation,
      evidence,
      settlement,
    },
    setupIssue: null,
    dispatchWakeIssue: null,
    manualTerminalIssue: null,
  };
}

function hostEndIssueIdentity(issue: DraftAuthorityIssueReceipt): IssueIdentity {
  return {
    operationId: issue.operationId,
    issueGeneration: issue.issueGeneration,
    executorId: issue.executorId,
  };
}

export async function holdDraftAuthorityOutboxEnd(input: OutboxMutationInput & {
  readonly evidence: DraftAuthorityHostEndEvidence;
}): Promise<OutboxResult> {
  const { actor, sendId, expectedGeneration } = input;
  const parsed = hostEndEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) return { kind: "invalid" };
  const evidence = parsed.data;
  const result = await runDraftAuthorityTransaction(
    ["pending", "claims"],
    "readwrite",
    async ({ pending, claims }): Promise<OutboxResult> => {
      const current = await readOutbox(pending, actor.accountId, sendId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      const decision = current?.decision;
      if (current !== null && decision?.kind === "held" && decision.reason === "host-end") {
        return decision.fromGeneration === expectedGeneration &&
          decision.settlement?.kind !== "terminal-undelivered" &&
          sameHostEndEvidence(decision.evidence, evidence)
          ? { kind: "replayed", receipt: current }
          : { kind: "conflict", current };
      }
      if (current === null || current.generation !== expectedGeneration ||
        (current.send.request.kind !== "chat" && current.send.request.kind !== "message") ||
        (current.decision.kind !== "waiting" && current.decision.kind !== "refused")) {
        return { kind: "conflict", current };
      }
      const bound = current.ownership === "dispatch"
        ? matchesDispatchHostEnd(current, evidence)
        : await matchesSetupHostEnd(current, claims, evidence);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (!bound) return { kind: "conflict", current };
      let settlement: DraftAuthorityHostEndHold["settlement"] = null;
      if (current.decision.kind === "refused") {
        const claim = current.decision.claim;
        const prior = await readIssue(claims, actor.accountId, claim.operationId);
        if (current.ownership !== "dispatch" || prior?.state !== "refused" ||
          !sameIssue(prior.receipt, claim)) return { kind: "conflict", current };
        settlement = { kind: "refused", issue: hostEndIssueIdentity(prior.receipt) };
      }
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      const receipt = withHostEndHold(current, evidence, settlement);
      await writeOutbox(pending, receipt);
      return { kind: "committed", receipt };
    },
  );
  return notifyOutboxMutation(result, actor);
}

interface EffectSettlement {
  readonly result: IssueResult;
  readonly changed: DraftAuthorityOutbox | null;
}

async function settleClaimedOutboxHostEnd(
  { pending, claims }: Pick<DraftAuthorityTransaction, "pending" | "claims">,
  actor: DraftAuthorityActor,
  prior: z.infer<typeof claimSchema>,
  end: DraftAuthorityPendingHostEndSettlement,
): Promise<EffectSettlement> {
  const { receipt } = prior;
  if (receipt.source.kind !== "pending-outbox" || receipt.effect.phase !== "dispatch" ||
    (receipt.effect.kind !== "create" && receipt.effect.kind !== "send") ||
    receipt.auxiliaryKind !== null || end.undeliveredProofId.length === 0) {
    return { result: { kind: "invalid" }, changed: null };
  }
  const evidence = hostEndEvidenceSchema.safeParse(end.evidence);
  if (!evidence.success) return { result: { kind: "invalid" }, changed: null };
  const current = await readOutbox(pending, actor.accountId, receipt.source.sendId);
  if (!draftAuthorityActorIsCurrent(actor)) return { result: { kind: "denied" }, changed: null };
  const decision = current?.decision;
  if (decision?.kind === "held" && decision.reason === "host-end") {
    const { settlement } = decision;
    return decision.fromGeneration === end.expectedGeneration && prior.state === "terminal" &&
      settlement?.kind === "terminal-undelivered" &&
      settlement.proofId === end.undeliveredProofId &&
      sameIssueIdentity(settlement.issue, receipt) &&
      sameHostEndEvidence(decision.evidence, evidence.data)
      ? { result: { kind: "replayed", receipt }, changed: null }
      : { result: { kind: "conflict", current }, changed: null };
  }
  if (current === null || current.generation !== end.expectedGeneration ||
    (current.send.request.kind !== "chat" && current.send.request.kind !== "message") ||
    (current.decision.kind !== "issuing" && current.decision.kind !== "uncertain") ||
    current.decision.kind !== prior.state || !sameIssue(current.decision.claim, receipt) ||
    !matchesDispatchHostEnd(current, evidence.data)) {
    return { result: { kind: "conflict", current }, changed: null };
  }
  const changed = withHostEndHold(current, evidence.data, {
    kind: "terminal-undelivered",
    issue: hostEndIssueIdentity(receipt),
    proofId: end.undeliveredProofId,
  });
  await Promise.all([
    claims.write(issueKey(actor.accountId, receipt.operationId), { ...prior, state: "terminal" }),
    writeOutbox(pending, changed),
  ]);
  return { result: { kind: "committed", receipt }, changed };
}

export async function settleDraftAuthorityEffect(
  input: SettleDraftAuthorityEffectInput,
): Promise<IssueResult> {
  const { actor, claim, outcome, pendingHostEnd } = input;
  if (claim.accountId !== actor.accountId) return { kind: "denied" };
  if (pendingHostEnd !== undefined && outcome !== "terminal") return { kind: "invalid" };
  const acceptsPrimaryDispatch = outcome === "accepted" && claim.source.kind === "pending-outbox" &&
    claim.effect.phase === "dispatch" && claim.auxiliaryKind === null;
  const stores = acceptsPrimaryDispatch
    ? (["drafts", "pending", "claims", "recovery"] as const)
    : (["drafts", "pending", "claims"] as const);
  const result = await runDraftAuthorityTransaction(
    stores,
    "readwrite",
    async ({ drafts, pending, claims, recovery }): Promise<EffectSettlement> => {
      const prior = await readIssue(claims, actor.accountId, claim.operationId);
      if (!draftAuthorityActorIsCurrent(actor)) {
        return { result: { kind: "denied" }, changed: null };
      }
      if (prior === null || !sameIssue(prior.receipt, claim)) {
        return { result: { kind: "conflict", current: null }, changed: null };
      }
      if (pendingHostEnd !== undefined) {
        return settleClaimedOutboxHostEnd({ pending, claims }, actor, prior, pendingHostEnd);
      }
      const acceptance = input.acceptance;
      const refinesAcceptance = outcome === "accepted" && prior.state === "accepted" &&
        prior.acceptance !== null && prior.acceptance.hostId === null &&
        acceptance !== undefined && acceptance.sandboxId === prior.acceptance.sandboxId &&
        acceptance.hostId !== null;
      if (prior.state === outcome && !refinesAcceptance) {
        if (input.acceptance !== undefined && prior.acceptance !== null &&
          (input.acceptance.sandboxId !== prior.acceptance.sandboxId ||
            input.acceptance.hostId !== prior.acceptance.hostId)) {
          return { result: { kind: "conflict", current: null }, changed: null };
        }
        return { result: { kind: "replayed", receipt: prior.receipt }, changed: null };
      }
      if (!refinesAcceptance && prior.state !== "issuing" && prior.state !== "uncertain" &&
        (prior.state !== "accepted" || outcome !== "terminal")) {
        return { result: { kind: "conflict", current: null }, changed: null };
      }

      const { source, effect } = prior.receipt;
      if (source.kind === "restored-draft" &&
        !(await restoredIssueIsCurrent(drafts, claims, prior.receipt))) {
        return { result: { kind: "conflict", current: null }, changed: null };
      }
      if (source.kind === "restored-draft" &&
        (effect.kind === "create" || effect.kind === "wake") &&
        outcome === "accepted" && !input.acceptance?.sandboxId) {
        return { result: { kind: "invalid" }, changed: null };
      }
      let changed: DraftAuthorityOutbox | null = null;
      if (source.kind === "pending-outbox") {
        const current = await readOutbox(pending, actor.accountId, source.sendId);
        const dispatch = effect.phase === "dispatch";
        const auxiliary = prior.receipt.auxiliaryKind === "dispatch-wake";
        const manualTerminal = prior.receipt.auxiliaryKind === "manual-terminal";
        const currentClaim = manualTerminal
          ? current?.manualTerminalIssue ?? null
          : auxiliary
          ? current?.dispatchWakeIssue ?? null
          : dispatch
          ? current?.decision.kind === "issuing" ||
            current?.decision.kind === "uncertain" ||
            current?.decision.kind === "accepted"
            ? current.decision.claim
            : null
          : current?.setupIssue ?? null;
        if (
          current === null ||
          (!manualTerminal && current.ownership !== effect.phase) ||
          !sameIssue(currentClaim, claim) ||
          (manualTerminal && !manualTerminalTargetMatches(current, effect.payload)) ||
          (auxiliary && (
            current.generation !== prior.receipt.outboxGeneration ||
            !dispatchWakeParentMatches(current, prior.receipt.auxiliaryFor, effect.payload.hostId)
          )) ||
          (dispatch && !auxiliary && !manualTerminal &&
            current.generation !== prior.receipt.outboxGeneration &&
            current.decision.kind !== "uncertain" &&
            current.decision.kind !== "accepted")
        ) {
          return { result: { kind: "conflict", current }, changed: null };
        }
        if (dispatch && !auxiliary && !manualTerminal && outcome === "terminal" &&
          (current.send.request.kind === "chat" || current.send.request.kind === "message")) {
          return { result: { kind: "invalid" }, changed: null };
        }
        if (auxiliary || manualTerminal) {
          changed = current;
        } else if (dispatch || effect.kind === "terminal") {
          changed = {
            ...current,
            generation: current.generation + 1,
            decision: outcome === "refused" && !dispatch
              ? { kind: "waiting" }
              : {
                  kind: effect.kind === "terminal" && outcome === "accepted"
                    ? "terminal"
                    : outcome,
                  claim: prior.receipt,
                },
            setupIssue: effect.kind === "terminal" && outcome === "refused"
              ? null
              : current.setupIssue,
          };
        }
      }
      if (!draftAuthorityActorIsCurrent(actor)) {
        return { result: { kind: "denied" }, changed: null };
      }
      if (acceptsPrimaryDispatch && changed?.decision.kind === "accepted" && changed.byteCustody) {
        await applyRecoveryRoots(recovery, {
          accountId: actor.accountId,
          byteLimit: LANDING_IMAGE_BUDGET_BYTES,
          changes: [{ before: changed.manifest.digests, after: [] }],
          verified: [],
        });
        if (!draftAuthorityActorIsCurrent(actor)) {
          throw new Error("Draft authority session changed during accepted dispatch retirement");
        }
        changed = { ...changed, byteCustody: false };
      }
      await claims.write(issueKey(actor.accountId, claim.operationId), {
        ...prior,
        state: outcome,
        acceptance: outcome === "accepted" ? input.acceptance ?? null : prior.acceptance,
      });
      if (changed !== null) await writeOutbox(pending, changed);
      return { result: { kind: "committed", receipt: prior.receipt }, changed };
    },
  );
  if (result.kind !== "complete") return result;
  if (result.value.changed !== null) notifyPendingChange(result.value.changed);
  return draftAuthorityActorIsCurrent(actor) ? result.value.result : { kind: "denied" };
}

type LegacyState =
  | { readonly kind: "waiting" }
  | { readonly kind: "uncertain"; readonly effect: DraftAuthorityEffectIntent }
  | { readonly kind: "accepted"; readonly effect: DraftAuthorityEffectIntent }
  | { readonly kind: "returning"; readonly disposition: DraftAuthorityReturnDisposition }
  | { readonly kind: "held"; readonly reason: "stop" | "return" | "uncertain" };

interface LegacyOutboxInput {
  readonly actor: DraftAuthorityActor;
  readonly actionId: string;
  readonly send: PendingSandboxSend;
  readonly manifest: DraftAuthorityManifest;
  readonly legacyState: LegacyState;
}

export async function admitLegacyDraftAuthorityOutbox(
  input: LegacyOutboxInput,
): Promise<OutboxResult> {
  const { actor, send, legacyState, actionId, manifest: roots } = input;
  if (send.userId !== actor.accountId) return { kind: "denied" };
  if (legacyState.kind === "waiting" &&
    (send.dispatch != null || send.returnRequested !== undefined ||
      send.stopRequested === true || send.ended === true ||
      send.delivery !== null)) {
    return { kind: "invalid" };
  }

  if (legacyState.kind === "returning" &&
    (!dispositionSchema.safeParse(legacyState.disposition).success ||
      (send.returnRequested === undefined && send.ended !== true &&
        send.stopRequested !== true))) {
    return { kind: "invalid" };
  }
  const dispatch = send.dispatch ?? null;
  const effect = legacyState.kind === "accepted" || legacyState.kind === "uncertain"
    ? legacyState.effect
    : null;
  if (effect !== null && (dispatch === null || effect.phase !== "dispatch")) {
    return { kind: "invalid" };
  }
  const intent = effect === null ? null : await draftAuthorityIntentDigest({
    source: { kind: "pending-outbox", sendId: send.id },
    effect,
    parent: null,
  });

  const result = await runDraftAuthorityTransaction(
    ["pending", "claims"],
    "readwrite",
    async ({ pending, claims }): Promise<OutboxResult> => {
      const key = outboxKey(actor.accountId, send.id);
      const raw = await pending.read(key);
      const current = await readOutbox(pending, actor.accountId, send.id);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (current !== null) return { kind: "replayed", receipt: current };
      if (raw !== undefined) return { kind: "conflict", current: null };

      let decision: DraftAuthorityPendingDecision;
      if (legacyState.kind === "accepted" || legacyState.kind === "uncertain") {
        const claim: DraftAuthorityIssueReceipt = {
          accountId: actor.accountId,
          sessionGeneration: actor.sessionGeneration,
          operationId: actionId,
          issueGeneration: 1,
          executorId: mintDraftId(),
          auxiliaryFor: null,
          linkedPrimary: null,
          auxiliaryKind: null,
          checkpointVersion: null,
          source: { kind: "pending-outbox", sendId: send.id, generation: 1 },
          effect: legacyState.effect,
          outboxGeneration: 1,
        };
        const claimKey = issueKey(actor.accountId, actionId);
        if (await claims.read(claimKey) !== undefined) {
          return { kind: "conflict", current: null };
        }
        if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
        await Promise.all([
          claims.write(claimKey, { receipt: claim, state: legacyState.kind, intent, acceptance: null }),
          claims.write(outboxIssueKey(actor.accountId, send.id, actionId), actionId),
        ]);
        decision = { kind: legacyState.kind, claim };
      } else if (legacyState.kind === "returning" && !hasReturnTarget(legacyState.disposition)) {
        decision = {
          kind: "held",
          reason: send.returnRequested === undefined && send.stopRequested === true
            ? "stop"
            : "return",
        };
      } else {
        decision = legacyState;
      }

      const receipt: DraftAuthorityOutbox = {
        accountId: actor.accountId,
        actionId,
        sendId: send.id,
        source: null,
        generation: 1,
        ownership: dispatch === null ? "setup" : "dispatch",
        dispatch,
        setupIssue: null,
        dispatchWakeIssue: null,
        manualTerminalIssue: null,
        decision,
        send,
        manifest: roots,
        byteCustody: false,
      };
      await writeOutbox(pending, receipt);
      return { kind: "committed", receipt };
    },
  );
  return notifyOutboxMutation(result, actor);
}

function matchesLegacyStopRest(
  outbox: DraftAuthorityOutbox,
  evidence: Extract<DraftAuthorityReturnEvidence, { readonly kind: "legacy-stop-rest" }>,
): boolean {
  const { decision, send } = outbox;
  const stage = send.stopStage;
  const stopAt = send.stopRequestedAt;
  return decision.kind === "held" && decision.reason === "stop" &&
    outbox.ownership === "setup" && outbox.dispatch === null && send.stopRequested === true &&
    stage !== undefined && stage.attemptId === evidence.attemptId &&
    stage.createdHostId === evidence.hostId && stage.createdSandboxId === evidence.sandboxId &&
    (send.createdSandbox === undefined || send.createdSandbox.sandboxId === evidence.sandboxId) &&
    typeof stopAt === "number" && Number.isFinite(stopAt) && stopAt > 0 &&
    evidence.observationGeneration > Math.max(stopAt, send.observationRequestedAt ?? stopAt);
}

interface RecordReturnInput extends OutboxMutationInput {
  readonly disposition: DraftAuthorityReturnDisposition;
  readonly heldHostEnd?: DraftAuthorityHostEndHold;
  readonly isAdmissionCurrent?: () => boolean;
}

export async function recordDraftAuthorityReturn(
  input: RecordReturnInput,
): Promise<OutboxResult> {
  const { actor, sendId, expectedGeneration, disposition, heldHostEnd, isAdmissionCurrent } = input;
  if (!dispositionSchema.safeParse(disposition).success || !hasReturnTarget(disposition)) {
    return { kind: "invalid" };
  }
  const stores = heldHostEnd === undefined
    ? (["pending", "claims"] as const)
    : (["pending", "claims", "drafts", "sidecars", "receipts"] as const);
  const result = await runDraftAuthorityTransaction(
    stores,
    "readwrite",
    async ({ pending, claims, drafts, sidecars, receipts }): Promise<OutboxResult> => {
      const current = await readOutbox(pending, actor.accountId, sendId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (current?.decision.kind === "returning") {
        if (JSON.stringify(current.decision.disposition) !== JSON.stringify(disposition)) {
          return { kind: "conflict", current };
        }
        return { kind: "replayed", receipt: current };
      }
      if (
        current === null ||
        current.generation !== expectedGeneration ||
        (current.ownership === "dispatch" && current.decision.kind === "terminal" &&
          (current.send.request.kind === "chat" || current.send.request.kind === "message")) ||
        (current.decision.kind !== "waiting" &&
          current.decision.kind !== "terminal" &&
          current.decision.kind !== "refused" &&
          !stopAllowsReturn(current.decision, disposition.stopOperationId) &&
          (current.decision.kind !== "held" ||
            current.decision.reason === "uncertain"))
      ) {
        return { kind: "conflict", current };
      }
      if (current.ownership === "setup" && current.setupIssue !== null) {
        const setup = await readIssue(claims, actor.accountId, current.setupIssue.operationId);
        if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
        if (setup === null || !sameIssue(setup.receipt, current.setupIssue) ||
          setup.state === "issuing" || setup.state === "uncertain" ||
          (setup.receipt.effect.kind === "terminal" && setup.state !== "refused")) {
          return { kind: "conflict", current };
        }
      }
      if (disposition.stopOperationId !== undefined &&
        !stopAllowsReturn(current.decision, disposition.stopOperationId)) {
        return { kind: "denied" };
      }
      const evidence = disposition.evidence;
      const isLegacyRest = evidence?.kind === "legacy-stop-rest";
      if (evidence?.kind === "legacy-stop-rest" && !matchesLegacyStopRest(current, evidence)) {
        return { kind: "denied" };
      }
      const provenTaskLoss = disposition.legacyTaskLoss?.epicId === current.send.epicId;
      const decision = current.decision;
      if (decision.kind === "held" && decision.reason === "host-end") {
        const expected = hostEndHoldSchema.safeParse(heldHostEnd);
        if (!expected.success ||
          JSON.stringify(hostEndHoldSchema.parse(decision)) !== JSON.stringify(expected.data)) {
          return { kind: "conflict", current };
        }
        const target = await eligibleReturnTarget({ drafts, sidecars, receipts }, disposition, current);
        if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
        if (target === null) return { kind: "conflict", current };
      } else if (heldHostEnd !== undefined) {
        return { kind: "conflict", current };
      } else if (decision.kind === "held") {
        if (current.dispatch !== null) return { kind: "denied" };
        if (decision.reason === "return" &&
          current.send.returnRequested === undefined && current.send.ended !== true) {
          return { kind: "denied" };
        }
        if (decision.reason === "stop") {
          const originalRow = current.send.stopStage?.createdSandboxId ??
            current.send.createdSandbox?.sandboxId;
          const originalHost = current.send.stopStage?.createdHostId;
          const provenEnd = evidence?.kind === "setup-host-end" &&
            (originalRow === undefined || originalRow === null || originalRow === evidence.sandboxId) &&
            (originalHost === undefined || originalHost === null || originalHost === evidence.hostId);
          if (!isLegacyRest && !provenEnd && !provenTaskLoss) return { kind: "denied" };
        }
      } else if (evidence !== undefined) {
        const allowed = evidence.kind === "dispatch-host-end"
          ? current.ownership === "dispatch" &&
            current.dispatch?.delivery.hostId === evidence.hostId &&
            current.dispatch.delivery.sandboxId === evidence.sandboxId
          : current.ownership === "setup";
        if (!allowed || current.decision.kind !== "waiting") return { kind: "denied" };
      }
      const receipt: DraftAuthorityOutbox = {
        ...current,
        generation: current.generation + 1,
        decision: { kind: "returning", disposition },
        setupIssue: null,
        dispatchWakeIssue: null,
        manualTerminalIssue: null,
      };
      if (isAdmissionCurrent?.() === false) return { kind: "conflict", current };
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      await writeOutbox(pending, receipt);
      return { kind: "committed", receipt };
    },
  );
  return notifyOutboxMutation(result, actor);
}

interface PublishReturnInput extends ReadOutboxInput {
  readonly returnId: string;
  readonly verified?: readonly DraftAuthorityVerifiedBlob[];
}

type ReturnResult =
  | DraftAuthorityMutationResult<DraftAuthorityReturnReceipt, DraftAuthorityOutbox>
  | { readonly kind: "held" | "missing-bytes" | "budget" };

function returnKey(accountId: string, sendId: string, returnId: string): IDBValidKey {
  return ["return", accountId, sendId, returnId];
}

export type DraftAuthorityCompletedReturnRead =
  | { readonly kind: "current"; readonly receipt: DraftAuthorityReturnReceipt }
  | { readonly kind: "missing" | "denied" | "unavailable" };

export async function readDraftAuthorityCompletedReturn(input: ReadOutboxInput & {
  readonly returnId: string;
}): Promise<DraftAuthorityCompletedReturnRead> {
  const { actor, sendId, returnId } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const result = await runDraftAuthorityTransaction(
    ["receipts"],
    "readonly",
    async ({ receipts }): Promise<DraftAuthorityCompletedReturnRead> => {
      const raw = await receipts.read(returnKey(actor.accountId, sendId, returnId));
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (raw === undefined) return { kind: "missing" };
      const stored = returnReceiptSchema.parse(raw);
      if (stored.accountId !== actor.accountId || stored.sendId !== sendId || stored.returnId !== returnId) {
        return { kind: "denied" };
      }
      return { kind: "current", receipt: stored };
    },
  );
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  return result.kind === "complete" ? result.value : { kind: "unavailable" };
}

function returnSlotIsOccupied(record: Extract<DraftAuthorityRecord, { kind: "live" }>): boolean {
  const { slot } = record.draft;
  if (slot.kind === "landing") return true;
  const { payload } = record;
  if (isJsonContent(payload.content, 0) && !isEmptyLandingDraftContent(payload.content)) {
    return true;
  }
  if (slot.kind === "chat") {
    return parseBrowserAnnotationRecords(payload.browserAnnotations).length > 0;
  }
  return payload.settings != null || payload.workspace != null || payload.composerMode != null;
}

async function eligibleReturnTarget(
  transaction: Pick<DraftAuthorityTransaction, "drafts" | "sidecars" | "receipts">,
  disposition: DraftAuthorityReturnDisposition,
  outbox: DraftAuthorityOutbox,
): Promise<ReturnTarget | null> {
  const { drafts, sidecars, receipts } = transaction;
  for (const target of [disposition.primary, disposition.fallback]) {
    if (target === null) continue;
    if (target.returnAccountId !== null && target.returnAccountId !== outbox.accountId) continue;
    const slot = expectedSlot(target.expected);
    if (slot.kind === "task" && (!outbox.send.epicConfirmed || slot.id !== outbox.send.epicId)) {
      continue;
    }
    const current = await readDraftAuthorityRecord(drafts, slot);
    if (!draftAuthorityExpectationMatches(current, target.expected)) continue;
    if (current?.kind === "live" && returnSlotIsOccupied(current)) continue;
    if (current?.kind === "tombstone") {
      const id = target.clearanceOperationId;
      if (id === undefined || (id !== outbox.actionId && id !== outbox.sendId) ||
        current.draft.occurrence === target.occurrence) continue;
      const clearance = await readDraftAuthorityEditReceipt(receipts, id);
      if (clearance?.kind !== "tombstone" || clearance.accountId !== outbox.accountId ||
        !draftAuthorityExpectationMatches(current, { kind: "current", draft: clearance.draft })) {
        continue;
      }
    }
    if (target === disposition.fallback &&
      (slot.kind !== "landing" || target.expected.kind !== "absent")) {
      continue;
    }
    if (target.canvasSidecar !== undefined) {
      if (slot.kind !== "chat") continue;
      const canvas = await readDraftAuthorityCanvasSidecar(
        sidecars,
        current?.draft ?? { slot, occurrence: target.occurrence },
        target.canvasSidecar.scope,
      );
      if ((canvas?.version ?? null) !== target.canvasSidecar.expectedVersion ||
        (canvas?.accountId != null && canvas.accountId !== outbox.accountId) ||
        (canvas?.annotations.length ?? 0) > 0) continue;
    }
    return target;
  }
  return null;
}

export async function publishDraftAuthorityReturn(
  input: PublishReturnInput,
): Promise<ReturnResult> {
  const { actor, sendId, returnId } = input;
  const key = returnKey(actor.accountId, sendId, returnId);
  const result = await runDraftAuthorityTransaction(
    ["pending", "drafts", "sidecars", "receipts", "recovery"],
    "readwrite",
    async ({ pending, drafts, sidecars, receipts, recovery }): Promise<ReturnResult> => {
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      const saved = await receipts.read(key);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (saved !== undefined) {
        return { kind: "replayed", receipt: returnReceiptSchema.parse(saved) };
      }
      const current = await readOutbox(pending, actor.accountId, sendId);
      if (current?.decision.kind !== "returning" ||
        current.decision.disposition.returnId !== returnId) {
        return { kind: "conflict", current };
      }
      const { disposition } = current.decision;
      const target = await eligibleReturnTarget({ drafts, sidecars, receipts }, disposition, current);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (target === null) return { kind: "held" };

      const slot = expectedSlot(target.expected);
      const before = await readDraftAuthorityRecord(drafts, slot);
      const existingTaskDraftId = before?.kind === "live" ? before.payload.draftId : null;
      const suppliedDraftId = target.payload.draftId;
      const payload = slot.kind === "task" && (typeof suppliedDraftId !== "string" || suppliedDraftId.length === 0)
        ? {
            ...target.payload,
            draftId: typeof existingTaskDraftId === "string" && existingTaskDraftId.length > 0
              ? existingTaskDraftId
              : target.occurrence,
          }
        : target.payload;
      const next: DraftAuthorityRecord = {
        kind: "live",
        draft: { slot, occurrence: target.occurrence, version: mintDraftId() },
        payload,
        manifest: target.manifest,
        returnAccountId: target.returnAccountId,
        recoveryAccountId: disposition.recoveryBytes && target.canvasSidecar === undefined
          ? actor.accountId : null,
      };
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (before?.kind === "live" && before.recoveryAccountId !== null &&
        before.recoveryAccountId !== actor.accountId) {
        return { kind: "denied" };
      }
      const previousReference = before?.draft ?? next.draft;
      const previousCanvas = target.canvasSidecar === undefined ? null
        : await readDraftAuthorityCanvasSidecar(sidecars, previousReference, target.canvasSidecar.scope);
      const beforeRoots = before?.kind === "live" && before.recoveryAccountId !== null
        ? before.manifest.digests
        : [];
      const afterRoots = next.recoveryAccountId === null ? [] : target.manifest.digests;
      const canvasRoots = target.canvasSidecar !== undefined &&
        (current.byteCustody || disposition.recoveryBytes)
        ? target.manifest.digests
        : [];
      const changes = [
        { before: beforeRoots, after: afterRoots },
        { before: previousCanvas?.rootDigests ?? [], after: canvasRoots },
      ].filter((change) => change.before.length + change.after.length > 0);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (changes.length > 0) {
        await applyRecoveryRoots(recovery, {
          accountId: actor.accountId,
          byteLimit: LANDING_IMAGE_BUDGET_BYTES,
          changes,
          verified: input.verified ?? [],
        });
        if (!draftAuthorityActorIsCurrent(actor)) {
          throw new Error("Draft authority session changed during return publication");
        }
      }
      const receipt: DraftAuthorityReturnReceipt = {
        accountId: actor.accountId,
        sendId,
        returnId,
        draft: next.draft,
      };
      if (target.canvasSidecar !== undefined) {
        await writeDraftAuthorityCanvasSidecar(
          sidecars,
          next.draft,
          target.canvasSidecar.scope,
          target.canvasSidecar.annotations,
          actor.accountId,
          canvasRoots,
        );
        if (previousCanvas !== null && previousReference.occurrence !== next.draft.occurrence) {
          await sidecars.remove(
            draftAuthorityCanvasKey(previousReference, target.canvasSidecar.scope),
          );
        }
      }
      await Promise.all([
        drafts.write(draftAuthorityKey(slot), next),
        receipts.write(key, receipt),
      ]);
      return { kind: "committed", receipt };
    },
  );
  if (result.kind !== "complete") {
    if (result.cause instanceof RecoveryBlobError) {
      switch (result.cause.kind) {
        case "missing": return { kind: "missing-bytes" };
        case "budget": return { kind: "budget" };
        case "invalid": return { kind: "invalid" };
      }
    }
    return result;
  }
  if (result.value.kind === "committed") {
    notifyDraftAuthorityChange(result.value.receipt.draft);
  }
  return draftAuthorityActorIsCurrent(actor) ? result.value : { kind: "denied" };
}

interface BrowserReturnInput extends OutboxMutationInput {
  readonly returnId: string;
  readonly chatId: string;
}

export type DraftAuthorityBrowserReturnRead =
  | {
      readonly kind: "current";
      readonly content: JsonContent;
      readonly browserAnnotations: readonly BrowserAnnotationRecord[];
      readonly bytes: ReadonlyMap<string, Blob>;
    }
  | { readonly kind: "missing" | "stale" | "denied" | "missing-bytes" | "unavailable" };

function matchesBrowserReturn(outbox: DraftAuthorityOutbox, input: BrowserReturnInput): boolean {
  if (outbox.generation !== input.expectedGeneration ||
    outbox.send.request.kind !== "message" || outbox.send.request.chatId !== input.chatId ||
    outbox.decision.kind !== "returning") return false;
  const { disposition } = outbox.decision;
  return disposition.returnId === input.returnId &&
    disposition.primary === null && disposition.recoveryBytes &&
    disposition.fallback?.expected.kind === "absent" &&
    disposition.fallback.expected.slot.kind === "landing";
}

export async function readDraftAuthorityBrowserReturn(
  input: BrowserReturnInput,
): Promise<DraftAuthorityBrowserReturnRead> {
  const { actor, sendId, returnId } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const result = await runDraftAuthorityTransaction(
    ["pending", "receipts", "recovery"],
    "readonly",
    async ({ pending, receipts, recovery }): Promise<DraftAuthorityBrowserReturnRead> => {
      const current = await readOutbox(pending, actor.accountId, sendId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (current === null) return { kind: "missing" };
      const { content, request } = current.send;
      if (!matchesBrowserReturn(current, input) || request.kind !== "message") {
        return { kind: "stale" };
      }
      if (await receipts.read(returnKey(actor.accountId, sendId, returnId)) !== undefined) {
        return { kind: "stale" };
      }
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      const rawAnnotations = request.browserAnnotations ?? [];
      const browserAnnotations = parseBrowserAnnotationRecords(rawAnnotations);
      const documentDigests = isJsonContent(content, 0) ? hashOnlyDocumentDigests(content) : null;
      if (documentDigests === null || browserAnnotations.length !== rawAnnotations.length) {
        return { kind: "missing-bytes" };
      }
      const digests = [...new Set([...documentDigests, ...collectAnnotationImageHashes(browserAnnotations)])];
      const owned = new Set(current.manifest.digests);
      if (digests.length > 0 && (!current.byteCustody || !digests.every((digest) => owned.has(digest)))) {
        return { kind: "missing-bytes" };
      }
      const bytes = digests.length === 0 ? new Map<string, Blob>() : await readRecoveryBlobs(recovery, {
        accountId: actor.accountId,
        byteLimit: LANDING_IMAGE_BUDGET_BYTES,
        digests,
      });
      return { kind: "current", content, browserAnnotations, bytes };
    },
  );
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  if (result.kind === "complete") return result.value;
  return result.cause instanceof RecoveryBlobError && result.cause.kind === "missing"
    ? { kind: "missing-bytes" }
    : { kind: "unavailable" };
}

export interface DraftAuthorityBrowserReturnAcknowledgement extends BrowserReturnInput {
  readonly expectedChat: DraftAuthorityExpectation;
  readonly isInstallationCurrent: () => boolean;
}

class BrowserReturnInstallationBecameStale extends Error {}

async function matchesBrowserReturnChat(
  { drafts, receipts }: Pick<DraftAuthorityTransaction, "drafts" | "receipts">,
  outbox: DraftAuthorityOutbox,
  input: DraftAuthorityBrowserReturnAcknowledgement,
): Promise<boolean> {
  const expected = input.expectedChat;
  const slot = expectedSlot(expected);
  if (slot.kind !== "chat" || slot.id !== input.chatId) return false;
  const current = await readDraftAuthorityRecord(drafts, slot);
  if (!draftAuthorityExpectationMatches(current, expected)) return false;
  if (current === null) return true;
  if (current.kind === "live") {
    return (current.returnAccountId === null || current.returnAccountId === input.actor.accountId) &&
      current.recoveryAccountId === null && !returnSlotIsOccupied(current);
  }
  const source = outbox.source;
  if (source === null || source.slot.kind !== "chat" || source.slot.id !== slot.id ||
    source.occurrence !== current.draft.occurrence) return false;
  for (const operationId of new Set([outbox.actionId, outbox.sendId])) {
    const clearance = await readDraftAuthorityEditReceipt(receipts, operationId);
    if (clearance?.kind === "tombstone" && clearance.accountId === input.actor.accountId &&
      draftAuthorityExpectationMatches(current, { kind: "current", draft: clearance.draft })) return true;
  }
  return false;
}

interface RetirePendingInput extends OutboxMutationInput {
  readonly returnId: string | null;
  readonly terminalClaim: DraftAuthorityIssueReceipt | null;
}

type RetirementResult = DraftAuthorityMutationResult<
  DraftAuthorityRetiredOutbox,
  DraftAuthorityOutbox
>;

export function cancelDraftAuthorityIdleOutbox(
  input: OutboxMutationInput,
): Promise<RetirementResult> {
  return retirePendingSource({ ...input, returnId: null, terminalClaim: null }, { kind: "idle-cancel" });
}

export function retireDraftAuthorityPendingSource(
  input: RetirePendingInput,
): Promise<RetirementResult> {
  return retirePendingSource(input, { kind: "ordinary" });
}

export function acknowledgeDraftAuthorityBrowserReturn(
  input: DraftAuthorityBrowserReturnAcknowledgement,
): Promise<RetirementResult> {
  return retirePendingSource(
    { ...input, terminalClaim: null },
    { kind: "browser-install", input },
  );
}

function isIdlePayloadFreeOutbox(outbox: DraftAuthorityOutbox): boolean {
  const { request, content, text, delivery } = outbox.send;
  return (request.kind === "terminal" || request.kind === "fork") &&
    outbox.decision.kind === "waiting" && delivery === null &&
    outbox.send.stopRequested !== true && outbox.send.returnRequested === undefined &&
    outbox.send.ended !== true && outbox.dispatch?.status !== "uncertain" &&
    outbox.dispatch?.input.initialMessage == null && outbox.submission === undefined &&
    !outbox.byteCustody && outbox.manifest.digests.length === 0 &&
    isJsonContent(content, 0) && isEmptyLandingDraftContent(content) &&
    (text.trim().length === 0 || (request.kind === "fork" && text === request.title));
}

type RetirementMode =
  | { readonly kind: "ordinary" | "idle-cancel" }
  | { readonly kind: "browser-install"; readonly input: DraftAuthorityBrowserReturnAcknowledgement };

async function retirePendingSource(
  input: RetirePendingInput,
  mode: RetirementMode,
): Promise<RetirementResult> {
  const { actor, sendId, expectedGeneration, returnId, terminalClaim } = input;
  const idleCancellation = mode.kind === "idle-cancel";
  const browser = mode.kind === "browser-install" ? mode.input : undefined;
  const key = outboxKey(actor.accountId, sendId);
  const stores = browser === undefined
    ? (["pending", "claims", "receipts", "recovery"] as const)
    : (["pending", "claims", "receipts", "recovery", "drafts"] as const);
  const result = await runDraftAuthorityTransaction(
    stores,
    "readwrite",
    async ({ pending, claims, receipts, recovery, drafts }): Promise<RetirementResult> => {
      const existing = retiredOutboxSchema.safeParse(await pending.read(key));
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (existing.success) {
        return existing.data.returnId === returnId &&
          (existing.data.idleCancelled === true) === idleCancellation &&
          (existing.data.browserInstalled === true) === (browser !== undefined) &&
          existing.data.browserChatId === browser?.chatId &&
          existing.data.accountId === actor.accountId && existing.data.sendId === sendId &&
          existing.data.generation === expectedGeneration + 1
          ? { kind: "replayed", receipt: existing.data }
          : { kind: "conflict", current: null };
      }
      const current = await readOutbox(pending, actor.accountId, sendId);
      if (current === null || current.generation !== expectedGeneration) {
        return { kind: "conflict", current };
      }
      if (browser !== undefined) {
        if (!matchesBrowserReturn(current, browser) ||
          await receipts.read(returnKey(actor.accountId, sendId, browser.returnId)) !== undefined ||
          !(await matchesBrowserReturnChat({ drafts, receipts }, current, browser)) ||
          !browser.isInstallationCurrent()) {
          return { kind: "conflict", current };
        }
      } else if (idleCancellation) {
        if (!isIdlePayloadFreeOutbox(current)) return { kind: "conflict", current };
      } else if (returnId === null) {
        if (
          terminalClaim === null ||
          (current.decision.kind !== "terminal" && current.decision.kind !== "accepted") ||
          !sameIssue(current.decision.claim, terminalClaim)
        ) {
          return { kind: "denied" };
        }
      } else {
        if (current.decision.kind !== "returning" ||
          current.decision.disposition.returnId !== returnId) {
          return { kind: "denied" };
        }
        const publication = returnReceiptSchema.safeParse(
          await receipts.read(returnKey(actor.accountId, sendId, returnId)),
        );
        if (!publication.success ||
          publication.data.accountId !== actor.accountId ||
          publication.data.sendId !== sendId ||
          publication.data.returnId !== returnId) {
          return { kind: "denied" };
        }
      }

      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (current.byteCustody) {
        await applyRecoveryRoots(recovery, {
          accountId: actor.accountId,
          byteLimit: LANDING_IMAGE_BUDGET_BYTES,
          changes: [{ before: current.manifest.digests, after: [] }],
          verified: [],
        });
        if (!draftAuthorityActorIsCurrent(actor)) {
          throw new Error("Draft authority session changed during retirement");
        }
      }
      const operationIds = await claims.readAll(IDBKeyRange.bound(
        ["outbox-issue", actor.accountId, sendId],
        ["outbox-issue", actor.accountId, sendId, []],
      ));
      if (!draftAuthorityActorIsCurrent(actor)) {
        throw new Error("Draft authority session changed during retirement");
      }
      let releasedPrimary: IDBValidKey | null = null;
      if (idleCancellation) {
        const activeIssues = [current.setupIssue, current.dispatchWakeIssue, current.manualTerminalIssue];
        const ids = new Set(operationIds);
        for (const issue of activeIssues) {
          if (issue !== null && !ids.has(issue.operationId)) return { kind: "conflict", current };
        }
        for (const operationId of ids) {
          if (typeof operationId !== "string") return { kind: "conflict", current };
          const issue = await readIssue(claims, actor.accountId, operationId);
          if (issue === null || issue.receipt.source.kind !== "pending-outbox" ||
            issue.receipt.source.sendId !== sendId ||
            issue.state === "issuing" || issue.state === "uncertain") {
            return { kind: "conflict", current };
          }
        }
        if (current.source !== null) {
          const primary = primaryKey(current.source);
          if (await claims.read(primary) === current.actionId) releasedPrimary = primary;
        }
        if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      }
      const receipt: DraftAuthorityRetiredOutbox = {
        accountId: actor.accountId,
        sendId,
        generation: current.generation + 1,
        returnId,
        ...(idleCancellation ? { idleCancelled: true } : {}),
        ...(browser === undefined ? {} : { browserInstalled: true, browserChatId: browser.chatId }),
      };
      if (browser !== undefined && !browser.isInstallationCurrent()) {
        throw new BrowserReturnInstallationBecameStale();
      }
      if (!draftAuthorityActorIsCurrent(actor)) {
        throw new Error("Draft authority session changed before retirement commit");
      }
      await Promise.all([
        pending.write(key, { kind: "retired", ...receipt }),
        ...(releasedPrimary === null ? [] : [claims.remove(releasedPrimary)]),
        ...operationIds.flatMap((operationId) => typeof operationId === "string"
          ? [
              claims.remove(issueKey(actor.accountId, operationId)),
              claims.remove(outboxIssueKey(actor.accountId, sendId, operationId)),
            ]
          : []),
      ]);
      return { kind: "committed", receipt };
    },
  );
  if (result.kind === "unavailable" && result.cause instanceof BrowserReturnInstallationBecameStale) {
    return { kind: "conflict", current: null };
  }
  if (result.kind !== "complete") return result;
  if (result.value.kind === "committed") notifyPendingChange(result.value.receipt);
  return draftAuthorityActorIsCurrent(actor) ? result.value : { kind: "denied" };
}

function dispatchWakeParentMatches(
  outbox: DraftAuthorityOutbox,
  parent: IssueIdentity | null,
  hostId: unknown,
): boolean {
  if (outbox.dispatch === null || outbox.dispatch.delivery.hostId !== hostId) {
    return false;
  }
  if (parent === null) return outbox.decision.kind === "waiting";
  if (outbox.decision.kind !== "refused" && outbox.decision.kind !== "uncertain") {
    return false;
  }
  const claim = outbox.decision.claim;
  return claim.operationId === parent.operationId &&
    claim.issueGeneration === parent.issueGeneration &&
    claim.executorId === parent.executorId;
}

export async function readDraftAuthorityIssueGrant(input: {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityIssueReceipt;
}): Promise<boolean> {
  const { actor, claim } = input;
  if (!draftAuthorityActorIsCurrent(actor) ||
    actor.accountId !== claim.accountId ||
    actor.sessionGeneration !== claim.sessionGeneration) {
    return false;
  }
  const result = await runDraftAuthorityTransaction(
    ["drafts", "claims", "pending"],
    "readonly",
    async ({ drafts, claims, pending }) => {
      const saved = await readIssue(claims, actor.accountId, claim.operationId);
      if (saved?.state !== "issuing" ||
        saved.receipt.sessionGeneration !== actor.sessionGeneration ||
        !sameIssue(saved.receipt, claim)) {
        return false;
      }
      const { source, effect } = saved.receipt;
      if (source.kind === "restored-draft") {
        return restoredIssueIsCurrent(drafts, claims, saved.receipt);
      }
      const outbox = await readOutbox(pending, actor.accountId, source.sendId);
      if (outbox === null ||
        (outbox.decision.kind === "held" && outbox.decision.reason === "host-end") ||
        outbox.ownership !== effect.phase ||
        !outbox.send.epicConfirmed ||
        (outbox.submission === undefined && requiresOutboxSubmission(outbox.send)) ||
        outbox.generation !== claim.outboxGeneration) {
        return false;
      }
      if (claim.auxiliaryKind === "manual-terminal") {
        return outbox.decision.kind === "waiting" &&
          sameIssue(outbox.manualTerminalIssue, claim) &&
          manualTerminalTargetMatches(outbox, effect.payload);
      }
      if (effect.phase === "setup") return sameIssue(outbox.setupIssue, claim);
      if (claim.auxiliaryKind === "dispatch-wake") {
        return sameIssue(outbox.dispatchWakeIssue, claim) &&
          dispatchWakeParentMatches(outbox, claim.auxiliaryFor, effect.payload.hostId);
      }
      return outbox.decision.kind === "issuing" && sameIssue(outbox.decision.claim, claim);
    },
  );
  return result.kind === "complete" && result.value && draftAuthorityActorIsCurrent(actor);
}

function manualTerminalTargetMatches(
  outbox: DraftAuthorityOutbox,
  payload: DraftAuthorityPayload,
): boolean {
  const { hostId, cwd, terminalId, epicId } = payload;
  return typeof hostId === "string" && hostId.length > 0 &&
    typeof terminalId === "string" && terminalId.length > 0 &&
    typeof cwd === "string" && cwd.length > 0 &&
    epicId === outbox.send.epicId &&
    (outbox.dispatch === null || outbox.dispatch.delivery.hostId === hostId);
}

interface HoldStopInput extends OutboxMutationInput {
  readonly operationId: string;
  readonly attemptId: string;
  readonly hostId: string;
  readonly sandboxId: string;
  readonly observationBoundary: number;
  readonly retryOf?: DraftAuthorityStopReceipt;
}

type StopResult = DraftAuthorityMutationResult<
  DraftAuthorityStopReceipt,
  DraftAuthorityOutbox
>;

function sameStop(left: DraftAuthorityStopReceipt, right: DraftAuthorityStopReceipt): boolean {
  return left.accountId === right.accountId &&
    left.sendId === right.sendId &&
    left.operationId === right.operationId &&
    left.executorId === right.executorId &&
    left.generation === right.generation &&
    left.attemptId === right.attemptId &&
    left.hostId === right.hostId &&
    left.sandboxId === right.sandboxId &&
    left.observationBoundary === right.observationBoundary;
}

function stopAllowsReturn(
  decision: DraftAuthorityPendingDecision,
  stopOperationId: string | undefined,
): boolean {
  return decision.kind === "stopping" &&
    decision.stop.operationId === stopOperationId &&
    (decision.outcome?.kind === "settled" || decision.outcome?.kind === "gone");
}

export async function holdDraftAuthorityStop(input: HoldStopInput): Promise<StopResult> {
  const {
    actor, operationId, sendId, expectedGeneration,
    attemptId, hostId, sandboxId, observationBoundary,
  } = input;
  const result = await runDraftAuthorityTransaction(
    ["pending", "claims", "receipts"],
    "readwrite",
    async ({ pending, claims, receipts }): Promise<StopResult> => {
      const key = ["stop", actor.accountId, sendId, operationId];
      const previous = await receipts.read(key);
      const current = await readOutbox(pending, actor.accountId, sendId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (previous !== undefined) {
        const receipt = stopReceiptSchema.parse(previous);
        return receipt.generation === expectedGeneration + 1 &&
          receipt.attemptId === attemptId && receipt.hostId === hostId &&
          receipt.sandboxId === sandboxId &&
          receipt.observationBoundary === observationBoundary
          ? { kind: "replayed", receipt }
          : { kind: "conflict", current };
      }
      if (current === null || current.generation !== expectedGeneration ||
        current.ownership !== "setup") {
        return { kind: "conflict", current };
      }
      const retry = input.retryOf;
      if (retry === undefined ? current.decision.kind !== "waiting"
        : current.decision.kind !== "stopping" ||
          current.decision.outcome?.kind !== "failed" ||
          !sameStop(current.decision.stop, retry) ||
          retry.attemptId !== attemptId || retry.hostId !== hostId ||
          retry.sandboxId !== sandboxId || observationBoundary < retry.observationBoundary) {
        return { kind: "conflict", current };
      }
      if (current.setupIssue !== null) {
        const issue = await readIssue(claims, actor.accountId, current.setupIssue.operationId);
        if (issue === null || issue.state === "issuing" || issue.state === "uncertain" ||
          issue.receipt.effect.kind === "terminal") {
          return { kind: "conflict", current };
        }
      }
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      const parsed = stopReceiptSchema.safeParse({
        accountId: actor.accountId,
        sessionGeneration: actor.sessionGeneration,
        operationId,
        sendId,
        executorId: mintDraftId(),
        generation: current.generation + 1,
        attemptId,
        hostId,
        sandboxId,
        observationBoundary,
      });
      if (!parsed.success) return { kind: "invalid" };
      const receipt = parsed.data;
      await Promise.all([
        writeOutbox(pending, {
          ...current,
          generation: receipt.generation,
          decision: { kind: "stopping", stop: receipt, outcome: null },
        }),
        receipts.write(key, receipt),
      ]);
      return { kind: "committed", receipt };
    },
  );
  if (result.kind !== "complete") return result;
  if (result.value.kind === "committed") notifyPendingChange(result.value.receipt);
  return draftAuthorityActorIsCurrent(actor) ? result.value : { kind: "denied" };
}

export async function readDraftAuthorityStopGrant(input: {
  readonly actor: DraftAuthorityActor;
  readonly stop: DraftAuthorityStopReceipt;
}): Promise<boolean> {
  const { actor, stop } = input;
  if (actor.accountId !== stop.accountId ||
    actor.sessionGeneration !== stop.sessionGeneration) {
    return false;
  }
  const current = await readDraftAuthorityOutbox({ actor, sendId: stop.sendId });
  return current.kind === "current" &&
    current.outbox.generation === stop.generation &&
    current.outbox.decision.kind === "stopping" &&
    current.outbox.decision.outcome === null &&
    current.outbox.decision.stop.sessionGeneration === actor.sessionGeneration &&
    sameStop(current.outbox.decision.stop, stop) &&
    draftAuthorityActorIsCurrent(actor);
}

export async function settleDraftAuthorityStop(input: {
  readonly actor: DraftAuthorityActor;
  readonly stop: DraftAuthorityStopReceipt;
  readonly outcome: DraftAuthorityStopOutcome;
}): Promise<OutboxResult> {
  const { actor, stop, outcome } = input;
  if (actor.accountId !== stop.accountId) return { kind: "denied" };
  const result = await runDraftAuthorityTransaction(
    ["pending"],
    "readwrite",
    async ({ pending }): Promise<OutboxResult> => {
      const current = await readOutbox(pending, actor.accountId, stop.sendId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (current === null || current.ownership !== "setup" ||
        current.decision.kind !== "stopping" || !sameStop(current.decision.stop, stop)) {
        return { kind: "conflict", current };
      }
      const previous = current.decision.outcome;
      if (previous !== null && JSON.stringify(previous) === JSON.stringify(outcome)) {
        return { kind: "replayed", receipt: current };
      }
      if (previous?.kind === "settled" || previous?.kind === "gone") {
        return { kind: "conflict", current };
      }
      const receipt: DraftAuthorityOutbox = {
        ...current,
        generation: current.generation + 1,
        decision: { ...current.decision, outcome },
      };
      await writeOutbox(pending, receipt);
      return { kind: "committed", receipt };
    },
  );
  return notifyOutboxMutation(result, actor);
}

export async function consumeDraftAuthorityOutboxSource(input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly actionId: string;
  readonly draft: DraftAuthorityVersion;
}): Promise<DraftAuthorityMutationResult<DraftAuthorityEditReceipt, DraftAuthorityRecord>> {
  return writeDraftAuthority({
    operation: { id: input.actionId, actor: input.actor },
    expected: { kind: "current", draft: input.draft },
    mutation: { kind: "delete", retirements: [] },
    pendingCustody: { sendId: input.sendId },
  });
}

async function restoredIssueIsCurrent(
  drafts: DraftAuthorityTransaction["drafts"],
  claims: DraftAuthorityTransaction["claims"],
  receipt: DraftAuthorityIssueReceipt,
): Promise<boolean> {
  const { source } = receipt;
  if (source.kind !== "restored-draft" ||
    source.returnAccountId !== receipt.accountId) return false;
  const active = receipt.checkpointVersion ?? source.draft;
  const current = await readDraftAuthorityRecord(drafts, active.slot);
  if (current?.kind !== "live" || current.returnAccountId !== receipt.accountId ||
    !draftAuthorityExpectationMatches(current, { kind: "current", draft: active })) {
    return false;
  }
  const linked = receipt.linkedPrimary;
  const operationId = await claims.read(primaryKey(active));
  if (linked === null) return operationId === receipt.operationId;
  if (operationId !== linked.operationId) return false;
  const primary = await readIssue(claims, receipt.accountId, linked.operationId);
  return primary?.state === "accepted" &&
    sameIssueIdentity(primary.receipt, linked) &&
    primary.acceptance?.sandboxId === receipt.effect.payload.sandboxId &&
    primary.acceptance?.hostId === receipt.effect.payload.hostId;
}

export async function readDraftAuthorityRestoredIssue(input: {
  readonly actor: DraftAuthorityActor;
  readonly draft: DraftAuthorityVersion;
}): Promise<
  | {
      readonly kind: "current";
      readonly issue: Omit<z.infer<typeof claimSchema>, "intent">;
    }
  | { readonly kind: "missing" | "denied" | "unavailable" }
> {
  const { actor, draft } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const outcome = await runDraftAuthorityTransaction(
    ["drafts", "claims"],
    "readonly",
    async ({ drafts, claims }) => {
      const operationId = await claims.read(primaryKey(draft));
      if (typeof operationId !== "string") return null;
      const saved = await readIssue(claims, actor.accountId, operationId);
      if (saved === null || !(await restoredIssueIsCurrent(drafts, claims, saved.receipt))) {
        return null;
      }
      return { receipt: saved.receipt, state: saved.state, acceptance: saved.acceptance };
    },
  );
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  if (outcome.kind !== "complete") return { kind: "unavailable" };
  return outcome.value === null
    ? { kind: "missing" }
    : { kind: "current", issue: outcome.value };
}

export interface DraftAuthorityRestoredTerminalHandoff {
  readonly actor: DraftAuthorityActor;
  readonly draft: DraftAuthorityVersion;
  readonly primary: DraftAuthorityIssueReceipt;
  readonly operationId: string;
  readonly sandboxId: string;
  readonly hostId: string;
  readonly surfaceKey: string;
}

function sameIssueIdentity(left: IssueIdentity, right: IssueIdentity): boolean {
  return left.operationId === right.operationId &&
    left.issueGeneration === right.issueGeneration &&
    left.executorId === right.executorId;
}

function restoredTerminalKey(accountId: string, primary: IssueIdentity): IDBValidKey {
  return ["restored-terminal", accountId, primary.operationId, primary.issueGeneration];
}

function restoredActionKey(accountId: string, primary: IssueIdentity): IDBValidKey {
  return ["restored-action", accountId, primary.operationId, primary.issueGeneration];
}

const actionIdentity = {
  actionId: z.string().min(1),
  epicId: z.string().min(1),
};

const restoredStartActionFields = {
  tuiAgentId: z.string().min(1),
  worktree: z.enum(["none", "explicit"]),
};

const restoredAction = z.discriminatedUnion("kind", [
  z.object({
    ...actionIdentity,
    kind: z.literal("landing-send"),
    chatId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  z.object({
    ...actionIdentity,
    kind: z.literal("landing-start"),
    ...restoredStartActionFields,
  }),
  z.object({
    ...actionIdentity,
    kind: z.literal("task-start"),
    ...restoredStartActionFields,
  }),
]);

export type DraftAuthorityRestoredAction = Readonly<z.infer<typeof restoredAction>>;

const restoredActionEffect = z.discriminatedUnion("method", [
  z.object({ method: z.literal("epic.create"), request: createEpicRequestSchemaV15 }),
  z.object({ method: z.literal("worktree.create"), request: worktreeCreateRequestSchema }),
  z.object({ method: z.literal("agent.tui.prepareLaunch"), request: prepareTuiLaunchRequestSchemaV11 }),
  z.object({ method: z.literal("epic.createTuiAgent"), request: createTuiAgentRequestSchema }),
]);

export type DraftAuthorityRestoredActionEffect = Readonly<z.infer<typeof restoredActionEffect>>;

const readyActionBinding = z.object({
  primary: issueIdentitySchema,
  setupAttempt: setupAttemptSchema,
  hostId: z.string().min(1),
  sandboxId: z.string().min(1),
});
export type DraftAuthorityRestoredActionReady = Omit<Readonly<z.infer<typeof readyActionBinding>>, "primary"> & {
  readonly primary: DraftAuthorityIssueReceipt;
};

const restoredActionMethod = z.enum([
  "epic.create", "worktree.create", "agent.tui.prepareLaunch", "epic.createTuiAgent",
]);
const restoredActionClaim = issueIdentitySchema.extend({
  accountId: z.string().min(1),
  sessionGeneration: z.string().min(1),
  draft: version,
  primary: issueIdentitySchema,
  actionId: z.string().min(1),
  hostId: z.string().min(1),
  sandboxId: z.string().min(1),
  method: restoredActionMethod,
});

export type DraftAuthorityRestoredActionClaim = Readonly<z.infer<typeof restoredActionClaim>>;

const observedActionTarget = {
  hostId: z.string().min(1),
  epicId: z.string().min(1),
};
const restoredActionEvidence = z.union([
  z.object({
    ...observedActionTarget,
    method: z.literal("epic.create"),
    proof: z.literal("response"),
    response: createEpicResponseSchemaV12,
  }),
  z.object({ ...observedActionTarget, method: z.literal("epic.create"), proof: z.literal("task-read") }),
  z.object({
    ...observedActionTarget,
    method: z.literal("worktree.create"),
    proof: z.literal("response"),
    response: worktreeCreateResponseSchema,
  }),
  z.object({
    ...observedActionTarget,
    method: z.literal("worktree.create"),
    proof: z.literal("binding-read"),
    tuiAgentId: z.string().min(1),
    binding: worktreeBindingSchema,
  }),
  z.object({
    ...observedActionTarget,
    method: z.literal("agent.tui.prepareLaunch"),
    proof: z.literal("response"),
    response: prepareTuiLaunchResponseSchema,
  }),
  z.object({
    ...observedActionTarget,
    method: z.literal("epic.createTuiAgent"),
    proof: z.literal("response"),
    response: createTuiAgentResponseSchema,
  }),
  z.object({
    ...observedActionTarget,
    method: z.literal("epic.createTuiAgent"),
    proof: z.literal("agent-read"),
    tuiAgentId: z.string().min(1),
    harnessId: z.string().min(1),
    harnessSessionId: z.string().nullable(),
  }),
]);
const restoredActionOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["refused", "uncertain"]) }),
  z.object({ kind: z.literal("accepted"), evidence: restoredActionEvidence }),
]);
export type DraftAuthorityRestoredActionOutcome = Readonly<z.infer<typeof restoredActionOutcome>>;
const restoredActionStep = z.object({
  claim: restoredActionClaim,
  effect: restoredActionEffect,
  requestDigest: z.string(),
  outcome: restoredActionOutcome.nullable(),
});
const restoredActionLane = z.object({
  ready: readyActionBinding,
  action: restoredAction,
  steps: z.array(restoredActionStep),
});
type RestoredActionLane = z.infer<typeof restoredActionLane>;
type RestoredActionStep = z.infer<typeof restoredActionStep>;
export type DraftAuthorityRestoredActionStep = Omit<RestoredActionStep, "requestDigest">;
type RestoredActionResult = DraftAuthorityMutationResult<DraftAuthorityRestoredActionClaim>;

function nextRestoredActionMethod(
  action: DraftAuthorityRestoredAction,
  steps: readonly RestoredActionStep[],
): DraftAuthorityRestoredActionEffect["method"] | undefined {
  if (action.kind === "landing-send") return steps.length === 0 ? "epic.create" : undefined;
  const methods: DraftAuthorityRestoredActionEffect["method"][] = [];
  if (action.kind === "landing-start") methods.push("epic.create");
  if (action.worktree === "explicit") methods.push("worktree.create");
  methods.push("agent.tui.prepareLaunch", "epic.createTuiAgent");
  return methods[steps.length];
}

async function readRestoredActionLane(
  claims: PendingStore,
  accountId: string,
  primary: IssueIdentity,
): Promise<RestoredActionLane | null> {
  const row = await claims.read(restoredActionKey(accountId, primary));
  return row === undefined ? null : restoredActionLane.parse(row);
}

function sameRestoredActionDraft(left: DraftAuthorityVersion, right: DraftAuthorityVersion): boolean {
  return sameDraftAuthoritySlot(left.slot, right.slot) &&
    left.occurrence === right.occurrence && left.version === right.version;
}

async function readRestoredActionPrimary(
  { drafts, claims }: Pick<DraftAuthorityTransaction, "drafts" | "claims">,
  accountId: string,
  draft: DraftAuthorityVersion,
  ready: z.infer<typeof readyActionBinding>,
): Promise<DraftAuthorityIssueReceipt | null> {
  const saved = await readIssue(claims, accountId, ready.primary.operationId);
  if (saved?.state !== "accepted" || !sameIssueIdentity(saved.receipt, ready.primary) ||
    saved.receipt.source.kind !== "restored-draft" || saved.receipt.linkedPrimary !== null ||
    saved.receipt.effect.phase !== "setup" ||
    (saved.receipt.effect.kind !== "create" && saved.receipt.effect.kind !== "wake") ||
    !sameSetupAttempt(saved.receipt.setupAttempt, ready.setupAttempt) ||
    saved.acceptance === null || saved.acceptance.hostId !== ready.hostId ||
    saved.acceptance.sandboxId !== ready.sandboxId) {
    return null;
  }
  const active = saved.receipt.checkpointVersion ?? saved.receipt.source.draft;
  if (!sameRestoredActionDraft(active, draft) ||
    !(await restoredIssueIsCurrent(drafts, claims, saved.receipt))) {
    return null;
  }
  return saved.receipt;
}

function actionEffectMatches(
  action: DraftAuthorityRestoredAction,
  hostId: string,
  effect: DraftAuthorityRestoredActionEffect,
  previous: readonly RestoredActionStep[],
): boolean {
  if (effect.method === "epic.create") {
    if (action.kind === "task-start" || effect.request.epic.id !== action.epicId) return false;
    const chat = effect.request.chat;
    if (action.kind === "landing-start") return chat == null;
    const initialMessage = chat?.initialMessage;
    return chat?.hostId === hostId && chat.chatId === action.chatId &&
      initialMessage != null && initialMessage.messageId === action.messageId &&
      initialMessage.clientActionId === action.actionId;
  }

  if (action.kind === "landing-send" || effect.request.epicId !== action.epicId) return false;
  if (effect.method === "worktree.create") {
    return action.worktree === "explicit" && effect.request.ownerKind === "terminal-agent" &&
      effect.request.ownerId === action.tuiAgentId && effect.request.entries.length > 0;
  }
  if (effect.request.tuiAgentId !== action.tuiAgentId) return false;
  if (effect.method === "agent.tui.prepareLaunch") {
    return effect.request.harnessSessionId === null &&
      effect.request.forkSourceHarnessSessionId === null && effect.request.forkSourceTuiAgentId === null;
  }

  const prepared = previous.at(-1);
  const accepted = prepared?.outcome?.kind === "accepted" ? prepared.outcome.evidence : null;
  if (prepared?.effect.method !== "agent.tui.prepareLaunch" ||
    accepted?.method !== "agent.tui.prepareLaunch") return false;
  const request = effect.request;
  const result = accepted.response;
  const prepare = prepared.effect.request;
  return request.hostId === hostId && request.harnessId === result.harnessId &&
    request.harnessSessionId === result.harnessSessionId &&
    request.terminalShellCommand === result.terminalShellCommand &&
    JSON.stringify(request.terminalShellArgs) === JSON.stringify(result.terminalShellArgs) &&
    JSON.stringify(request.workspaceFolders) === JSON.stringify(result.workspaceFolders) &&
    request.profileId === prepare.profileId && request.model === prepare.model &&
    request.reasoningEffort === prepare.reasoningEffort && request.agentMode === prepare.agentMode &&
    request.workspaceMode === prepare.workspaceMode && request.terminalAgentArgs === prepare.terminalAgentArgs &&
    request.forkSourceHarnessSessionId === null;
}

function worktreeReadbackMatches(
  request: z.infer<typeof worktreeCreateRequestSchema>,
  binding: z.infer<typeof worktreeBindingSchema>,
): boolean {
  return binding.entries.length === request.entries.length && request.entries.every((entry) =>
    binding.entries.some((row) => {
      if (row.workspacePath !== entry.workspacePath || row.isPrimary !== entry.isPrimary ||
        JSON.stringify(row.repoIdentifier) !== JSON.stringify(entry.repoIdentifier)) return false;
      if (entry.kind === "local") return row.mode === "local" && row.worktreePath === null;
      if (entry.kind === "import") return row.mode === "worktree" && row.isImported &&
        row.worktreePath === entry.worktreePath;
      return row.mode === "worktree" && !row.isImported && row.worktreePath !== null &&
        row.branch === entry.branch.name;
    }),
  );
}

function actionEvidenceMatches(
  action: DraftAuthorityRestoredAction,
  step: RestoredActionStep,
  evidence: z.infer<typeof restoredActionEvidence>,
): boolean {
  const { effect } = step;
  if (evidence.hostId !== step.claim.hostId || evidence.epicId !== action.epicId) return false;
  if (effect.method === "epic.create" && evidence.method === "epic.create") {
    return evidence.proof === "task-read" ||
      (evidence.response.refusal === undefined &&
        (evidence.response.task == null || evidence.response.task.epic?.light?.id === action.epicId));
  }
  if (effect.method === "worktree.create" && evidence.method === "worktree.create") {
    if (evidence.proof === "binding-read") {
      return evidence.tuiAgentId === effect.request.ownerId &&
        worktreeReadbackMatches(effect.request, evidence.binding);
    }
    return effect.request.entries.every((entry) =>
      evidence.response.perEntry.some((row) => row.workspacePath === entry.workspacePath && row.ok) &&
      evidence.response.binding.entries.some((row) => row.workspacePath === entry.workspacePath),
    );
  }
  if (effect.method === "agent.tui.prepareLaunch" && evidence.method === effect.method) {
    return evidence.response.hostId === step.claim.hostId &&
      evidence.response.harnessId === effect.request.harnessId &&
      evidence.response.workingDirectory.length > 0;
  }
  if (effect.method === "epic.createTuiAgent" && evidence.method === effect.method) {
    return evidence.proof === "response"
      ? evidence.response.tuiAgentId === effect.request.tuiAgentId
      : evidence.tuiAgentId === effect.request.tuiAgentId &&
        evidence.harnessId === effect.request.harnessId &&
        (effect.request.harnessSessionId === null ||
          evidence.harnessSessionId === effect.request.harnessSessionId);
  }
  return false;
}

export async function claimDraftAuthorityRestoredActionEffect(input: {
  readonly actor: DraftAuthorityActor;
  readonly draft: DraftAuthorityVersion;
  readonly ready: DraftAuthorityRestoredActionReady;
  readonly action: DraftAuthorityRestoredAction;
  readonly effect: DraftAuthorityRestoredActionEffect;
  readonly expectedIssueGeneration: number | null;
  readonly isCurrent: () => boolean;
}): Promise<RestoredActionResult> {
  const { actor, draft, expectedIssueGeneration, isCurrent } = input;
  const readyResult = readyActionBinding.safeParse(input.ready);
  const actionResult = restoredAction.safeParse(input.action);
  const effectResult = restoredActionEffect.safeParse(input.effect);
  if (!readyResult.success || !actionResult.success || !effectResult.success) return { kind: "invalid" };
  const ready = readyResult.data;
  const action = actionResult.data;
  const effect = effectResult.data;
  if (action.kind === "task-start"
    ? draft.slot.kind !== "task" || draft.slot.id !== action.epicId
    : draft.slot.kind !== "landing") return { kind: "invalid" };
  if (!draftAuthorityActorIsCurrent(actor) || input.ready.primary.accountId !== actor.accountId) {
    return { kind: "denied" };
  }
  const requestDigest = await draftAuthorityIntentDigest(input.effect);
  const result = await runDraftAuthorityTransaction(
    ["drafts", "claims"],
    "readwrite",
    async (tx): Promise<RestoredActionResult> => {
      const { claims } = tx;
      const primary = await readRestoredActionPrimary(tx, actor.accountId, draft, ready);
      if (primary === null || primary.sessionGeneration !== input.ready.primary.sessionGeneration) {
        return { kind: "conflict", current: null };
      }
      const lane = await readRestoredActionLane(claims, actor.accountId, primary);
      const steps = lane?.steps ?? [];
      if (lane !== null && (JSON.stringify(lane.action) !== JSON.stringify(action) ||
        JSON.stringify(lane.ready) !== JSON.stringify(ready))) return { kind: "conflict", current: null };
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      const saved = steps.find((step) => step.effect.method === effect.method);
      if (saved !== undefined && saved.requestDigest !== requestDigest) {
        return { kind: "conflict", current: null };
      }
      if (saved !== undefined && expectedIssueGeneration === null) return { kind: "replayed", receipt: saved.claim };

      const last = steps.at(-1);
      if (expectedIssueGeneration === null) {
        if ((last !== undefined && last.outcome?.kind !== "accepted") ||
          nextRestoredActionMethod(action, steps) !== effect.method ||
          !actionEffectMatches(action, ready.hostId, effect, steps)) return { kind: "conflict", current: null };
      } else if (last !== saved || saved?.outcome?.kind !== "refused" ||
        saved.claim.issueGeneration !== expectedIssueGeneration) {
        return { kind: "conflict", current: null };
      }

      const terminalId = await claims.read(restoredTerminalKey(actor.accountId, primary));
      if (terminalId !== undefined && (typeof terminalId !== "string" ||
        (await readIssue(claims, actor.accountId, terminalId))?.state !== "terminal")) {
        return { kind: "conflict", current: null };
      }
      if (!draftAuthorityActorIsCurrent(actor) ||
        (last !== undefined && last.claim.sessionGeneration !== actor.sessionGeneration)) return { kind: "denied" };
      if (!isCurrent()) return { kind: "conflict", current: null };
      const claim: DraftAuthorityRestoredActionClaim = {
        accountId: actor.accountId,
        sessionGeneration: actor.sessionGeneration,
        draft,
        primary: ready.primary,
        actionId: action.actionId,
        hostId: ready.hostId,
        sandboxId: ready.sandboxId,
        method: effect.method,
        operationId: saved?.claim.operationId ?? mintDraftId(),
        issueGeneration: (saved?.claim.issueGeneration ?? 0) + 1,
        executorId: mintDraftId(),
      };
      await claims.write(restoredActionKey(actor.accountId, primary), {
        ready, action,
        steps: [...(saved === undefined ? steps : steps.slice(0, -1)), { claim, effect, requestDigest, outcome: null }],
      });
      if (!draftAuthorityActorIsCurrent(actor) || !isCurrent()) throw new RestoredSuccessorBecameStale();
      return { kind: "committed", receipt: claim };
    },
  );
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  if (result.kind === "unavailable" && result.cause instanceof RestoredSuccessorBecameStale) {
    return { kind: "conflict", current: null };
  }
  return result.kind === "complete" ? result.value : result;
}

async function readCurrentRestoredActionStep(
  tx: Pick<DraftAuthorityTransaction, "drafts" | "claims">,
  claim: DraftAuthorityRestoredActionClaim,
): Promise<{ lane: RestoredActionLane; step: RestoredActionStep } | null> {
  const lane = await readRestoredActionLane(tx.claims, claim.accountId, claim.primary);
  if (lane === null || lane.action.actionId !== claim.actionId) return null;
  const step = lane.steps.find((candidate) => candidate.effect.method === claim.method);
  if (step === undefined || !sameIssueIdentity(step.claim, claim) ||
    !sameIssueIdentity(step.claim.primary, claim.primary) ||
    step.claim.sessionGeneration !== claim.sessionGeneration ||
    step.claim.hostId !== claim.hostId || step.claim.sandboxId !== claim.sandboxId ||
    !sameRestoredActionDraft(step.claim.draft, claim.draft) ||
    !(await readRestoredActionPrimary(tx, claim.accountId, claim.draft, lane.ready))) return null;
  return { lane, step };
}

export async function isFinalAcceptedRestoredStart(
  tx: Pick<DraftAuthorityTransaction, "drafts" | "claims">,
  claim: DraftAuthorityRestoredActionClaim,
): Promise<boolean> {
  if (claim.method !== "epic.createTuiAgent") return false;
  const current = await readCurrentRestoredActionStep(tx, claim);
  if (current === null) return false;
  const { lane, step } = current;
  const kind = claim.draft.slot.kind;
  return (kind === "landing" && lane.action.kind === "landing-start" ||
    kind === "task" && lane.action.kind === "task-start" && lane.action.epicId === claim.draft.slot.id) &&
    lane.steps.at(-1) === step &&
    step.outcome?.kind === "accepted" && step.outcome.evidence.method === "epic.createTuiAgent";
}

export async function readDraftAuthorityRestoredActionEffectGrant(input: {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityRestoredActionClaim;
  readonly effect: DraftAuthorityRestoredActionEffect;
}): Promise<boolean> {
  const { actor, claim, effect } = input;
  if (actor.accountId !== claim.accountId || actor.sessionGeneration !== claim.sessionGeneration ||
    !draftAuthorityActorIsCurrent(actor)) return false;
  const requestDigest = await draftAuthorityIntentDigest(effect);
  const result = await runDraftAuthorityTransaction(["drafts", "claims"], "readonly", async (tx) => {
    const current = await readCurrentRestoredActionStep(tx, claim);
    return current !== null && current.step.outcome === null && current.step.requestDigest === requestDigest;
  });
  return result.kind === "complete" && result.value && draftAuthorityActorIsCurrent(actor);
}

export async function settleDraftAuthorityRestoredActionEffect(input: {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityRestoredActionClaim;
  readonly outcome: DraftAuthorityRestoredActionOutcome;
}): Promise<RestoredActionResult> {
  const { actor, claim } = input;
  if (actor.accountId !== claim.accountId || !draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const parsed = restoredActionOutcome.safeParse(input.outcome);
  if (!parsed.success) return { kind: "invalid" };
  const outcome = parsed.data;
  const result = await runDraftAuthorityTransaction(
    ["drafts", "claims"],
    "readwrite",
    async (tx): Promise<RestoredActionResult> => {
      const current = await readCurrentRestoredActionStep(tx, claim);
      if (current === null) return { kind: "conflict", current: null };
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      const { lane, step } = current;
      if (JSON.stringify(step.outcome) === JSON.stringify(outcome)) {
        return { kind: "replayed", receipt: step.claim };
      }
      if (lane.steps.at(-1) !== step || (step.outcome !== null && step.outcome.kind !== "uncertain")) {
        return { kind: "conflict", current: null };
      }
      if (outcome.kind === "accepted" && !actionEvidenceMatches(lane.action, step, outcome.evidence)) {
        return { kind: "invalid" };
      }
      await tx.claims.write(restoredActionKey(actor.accountId, claim.primary), {
        ...lane,
        steps: [...lane.steps.slice(0, -1), { ...step, outcome }],
      });
      if (!draftAuthorityActorIsCurrent(actor)) throw new RestoredSuccessorBecameStale();
      return { kind: "committed", receipt: step.claim };
    },
  );
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  return result.kind === "complete" ? result.value : result;
}

export async function readDraftAuthorityRestoredAction(input: {
  readonly actor: DraftAuthorityActor;
  readonly draft: DraftAuthorityVersion;
}): Promise<
  | {
      readonly kind: "current";
      readonly action: DraftAuthorityRestoredAction;
      readonly steps: readonly DraftAuthorityRestoredActionStep[];
    }
  | { readonly kind: "missing" | "denied" | "unavailable" }
> {
  const { actor, draft } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const result = await runDraftAuthorityTransaction(["drafts", "claims"], "readonly", async (tx) => {
    const operationId = await tx.claims.read(primaryKey(draft));
    if (typeof operationId !== "string") return null;
    const primary = await readIssue(tx.claims, actor.accountId, operationId);
    if (primary === null) return null;
    const lane = await readRestoredActionLane(tx.claims, actor.accountId, primary.receipt);
    if (lane === null || !(await readRestoredActionPrimary(tx, actor.accountId, draft, lane.ready))) return null;
    return lane;
  });
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  if (result.kind !== "complete") return { kind: "unavailable" };
  if (result.value === null) return { kind: "missing" };
  return {
    kind: "current",
    action: result.value.action,
    steps: result.value.steps.map(({ claim, effect, outcome }) => ({ claim, effect, outcome })),
  };
}

type RestoredTerminalTarget = {
  readonly terminalId: string;
  readonly cwd: string;
};

export type ClaimDraftAuthorityRestoredTerminalInput = {
  readonly handoff: DraftAuthorityRestoredTerminalHandoff;
} & (
  | {
      readonly target: RestoredTerminalTarget & { readonly landingPageId: string };
    }
  | {
      readonly target: RestoredTerminalTarget & { readonly epicId: string };
      readonly setupAttempt: DraftAuthoritySetupAttempt;
      readonly isCurrent: () => boolean;
    }
);

export async function claimDraftAuthorityRestoredTerminal(
  input: ClaimDraftAuthorityRestoredTerminalInput,
): Promise<IssueResult> {
  const { handoff, target } = input;
  const { actor, draft, primary, operationId, sandboxId, hostId, surfaceKey } = handoff;
  const task = "setupAttempt" in input ? input : null;
  const matchesSlot = "landingPageId" in target
    ? draft.slot.kind === "landing" && draft.slot.id === target.landingPageId
    : draft.slot.kind === "task" && draft.slot.id === target.epicId;
  if (!matchesSlot || (task !== null && !setupAttemptSchema.safeParse(task.setupAttempt).success) ||
    target.cwd.length === 0 || target.terminalId.length === 0 ||
    operationId.length === 0 || hostId.length === 0 || sandboxId.length === 0 ||
    surfaceKey.length === 0) {
    return { kind: "invalid" };
  }
  if (!draftAuthorityActorIsCurrent(actor) || primary.accountId !== actor.accountId) {
    return { kind: "denied" };
  }

  const effect: DraftAuthorityEffectIntent = {
    kind: "terminal",
    phase: "setup",
    identity: target.terminalId,
    payload: { sandboxId, hostId, surfaceKey, ...target },
  };
  const link = {
    operationId: primary.operationId,
    issueGeneration: primary.issueGeneration,
    executorId: primary.executorId,
  };
  const intent = await draftAuthorityIntentDigest(task === null
    ? { draft, link, effect }
    : { draft, link, effect, setupAttempt: task.setupAttempt });
  const outcome = await runDraftAuthorityTransaction(
    ["drafts", "claims"],
    "readwrite",
    async ({ drafts, claims }): Promise<IssueResult> => {
      const prior = await readIssue(claims, actor.accountId, operationId);
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (prior !== null) {
        return prior.intent === intent
          ? { kind: "replayed", receipt: prior.receipt }
          : { kind: "conflict", current: null };
      }
      const saved = await readIssue(claims, actor.accountId, primary.operationId);
      if (saved?.state !== "accepted" ||
        !sameIssue(saved.receipt, primary) ||
        saved.receipt.source.kind !== "restored-draft" ||
        (saved.receipt.effect.kind !== "create" && saved.receipt.effect.kind !== "wake") ||
        saved.acceptance === null ||
        saved.acceptance.sandboxId !== sandboxId ||
        saved.acceptance.hostId !== hostId ||
        (task !== null && !sameSetupAttempt(saved.receipt.setupAttempt, task.setupAttempt)) ||
        !(await restoredIssueIsCurrent(drafts, claims, saved.receipt))) {
        return { kind: "conflict", current: null };
      }
      const slot = saved.receipt.checkpointVersion ?? saved.receipt.source.draft;
      const active = await readDraftAuthorityRecord(drafts, slot.slot);
      if (active === null ||
        !draftAuthorityExpectationMatches(active, { kind: "current", draft })) {
        return { kind: "conflict", current: null };
      }
      const terminalKey = restoredTerminalKey(actor.accountId, link);
      if (await claims.read(terminalKey) !== undefined ||
        await claims.read(restoredActionKey(actor.accountId, link)) !== undefined) {
        return { kind: "conflict", current: null };
      }
      if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
      if (task !== null && !task.isCurrent()) return { kind: "conflict", current: null };
      const receipt: DraftAuthorityIssueReceipt = {
        accountId: actor.accountId,
        sessionGeneration: actor.sessionGeneration,
        operationId,
        issueGeneration: 1,
        executorId: mintDraftId(),
        auxiliaryFor: null,
        auxiliaryKind: null,
        linkedPrimary: link,
        checkpointVersion: null,
        source: { kind: "restored-draft", draft, returnAccountId: actor.accountId },
        effect,
        ...(task === null ? {} : { setupAttempt: task.setupAttempt }),
        outboxGeneration: null,
      };
      await Promise.all([
        claims.write(terminalKey, operationId),
        claims.write(issueKey(actor.accountId, operationId), {
          receipt,
          state: "issuing",
          acceptance: null,
          intent,
        }),
      ]);
      return { kind: "committed", receipt };
    },
  );
  if (outcome.kind !== "complete") return outcome;
  return draftAuthorityActorIsCurrent(actor) ? outcome.value : { kind: "denied" };
}
