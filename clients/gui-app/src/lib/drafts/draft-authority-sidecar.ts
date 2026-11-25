import { z } from "zod";
import {
  collectAnnotationImageHashes,
  parseBrowserAnnotationRecords,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import { LANDING_IMAGE_BUDGET_BYTES } from "@/lib/composer/landing-image-budget";
import { appLogger, describeLogError } from "@/lib/logger";
import { applyRecoveryRoots, readRecoveryBlobs } from "./recovery-blob-store";
import { readDraftAuthorityRecord } from "./draft-authority";
import { runDraftAuthorityTransaction } from "./draft-authority-db";
import { draftAuthorityOptionalActorIsCurrent } from "./draft-authority-session";
import { mintDraftId } from "./draft-ids";
import type {
  DraftAuthorityActor,
  DraftAuthorityBorrowedStore,
  DraftAuthorityReference,
  DraftAuthorityVersion,
} from "./draft-authority-types";

export const draftAuthorityCanvasScopeSchema = z.object({
  kind: z.enum(["desktop-window", "phone-app"]),
  id: z.string().min(1),
});
export type DraftAuthorityCanvasScope = z.infer<typeof draftAuthorityCanvasScopeSchema>;

export interface DraftAuthorityCanvasSidecar {
  readonly version: string;
  readonly accountId: string | null;
  readonly rootDigests: readonly string[];
  readonly annotations: readonly BrowserAnnotationRecord[];
}

export interface DraftAuthorityCanvasAcknowledgement {
  readonly reference: DraftAuthorityVersion;
  readonly scope: DraftAuthorityCanvasScope;
  readonly sidecarVersion: string;
}

interface CanvasAcknowledgementScope {
  readonly actor: DraftAuthorityActor;
  readonly reference: DraftAuthorityReference;
  readonly scope: DraftAuthorityCanvasScope;
}

type CanvasAcknowledgementListener = (receipt: DraftAuthorityCanvasAcknowledgement) => void;
const canvasAcknowledgements = new Map<string, Set<CanvasAcknowledgementListener>>();

function canvasAcknowledgementKey({ actor, reference, scope }: CanvasAcknowledgementScope): string {
  return JSON.stringify([
    actor.accountId,
    actor.sessionGeneration,
    reference.slot.kind,
    reference.slot.id,
    reference.occurrence,
    scope.kind,
    scope.id,
  ]);
}

export function subscribeToCanonicalChatCanvasAcknowledgements(
  input: CanvasAcknowledgementScope,
  listener: CanvasAcknowledgementListener,
): () => void {
  const key = canvasAcknowledgementKey(input);
  const listeners = canvasAcknowledgements.get(key) ?? new Set<CanvasAcknowledgementListener>();
  listeners.add(listener);
  canvasAcknowledgements.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) canvasAcknowledgements.delete(key);
  };
}

const storedSidecarSchema = z.object({
  version: z.string().min(1),
  accountId: z.string().nullable(),
  rootDigests: z.array(z.string()),
  annotations: z.array(z.unknown()),
});

export function draftAuthorityCanvasKey(
  reference: DraftAuthorityReference,
  scope: DraftAuthorityCanvasScope,
): IDBValidKey {
  return [scope.kind, scope.id, reference.slot.id, reference.occurrence];
}

export async function readDraftAuthorityCanvasSidecar(
  store: DraftAuthorityBorrowedStore<IDBValidKey>,
  reference: DraftAuthorityReference,
  scope: DraftAuthorityCanvasScope,
): Promise<DraftAuthorityCanvasSidecar | null> {
  const found = await store.read(draftAuthorityCanvasKey(reference, scope));
  if (found === undefined) return null;
  const stored = storedSidecarSchema.parse(found);
  const annotations = parseBrowserAnnotationRecords(stored.annotations);
  if (annotations.length !== stored.annotations.length ||
    annotations.some((annotation) => annotation.source.kind !== "canvas")) {
    throw new Error("Invalid committed canvas sidecar");
  }
  return {
    version: stored.version,
    accountId: stored.accountId,
    rootDigests: stored.rootDigests,
    annotations,
  };
}

export async function writeDraftAuthorityCanvasSidecar(
  store: DraftAuthorityBorrowedStore<IDBValidKey>,
  reference: DraftAuthorityReference,
  scope: DraftAuthorityCanvasScope,
  annotations: readonly BrowserAnnotationRecord[],
  accountId: string | null,
  rootDigests: readonly string[],
): Promise<DraftAuthorityCanvasSidecar> {
  if (annotations.some((annotation) => annotation.source.kind !== "canvas")) {
    throw new Error("The chat canvas sidecar accepts canvas annotations only");
  }
  const next = { version: mintDraftId(), accountId, annotations, rootDigests };
  await store.write(draftAuthorityCanvasKey(reference, scope), next);
  return next;
}

type CanvasSidecarResult =
  | { readonly kind: "current"; readonly sidecar: DraftAuthorityCanvasSidecar | null }
  | { readonly kind: "conflict" | "denied" | "unavailable" };

export async function readCanonicalChatCanvasSidecar(
  reference: DraftAuthorityReference,
  scope: DraftAuthorityCanvasScope,
  actor: DraftAuthorityActor | null,
): Promise<CanvasSidecarResult> {
  if (!draftAuthorityOptionalActorIsCurrent(actor)) return { kind: "denied" };
  const outcome = await runDraftAuthorityTransaction(
    ["drafts", "sidecars"],
    "readonly",
    async ({ drafts, sidecars }): Promise<CanvasSidecarResult> => {
      const current = await readDraftAuthorityRecord(drafts, reference.slot);
      if (reference.slot.kind !== "chat" || current?.kind !== "live" ||
        current.draft.occurrence !== reference.occurrence ||
        ("version" in reference && reference.version !== current.draft.version)) {
        return { kind: "conflict" };
      }
      const sidecar = await readDraftAuthorityCanvasSidecar(sidecars, reference, scope);
      if (!draftAuthorityOptionalActorIsCurrent(actor) ||
        (sidecar?.accountId != null && sidecar.accountId !== actor?.accountId)) {
        return { kind: "denied" };
      }
      return { kind: "current", sidecar };
    },
  );
  if (!draftAuthorityOptionalActorIsCurrent(actor)) return { kind: "denied" };
  return outcome.kind === "complete" ? outcome.value : { kind: "unavailable" };
}

export async function commitCanonicalChatCanvasSidecar(input: {
  readonly actor: DraftAuthorityActor | null;
  readonly reference: DraftAuthorityVersion;
  readonly scope: DraftAuthorityCanvasScope;
  readonly expectedVersion: string | null;
  readonly annotations: readonly BrowserAnnotationRecord[];
}): Promise<CanvasSidecarResult> {
  const { actor, reference, scope, expectedVersion, annotations } = input;
  const outcome = await runDraftAuthorityTransaction(
    ["drafts", "sidecars", "recovery"],
    "readwrite",
    async ({ drafts, sidecars, recovery }): Promise<CanvasSidecarResult> => {
      const current = await readDraftAuthorityRecord(drafts, reference.slot);
      if (reference.slot.kind !== "chat" || current?.kind !== "live" ||
        current.draft.occurrence !== reference.occurrence ||
        current.draft.version !== reference.version) {
        return { kind: "conflict" };
      }
      const previous = await readDraftAuthorityCanvasSidecar(sidecars, reference, scope);
      if (!draftAuthorityOptionalActorIsCurrent(actor) ||
        (previous?.accountId != null && previous.accountId !== actor?.accountId)) {
        return { kind: "denied" };
      }
      if ((previous?.version ?? null) !== expectedVersion) return { kind: "conflict" };
      const rooted = previous?.rootDigests ?? [];
      const needed = new Set([
        ...current.manifest.digests,
        ...collectAnnotationImageHashes(annotations),
      ]);
      const retained = rooted.filter((digest) => needed.has(digest));
      if (previous?.accountId != null && retained.length !== rooted.length) {
        await applyRecoveryRoots(recovery, {
          accountId: previous.accountId,
          byteLimit: LANDING_IMAGE_BUDGET_BYTES,
          changes: [{ before: rooted, after: retained }],
          verified: [],
        });
        if (!draftAuthorityOptionalActorIsCurrent(actor)) {
          throw new Error("Draft authority session changed during canvas write");
        }
      }
      return {
        kind: "current",
        sidecar: await writeDraftAuthorityCanvasSidecar(
          sidecars, reference, scope, annotations, previous?.accountId ?? null, retained,
        ),
      };
    },
  );
  if (!draftAuthorityOptionalActorIsCurrent(actor)) return { kind: "denied" };
  if (outcome.kind !== "complete") return { kind: "unavailable" };
  const result = outcome.value;
  if (actor !== null && result.kind === "current" && result.sidecar !== null) {
    const receipt = { reference, scope, sidecarVersion: result.sidecar.version };
    const key = canvasAcknowledgementKey({ actor, reference, scope });
    for (const listener of canvasAcknowledgements.get(key) ?? []) {
      if (!draftAuthorityOptionalActorIsCurrent(actor)) break;
      try {
        listener(receipt);
      } catch (error: unknown) {
        appLogger.warn("[draft-authority] canvas acknowledgement listener failed", {
          error: describeLogError(error),
        });
      }
    }
  }
  return draftAuthorityOptionalActorIsCurrent(actor) ? result : { kind: "denied" };
}

export async function readCanonicalChatCanvasAssets(input: {
  readonly actor: DraftAuthorityActor;
  readonly draft: DraftAuthorityVersion;
  readonly scope: DraftAuthorityCanvasScope;
}): Promise<
  | {
      readonly kind: "current";
      readonly sidecar: DraftAuthorityCanvasSidecar;
      readonly bytes: ReadonlyMap<string, Blob>;
    }
  | { readonly kind: "conflict" | "denied" | "unavailable" }
> {
  const { actor, draft, scope } = input;
  if (!draftAuthorityOptionalActorIsCurrent(actor)) return { kind: "denied" };
  const outcome = await runDraftAuthorityTransaction(
    ["drafts", "sidecars", "recovery"],
    "readonly",
    async ({ drafts, sidecars, recovery }) => {
      const current = await readDraftAuthorityRecord(drafts, draft.slot);
      if (current?.kind !== "live" || current.draft.occurrence !== draft.occurrence ||
        current.draft.version !== draft.version || draft.slot.kind !== "chat") {
        return { kind: "conflict" as const };
      }
      const sidecar = await readDraftAuthorityCanvasSidecar(sidecars, draft, scope);
      if (sidecar === null) return { kind: "conflict" as const };
      if (sidecar.accountId !== actor.accountId ||
        !draftAuthorityOptionalActorIsCurrent(actor)) {
        return { kind: "denied" as const };
      }
      const bytes = await readRecoveryBlobs(recovery, {
        accountId: actor.accountId,
        byteLimit: LANDING_IMAGE_BUDGET_BYTES,
        digests: sidecar.rootDigests,
      });
      return { kind: "current" as const, sidecar, bytes };
    },
  );
  if (!draftAuthorityOptionalActorIsCurrent(actor)) return { kind: "denied" };
  return outcome.kind === "complete" ? outcome.value : { kind: "unavailable" };
}
