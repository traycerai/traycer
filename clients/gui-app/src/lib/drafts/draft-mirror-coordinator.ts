import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { appLogger, describeLogError } from "@/lib/logger";
import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import {
  forgetBlobUnsupportedHost,
  putDraftBlobs,
  putDraftBlobsForWrite,
  readDraftBlobsIntoLocalStore,
  resetDraftBlobTransportForTests,
} from "./draft-blob-transport";
import {
  blobHashesFromContent,
  blobHashesOfDocument,
} from "./draft-write-codec";

import { interviewDraftBindingKey } from "./draft-ids";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";
import {
  adoptLandingDraft,
  applyLandingHostDelete,
  applyLandingHostDocument,
  collectLandingDirtyWrites,
  collectUnadoptedLandingDrafts,
  dropLandingAbsentFromList,
  landingDraftIsDirty,
  landingDraftRememberSynced,
  rememberLandingBlobsOnHost,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  applyComposerHostDelete,
  applyComposerHostDocument,
  collectComposerDirtyWrites,
  composerDraftIsDirty,
  composerDraftRememberSynced,
  dropComposerAbsentFromList,
  findComposerChatIdByDraftId,
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  applyInterviewHostDelete,
  applyInterviewHostDocument,
  collectInterviewDirtyWrites,
  dropInterviewAbsentFromList,
  findInterviewByDraftId,
  interviewDraftIsDirty,
  interviewDraftRememberSynced,
} from "@/stores/composer/interview-draft-store";
import {
  applyNewChatHostDelete,
  applyNewChatHostDocument,
  collectNewChatDirtyWrites,
  dropNewChatAbsentFromList,
  useNewConversationModalStore,
  findNewChatByDraftId,
  newChatDraftIsDirty,
  newChatDraftRememberSynced,
} from "@/stores/epics/new-conversation-modal-store";
import {
  composerDraftWrite,
  interviewDraftWrite,
  landingTarget,
  newChatTarget,
  requiredChatTarget,
  stashDraftWrite,
} from "./draft-write-codec";
import type {
  PromptStashEntry,
  PromptStashImageBlob,
} from "@/lib/composer/prompt-stash-codec";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import {
  setDraftLocalDeleteListener,
  setDraftLocalEditListener,
  setDraftLocalFlushListener,
} from "./draft-local-edits";
import {
  DraftMirrorSession,
  type DraftDirtyWrite,
  type DraftMirrorSink,
} from "./draft-mirror-session";
import type { DraftMirrorTiming } from "./draft-mirror-timing";

type SessionEntry = {
  readonly session: DraftMirrorSession;
  refCount: number;
};

const sessions = new Map<string, SessionEntry>();
const sessionClients = new Map<string, HostRequester<HostRpcRegistry>>();
const cloudScopeIdByHost = new Map<string, string | null>();
const cloudScopeListeners = new Set<() => void>();

function notifyCloudScopeListeners(): void {
  for (const listener of cloudScopeListeners) listener();
}

function setCloudScopeId(hostId: string, scopeId: string | null): void {
  const previous = cloudScopeIdByHost.get(hostId) ?? null;
  if (previous === scopeId) return;
  cloudScopeIdByHost.set(hostId, scopeId);
  notifyCloudScopeListeners();
}

export function subscribeDraftsCloudScope(listener: () => void): () => void {
  cloudScopeListeners.add(listener);
  return () => {
    cloudScopeListeners.delete(listener);
  };
}

const composerHostByChatId = new Map<string, string>();
const interviewHostByKey = new Map<string, string>();
const newChatHostByEpicId = new Map<string, string>();

/** Placement host that may lazily adopt landing drafts (decision #9). */
let landingAdoptionHostId: string | null = null;

/** Host that last published or ingested each stash id. */
const stashHostById = new Map<string, string>();
/** Ids applied from a host list/subscribe, keyed `hostId:entryId`. */
const stashSeenOnHost = new Set<string>();

function stashSeenKey(hostId: string, entryId: string): string {
  return `${hostId}:${entryId}`;
}

export function bindLandingAdoptionHost(hostId: string | null): void {
  landingAdoptionHostId = hostId;
}

/**
 * Upsert-once a local stash capture onto `hostId`. No-op when no
 * session is mounted (offline / old host) — IndexedDB remains the
 * local tier.
 */
export function publishStashEntry(
  hostId: string,
  entry: PromptStashEntry,
): Promise<void> {
  stashHostById.set(entry.id, hostId);
  const session = sessions.get(hostId)?.session;
  if (session === undefined) return Promise.resolve();
  return session.publishImmutable(
    stashDraftWrite({
      draftId: entry.id,
      content: entry.content,
      blobHashes: entry.blobHashes,
      createdAt: entry.createdAt,
    }),
  );
}

/**
 * Owner-authorized delete after restore-consume. Idempotent: a second
 * device's consume that lost the race still restored locally; the
 * host answers `deleted: false`.
 */
export async function deleteStashEntryOnHost(
  hostId: string | null,
  entryId: string,
): Promise<void> {
  const bound = hostId ?? stashHostById.get(entryId) ?? null;
  if (bound === null) return;
  const session = sessions.get(bound)?.session;
  if (session === undefined) return;
  const dropped = await session.deleteOnHost(entryId);
  if (dropped) stashHostById.delete(entryId);
}

export function draftsCloudScopeId(hostId: string): string | null {
  return (
    cloudScopeIdByHost.get(hostId) ??
    sessions.get(hostId)?.session.cloudScopeId() ??
    null
  );
}

export async function consumeStashOnHost(
  hostId: string | null,
  entryId: string,
): Promise<void> {
  const bound = hostId ?? stashHostById.get(entryId) ?? null;
  if (bound === null) {
    await deleteStashEntryOnHost(null, entryId);
    return;
  }
  const knownHost = stashHostById.get(entryId);
  if (knownHost === undefined || knownHost === bound) {
    await deleteStashEntryOnHost(bound, entryId);
    return;
  }
  const client = sessionClients.get(bound);
  if (client !== undefined) {
    try {
      const claimed = await client.request("drafts.claim", {
        draftId: entryId,
      });
      if (claimed.status === "ok" || claimed.status === "already-owned") {
        stashHostById.set(entryId, bound);
      }
    } catch {
      // Delete still runs: same-host consume and a lost claim race
      // are both idempotent (`deleted: false`).
    }
  }
  await deleteStashEntryOnHost(bound, entryId);
}

async function ingestStashDocument(
  document: DraftDocument,
  images: ReadonlyMap<string, PromptStashImageBlob>,
): Promise<void> {
  if (document.kind !== "stash-entry") return;
  stashHostById.set(document.draftId, document.ownerHostId);
  stashSeenOnHost.add(stashSeenKey(document.ownerHostId, document.draftId));
  try {
    await usePromptStashStore.getState().ingestRemote(
      {
        id: document.draftId,
        createdAt: document.portable.createdAt,
        content: document.portable.content,
        blobHashes: document.portable.blobHashes,
      },
      images,
    );
  } catch (error: unknown) {
    appLogger.warn("[draft-mirror] stash ingest failed", {
      error: describeLogError(error),
    });
  }
}

function dropStashEntry(draftId: string): void {
  const hostId = stashHostById.get(draftId);
  stashHostById.delete(draftId);
  if (hostId !== undefined) {
    stashSeenOnHost.delete(stashSeenKey(hostId, draftId));
  }
  void usePromptStashStore.getState().dropRemote(draftId);
}

function dropStashAbsentFromList(
  hostId: string,
  listedIds: ReadonlySet<string>,
): void {
  for (const [entryId, boundHost] of [...stashHostById.entries()]) {
    if (boundHost !== hostId) continue;
    if (!stashSeenOnHost.has(stashSeenKey(hostId, entryId))) continue;
    if (listedIds.has(entryId)) continue;
    dropStashEntry(entryId);
  }
}

export function bindComposerDraftHost(chatId: string, hostId: string): void {
  composerHostByChatId.set(chatId, hostId);
}

export function unbindComposerDraftHost(chatId: string, hostId: string): void {
  if (composerHostByChatId.get(chatId) === hostId) {
    composerHostByChatId.delete(chatId);
  }
}

export function bindInterviewDraftHost(
  chatId: string,
  blockId: string,
  hostId: string,
): void {
  interviewHostByKey.set(interviewDraftBindingKey(chatId, blockId), hostId);
}

export function unbindInterviewDraftHost(
  chatId: string,
  blockId: string,
  hostId: string,
): void {
  const key = interviewDraftBindingKey(chatId, blockId);
  if (interviewHostByKey.get(key) === hostId) interviewHostByKey.delete(key);
}

export function bindNewChatDraftHost(epicId: string, hostId: string): void {
  newChatHostByEpicId.set(epicId, hostId);
}

export function unbindNewChatDraftHost(epicId: string, hostId: string): void {
  if (newChatHostByEpicId.get(epicId) === hostId) {
    newChatHostByEpicId.delete(epicId);
  }
}

const sink: DraftMirrorSink = {
  isDirty(draftId) {
    return (
      landingDraftIsDirty(draftId) ||
      composerDraftIsDirty(draftId) ||
      interviewDraftIsDirty(draftId) ||
      newChatDraftIsDirty(draftId)
    );
  },
  applyUpsert(document) {
    return applyHostDocument(document);
  },
  applyDelete(draftId) {
    applyLandingHostDelete(draftId);
    applyComposerHostDelete(draftId);
    applyInterviewHostDelete(draftId);
    applyNewChatHostDelete(draftId);
    dropStashEntry(draftId);
  },
  collectDirtyWrites(hostId) {
    return Promise.resolve(collectAllDirtyWrites(hostId));
  },
  rememberSynced(draftId, hostRevision, collectedGeneration) {
    landingDraftRememberSynced(draftId, hostRevision, collectedGeneration);
    composerDraftRememberSynced(draftId, hostRevision, collectedGeneration);
    interviewDraftRememberSynced(draftId, hostRevision, collectedGeneration);
    newChatDraftRememberSynced(draftId, hostRevision, collectedGeneration);
  },
  async prepareWrite(hostId, write) {
    const client = sessionClients.get(hostId);
    if (client === undefined) return write;
    const confirmed = await putDraftBlobsForWrite(hostId, client, write);
    rememberLandingBlobsOnHost(write.draftId, confirmed);
    return write;
  },
  dropAbsentFromList(hostId, listedIds) {
    dropLandingAbsentFromList(hostId, listedIds);
    dropComposerAbsentFromList(hostId, listedIds, composerHostByChatId);
    dropInterviewAbsentFromList(hostId, listedIds, interviewHostByKey);
    dropNewChatAbsentFromList(hostId, listedIds, newChatHostByEpicId);
    dropStashAbsentFromList(hostId, listedIds);
  },
  adoptUnadoptedLandingDrafts(hostId, wanted) {
    return adoptUnadoptedLandingDraftsForHost(hostId, wanted);
  },
  applyCloudScope(hostId, scopeId) {
    setCloudScopeId(hostId, scopeId);
  },
};

async function applyHostDocument(document: DraftDocument): Promise<void> {
  const client = sessionClients.get(document.ownerHostId);
  const hashes = blobHashesOfDocument(document);
  if (client !== undefined && hashes.length > 0) {
    const images = await readDraftBlobsIntoLocalStore(
      document.ownerHostId,
      client,
      hashes,
    );
    rememberLandingBlobsOnHost(document.draftId, [...images.keys()]);
    if (document.kind === "stash-entry") {
      await ingestStashDocument(document, images);
      return;
    }
  }
  if (document.kind === "stash-entry") {
    await ingestStashDocument(document, new Map());
    return;
  }
  if (document.kind === "interview") {
    applyInterviewHostDocument(document);
    return;
  }
  if (document.kind === "landing") {
    applyLandingHostDocument(document, document.portable.content);
    return;
  }
  if (document.kind === "chat-composer") {
    applyComposerHostDocument(document);
    return;
  }
  applyNewChatHostDocument(document);
}

function collectAllDirtyWrites(hostId: string): readonly DraftDirtyWrite[] {
  const out: DraftDirtyWrite[] = [];
  for (const { draft } of collectLandingDirtyWrites(hostId)) {
    out.push({
      generation: draft.generation,
      write: composerDraftWrite({
        draftId: draft.id,
        kind: "landing",
        target: landingTarget(),
        revision: draft.hostRevision,
        lastTouchedAt: draft.lastTouchedAt,
        content: draft.content,
        selection: draft.selection,
        runSettings: draft.settings,
        composerMode: draft.composerMode,
        workspace: draft.workspace,
        closed: draft.closed,
      }),
    });
  }
  for (const { chatId, draft } of collectComposerDirtyWrites()) {
    if (composerHostByChatId.get(chatId) !== hostId) continue;
    if (draft.draftId === null) continue;
    if (draft.targetEpicId === null) {
      warnUnboundComposerTarget(chatId, draft.draftId);
      continue;
    }
    out.push({
      generation: draft.generation,
      write: composerDraftWrite({
        draftId: draft.draftId,
        kind: "chat-composer",
        target: requiredChatTarget({
          epicId: draft.targetEpicId,
          chatId,
          blockId: null,
        }),
        revision: draft.hostRevision,
        lastTouchedAt: draft.lastTouchedAt,
        content: draft.content,
        selection: draft.selection,
        runSettings: null,
        composerMode: "chat",
        workspace: null,
        closed: false,
      }),
    });
  }
  for (const { chatId, blockId, draft } of collectInterviewDirtyWrites()) {
    if (
      interviewHostByKey.get(interviewDraftBindingKey(chatId, blockId)) !==
      hostId
    ) {
      continue;
    }
    if (draft.targetEpicId === null) {
      warnUnboundInterviewTarget(chatId, blockId, draft.draftId);
      continue;
    }
    out.push({
      generation: draft.generation,
      write: interviewDraftWrite({
        draftId: draft.draftId,
        target: requiredChatTarget({
          epicId: draft.targetEpicId,
          chatId,
          blockId,
        }),
        revision: draft.hostRevision,
        lastTouchedAt: draft.lastTouchedAt,
        draft,
      }),
    });
  }
  for (const { epicId, patch } of collectNewChatDirtyWrites()) {
    if (newChatHostByEpicId.get(epicId) !== hostId) continue;
    if (patch.draftId === null) continue;
    out.push({
      generation: patch.generation,
      write: composerDraftWrite({
        draftId: patch.draftId,
        kind: "new-chat",
        target: newChatTarget(epicId),
        revision: patch.hostRevision,
        lastTouchedAt: patch.lastTouchedAt,
        content: patch.content ?? EMPTY_LANDING_DRAFT_CONTENT,
        selection: patch.selection,
        runSettings: patch.settings,
        composerMode: patch.composerMode,
        workspace: patch.workspace,
        closed: false,
      }),
    });
  }
  return out;
}

const warnedUnboundComposer = new Set<string>();
const warnedUnboundInterview = new Set<string>();

function warnUnboundComposerTarget(chatId: string, draftId: string): void {
  if (!import.meta.env.DEV) return;
  if (warnedUnboundComposer.has(chatId)) return;
  warnedUnboundComposer.add(chatId);
  appLogger.warn(
    "[draft-mirror] withholding chat-composer upsert until targetEpicId is bound",
    { chatId, draftId },
  );
}

function warnUnboundInterviewTarget(
  chatId: string,
  blockId: string,
  draftId: string,
): void {
  if (!import.meta.env.DEV) return;
  const key = interviewDraftBindingKey(chatId, blockId);
  if (warnedUnboundInterview.has(key)) return;
  warnedUnboundInterview.add(key);
  appLogger.warn(
    "[draft-mirror] withholding interview upsert until targetEpicId is bound",
    { chatId, blockId, draftId },
  );
}

function hostIdForDraft(draftId: string): string | null {
  const landing = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId);
  if (landing !== undefined) {
    return landing.adoption.state === "adopted"
      ? landing.adoption.hostId
      : null;
  }
  const composerChatId = findComposerChatIdByDraftId(draftId);
  if (composerChatId !== null) {
    return composerHostByChatId.get(composerChatId) ?? null;
  }
  const interview = findInterviewByDraftId(draftId);
  if (interview !== null) {
    return (
      interviewHostByKey.get(
        interviewDraftBindingKey(interview.chatId, interview.blockId),
      ) ?? null
    );
  }
  const newChat = findNewChatByDraftId(draftId);
  if (newChat !== null) {
    return newChatHostByEpicId.get(newChat.epicId) ?? null;
  }
  return stashHostById.get(draftId) ?? null;
}

function sessionForDraft(draftId: string): DraftMirrorSession | null {
  const hostId = hostIdForDraft(draftId);
  if (hostId === null) return null;
  return sessions.get(hostId)?.session ?? null;
}

function routeLocalEdit(draftId: string): void {
  const landing = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId);
  if (landing !== undefined && landing.adoption.state === "unadopted") {
    if (landingAdoptionHostId === null) return;
    sessions.get(landingAdoptionHostId)?.session.noteDirty(draftId);
    return;
  }
  sessionForDraft(draftId)?.noteDirty(draftId);
}

function routeLocalDelete(draftId: string): void {
  const session = sessionForDraft(draftId);
  if (session === null) return;
  void session.deleteOnHost(draftId);
}

function routeLocalFlush(draftId: string): void {
  const landing = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId);
  if (landing !== undefined && landing.adoption.state === "unadopted") {
    if (landingAdoptionHostId === null) return;
    const session = sessions.get(landingAdoptionHostId)?.session;
    if (session === undefined) return;
    void session.flush([draftId]);
    return;
  }
  void flushDraftMirrorSessions([draftId]);
}

setDraftLocalEditListener(routeLocalEdit);
setDraftLocalDeleteListener(routeLocalDelete);
setDraftLocalFlushListener(routeLocalFlush);

export interface AcquireDraftMirrorArgs {
  readonly hostId: string;
  readonly client: HostRequester<HostRpcRegistry>;
  readonly streamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly timing: Partial<DraftMirrorTiming> | undefined;
}

export function acquireDraftMirrorSession(
  args: AcquireDraftMirrorArgs,
): DraftMirrorSession {
  const existing = sessions.get(args.hostId);
  if (existing !== undefined) {
    existing.refCount += 1;
    return existing.session;
  }
  // New session = new host connection. Re-probe blob methods so a
  // host that upgraded while this renderer stayed up is not stuck
  // blob-less until restart.
  forgetBlobUnsupportedHost(args.hostId);
  const session = new DraftMirrorSession({
    hostId: args.hostId,
    rpc: {
      list: async () => {
        const listed = await args.client.request("drafts.list", {});
        setCloudScopeId(args.hostId, listed.scopeId ?? null);
        return listed;
      },
      upsert: (draft) => args.client.request("drafts.upsert", { draft }),
      delete: (draftId) => args.client.request("drafts.delete", { draftId }),
    },
    streamClient: args.streamClient,
    sink,
    timing: args.timing,
    now: undefined,
  });
  sessions.set(args.hostId, { session, refCount: 1 });
  sessionClients.set(args.hostId, args.client);
  session.start();
  return session;
}

export function releaseDraftMirrorSession(hostId: string): void {
  const existing = sessions.get(hostId);
  if (existing === undefined) return;
  existing.refCount -= 1;
  if (existing.refCount > 0) return;
  existing.session.close();
  sessions.delete(hostId);
  sessionClients.delete(hostId);
  cloudScopeIdByHost.delete(hostId);
  notifyCloudScopeListeners();
}

export async function flushDraftMirrorSessions(
  draftIds: ReadonlyArray<string> | null,
): Promise<void> {
  if (draftIds === null) {
    await Promise.all(
      [...sessions.values()].map((entry) => entry.session.flush(null)),
    );
    return;
  }
  const idsByHost = new Map<string, string[]>();
  for (const draftId of draftIds) {
    const hostId = hostIdForDraft(draftId);
    if (hostId === null) continue;
    const bucket = idsByHost.get(hostId);
    if (bucket === undefined) {
      idsByHost.set(hostId, [draftId]);
      continue;
    }
    bucket.push(draftId);
  }
  await Promise.all(
    [...idsByHost.entries()].map(([hostId, ids]) => {
      const session = sessions.get(hostId)?.session;
      return session === undefined ? Promise.resolve() : session.flush(ids);
    }),
  );
}

/**
 * Decision #9: adopt on the first debounced sync for the landing
 * placement host, not on mount. `wanted === null` means every dirty
 * unadopted landing draft (bootstrap / flush-all).
 */
export async function adoptUnadoptedLandingDraftsForHost(
  hostId: string,
  wanted: ReadonlySet<string> | null,
): Promise<void> {
  if (landingAdoptionHostId !== hostId) return;
  const client = sessionClients.get(hostId);
  for (const draft of collectUnadoptedLandingDrafts()) {
    if (wanted !== null && !wanted.has(draft.id)) continue;
    adoptLandingDraft(draft.id, hostId);
    if (client === undefined) continue;
    const hashes = blobHashesFromContent(draft.content);
    const confirmed = await putDraftBlobs(hostId, client, hashes);
    rememberLandingBlobsOnHost(draft.id, confirmed);
  }
}

export function resetDraftMirrorCoordinatorForTests(): void {
  for (const entry of sessions.values()) {
    entry.session.close();
  }
  sessions.clear();
  sessionClients.clear();
  cloudScopeIdByHost.clear();
  composerHostByChatId.clear();
  interviewHostByKey.clear();
  newChatHostByEpicId.clear();
  landingAdoptionHostId = null;
  stashHostById.clear();
  stashSeenOnHost.clear();
  warnedUnboundComposer.clear();
  warnedUnboundInterview.clear();
  resetDraftBlobTransportForTests();
  notifyCloudScopeListeners();
  // Re-bind production listeners. Tests that install their own must not
  // leave `routeLocalDelete` unbound for later files in the same worker.
  setDraftLocalEditListener(routeLocalEdit);
  setDraftLocalDeleteListener(routeLocalDelete);
  setDraftLocalFlushListener(routeLocalFlush);
}

export function draftMirrorSessionCountForTests(): number {
  return sessions.size;
}

export async function submitComposerDraft(chatId: string): Promise<void> {
  const before = readComposerDraftSnapshot(chatId);
  useComposerDraftStore.getState().clearDraft(chatId);
  if (before.draftId === null) return;
  const session = sessionForDraft(before.draftId);
  if (session === null) return;
  await session.flush([before.draftId]);
  await session.deleteOnHost(before.draftId);
}

export function collectDraftMirrorDirtyWrites(
  hostId: string,
): readonly DraftDirtyWrite[] {
  return collectAllDirtyWrites(hostId);
}

export async function applyIncomingDraftDocument(
  document: DraftDocument,
): Promise<void> {
  await applyHostDocument(document);
}

export async function ingestCloudDraftSummary(input: {
  readonly hostId: string;
  readonly summary: CloudChatSummary;
  readonly document: DraftDocument;
}): Promise<void> {
  if (input.summary.ownerHostId === input.hostId) return;
  await applyHostDocument(input.document);
}

registerExtraImageRootSource({
  hashes: () => {
    const hashes: string[] = [];
    for (const draft of Object.values(
      useComposerDraftStore.getState().drafts,
    )) {
      if (draft === undefined) continue;
      hashes.push(...blobHashesFromContent(draft.content));
    }
    for (const patch of Object.values(
      useNewConversationModalStore.getState().draftPatchesByEpicId,
    )) {
      if (patch === undefined || patch.content === null) continue;
      hashes.push(...blobHashesFromContent(patch.content));
    }
    for (const row of usePromptStashStore.getState().rows) {
      if (row.kind !== "entry") continue;
      hashes.push(...row.entry.blobHashes);
    }
    return hashes;
  },
});

export type { DraftWrite };
