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
import { draftKindIsHostBound } from "./draft-portability";
import { isDraftsCapabilityMissing } from "./draft-capability";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

import { interviewDraftBindingKey } from "./draft-ids";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";
import {
  adoptLandingDraft,
  applyLandingHostDelete,
  applyLandingHostDocument,
  collectLandingDirtyWrites,
  collectUnadoptedLandingDrafts,
  deleteLandingDraftOnHost,
  dropForeignLandingMirrorsAbsent,
  dropLandingAbsentFromList,
  landingDraftIsDirty,
  landingDraftRememberSynced,
  landingRowIsForeign,
  rememberLandingBlobsOnHost,
  reopenLandingDraftView,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  applyComposerHostDelete,
  applyComposerHostDocument,
  collectComposerDirtyWrites,
  composerDraftIsDirty,
  composerDraftRememberSynced,
  composerDraftRowIsForeign,
  composerSubmittedDraftDeleteIsPending,
  dropComposerAbsentFromList,
  findComposerChatIdByDraftId,
  pendingSubmittedDraftDelete,
  pendingSubmittedDraftDeleteHostId,
  pendingSubmittedDraftDeletesForHost,
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import type { TabRef } from "@/stores/tabs/types";
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
import type { ImageBlob } from "@/lib/attachments/image-bytes";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import {
  setDraftLocalDeleteListener,
  setDraftLocalEditListener,
  setDraftLocalFlushListener,
  setLandingPlacementHostReader,
} from "./draft-local-edits";
import {
  DraftMirrorSession,
  type DraftDeleteOutcome,
  type DraftDirtyWrite,
  type DraftMirrorSink,
} from "./draft-mirror-session";
import type { DraftMirrorTiming } from "./draft-mirror-timing";
import {
  completeLandingDraftDelete,
  landingDraftIsRetired,
  pendingLandingDraftDeleteHostId,
  pendingLandingDraftDeletesForHost,
  retireLandingDraft,
  retireLandingDraftForRetract,
  resolveLandingDraftRetirementOwner,
} from "./landing-draft-retirement";

type SessionEntry = {
  readonly session: DraftMirrorSession;
  refCount: number;
};

const sessions = new Map<string, SessionEntry>();
const sessionClients = new Map<string, HostRequester<HostRpcRegistry>>();
const knownLandingDraftIds = new Set<string>();
const cloudScopeIdByHost = new Map<string, string | null>();
const cloudScopeListeners = new Set<() => void>();
const sessionListeners = new Set<() => void>();

/**
 * Whether this window holds a draft mirror session with `hostId` - the "All"
 * filter's live-host set (D09). `composer-draft-store` is persisted and never
 * sweeps an unmounted chat, so without this every chat draft any host ever
 * listed would keep listing after its session is gone, with a dead Open.
 */
export function hasDraftMirrorSession(hostId: string): boolean {
  return sessions.has(hostId);
}

export function subscribeDraftMirrorSessions(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

function notifySessionListeners(): void {
  for (const listener of sessionListeners) listener();
}

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
/**
 * Live binds per `(chat, block, host)`. Two duplicate views of the same
 * interview mount the same binding, and unmounting either one used to delete
 * the single map entry - leaving the surviving view unsynchronized until it
 * remounted. Counted, so the entry outlives every view but the last.
 */
const interviewBindingRefs = new Map<string, number>();
const newChatHostByEpicId = new Map<string, string>();

function interviewBindingRefKey(bindingKey: string, hostId: string): string {
  return `${bindingKey}\u0000${hostId}`;
}

/** Placement host that may lazily adopt landing drafts (decision #9). */
let landingAdoptionHostId: string | null = null;
/**
 * Ordering fence for the cloud-directory absence sweep: every landing
 * document apply - a cloud-head ingest or a host session's live echo -
 * takes the next sequence number when it STARTS, and a directory snapshot
 * records the sequence current when its request was DISPATCHED. A row
 * applied after that (by another mount, through another host) is not
 * absent from that snapshot in any sense the snapshot can attest to.
 */
let cloudIngestSeq = 0;
const cloudIngestSeqByDraft = new Map<string, number>();
/**
 * View state of landing rows a successor may inherit, keyed by the
 * superseded id: a row a host `delete` frame removed while open in this
 * window before the `upsert` naming it arrived (a host that emits the old
 * frame order, or a delete that raced ahead). The successor takes over the
 * tab - open, and active if the ancestor was - so the user keeps looking at
 * what reads as the same draft. The primary path is the in-place re-key
 * (`rekeyLandingTabInPlace`), which needs the ancestor still open here.
 * Consumed on use; bounded.
 */
const inheritableLandingTabs = new Map<string, { readonly active: boolean }>();
const INHERITABLE_LANDING_TABS_CAP = 64;

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
  // Consumed through a host other than the one that published it: the
  // entry's cloud row is retracted on the user's authority from here, and
  // the publishing host tombstones its (immutable, hence unchanged) local
  // row when it finds the cloud row gone. Ownership never moves.
  const client = sessionClients.get(bound);
  if (client !== undefined) {
    try {
      await client.request("drafts.retract", { draftId: entryId });
      stashHostById.delete(entryId);
      return;
    } catch {
      // An older host without `drafts.retract`: fall through to the
      // idempotent delete, which answers `deleted: false` there and leaves
      // the publisher's row (lossy, not broken).
    }
  }
  await deleteStashEntryOnHost(bound, entryId);
}

async function ingestStashDocument(
  document: DraftDocument,
  images: ReadonlyMap<string, ImageBlob>,
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
  usePromptStashStore
    .getState()
    .dropRemote(draftId)
    .catch((error: unknown) => {
      appLogger.warn("[draft-mirror] stash drop failed", {
        error: describeLogError(error),
      });
    });
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
  const key = interviewDraftBindingKey(chatId, blockId);
  const refKey = interviewBindingRefKey(key, hostId);
  interviewBindingRefs.set(refKey, (interviewBindingRefs.get(refKey) ?? 0) + 1);
  interviewHostByKey.set(key, hostId);
}

export function unbindInterviewDraftHost(
  chatId: string,
  blockId: string,
  hostId: string,
): void {
  const key = interviewDraftBindingKey(chatId, blockId);
  const refKey = interviewBindingRefKey(key, hostId);
  const remaining = (interviewBindingRefs.get(refKey) ?? 0) - 1;
  if (remaining > 0) {
    interviewBindingRefs.set(refKey, remaining);
    return;
  }
  interviewBindingRefs.delete(refKey);
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
  isDeletePending(draftId) {
    return (
      landingDraftIsRetired(draftId) ||
      composerSubmittedDraftDeleteIsPending(draftId)
    );
  },
  pendingDeletesForHost(hostId) {
    return [
      ...pendingLandingDraftDeletesForHost(hostId),
      ...pendingSubmittedDraftDeletesForHost(hostId),
    ];
  },
  settleDelete(hostId, draftId, outcome) {
    // Landing: only while the receipt still names this host. Composer: a
    // retired submitted id is done once the host has answered anything but
    // a failure.
    settleLandingDeleteOutcome(draftId, hostId, outcome);
    useComposerDraftStore.getState().completeSubmittedDraftDelete(draftId);
  },
  applyUpsert(document) {
    return applyHostDocument(document);
  },
  applyDelete(draftId) {
    rememberInheritableLandingTab(draftId);
    // A tombstone can arrive while the first landing upsert awaits its images,
    // before there is any local row for applyLandingHostDelete to remove.
    if (knownLandingDraftIds.has(draftId)) retireLandingDraft(draftId, null);
    completeLandingDraftDelete(draftId);
    useComposerDraftStore.getState().completeSubmittedDraftDelete(draftId);
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

function rejectRetiredLandingDocument(document: DraftDocument): boolean {
  if (document.kind !== "landing" || !landingDraftIsRetired(document.draftId))
    return false;
  // Desktop may restore content before it has recovered host adoption.
  // The first owner document supplies the missing delete destination, never
  // a replacement visible row. ACKed receipts cannot be rearmed here.
  resolveLandingDraftRetirementOwner(document.draftId, document.ownerHostId);
  if (pendingLandingDraftDeleteHostId(document.draftId) !== null) {
    routeLocalDelete(document.draftId);
  }
  return true;
}

/**
 * Record the view state of an open landing row about to be removed by a
 * host tombstone, for a successor that names it (see
 * `inheritableLandingTabs`).
 */
function rememberInheritableLandingTab(draftId: string): void {
  const { drafts, activeDraftId } = useLandingDraftStore.getState();
  const row = drafts.find((draft) => draft.id === draftId);
  if (row === undefined || row.closed) {
    inheritableLandingTabs.delete(draftId);
    return;
  }
  inheritableLandingTabs.delete(draftId);
  inheritableLandingTabs.set(draftId, { active: activeDraftId === draftId });
  for (const key of inheritableLandingTabs.keys()) {
    if (inheritableLandingTabs.size <= INHERITABLE_LANDING_TABS_CAP) break;
    inheritableLandingTabs.delete(key);
  }
}

/**
 * A landing document that names an ancestor still open in a tab here (the
 * owner's re-mint, whose `upsert` precedes the ancestor's `delete` frame;
 * or a fork echoed by another host's session, whose owner has yet to
 * tombstone it): re-key that tab onto the successor in place, keeping its
 * strip position and group, and retire the ancestor locally so the delete
 * that follows is a no-op. Zero UI: the tab simply reads the successor now.
 * False when there is nothing to re-key (no ancestor open in the strip);
 * the caller then applies the document as an insert.
 */
function rekeyLandingTabInPlace(
  document: Extract<DraftDocument, { kind: "landing" }>,
): boolean {
  if (document.supersedes === null) return false;
  const ancestor = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === document.supersedes);
  if (ancestor === undefined || ancestor.closed) return false;
  let replaced: TabRef | null;
  try {
    replaced = tabCommandCoordinator.replaceDraftWithDocument({
      previousDraftId: ancestor.id,
      nextDraftId: document.draftId,
      installNext: () => {
        // A document the store rejects (retired, or older than the row's
        // current revision) installs nothing, and the command must not
        // re-key the tab onto a row that never materialised.
        if (!applyLandingHostDocument(document, document.portable.content)) {
          return false;
        }
        // The strip item now names the successor, which must be open: a
        // foreign row's `closed` is this device's view (the ancestor's was
        // open), an own row on the placement follows the host's value.
        reopenLandingDraftView(document.draftId);
        return true;
      },
    });
  } catch (error: unknown) {
    // The transaction refused mid-flight (the successor could not be
    // installed, or a listener moved the ancestor underneath it): the
    // layout and the ancestor are untouched, and the document falls to
    // the plain apply + inherit path below.
    appLogger.warn("[draft-mirror] landing re-key refused", {
      draftId: document.draftId,
      supersedes: document.supersedes,
      error: describeLogError(error),
    });
    return false;
  }
  if (replaced === null) return false;
  inheritableLandingTabs.delete(document.supersedes);
  return true;
}

/**
 * The fallback for a successor whose ancestor is no longer in the store
 * (removed by a `delete` frame that came first): the successor inherits
 * the view state recorded at that delete - open, and active if the ancestor
 * was. Without a record the row lands as a plain insert.
 */
function inheritLandingTab(
  document: Extract<DraftDocument, { kind: "landing" }>,
): void {
  if (document.supersedes === null) return;
  const { drafts, activeDraftId } = useLandingDraftStore.getState();
  const ancestor = drafts.find((draft) => draft.id === document.supersedes);
  let view: { readonly active: boolean } | undefined;
  if (ancestor === undefined) {
    view = inheritableLandingTabs.get(document.supersedes);
  } else if (!ancestor.closed) {
    // Open here but with no strip item to re-key (a surface outside the
    // strip): the successor is activated the same way.
    view = { active: activeDraftId === ancestor.id };
  }
  inheritableLandingTabs.delete(document.supersedes);
  if (view === undefined) return;
  reopenLandingDraftView(document.draftId);
  if (!view.active) return;
  tabCommandCoordinator.activateTab({
    kind: "draft",
    draftId: document.draftId,
    settings: null,
    create: false,
  });
}

async function applyHostDocument(document: DraftDocument): Promise<void> {
  if (document.kind === "landing") {
    knownLandingDraftIds.add(document.draftId);
    // The absence-sweep fence is reserved here, synchronously at the start
    // of EVERY landing apply - a host session's live echo as much as a
    // cloud-head ingest - and before the blob reads below: a directory
    // request dispatched earlier must not sweep a row this apply installs.
    cloudIngestSeq += 1;
    cloudIngestSeqByDraft.set(document.draftId, cloudIngestSeq);
  }
  // This apply's own reservation. The blob read below can outlast a newer
  // apply of the same row (or a newer directory run's reservation before
  // its head read), and cloud heads carry revision 0 so nothing later
  // fences an older head by revision: whoever reserved last wins the row.
  const applySeq = cloudIngestSeq;
  if (rejectRetiredLandingDocument(document)) return;
  if (composerSubmittedDraftDeleteIsPending(document.draftId)) {
    await retrySubmittedDraftDelete(document.draftId);
    return;
  }
  const client = sessionClients.get(document.ownerHostId);
  const hashes = blobHashesOfDocument(document);
  if (client !== undefined && hashes.length > 0) {
    const images = await readDraftBlobsIntoLocalStore(
      document.ownerHostId,
      client,
      hashes,
    );
    if (
      document.kind === "landing" &&
      cloudIngestSeqByDraft.get(document.draftId) !== applySeq
    ) {
      return;
    }
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
    // Re-checked after the blob reads: a delete routed meanwhile retired it.
    if (rejectRetiredLandingDocument(document)) return;
    if (rekeyLandingTabInPlace(document)) return;
    if (applyLandingHostDocument(document, document.portable.content)) {
      inheritLandingTab(document);
    }
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
        supersedes: draft.supersedes,
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
        supersedes: draft.supersedes,
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
        // New-chat drafts live on the epic's host and are never forked.
        supersedes: null,
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
  const landingDeleteHostId = pendingLandingDraftDeleteHostId(draftId);
  if (landingDeleteHostId !== null) return landingDeleteHostId;
  const pendingDeleteHostId = pendingSubmittedDraftDeleteHostId(draftId);
  if (pendingDeleteHostId !== null) return pendingDeleteHostId;
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
  // A foreign row is never written through its adoption host's session:
  // that host is not the placement (a replica's owner, or a host the
  // placement auto-followed away from). Its edit forked it onto a fresh row
  // of the placement host's own before applying, and that row routes.
  if (landing !== undefined && landingRowIsForeign(landing)) return;
  if (landing !== undefined && landing.adoption.state === "unadopted") {
    if (landingAdoptionHostId === null) return;
    sessions.get(landingAdoptionHostId)?.session.noteDirty(draftId);
    return;
  }
  sessionForDraft(draftId)?.noteDirty(draftId);
}

function routeLocalDelete(draftId: string): void {
  // A receipt that names a host is an explicit route (History deleting an
  // own row through the host that holds it, whichever host the landing
  // placement points at) and takes precedence over the placement rule.
  const explicitHostId = pendingLandingDraftDeleteHostId(draftId);
  const landing = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId);
  // A foreign row (still in the store: the notice precedes its removal) is
  // not this placement's to `drafts.delete`. Its cloud row is retracted on
  // the user's authority through the placement host instead; the owner
  // host tombstones its own row from there. The receipt records the
  // retract so the placement host's session retries it until the host
  // answers; a host without `drafts.retract` leaves the owner's row
  // (lossy, not broken).
  if (
    explicitHostId === null &&
    landing !== undefined &&
    landingRowIsForeign(landing)
  ) {
    if (landingAdoptionHostId !== null) {
      retireLandingDraftForRetract(draftId, landingAdoptionHostId);
      void retractDraftThroughHost(landingAdoptionHostId, draftId);
    }
    return;
  }
  const hostId = explicitHostId ?? hostIdForDraft(draftId);
  if (hostId === null) return;
  const session = sessions.get(hostId)?.session;
  if (session === undefined) return;
  void session.deleteOnHostOutcome(draftId).then((outcome) => {
    settleLandingDeleteOutcome(draftId, hostId, outcome);
  });
}

/**
 * Retract a draft's cloud row on the user's authority through `hostId`,
 * for a row that host does not own (it would answer a `drafts.delete` with
 * `absent` and the owner's cloud row would survive). The caller has
 * recorded the pending retract on the id's receipt; the answer settles it
 * through the sink like a delete's (`deleted` / `absent` / `unsupported`
 * are terminal, a failure leaves it pending for the host's session to
 * retry). A mounted session is preferred, as for a delete; otherwise the
 * request goes out on the bare client. Resolves once the host has answered
 * or the request has failed and been left pending.
 */
async function retractDraftThroughHost(
  hostId: string,
  draftId: string,
): Promise<void> {
  const session = sessions.get(hostId)?.session;
  if (session !== undefined) {
    const outcome = await session.retractOnHostOutcome(draftId);
    if (outcome !== "failed") sink.settleDelete(hostId, draftId, outcome);
    return;
  }
  const client = sessionClients.get(hostId);
  if (client === undefined) return;
  try {
    const response = await client.request("drafts.retract", { draftId });
    sink.settleDelete(
      hostId,
      draftId,
      response.retracted ? "deleted" : "absent",
    );
  } catch (error: unknown) {
    if (isDraftsCapabilityMissing(error)) {
      sink.settleDelete(hostId, draftId, "unsupported");
      return;
    }
    appLogger.warn("[draft-mirror] drafts.retract failed", {
      error: describeLogError(error),
    });
  }
}

/**
 * Apply a host's `drafts.delete` answer to a landing retirement receipt -
 * only while the receipt still names `hostId`. Ownership never moves, so
 * `absent` is as final as `deleted`: the row is not on the host that owns
 * it. `failed` leaves the receipt pending for retry.
 */
function settleLandingDeleteOutcome(
  draftId: string,
  hostId: string,
  outcome: DraftDeleteOutcome,
): void {
  if (pendingLandingDraftDeleteHostId(draftId) !== hostId) return;
  if (outcome === "failed") return;
  completeLandingDraftDelete(draftId);
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
setLandingPlacementHostReader(() => landingAdoptionHostId);

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
      retract: (draftId) => args.client.request("drafts.retract", { draftId }),
    },
    streamClient: args.streamClient,
    sink,
    timing: args.timing,
    now: undefined,
  });
  sessions.set(args.hostId, { session, refCount: 1 });
  sessionClients.set(args.hostId, args.client);
  // Only a NEW host entry moves the live-host set; a second ref for a host
  // already mounted changes nothing an observer can see.
  notifySessionListeners();
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
  notifySessionListeners();
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
  // `upsertDirty` awaits this before it collects a single write, so awaiting
  // each draft's blobs in turn put N serialized round trips in front of the
  // first upsert of every bootstrap flush. The uploads are independent.
  const uploads: Promise<void>[] = [];
  for (const draft of collectUnadoptedLandingDrafts()) {
    if (wanted !== null && !wanted.has(draft.id)) continue;
    adoptLandingDraft(draft.id, hostId);
    if (client === undefined) continue;
    const hashes = blobHashesFromContent(draft.content);
    uploads.push(
      putDraftBlobs(hostId, client, hashes).then((confirmed) => {
        rememberLandingBlobsOnHost(draft.id, confirmed);
      }),
    );
  }
  await Promise.all(uploads);
}

export function resetDraftMirrorCoordinatorForTests(): void {
  for (const entry of sessions.values()) {
    entry.session.close();
  }
  sessions.clear();
  sessionClients.clear();
  knownLandingDraftIds.clear();
  cloudScopeIdByHost.clear();
  composerHostByChatId.clear();
  interviewHostByKey.clear();
  interviewBindingRefs.clear();
  newChatHostByEpicId.clear();
  landingAdoptionHostId = null;
  cloudIngestSeq = 0;
  cloudIngestSeqByDraft.clear();
  inheritableLandingTabs.clear();
  stashHostById.clear();
  stashSeenOnHost.clear();
  warnedUnboundComposer.clear();
  warnedUnboundInterview.clear();
  resetDraftBlobTransportForTests();
  notifyCloudScopeListeners();
  notifySessionListeners();
  // Re-bind production listeners. Tests that install their own must not
  // leave `routeLocalDelete` unbound for later files in the same worker.
  setDraftLocalEditListener(routeLocalEdit);
  setDraftLocalDeleteListener(routeLocalDelete);
  setDraftLocalFlushListener(routeLocalFlush);
  setLandingPlacementHostReader(() => landingAdoptionHostId);
}

export function draftMirrorSessionCountForTests(): number {
  return sessions.size;
}

export async function submitComposerDraft(chatId: string): Promise<void> {
  const before = readComposerDraftSnapshot(chatId);
  const hostId =
    before.draftId === null ? null : hostIdForDraft(before.draftId);
  const store = useComposerDraftStore.getState();
  store.clearDraft(chatId);
  if (before.draftId === null || hostId === null) return;
  // A row the tab host does not own (a replica, or another host's row),
  // submitted without an edit that would have forked it: `drafts.delete`
  // there would answer `absent` and the owner's cloud row would survive.
  // The id is dropped with no pending delete, and the cloud row is
  // retracted on the user's authority through the tab host instead - the
  // same rule the landing path applies to a foreign row.
  const foreign = composerDraftRowIsForeign(before, hostId);
  // Retire the id BEFORE any host round trip below is awaited. `clearDraft`
  // keeps it, so an edit typed during an awaited retract or delete would
  // re-dirty the id, the mirror could upsert it, and the tombstone that
  // follows would remove that content and mark it synced. Fenced first,
  // the next edit mints a fresh id and a fresh host row.
  store.fenceAndDetachSubmittedDraft(
    chatId,
    before.draftId,
    foreign ? null : hostId,
  );
  // A fork whose first write has not been acknowledged still carries
  // `supersedes`: the upsert that would make the host retract the
  // ancestor's cloud row has not landed (and after the fence above it never
  // will), while the delete of the fresh id answers `absent`. The ancestor
  // is retracted here on the user's authority instead, whatever the fresh
  // row's ownership reads; a host that already retracted it (the ack raced
  // this submit) has nothing left to pay.
  if (before.supersedes !== null) {
    store.recordPendingSubmittedDraftRetract(before.supersedes, hostId);
    await retractDraftThroughHost(hostId, before.supersedes);
  }
  if (foreign) {
    store.recordPendingSubmittedDraftRetract(before.draftId, hostId);
    await retractDraftThroughHost(hostId, before.draftId);
    return;
  }
  await retrySubmittedDraftDelete(before.draftId);
}

async function retrySubmittedDraftDelete(draftId: string): Promise<void> {
  const pending = pendingSubmittedDraftDelete(draftId);
  if (pending === null) return;
  const session = sessions.get(pending.hostId)?.session;
  if (session === undefined) return;
  const outcome = pending.retract
    ? await session.retractOnHostOutcome(draftId)
    : await session.deleteOnHostOutcome(draftId);
  if (outcome !== "failed") {
    useComposerDraftStore.getState().completeSubmittedDraftDelete(draftId);
  }
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
  // A host-bound surface is never a replica here. `applyComposerHostDocument`
  // keys on `target.chatId`, so ingesting another host's chat-composer draft
  // overwrites the row for a chat that lives on THAT host - flipping the
  // owning host's own live draft to `origin: "replica"`, which would make
  // the chat composer fork it on the next keystroke. Every tile mount
  // re-ran this.
  if (draftKindIsHostBound(input.document.kind)) return;
  // The absence-sweep fence is reserved by `applyHostDocument` at its
  // (synchronous) start, before the blob reads: an older directory request
  // settling in that window already sees this row as newer than its
  // snapshot. Ownership never moves, so there is nothing else to admit: a
  // dirty own row keeps its content (`applyLandingHostDocument`), and a
  // replica head is exactly what the directory is for.
  await applyHostDocument(input.document);
}

/**
 * Delete a landing draft through `hostId` from a surface that holds that
 * host's client but need not have a mirror session mounted: History runs on
 * the app-wide host, and only the landing placement and mounted tabs
 * acquire sessions, so with the composer pinned elsewhere the routed
 * delete (`notifyDraftLocalDelete` -> `routeLocalDelete`) has no session to
 * reach. A mounted session is preferred (it serializes the tombstone
 * behind in-flight upserts); otherwise the tombstone goes out on the
 * client directly. The receipt stays pending until the host answers, so a
 * failure is retried by whichever session for that host mounts later.
 */
export function deleteLandingDraftThroughHost(
  draftId: string,
  hostId: string,
  client: HostRequester<HostRpcRegistry> | null,
): void {
  deleteLandingDraftOnHost(draftId, hostId);
  if (sessions.has(hostId) || client === null) return;
  if (pendingLandingDraftDeleteHostId(draftId) !== hostId) return;
  void client
    .request("drafts.delete", { draftId })
    .then((response) => {
      settleLandingDeleteOutcome(
        draftId,
        hostId,
        response.deleted ? "deleted" : "absent",
      );
    })
    .catch((error: unknown) => {
      if (isDraftsCapabilityMissing(error)) {
        settleLandingDeleteOutcome(draftId, hostId, "unsupported");
        return;
      }
      appLogger.warn("[draft-mirror] direct drafts.delete failed", {
        error: describeLogError(error),
      });
    });
}

/** The current ingest sequence; a directory captures it at dispatch. */
export function cloudDraftIngestSeq(): number {
  return cloudIngestSeq;
}

/**
 * Reserve the absence-sweep fence for a draft whose cloud head is about
 * to be READ: the read (head plus parts) can take a while, and an older
 * directory snapshot settling meanwhile must not sweep the existing mirror
 * the apply is about to refresh. `applyHostDocument` reserves again at the
 * apply; a read with a terminal outcome simply leaves this reservation,
 * which protects the row until a later snapshot.
 */
export function reserveCloudDraftIngestFence(draftId: string): void {
  cloudIngestSeq += 1;
  cloudIngestSeqByDraft.set(draftId, cloudIngestSeq);
}

/**
 * Drop local mirrors of cloud rows a settled directory no longer lists.
 * `fenceSeq` is the ingest sequence at that directory's fetch start: a row
 * ingested since is kept. A replica qualifies once clean. An OWN row
 * adopted on another host qualifies only when it was published (an
 * unpublished own row is never listed) and that host has no mirror
 * session here (a mounted session delivers its own tombstones, and its
 * unsynced writes may not have reached the directory yet).
 */
export function sweepAbsentCloudDraftMirrors(
  hostId: string,
  listed: ReadonlyMap<string, ReadonlySet<string>>,
  fenceSeq: number,
): readonly string[] {
  return dropForeignLandingMirrorsAbsent(hostId, listed, (draft) => {
    if ((cloudIngestSeqByDraft.get(draft.id) ?? 0) > fenceSeq) return false;
    if (draft.origin === "replica") return true;
    // A row with no recorded publication state is treated as unpublished.
    return (
      draft.publication !== null &&
      draft.publication.status !== "unpublished" &&
      draft.adoption.state === "adopted" &&
      !sessions.has(draft.adoption.hostId)
    );
  });
}

/**
 * Own rows whose cloud entry a settled directory no longer lists, while the
 * session of the host that holds them is mounted here: the owner host never
 * re-publishes an unchanged row, so on its own it cannot see that a fork
 * elsewhere tombstoned its cloud row. A `drafts.subscribe` `flush` for the
 * row makes that host probe the cloud and apply its tombstone rule - delete
 * the row if unchanged, re-mint it if edited since. Nothing is deleted
 * client-side. `fenceSeq` as for the sweep: a row applied after the
 * directory was dispatched is not absent in any sense it can attest to.
 * `alreadyFlushed` holds the ids nudged for this snapshot; returns the ids
 * flushed now, so the caller sends each at most once per snapshot.
 */
export function flushAbsentOwnCloudDrafts(
  listed: ReadonlyMap<string, ReadonlySet<string>>,
  fenceSeq: number,
  alreadyFlushed: ReadonlySet<string>,
): readonly string[] {
  const flushed: string[] = [];
  for (const draft of useLandingDraftStore.getState().drafts) {
    if (draft.adoption.state !== "adopted" || draft.origin !== "own") continue;
    if (alreadyFlushed.has(draft.id)) continue;
    if (
      draft.publication === null ||
      draft.publication.publishedRevision === null
    ) {
      continue;
    }
    if ((cloudIngestSeqByDraft.get(draft.id) ?? 0) > fenceSeq) continue;
    const owners = listed.get(draft.id);
    if (
      owners !== undefined &&
      (draft.ownerHostId === null || owners.has(draft.ownerHostId))
    ) {
      continue;
    }
    const session = sessions.get(draft.adoption.hostId)?.session;
    if (session === undefined) continue;
    void session.flush([draft.id]);
    flushed.push(draft.id);
  }
  return flushed;
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
