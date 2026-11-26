import { z } from "zod";
import {
  utf8Bytes,
  webCryptoSha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import { appLogger, describeLogError } from "@/lib/logger";
import { parseBrowserAnnotationRecords } from "@/lib/browser-view/annotation/browser-annotation-record";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { isJsonContent, isRecord } from "@/lib/editor/prosemirror-json";
import { landingPlacementHostId } from "./draft-local-edits";
import { LANDING_IMAGE_BUDGET_BYTES } from "@/lib/composer/landing-image-budget";
import { persistKey } from "@/lib/persist/keys";
import { runDraftAuthorityTransaction } from "./draft-authority-db";
import { mintDraftId } from "./draft-ids";
import {
  applyRecoveryRoots,
  readRecoveryBlobs,
  RecoveryBlobError,
} from "./recovery-blob-store";
import {
  draftAuthorityCanvasKey,
  readDraftAuthorityCanvasSidecar,
  type DraftAuthorityCanvasScope,
} from "./draft-authority-sidecar";
import { notifyDraftAuthorityRetirement } from "./draft-authority-retirement";
import {
  isFinalAcceptedRestoredStart,
  type DraftAuthorityRestoredActionClaim,
} from "./draft-authority-pending";
import { draftAuthorityActorIsCurrent, draftAuthorityOptionalActorIsCurrent } from "./draft-authority-session";
import type {
  DraftAuthorityActor,
  DraftAuthorityBorrowedStore,
  DraftAuthorityEditReceipt,
  DraftAuthorityExpectation,
  DraftAuthorityHostRetirement,
  DraftAuthorityInstallSource,
  DraftAuthorityLandingFlush,
  DraftAuthorityManifest,
  DraftAuthorityMutationResult,
  DraftAuthorityOperation,
  DraftAuthorityPayload,
  DraftAuthorityReadResult,
  DraftAuthorityReference,
  DraftAuthorityVerifiedBlob,
  DraftAuthorityRecord,
  DraftAuthoritySlot,
  DraftAuthorityVersion,
} from "./draft-authority-types";

const slotSchema = z.object({
  kind: z.enum(["task", "chat", "landing"]),
  id: z.string().min(1),
});
const versionSchema = z.object({
  slot: slotSchema,
  occurrence: z.string().min(1),
  version: z.string().min(1),
});
const manifestSchema = z.object({ digests: z.array(z.string()) });
const recordSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("live"),
    draft: versionSchema,
    payload: z.record(z.string(), z.unknown()),
    manifest: manifestSchema,
    returnAccountId: z.string().nullable(),
    recoveryAccountId: z.string().nullable(),
  }),
  z.object({ kind: z.literal("tombstone"), draft: versionSchema }),
]);
const editReceiptSchema = z.object({
  intent: z.string(),
  receipt: z.object({
    operationId: z.string(),
    accountId: z.string().nullable(),
    draft: versionSchema,
    kind: z.enum(["live", "tombstone"]),
  }),
});

const CHANGE_KEY = persistKey("draft-authority-changed");
const listeners = new Set<(slot: DraftAuthoritySlot) => void>();

export function draftAuthorityKey(slot: DraftAuthoritySlot): IDBValidKey {
  return [slot.kind, slot.id];
}

export function sameDraftAuthoritySlot(
  left: DraftAuthoritySlot,
  right: DraftAuthoritySlot,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export function draftAuthorityExpectationMatches(
  current: DraftAuthorityRecord | null,
  expected: DraftAuthorityExpectation,
): boolean {
  if (expected.kind === "absent") return current === null;
  return (
    current !== null &&
    sameDraftAuthoritySlot(current.draft.slot, expected.draft.slot) &&
    current.draft.occurrence === expected.draft.occurrence &&
    current.draft.version === expected.draft.version
  );
}

export async function readDraftAuthorityEditReceipt(
  store: DraftAuthorityBorrowedStore<IDBValidKey>,
  operationId: string,
): Promise<DraftAuthorityEditReceipt | null> {
  const saved = await store.read(["draft-write", operationId]);
  return saved === undefined ? null : editReceiptSchema.parse(saved).receipt;
}

export async function readDraftAuthorityRecord(
  store: DraftAuthorityBorrowedStore<IDBValidKey>,
  slot: DraftAuthoritySlot,
): Promise<DraftAuthorityRecord | null> {
  const value = await store.read(draftAuthorityKey(slot));
  if (value === undefined) return null;
  const record = recordSchema.parse(value);
  if (!sameDraftAuthoritySlot(record.draft.slot, slot)) {
    throw new Error("Draft authority slot does not match its record");
  }
  return record;
}

export async function readDraftAuthoritySlot(
  slot: DraftAuthoritySlot,
): Promise<DraftAuthorityReadResult> {
  const result = await runDraftAuthorityTransaction(
    ["drafts"],
    "readonly",
    ({ drafts }) => readDraftAuthorityRecord(drafts, slot),
  );
  if (result.kind !== "complete") return { kind: "unavailable" };
  return result.value === null
    ? { kind: "missing" }
    : { kind: "current", record: result.value };
}

export async function readDraftAuthoritySlots(
  slots: readonly DraftAuthoritySlot[],
): Promise<readonly (DraftAuthorityRecord | null)[] | null> {
  const result = await runDraftAuthorityTransaction(
    ["drafts"],
    "readonly",
    ({ drafts }) => Promise.all(slots.map((slot) => readDraftAuthorityRecord(drafts, slot))),
  );
  return result.kind === "complete" ? result.value : null;
}

export async function listDraftAuthoritySlots(
  kind: DraftAuthoritySlot["kind"],
): Promise<readonly DraftAuthorityRecord[] | null> {
  const result = await runDraftAuthorityTransaction(
    ["drafts"],
    "readonly",
    async ({ drafts }) => {
      const values = await drafts.readAll(IDBKeyRange.bound([kind], [kind, []]));
      return values.flatMap((value) => {
        const parsed = recordSchema.safeParse(value);
        return parsed.success && parsed.data.draft.slot.kind === kind &&
          (parsed.data.kind === "tombstone" || parsed.data.recoveryAccountId === null)
          ? [parsed.data]
          : [];
      });
    },
  );
  return result.kind === "complete" ? result.value : null;
}

export async function draftAuthorityIntentDigest(intent: unknown): Promise<string> {
  const encoded = JSON.stringify(intent);
  if (encoded === undefined) throw new Error("Missing draft authority intent");
  return webCryptoSha256Hex(utf8Bytes(encoded));
}

function emitDraftAuthorityChange(slot: DraftAuthoritySlot): void {
  for (const listener of listeners) {
    try {
      listener(slot);
    } catch (error: unknown) {
      appLogger.warn("[draft-authority] local invalidation failed", {
        error: describeLogError(error),
      });
    }
  }
}

export function notifyDraftAuthorityChange(draft: DraftAuthorityVersion): void {
  try {
    globalThis.localStorage?.setItem(CHANGE_KEY, JSON.stringify(draft));
  } catch {
    // A missed invalidation does not change the committed version.
  }
  emitDraftAuthorityChange(draft.slot);
}

function onStorageChange(event: StorageEvent): void {
  if (event.key !== CHANGE_KEY || event.newValue === null) return;
  try {
    const next = versionSchema.safeParse(JSON.parse(event.newValue));
    if (next.success) emitDraftAuthorityChange(next.data.slot);
  } catch {
    // Notifications carry hints only; readers resolve their own committed record.
  }
}

export function subscribeToDraftAuthorityChanges(
  listener: (slot: DraftAuthoritySlot) => void,
): () => void {
  if (listeners.size === 0) globalThis.window?.addEventListener("storage", onStorageChange);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) globalThis.window?.removeEventListener("storage", onStorageChange);
  };
}

interface LiveDraftInput {
  readonly payload: DraftAuthorityPayload;
  readonly manifest: DraftAuthorityManifest;
  readonly returnAccountId: string | null;
}

type DraftMutation =
  | ({ readonly kind: "replace"; readonly occurrence: string } & LiveDraftInput)
  | ({ readonly kind: "edit" } & LiveDraftInput)
  | { readonly kind: "delete"; readonly retirements: readonly DraftAuthorityHostRetirement[] };

export interface WriteDraftAuthorityInput {
  readonly operation: DraftAuthorityOperation;
  readonly expected: DraftAuthorityExpectation;
  readonly mutation: DraftMutation;
  readonly installSource?: DraftAuthorityInstallSource;
  readonly pendingCustody?: { readonly sendId: string };
  readonly canvas?: {
    readonly scope: DraftAuthorityCanvasScope;
    readonly expectedVersion: string | null;
  };
  readonly verifiedRecoveryBlobs?: readonly DraftAuthorityVerifiedBlob[];
}

function nextDraftAuthorityRecord(
  slot: DraftAuthoritySlot,
  current: DraftAuthorityRecord | null,
  mutation: DraftMutation,
): DraftAuthorityRecord | null {
  if (mutation.kind === "replace") {
    if (current?.kind === "tombstone" && current.draft.occurrence === mutation.occurrence) return null;
    return {
      kind: "live",
      draft: { slot, occurrence: mutation.occurrence, version: mintDraftId() },
      payload: mutation.payload,
      manifest: mutation.manifest,
      returnAccountId: mutation.returnAccountId,
      recoveryAccountId: null,
    };
  }
  if (current?.kind !== "live") return null;
  const draft = { ...current.draft, version: mintDraftId() };
  if (mutation.kind === "delete") return { kind: "tombstone", draft };
  return {
    kind: "live",
    draft,
    payload: mutation.payload,
    manifest: mutation.manifest,
    returnAccountId: mutation.returnAccountId,
    recoveryAccountId: current.recoveryAccountId,
  };
}

export interface ConsumeAcceptedDirectLandingSendInput {
  readonly actor: DraftAuthorityActor;
  readonly actionId: string;
  readonly predecessor: DraftAuthorityVersion;
  readonly acceptance: {
    readonly hostId: string;
    readonly epicId: string;
    readonly chatId: string;
    readonly messageId: string;
  };
}

export async function consumeAcceptedDirectLandingSend(
  input: ConsumeAcceptedDirectLandingSendInput,
): Promise<DraftAuthorityMutationResult<DraftAuthorityEditReceipt, DraftAuthorityRecord>> {
  const { actor, actionId, predecessor, acceptance } = input;
  const { hostId, epicId, chatId, messageId } = acceptance;
  if (predecessor.slot.kind !== "landing" ||
    [actionId, hostId, epicId, chatId, messageId].some((id) => id.length === 0)) {
    return { kind: "invalid" };
  }
  const result = await commitDraftAuthority(
    {
      operation: { id: actionId, actor },
      expected: {
        kind: "current",
        draft: {
          slot: { kind: "landing", id: predecessor.slot.id },
          occurrence: predecessor.occurrence,
          version: predecessor.version,
        },
      },
      mutation: { kind: "delete", retirements: [] },
    },
    { kind: "landing-send", acceptance },
  );
  return draftAuthorityActorIsCurrent(actor) ? result : { kind: "denied" };
}

export interface DraftAuthorityRestoredStartTaskMirrorBinding {
  readonly draftId: string;
  readonly hostId: string;
  readonly isCurrent: () => boolean;
}

export interface ConsumeAcceptedRestoredStartInput {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityRestoredActionClaim;
  readonly taskMirrorBinding?: DraftAuthorityRestoredStartTaskMirrorBinding;
  readonly isCurrent: () => boolean;
}

export async function consumeAcceptedRestoredStart(
  start: ConsumeAcceptedRestoredStartInput,
): Promise<DraftAuthorityMutationResult<DraftAuthorityEditReceipt, DraftAuthorityRecord>> {
  const { actor, claim, taskMirrorBinding } = start;
  const slot = claim.draft.slot;
  if (claim.method !== "epic.createTuiAgent" || (slot.kind !== "landing" && slot.kind !== "task") ||
    (taskMirrorBinding !== undefined &&
      (slot.kind !== "task" || taskMirrorBinding.draftId.length === 0 || taskMirrorBinding.hostId.length === 0))) {
    return { kind: "invalid" };
  }
  if (claim.accountId !== actor.accountId || claim.sessionGeneration !== actor.sessionGeneration ||
    !draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const result = await commitDraftAuthority(
    {
      operation: { id: claim.actionId, actor },
      expected: { kind: "current", draft: claim.draft },
      mutation: { kind: "delete", retirements: [] },
    },
    { kind: "restored-start", start },
  );
  return draftAuthorityActorIsCurrent(actor) ? result : { kind: "denied" };
}

export function writeDraftAuthority(
  input: WriteDraftAuthorityInput,
): Promise<DraftAuthorityMutationResult<DraftAuthorityEditReceipt, DraftAuthorityRecord>> {
  return commitDraftAuthority(input, undefined);
}

function persistedMirrorId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function acceptedLandingMirrorRetirement(
  draft: LiveDraftAuthorityRecord,
  accountId: string,
): DraftAuthorityHostRetirement | null {
  const { adoption, id, origin } = draft.payload;
  if (id !== draft.draft.slot.id || !isRecord(adoption) || adoption.state !== "adopted" ||
    typeof adoption.hostId !== "string" || adoption.hostId.length === 0) {
    return null;
  }
  const placement = landingPlacementHostId();
  if (origin === "replica" || (placement !== null && adoption.hostId !== placement)) {
    return placement === null ? null : { accountId, hostId: placement, draftId: id, kind: "retract" };
  }
  return { accountId, hostId: adoption.hostId, draftId: id, kind: "delete" };
}

type AcceptedDraftConsumption =
  | { readonly kind: "landing-send"; readonly acceptance: ConsumeAcceptedDirectLandingSendInput["acceptance"] }
  | { readonly kind: "restored-start"; readonly start: ConsumeAcceptedRestoredStartInput };

class RestoredStartCleanupBecameStale extends Error {}

async function commitDraftAuthority(
  input: WriteDraftAuthorityInput,
  consumption: AcceptedDraftConsumption | undefined,
): Promise<DraftAuthorityMutationResult<DraftAuthorityEditReceipt, DraftAuthorityRecord>> {
  const { operation, mutation, expected } = input;
  const landingSend = consumption?.kind === "landing-send" ? consumption.acceptance : undefined;
  const start = consumption?.kind === "restored-start" ? consumption.start : undefined;
  const slot = expected.kind === "absent" ? expected.slot : expected.draft.slot;
  const accountId = operation.actor?.accountId ?? null;
  if (input.installSource !== undefined &&
    (mutation.kind !== "replace" || expected.kind !== "absent" ||
      expected.slot.kind !== "landing" || accountId === null)) {
    return { kind: "invalid" };
  }
  const acceptedLandingSend = landingSend === undefined ? undefined : {
    purpose: "accepted-direct-landing-send",
    sessionGeneration: operation.actor?.sessionGeneration,
    target: [landingSend.hostId, landingSend.epicId, landingSend.chatId, landingSend.messageId],
  };
  const acceptedRestoredStart = start === undefined ? undefined : {
    purpose: "accepted-restored-start",
    sessionGeneration: operation.actor?.sessionGeneration,
    issue: [
      start.claim.method, start.claim.operationId, start.claim.issueGeneration, start.claim.executorId,
      start.claim.primary.operationId, start.claim.primary.issueGeneration, start.claim.primary.executorId,
      start.claim.hostId, start.claim.sandboxId,
    ],
    taskMirrorBinding: start.taskMirrorBinding === undefined
      ? undefined : [start.taskMirrorBinding.draftId, start.taskMirrorBinding.hostId],
  };
  let intent: string;
  try {
    intent = await draftAuthorityIntentDigest(input.installSource === undefined
      ? {
          accountId,
          expected,
          mutation,
          canvas: input.canvas,
          pendingCustody: input.pendingCustody,
          acceptedLandingSend,
          acceptedRestoredStart,
        }
      : { accountId, expected, source: input.installSource });
  } catch {
    return { kind: "unavailable" };
  }

  const stores = ["drafts", "sidecars", "receipts", "retirements", "pending", "recovery",
    ...(start === undefined ? [] : ["claims"] as const)] as const;
  let committedHostItems: readonly DraftAuthorityHostRetirement[] = [];
  const result = await runDraftAuthorityTransaction(
    stores,
    "readwrite",
    async ({ drafts, sidecars, receipts, retirements, pending, recovery, claims }): Promise<
      DraftAuthorityMutationResult<DraftAuthorityEditReceipt, DraftAuthorityRecord>
    > => {
      const currentActor = (): boolean =>
        operation.actor === null || draftAuthorityActorIsCurrent(operation.actor);
      if (!currentActor()) return { kind: "denied" };

      const receiptKey = ["draft-write", operation.id];
      const saved = await receipts.read(receiptKey);
      if (!currentActor()) return { kind: "denied" };
      if (saved !== undefined) {
        const previous = editReceiptSchema.parse(saved);
        return previous.intent === intent
          ? { kind: "replayed", receipt: previous.receipt }
          : { kind: "conflict", current: null };
      }

      const current = await readDraftAuthorityRecord(drafts, slot);
      if (!currentActor()) return { kind: "denied" };
      if (landingSend !== undefined && current?.kind === "live" &&
        ((current.returnAccountId !== null && current.returnAccountId !== accountId) ||
          (current.recoveryAccountId !== null && current.recoveryAccountId !== accountId))) {
        return { kind: "denied" };
      }
      if (!draftAuthorityExpectationMatches(current, expected)) {
        return { kind: "conflict", current };
      }
      if (start !== undefined) {
        if (current?.kind !== "live" || current.returnAccountId !== accountId ||
          !start.isCurrent() || !(await isFinalAcceptedRestoredStart({ drafts, claims }, start.claim))) {
          return { kind: "conflict", current };
        }
        if (!currentActor()) return { kind: "denied" };
      }
      if (input.pendingCustody !== undefined) {
        if (accountId === null || mutation.kind !== "delete" || expected.kind !== "current") {
          return { kind: "invalid" };
        }
        const custody = z.object({
          accountId: z.string(),
          actionId: z.string(),
          sendId: z.string(),
          source: versionSchema.nullable(),
        }).safeParse(await pending.read([accountId, input.pendingCustody.sendId]));
        if (!currentActor() || !custody.success ||
          custody.data.accountId !== accountId ||
          custody.data.actionId !== operation.id ||
          custody.data.sendId !== input.pendingCustody.sendId ||
          custody.data.source === null ||
          !draftAuthorityExpectationMatches(current, {
            kind: "current",
            draft: custody.data.source,
          })) {
          return { kind: "denied" };
        }
      }
      const next = nextDraftAuthorityRecord(slot, current, mutation);
      if (next === null) return { kind: "invalid" };
      const landingMirror = landingSend !== undefined && accountId !== null && current?.kind === "live"
        ? acceptedLandingMirrorRetirement(current, accountId)
        : null;
      let hostItems = landingMirror !== null ? [landingMirror]
        : mutation.kind === "delete" ? mutation.retirements : [];
      if (hostItems.some((item) => item.accountId !== accountId)) {
        return { kind: "denied" };
      }

      const taskPayload = start !== undefined && slot.kind === "task" && current?.kind === "live"
        ? current.payload
        : undefined;
      const taskDraftId = persistedMirrorId(taskPayload?.draftId);
      const taskOwner = persistedMirrorId(taskPayload?.ownerHostId);
      const taskFallback = taskPayload !== undefined && taskOwner === null ? start?.taskMirrorBinding : undefined;
      const startStillCurrent = (): boolean => start === undefined ||
        (start.isCurrent() && (taskFallback === undefined ||
          (taskFallback.draftId === taskDraftId && taskFallback.isCurrent())));
      if (!startStillCurrent()) return { kind: "conflict", current };

      let canvasKey: IDBValidKey | undefined;
      let canvasRoots: readonly string[] = [];
      if (input.canvas !== undefined) {
        if (mutation.kind !== "delete" || current?.kind !== "live" || slot.kind !== "chat") {
          return { kind: "invalid" };
        }
        const sidecar = await readDraftAuthorityCanvasSidecar(sidecars, current.draft, input.canvas.scope);
        if (!currentActor() || (sidecar?.accountId != null && sidecar.accountId !== accountId)) {
          return { kind: "denied" };
        }
        if ((sidecar?.version ?? null) !== input.canvas.expectedVersion) {
          return { kind: "conflict", current };
        }
        if (sidecar !== null) {
          canvasKey = draftAuthorityCanvasKey(current.draft, input.canvas.scope);
          canvasRoots = sidecar.rootDigests;
        }
      }

      const recoveryOwner = current?.kind === "live" ? current.recoveryAccountId : null;
      if (recoveryOwner !== null && accountId !== recoveryOwner) return { kind: "denied" };
      const changes = [];
      if (current?.kind === "live" && recoveryOwner !== null) {
        changes.push({
          before: current.manifest.digests,
          after: next.kind === "live" && next.recoveryAccountId !== null
            ? next.manifest.digests
            : [],
        });
      }
      if (canvasRoots.length > 0) changes.push({ before: canvasRoots, after: [] });
      if (changes.length > 0) {
        if (accountId === null) return { kind: "denied" };
        await applyRecoveryRoots(recovery, {
          accountId,
          byteLimit: LANDING_IMAGE_BUDGET_BYTES,
          changes,
          verified: input.verifiedRecoveryBlobs ?? [],
        });
        if (!currentActor()) {
          throw new Error("Draft authority session changed while editing recovery");
        }
      }

      if (start !== undefined && current?.kind === "live" && accountId !== null) {
        if (!currentActor() || !startStillCurrent()) throw new RestoredStartCleanupBecameStale();
        const taskHost = taskOwner ?? taskFallback?.hostId ?? null;
        const mirror = slot.kind === "landing"
          ? acceptedLandingMirrorRetirement(current, accountId)
          : taskDraftId === null || taskHost === null
            ? null
            : { accountId, hostId: taskHost, draftId: taskDraftId, kind: "delete" as const };
        if (mirror !== null) hostItems = [mirror];
      }

      const receipt: DraftAuthorityEditReceipt = {
        operationId: operation.id,
        accountId,
        draft: next.draft,
        kind: next.kind,
      };
      await Promise.all([
        drafts.write(draftAuthorityKey(slot), next),
        receipts.write(receiptKey, { intent, receipt }),
        ...(canvasKey === undefined ? [] : [sidecars.remove(canvasKey)]),
        ...hostItems.flatMap((item) => [
          retirements.write(
            ["host", item.accountId, item.hostId, item.draftId, item.kind],
            { ...item, operationId: operation.id, state: "pending" },
          ),
          retirements.write(
            ["draft-id", item.accountId, item.draftId],
            operation.id,
          ),
        ]),
      ]);
      if (start !== undefined && (!currentActor() || !startStillCurrent())) {
        throw new RestoredStartCleanupBecameStale();
      }
      committedHostItems = hostItems;
      return { kind: "committed", receipt };
    },
  );
  if (result.kind === "unavailable" && result.cause instanceof RestoredStartCleanupBecameStale) {
    return { kind: "conflict", current: null };
  }
  if (result.kind !== "complete") return result;
  if (result.value.kind === "committed") {
    notifyDraftAuthorityChange(result.value.receipt.draft);
    for (const item of committedHostItems) {
      notifyDraftAuthorityRetirement(item.accountId, item.hostId);
    }
  }
  return result.value;
}

export async function importDraftAuthoritySlot(
  source: DraftAuthorityRecord,
): Promise<DraftAuthorityReadResult> {
  const result = await runDraftAuthorityTransaction(
    ["drafts"],
    "readwrite",
    async ({ drafts }) => {
      const slot = source.draft.slot;
      const current = await readDraftAuthorityRecord(drafts, slot);
      if (current !== null) return current;
      await drafts.write(draftAuthorityKey(slot), source);
      return source;
    },
  );
  return result.kind === "complete"
    ? { kind: "current", record: result.value }
    : { kind: "unavailable" };
}

export async function admitDraftAuthorityLandingHistory(input: {
  readonly actor: DraftAuthorityActor | null;
  readonly draftId: string;
  readonly payload: DraftAuthorityPayload;
  readonly manifest: DraftAuthorityManifest;
  readonly isCurrent: () => boolean;
}): Promise<DraftAuthorityLandingFlush> {
  const { actor, draftId, payload, manifest, isCurrent } = input;
  if (draftId.length === 0 || payload.id !== draftId) return { kind: "conflict" };
  const stillCurrent = (): boolean => draftAuthorityOptionalActorIsCurrent(actor) && isCurrent();
  const slot: DraftAuthoritySlot = { kind: "landing", id: draftId };
  const outcome = await runDraftAuthorityTransaction(
    ["drafts", "retirements"],
    "readwrite",
    async ({ drafts, retirements }): Promise<DraftAuthorityLandingFlush> => {
      if (!stillCurrent()) return { kind: "conflict" };
      const current = await readDraftAuthorityRecord(drafts, slot);
      if (current !== null) return { kind: "conflict" };
      if (actor !== null && await retirements.read(["draft-id", actor.accountId, draftId]) !== undefined) {
        return { kind: "conflict" };
      }
      if (!stillCurrent()) return { kind: "conflict" };
      const draft = { slot, occurrence: draftId, version: mintDraftId() };
      const record: LiveDraftAuthorityRecord = {
        kind: "live", draft, payload, manifest, returnAccountId: null, recoveryAccountId: null,
      };
      await drafts.write(draftAuthorityKey(slot), record);
      if (!stillCurrent()) throw new Error("Landing History gesture changed before admission");
      return { kind: "committed", draft, manifest };
    },
  );
  if (outcome.kind !== "complete") return { kind: "unavailable" };
  const confirmedCurrent = stillCurrent();
  if (outcome.value.kind === "committed") notifyDraftAuthorityChange(outcome.value.draft);
  return confirmedCurrent ? outcome.value : { kind: "conflict" };
}

export type DraftAuthorityRecoveryRead =
  | {
      readonly kind: "live";
      readonly draft: DraftAuthorityVersion;
      readonly payload: DraftAuthorityPayload;
      readonly manifest: DraftAuthorityManifest;
      readonly bytes: ReadonlyMap<string, Blob>;
    }
  | { readonly kind: "missing" | "stale" | "denied" | "missing-bytes" | "unavailable" };

export async function readDraftAuthorityRecovery(input: {
  readonly actor: DraftAuthorityActor;
  readonly reference: DraftAuthorityReference;
}): Promise<DraftAuthorityRecoveryRead> {
  const { actor, reference } = input;
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  const outcome = await runDraftAuthorityTransaction(
    ["drafts", "recovery"],
    "readonly",
    async ({ drafts, recovery }): Promise<DraftAuthorityRecoveryRead> => {
      const current = await readDraftAuthorityRecord(drafts, reference.slot);
      if (current === null) return { kind: "missing" };
      if (current.kind !== "live" || current.draft.occurrence !== reference.occurrence) {
        return { kind: "stale" };
      }
      if (current.recoveryAccountId !== actor.accountId ||
        !draftAuthorityActorIsCurrent(actor)) {
        return { kind: "denied" };
      }
      const bytes = await readRecoveryBlobs(recovery, {
        accountId: actor.accountId,
        byteLimit: LANDING_IMAGE_BUDGET_BYTES,
        digests: current.manifest.digests,
      });
      return {
        kind: "live",
        draft: current.draft,
        payload: current.payload,
        manifest: current.manifest,
        bytes,
      };
    },
  );
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  if (outcome.kind === "complete") return outcome.value;
  return outcome.cause instanceof RecoveryBlobError && outcome.cause.kind === "missing"
    ? { kind: "missing-bytes" }
    : { kind: "unavailable" };
}

type LiveDraftAuthorityRecord = Extract<DraftAuthorityRecord, { readonly kind: "live" }>;

async function listDraftAuthorityRecovery<Value>(
  actor: DraftAuthorityActor,
  project: (record: LiveDraftAuthorityRecord) => Value,
): Promise<readonly Value[] | null> {
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  const result = await runDraftAuthorityTransaction(
    ["drafts"],
    "readonly",
    async ({ drafts }) => {
      const records = await drafts.readAll(IDBKeyRange.bound(["landing"], ["landing", []]));
      return records.flatMap((value) => {
        const parsed = recordSchema.safeParse(value);
        return parsed.success && parsed.data.kind === "live" &&
          parsed.data.draft.slot.kind === "landing" &&
          parsed.data.recoveryAccountId === actor.accountId
          ? [project(parsed.data)]
          : [];
      });
    },
  );
  return result.kind === "complete" && draftAuthorityActorIsCurrent(actor)
    ? result.value
    : null;
}

export function listDraftAuthorityRecoveryReferences(
  actor: DraftAuthorityActor,
): Promise<readonly DraftAuthorityVersion[] | null> {
  return listDraftAuthorityRecovery(actor, ({ draft }) => draft);
}

export interface DraftAuthorityRecoveryPreview {
  readonly draft: DraftAuthorityVersion;
  readonly preview: string;
  readonly lastEditedAt: number | null;
  readonly hasAnnotations: boolean;
}

export function listDraftAuthorityRecoveryPreviews(
  actor: DraftAuthorityActor,
): Promise<readonly DraftAuthorityRecoveryPreview[] | null> {
  return listDraftAuthorityRecovery(actor, ({ draft, payload }) => {
    const { content, lastTouchedAt, browserAnnotations } = payload;
    const preview = isJsonContent(content, 0)
      ? extractPlainTextFromComposerJSONContent(content).replace(/\s+/g, " ").trim().slice(0, 400)
      : "";
    return {
      draft,
      preview,
      lastEditedAt: typeof lastTouchedAt === "number" && Number.isFinite(lastTouchedAt)
        ? lastTouchedAt
        : null,
      hasAnnotations: parseBrowserAnnotationRecords(browserAnnotations).length > 0,
    };
  });
}

export async function acknowledgeDraftAuthorityEditorWrite(
  receipt: DraftAuthorityEditReceipt,
): Promise<void> {
  if (receipt.accountId !== null || receipt.kind !== "live") return;
  await runDraftAuthorityTransaction(
    ["receipts"],
    "readwrite",
    async ({ receipts }) => {
      const key = ["draft-write", receipt.operationId];
      const current = editReceiptSchema.safeParse(await receipts.read(key));
      if (current.success &&
        current.data.receipt.accountId === null &&
        current.data.receipt.draft.version === receipt.draft.version) {
        await receipts.remove(key);
      }
    },
  );
}
