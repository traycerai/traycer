import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import { appLogger } from "@/lib/logger";
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
} from "./draft-write-codec";
import {
  setDraftLocalDeleteListener,
  setDraftLocalEditListener,
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

const composerHostByChatId = new Map<string, string>();
const interviewHostByKey = new Map<string, string>();
const newChatHostByEpicId = new Map<string, string>();

/** Placement host that may lazily adopt landing drafts (decision #9). */
let landingAdoptionHostId: string | null = null;

export function bindLandingAdoptionHost(hostId: string | null): void {
  landingAdoptionHostId = hostId;
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
    applyHostDocument(document);
  },
  applyDelete(draftId) {
    applyLandingHostDelete(draftId);
    applyComposerHostDelete(draftId);
    applyInterviewHostDelete(draftId);
    applyNewChatHostDelete(draftId);
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
  prepareWrite(write) {
    // T9 slots here: before drafts.upsert, upload blobHashes via
    // drafts.putBlob (host-wide blob store). Identity until then — the
    // window-partitioned landing-image-store stays the local byte tier
    // for every draft, adopted or not. Kept Promise-returning so T9
    // can await putBlob without changing the sink signature.
    return Promise.resolve(write);
  },
  dropAbsentFromList(hostId, listedIds) {
    dropLandingAbsentFromList(hostId, listedIds);
    dropComposerAbsentFromList(hostId, listedIds, composerHostByChatId);
    dropInterviewAbsentFromList(hostId, listedIds, interviewHostByKey);
    dropNewChatAbsentFromList(hostId, listedIds, newChatHostByEpicId);
  },
  adoptUnadoptedLandingDrafts(hostId, wanted) {
    adoptUnadoptedLandingDraftsForHost(hostId, wanted);
  },
};

function applyHostDocument(document: DraftDocument): void {
  if (document.kind === "stash-entry") return;
  if (document.kind === "interview") {
    applyInterviewHostDocument(document);
    return;
  }
  // T9 slots here: a host-backed draft's blobHashes should resolve
  // through drafts.readBlob into the window-partitioned landing-image-store
  // (still the local render/GC tier). Until then, apply hash-only content
  // as-is — missing local bytes render unavailable, they are not fetched.
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
  return null;
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

setDraftLocalEditListener(routeLocalEdit);
setDraftLocalDeleteListener(routeLocalDelete);

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
  const session = new DraftMirrorSession({
    hostId: args.hostId,
    rpc: {
      list: () => args.client.request("drafts.list", {}),
      upsert: (draft) => args.client.request("drafts.upsert", { draft }),
      delete: (draftId) => args.client.request("drafts.delete", { draftId }),
    },
    streamClient: args.streamClient,
    sink,
    timing: args.timing,
    now: undefined,
  });
  sessions.set(args.hostId, { session, refCount: 1 });
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
export function adoptUnadoptedLandingDraftsForHost(
  hostId: string,
  wanted: ReadonlySet<string> | null,
): void {
  if (landingAdoptionHostId !== hostId) return;
  for (const draft of collectUnadoptedLandingDrafts()) {
    if (wanted !== null && !wanted.has(draft.id)) continue;
    adoptLandingDraft(draft.id, hostId);
    // T9 slots here: after flipping adoption and before the first
    // upsert, upload this draft's landing-image-store bytes
    // (blobHashes) via drafts.putBlob. Do not add that call in T7.
  }
}

export function resetDraftMirrorCoordinatorForTests(): void {
  for (const entry of sessions.values()) {
    entry.session.close();
  }
  sessions.clear();
  composerHostByChatId.clear();
  interviewHostByKey.clear();
  newChatHostByEpicId.clear();
  landingAdoptionHostId = null;
  warnedUnboundComposer.clear();
  warnedUnboundInterview.clear();
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

export type { DraftWrite };
