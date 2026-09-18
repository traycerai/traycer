import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  holdPendingIngestImageHash,
  mintPendingIngestHolderId,
  releasePendingIngestImageHashes,
} from "@/lib/composer/pending-ingest-image-roots";
import { appLogger, describeLogError } from "@/lib/logger";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  registerExtraImageRootSource,
  registerExtraImageSizeSource,
} from "@/lib/composer/landing-image-budget";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { sniffImageMimeType } from "@/lib/attachments/image-mime-signature";
import {
  currentDraftBlobOwnerId,
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
import {
  forgetCloudDraftPayloadUnsupportedHost,
  rebindCloudDraftImageClientForHost,
  recoverCloudDraftImages,
  resetCloudDraftImageRecoveryForTests,
} from "./cloud-draft-image-recovery";
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
} from "./draft-write-codec";
import type { ImageBlob } from "@/lib/attachments/image-bytes";
import {
  convertStashEntry,
  landingDraftsAreReady,
  type StashConversionOutcome,
} from "./stash-migration";
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

/**
 * Stash ids whose source row this session has already asked its host to
 * retire. An old host without `drafts.retract` answers the fall-back delete
 * `deleted: false` and keeps listing the row, so without this the same
 * retire would go out on every `drafts.list` forever; one wasted request per
 * session per zombie row is the accepted cost (G5).
 */
const retiredStashIdsThisSession = new Set<string>();

export function bindLandingAdoptionHost(hostId: string | null): void {
  landingAdoptionHostId = hostId;
}

export function draftsCloudScopeId(hostId: string): string | null {
  return (
    cloudScopeIdByHost.get(hostId) ??
    sessions.get(hostId)?.session.cloudScopeId() ??
    null
  );
}

/**
 * A `stash-entry` row an old client wrote (D20 keeps the kind on the wire):
 * converted into a closed start-page draft exactly once - the converted map
 * is app-global and survives restarts - and the source row retired so it
 * stops being listed.
 *
 * The blobs are already in this window's landing store (`applyHostDocument`
 * read them through `readDraftBlobsIntoLocalStore` before calling here), so
 * `readBlob` resolves straight from that map.
 *
 * `applyOwner` is the account the apply belongs to, captured before its first
 * await. Re-asked here because the conversion installs a landing draft - this
 * account's private text, and a set of hashes this account's partition will
 * root - and every await upstream is a window in which a sign-out or a user
 * switch could have moved the answer.
 */
async function convertStashDocument(
  document: DraftDocument,
  images: ReadonlyMap<string, ImageBlob>,
  applyOwner: string | null,
): Promise<boolean> {
  if (document.kind !== "stash-entry") return false;
  if (currentDraftBlobOwnerId() !== applyOwner) return false;
  // Not while the landing store may still be replaced wholesale: on desktop
  // the per-window projection is authoritative when it lands, so a row
  // installed before it would be dropped while the converted map recorded it
  // as done.
  //
  // WAITING rather than bailing, because nothing inside this session asks
  // again. The mirror mount can acquire its host session before the async
  // per-window projection marks landing drafts ready, and a `drafts.list`
  // replays only on reconnect; the cloud path is worse, because
  // `use-cloud-drafts-ingest` marks the head ingested BEFORE the apply and
  // only an unmount or a thrown error releases that key - an abandoned apply
  // is neither. So a stash row that arrived a moment early stayed invisible
  // until the app restarted. This is the same bounded ~10s poll the local
  // database migration already waits on.
  if (!(await landingDraftsAreReady())) return false;
  // Re-proved after that wait. It is an await like any other, and the owner
  // check above is now the stale side of it: a sign-out or a user switch
  // during the poll would otherwise convert account A's stash row into
  // account B's landing draft.
  if (currentDraftBlobOwnerId() !== applyOwner) return false;
  let outcome: StashConversionOutcome;
  try {
    outcome = await convertStashEntry({
      stashId: document.draftId,
      content: document.portable.content,
      blobHashes: document.portable.blobHashes,
      lastTouchedAt: document.portable.createdAt,
      readBlob: (hash) => Promise.resolve(images.get(hash) ?? null),
      // Threaded, not asked once here. The check above is made before the
      // conversion's own awaits - the image import and, for an entry with no
      // images, the async call itself - so on its own it fences nothing that
      // happens after them.
      stillCurrent: () => currentDraftBlobOwnerId() === applyOwner,
    });
  } catch (error: unknown) {
    appLogger.warn("[draft-mirror] stash conversion failed", {
      error: describeLogError(error),
    });
    return false;
  }
  // Nothing was installed and no receipt was written, so the source row is the
  // only remaining copy: retiring it here would destroy a prompt that no
  // account now holds. It stays listed for a later session to convert.
  if (outcome.status === "abandoned") return false;
  // A row converted in an EARLIER session still has to be retired, so the
  // retire below is not gated on this call having done the conversion - but
  // the fence is this session's, and an earlier session reserved its own.
  if (outcome.status === "converted") {
    reserveCloudDraftIngestFence(outcome.draftId);
  }
  await retireStashSourceRow(document);
  return true;
}

/**
 * Delete the converted row on its owner host when that host has a session
 * here; otherwise retract the cloud row on the user's authority through the
 * landing placement host, which is the only client this window is sure to
 * hold. A host too old for `drafts.retract` leaves the row (lossy, not
 * broken) - exactly what the foreign-landing-row delete does.
 */
async function retireStashSourceRow(document: DraftDocument): Promise<void> {
  if (retiredStashIdsThisSession.has(document.draftId)) return;
  retiredStashIdsThisSession.add(document.draftId);
  try {
    const owner = sessions.get(document.ownerHostId)?.session;
    if (owner !== undefined) {
      await owner.deleteOnHost(document.draftId);
      return;
    }
    if (landingAdoptionHostId === null) return;
    await retractDraftThroughHost(landingAdoptionHostId, document.draftId);
  } catch (error: unknown) {
    // The draft is converted either way; a failed retire leaves the source
    // row to be retired by a later session.
    appLogger.warn("[draft-mirror] stash source retire failed", {
      error: describeLogError(error),
    });
  }
}

export function bindComposerDraftHost(chatId: string, hostId: string): void {
  composerHostByChatId.set(chatId, hostId);
}

/**
 * Host a mounted composer bound this chat's draft to, or `null` when no
 * composer for it is mounted here. The sibling of `newChatBoundHostId`, and
 * the drafts list's test for "will an edit to this row be routed at all":
 * `routeLocalEdit` and the dirty-write collector both resolve a chat draft
 * through this map alone, so an unbound chat's restored row needs an explicit
 * upsert rather than a notice nothing acts on.
 */
export function composerBoundHostId(chatId: string): string | null {
  return composerHostByChatId.get(chatId) ?? null;
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

/**
 * Host a mounted modal bound this epic's new-chat draft to. The drafts list
 * reads it as the owner fallback for a patch no host document has echoed
 * `ownerHostId` onto yet.
 */
export function newChatBoundHostId(epicId: string): string | null {
  return newChatHostByEpicId.get(epicId) ?? null;
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
  async applyUpsert(document) {
    // The sink contract is `void`: a stream frame has nobody to report an
    // abandonment to, and `rememberIncomingSynced` already re-derives what it
    // needs from `held`. The boolean exists for the CLOUD ingest caller, which
    // writes bytes on the strength of the apply.
    await applyHostDocument(document, null);
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
  },
  collectDirtyWrites(hostId) {
    return Promise.resolve(collectAllDirtyWrites(hostId));
  },
  rememberSynced(draftId, hostRevision, collectedGeneration, ownerHostId) {
    // Only the stores that KEY a frontier on the owner are told who owns the
    // row. Interview keeps no owner and no frontier; new-chat keeps a
    // frontier but identifies its line by draft id alone, exactly as its own
    // fence does.
    landingDraftRememberSynced(
      draftId,
      hostRevision,
      collectedGeneration,
      ownerHostId,
    );
    composerDraftRememberSynced(
      draftId,
      hostRevision,
      collectedGeneration,
      ownerHostId,
    );
    interviewDraftRememberSynced(draftId, hostRevision, collectedGeneration);
    newChatDraftRememberSynced(draftId, hostRevision, collectedGeneration);
  },
  async prepareWrite(hostId, write) {
    const client = sessionClients.get(hostId);
    if (client === undefined) return write;
    const confirmed = await putDraftBlobsForWrite(
      hostId,
      client,
      write,
      currentDraftBlobOwnerId(),
    );
    rememberLandingBlobsOnHost(write.draftId, confirmed);
    return write;
  },
  dropAbsentFromList(hostId, listedIds) {
    dropLandingAbsentFromList(hostId, listedIds);
    dropComposerAbsentFromList(hostId, listedIds, composerHostByChatId);
    dropInterviewAbsentFromList(hostId, listedIds, interviewHostByKey);
    dropNewChatAbsentFromList(hostId, listedIds, newChatHostByEpicId);
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

/**
 * Is this apply still for the account that started it?
 *
 * A draft document is one person's private text and images. Installing one
 * after the window has moved to another account puts it in that account's
 * composer and, worse, gives its images a live root there - which is why no
 * amount of fencing at the byte layer is sufficient on its own.
 */
function applyStillOwned(
  applyOwner: string | null,
  document: DraftDocument,
): boolean {
  if (currentDraftBlobOwnerId() === applyOwner) return true;
  appLogger.warn("[draft-mirror] dropped an apply after an identity change", {
    draft: document.draftId,
  });
  return false;
}

/**
 * Pull this document's blobs into the local partition before it is applied.
 *
 * Extracted from `applyHostDocument` to keep it under the complexity ceiling,
 * and the three outcomes are its whole contract: `"abandoned"` when a newer
 * apply or an identity change has made this one moot, `"ingested"` when a stash
 * document was fully handled here, and `"continue"` when the caller should go
 * on applying.
 */
async function prefetchDocumentBlobs(
  document: DraftDocument,
  applySeq: number,
  applyOwner: string | null,
): Promise<"abandoned" | "ingested" | "continue"> {
  const client = sessionClients.get(document.ownerHostId);
  const hashes = blobHashesOfDocument(document);
  if (client === undefined || hashes.length === 0) return "continue";
  // ROOTED while this apply runs, and that is not belt and braces.
  //
  // A hash this partition already holds is a LOCAL hit: the read answers from
  // the store and nothing about that hit roots it. The document that will root
  // it is not installed yet - it is waiting for the slowest hash in the same
  // batch, which may be a host round trip - so between the two a sweep sees an
  // unreferenced hash, correctly calls it an orphan, and takes bytes this apply
  // is about to need. The apply then installs a document naming a digest whose
  // bytes it never re-writes.
  //
  // Held per hash as it resolves rather than per batch, so an early local hit
  // is covered for as long as its siblings run, and released on EVERY exit
  // below - after the install, so custody passes to the document's own root
  // with no gap.
  //
  // The id is minted per ACQUISITION and is deliberately not derived from the
  // document. Keying it by owner/draft/`applySeq` looked unique and was not:
  // `applySeq` advances only for a landing apply, so two revisions of one
  // composer row read concurrently under the SAME id, and the first to finish
  // released the second's holds along with its own. See
  // `mintPendingIngestHolderId`.
  const holderId = mintPendingIngestHolderId(
    `draft-mirror-prefetch:${document.ownerHostId}:${document.draftId}`,
  );
  for (const hash of hashes) holdPendingIngestImageHash(holderId, hash);
  try {
    const images = await readDraftBlobsIntoLocalStore(
      document.ownerHostId,
      client,
      hashes,
    );
    if (
      document.kind === "landing" &&
      cloudIngestSeqByDraft.get(document.draftId) !== applySeq
    ) {
      return "abandoned";
    }
    if (!applyStillOwned(applyOwner, document)) return "abandoned";
    rememberLandingBlobsOnHost(document.draftId, [...images.keys()]);
    if (document.kind === "stash-entry") {
      // `"abandoned"` for a conversion that installed nothing: the caller must
      // not go on to report the document as applied, and a stash row has no
      // landing/new-chat apply below to fall through to either.
      return (await convertStashDocument(document, images, applyOwner))
        ? "ingested"
        : "abandoned";
    }
    return "continue";
  } finally {
    releasePendingIngestImageHashes(holderId);
  }
}

/**
 * @returns whether a row actually took this document, and therefore whether
 * its hashes are now ROOTED. Every abandonment path answers `false`: a retired
 * draft, a pending submitted delete, a newer apply, an identity change, and -
 * since the revision fences landed - an older revision the store refuses.
 *
 * Callers that write bytes on the strength of this apply need that answer.
 * `putImageBytesAtHash` seeds a session entry which is itself a GC root, so
 * recovering images for a document no row took leaves them resident with
 * nothing to release them.
 */
async function applyHostDocument(
  document: DraftDocument,
  /**
   * Bytes for a STASH document's hashes, already fetched, or `null` when the
   * caller has none to offer.
   *
   * Non-null only on the cloud-ingest path, and the ordering is the whole
   * point: a stash row is CONVERTED into a closed start-page draft, and the
   * conversion writes its images into the landing partition as part of that
   * one operation - so bytes fetched AFTER the apply have nowhere to go. The
   * cloud caller therefore fetches first and hands them in here.
   *
   * The mirror path needs nothing: `prefetchDocumentBlobs` reads the owning
   * host's blobs and converts the row itself, answering `"ingested"` above.
   */
  stashImages: ReadonlyMap<string, ImageBlob> | null,
): Promise<boolean> {
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
  // The ACCOUNT this apply belongs to, captured before any await.
  //
  // Every fence below this line is about the DOCUMENT's freshness - a newer
  // apply, a routed delete, a retired row. None of them is about WHO the
  // document is for, and the blob read is not cancellable, so a sign-out or a
  // user switch during it left this continuation to install account A's
  // private draft under account B: its text in B's composer, and - the part
  // that defeats the byte-level fences entirely - a row that ROOTS A's images
  // in B's partition, so the GC keeps them and the retirement upstream is
  // undone by the very apply that follows it.
  //
  // A byte fence cannot answer this; only the apply can. Re-checked before
  // every side effect below rather than once here, because each of them is
  // past a different set of awaits.
  const applyOwner = currentDraftBlobOwnerId();
  if (rejectRetiredLandingDocument(document)) return false;
  if (composerSubmittedDraftDeleteIsPending(document.draftId)) {
    await retrySubmittedDraftDelete(document.draftId);
    return false;
  }
  const prefetched = await prefetchDocumentBlobs(
    document,
    applySeq,
    applyOwner,
  );
  if (prefetched === "abandoned") return false;
  // A stash row WAS converted into a landing draft, so its hashes are rooted.
  if (prefetched === "ingested") return true;
  if (!applyStillOwned(applyOwner, document)) return false;
  if (document.kind === "stash-entry") {
    return convertStashDocument(document, stashImages ?? new Map(), applyOwner);
  }
  if (document.kind === "interview") {
    applyInterviewHostDocument(document);
    return true;
  }
  if (document.kind === "landing") {
    // Re-checked after the blob reads: a delete routed meanwhile retired it.
    if (rejectRetiredLandingDocument(document)) return false;
    if (!applyStillOwned(applyOwner, document)) return false;
    // A re-key moves the row to this document's id; the row is live and its
    // hashes are rooted under the new identity.
    if (rekeyLandingTabInPlace(document)) return true;
    if (!applyLandingHostDocument(document, document.portable.content)) {
      return false;
    }
    inheritLandingTab(document);
    return true;
  }
  if (document.kind === "chat-composer") {
    return applyComposerHostDocument(document);
  }
  return applyNewChatHostDocument(document);
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
    // The host a write is sent to owns the row. Nothing else records it on
    // this plane - the upsert path only calls `rememberSynced`, never an
    // `applyUpsert` - so without this a modal that published normally kept
    // `ownerHostId: null`, and the drafts list lost the row the moment the
    // epic was unbound and the `newChatBoundHostId` fallback went with it.
    useNewConversationModalStore
      .getState()
      .setNewChatOwnerHostId(epicId, hostId);
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
  // Same signal, same reason, for the cloud payload read this host pipes.
  forgetCloudDraftPayloadUnsupportedHost(args.hostId);
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
  // Every cloud address remembered for this host names the requester of the
  // mirror that ingested it, and that mirror has just been replaced. The
  // ingest hook will not re-record them - an already-applied head stays in its
  // `ingested` set - so without this the registry keeps a closed requester
  // until a new head arrives or the tree remounts.
  rebindCloudDraftImageClientForHost(args.hostId, args.client);
  session.start();
  return session;
}

/**
 * The requester for a host this window currently holds a draft mirror on, or
 * `null`.
 *
 * The same map `applyHostDocument` consults before it fetches a document's
 * blobs, exposed so a READER can ask the same question. That equivalence is the
 * point: a host with no mirror session here is a host this window never
 * uploaded a draft blob to, so there is nothing for `drafts.readBlob` to find -
 * and a requester built some other way would be addressing a host whose draft
 * store this window has no relationship with.
 */
export function draftMirrorClientForHost(
  hostId: string | null,
): HostRequester<HostRpcRegistry> | null {
  if (hostId === null) return null;
  return sessionClients.get(hostId) ?? null;
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
      putDraftBlobs(hostId, client, hashes, currentDraftBlobOwnerId()).then(
        (confirmed) => {
          rememberLandingBlobsOnHost(draft.id, confirmed);
        },
      ),
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
  retiredStashIdsThisSession.clear();
  warnedUnboundComposer.clear();
  warnedUnboundInterview.clear();
  resetDraftBlobTransportForTests();
  resetCloudDraftImageRecoveryForTests();
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

/**
 * Send (or re-send) the pending delete/retract a submit or a drafts-list
 * delete recorded for `draftId`, through the session of the host its receipt
 * names. No session, no request - the receipt stays pending for whichever
 * session mounts next. Exported for the drafts list, whose rows belong to
 * composers that are not mounted: it fences the row exactly as submit does and
 * then needs that same receipt acted on.
 */
export async function retrySubmittedDraftDelete(
  draftId: string,
): Promise<void> {
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
  await applyHostDocument(document, null);
}

export async function ingestCloudDraftSummary(input: {
  readonly hostId: string;
  readonly summary: CloudChatSummary;
  readonly document: DraftDocument;
  /**
   * The account the head read was ISSUED under. See below: a continuation
   * cannot ask who it belongs to, it can only be told.
   */
  readonly readOwner: string | null;
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
  // The ACCOUNT this ingest belongs to. Taken from the CALLER, which captured
  // it when it issued the head read - reading it here would answer with
  // whoever holds the window now, which is the whole failure: a read that
  // started under A and finished under B would install A's text under B with
  // every check agreeing.
  const ingestOwner = input.readOwner;
  if (currentDraftBlobOwnerId() !== ingestOwner) return;
  // A stash row's bytes have to arrive WITH it. `ingestRemote` is idempotent
  // by entry id and the images ride the same durable write as the row, so
  // there is no second chance after the apply - which is why this fetch is
  // here rather than beside the landing/new-chat recovery below.
  //
  // Never fatal to the apply. A stash row that lands without its images is
  // exactly the status quo and still restores its text; a row that does not
  // land at all because a blob read failed would be a regression, so the
  // fetch answers with an empty map on every failure and the apply proceeds.
  // The KIND is checked here, synchronously, rather than inside the fetch.
  // `applyHostDocument` reserves the absence-sweep fence at its synchronous
  // start, so any await between this point and that call hands a concurrent
  // directory sweep a window in which the row is not yet fenced - and awaiting
  // an async function that returns immediately still yields a microtask, which
  // is enough. A landing or new-chat document therefore reaches the apply with
  // no suspension at all, exactly as before.
  //
  // A stash document does suspend, and may: the fence is landing-only, and a
  // stash row is not swept by the directory pass.
  const fetchesStashImages = input.document.kind === "stash-entry";
  const stashImages = fetchesStashImages
    ? await recoverCloudStashImages(input)
    : null;
  // Keyed on whether this SUSPENDED, not on what came back. The fetch answers
  // `null` for a stash document too - no hashes, no mounted client, a read that
  // threw - and every one of those still awaited, so every one of them still
  // needs the account re-asked before this document is applied.
  if (fetchesStashImages && currentDraftBlobOwnerId() !== ingestOwner) return;
  const installed = await applyHostDocument(input.document, stashImages);
  // No row took it, so this document roots nothing and there is nothing for
  // recovery to fetch FOR - whether it was retired, fenced by a pending
  // delete, beaten by a newer apply, refused as an older revision, or kept out
  // by a dirty local row. The owner re-check below covers only the last of
  // those, which is why it is not enough on its own.
  if (!installed) return;
  // An apply that abandoned installed no row, so this document roots nothing
  // and there is nothing for recovery to fetch FOR. Running it anyway is not
  // merely wasted: recording its sources spends slots in a shared, per-digest
  // candidate list and can evict the address of the account that IS being
  // served. `applyHostDocument` swallows its own abandonment, so the condition
  // is re-derived here rather than returned from it.
  if (currentDraftBlobOwnerId() !== ingestOwner) return;
  await recoverIngestedCloudDraftImages(input);
}

/**
 * Pull a cloud-ingested draft's images down from the published
 * `image-attachment` blobs, for the window that has no other source for them.
 *
 * This is the ONLY path where that can be true. A document that arrives on
 * `drafts.subscribe` came from a host this window holds a mirror on, so
 * `applyHostDocument` has already read its blobs off that host; a document that
 * arrives here is owned by a host this window is not mirroring, which is the
 * second-window and offline-owner case the replica exists for.
 *
 * Run AFTER the apply so the row already roots these hashes, and awaited rather
 * than detached so an ingest is one settled unit - nothing is gated on it, and
 * each read carries its own timeout, so awaiting costs a bounded wait on a
 * chain whose caller has already released its ingest guard.
 *
 * Landing and new-chat only. Stash entries also reach this function, and their
 * bytes are deliberately NOT recovered here: a stash row is converted into a
 * closed start-page draft, and `convertStashEntry` writes its images into the
 * landing partition as part of that one conversion - so bytes fetched after
 * the row lands have nowhere to go. Recovering them means handing an images
 * map to `convertStashDocument` BEFORE it applies, which is custody work of
 * its own.
 */
/**
 * Fetch a cloud-ingested STASH document's images, for handing to the apply.
 *
 * The stash twin of {@link recoverIngestedCloudDraftImages}, and it runs on the
 * other side of the apply for a reason the sibling's own comment gives: that
 * one writes into this window's image partition, where the APPLIED row is what
 * roots the hashes, so it must run after. A stash row is not applied as a row
 * at all - it is CONVERTED, and the conversion reads these bytes through the
 * map handed in - so for this kind "after the apply" is not late, it is never.
 *
 * The bytes still pass through the partition on the way: the cloud transfer
 * verifies each digest with `putImageBytesAtHash`, which is what makes a
 * returned byte string trustworthy, and that write seeds a session entry which
 * roots them meanwhile. Once the conversion has re-written them under their
 * landing hashes that first copy is incidental, and the sweep reclaims it on
 * its own schedule - the same
 * disposition any unrooted transfer gets.
 *
 * Answers an EMPTY map for every failure, including a fetch that raises: the
 * caller applies the document either way, and a stash entry whose images are
 * missing is the behaviour this replaces, not a new one.
 */
async function recoverCloudStashImages(input: {
  readonly hostId: string;
  readonly summary: CloudChatSummary;
  readonly document: DraftDocument;
}): Promise<ReadonlyMap<string, ImageBlob> | null> {
  const { document } = input;
  if (document.kind !== "stash-entry") return null;
  const hashes = blobHashesOfDocument(document);
  if (hashes.length === 0) return null;
  // The ingesting host's requester, for the reason the sibling states: the
  // cloud read is a byte pipe through whatever host this device runs.
  const client = sessionClients.get(input.hostId);
  if (client === undefined) return null;
  try {
    await recoverCloudDraftImages({
      identity: input.summary.identity,
      hostId: input.hostId,
      client,
      hashes,
    });
  } catch (error: unknown) {
    appLogger.warn("[draft-mirror] cloud stash image recovery failed", {
      error: describeLogError(error),
    });
    return null;
  }
  const images = new Map<string, ImageBlob>();
  for (const hash of hashes) {
    const bytes = await getImageBytes(hash);
    if (bytes === undefined) continue;
    // Sniffed from the BYTES, never from the document's `mimeType` attr, and
    // with NO fallback. The transport's readers answer `"image/png"` for bytes
    // that sniff to nothing, which suits the landing partition - it holds bytes,
    // not records - but the stash reads a blob back through
    // `isValidStashBlobRecord`, which requires the sniff to equal the stored
    // MIME and answers `corrupt` when it does not. A label this side cannot
    // justify is therefore a record that reads as damaged later, so it is not
    // minted at all.
    const mimeType = sniffImageMimeType(bytes);
    if (mimeType === null) continue;
    images.set(hash, { bytes, mimeType });
  }
  return images;
}

async function recoverIngestedCloudDraftImages(input: {
  readonly hostId: string;
  readonly summary: CloudChatSummary;
  readonly document: DraftDocument;
}): Promise<void> {
  const { document } = input;
  if (document.kind !== "landing" && document.kind !== "new-chat") return;
  const hashes = blobHashesOfDocument(document);
  if (hashes.length === 0) return;
  // The INGESTING host's requester: the cloud read is a byte pipe through
  // whatever host this device runs, and this is the one we know is mounted -
  // every site that runs the cloud ingest acquires this mirror alongside it.
  const client = sessionClients.get(input.hostId);
  if (client === undefined) return;
  // Contained at this boundary, not inside the recovery module, and the
  // asymmetry is deliberate. `useCloudDraftsIngest` calls this from a `void
  // attemptRead(0)` chain with no catch around the ingest, so ANY rejection
  // that reaches it is an unhandled rejection. Every failure the recovery can
  // actually produce is already answered as a miss, so this catches only a
  // fault nobody predicted - and it belongs here, where the consequence is,
  // rather than in the module, where swallowing would also hide it from that
  // module's own tests.
  await recoverCloudDraftImages({
    identity: input.summary.identity,
    hostId: input.hostId,
    client,
    hashes,
  }).catch((error: unknown) => {
    appLogger.warn("[draft-mirror] cloud draft image recovery failed", {
      error: describeLogError(error),
    });
  });
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

/**
 * Every composer DOCUMENT this coordinator mirrors: chat-composer draft rows and
 * new-conversation modal patches.
 *
 * ONE enumeration, two projections. The budget takes its usage sum over the root
 * union, so the set that contributes digests and the set that contributes
 * declared sizes have to be the same set - `landing-image-budget.ts` records a
 * period when they were not and what it cost. Two loops over the same two stores
 * would be that mismatch waiting to happen the first time one of them grows a
 * third store; one function that both sides read cannot drift.
 *
 * The prompt stash is deliberately NOT here. It keeps blob hashes, not
 * documents, so it has no `size` to declare and stays a root-only source below.
 */
function mirroredComposerContents(): ReadonlyArray<JsonContent> {
  const contents: JsonContent[] = [];
  for (const draft of Object.values(useComposerDraftStore.getState().drafts)) {
    if (draft === undefined) continue;
    contents.push(draft.content);
  }
  for (const patch of Object.values(
    useNewConversationModalStore.getState().draftPatchesByEpicId,
  )) {
    if (patch === undefined || patch.content === null) continue;
    contents.push(patch.content);
  }
  return contents;
}

registerExtraImageRootSource({
  hashes: () => {
    const hashes: string[] = [];
    for (const content of mirroredComposerContents()) {
      hashes.push(...blobHashesFromContent(content));
    }
    return hashes;
  },
});

/**
 * What those same documents DECLARE their images weigh.
 *
 * The root source above says a digest is protected; it cannot say how much it
 * weighs. `rootByteCost` answers that in three steps, and the STORE's
 * measurement covers every root whose bytes this window has held - which is the
 * whole of the paste case, and why sequential pastes into a chat composer are
 * already charged for the images sitting in it.
 *
 * The step it does not cover is a root this partition has NEVER held: a draft
 * mirrored from the host, or restored on a second machine, naming digests whose
 * bytes the recovery legs have not fetched yet. Unmeasured, undeclared and
 * absent from the partition, such a root prices at ZERO - and recovery then
 * writes those bytes in through `cloud-draft-image-recovery` /
 * `readDraftBlobsIntoLocalStore`, neither of which asks the budget for room.
 * The landing surface never had this hole, because `declaredSizeByHash` walks
 * landing drafts directly; this is the same reading for the two composer
 * surfaces that reach the budget only through this registration.
 *
 * `collectImageAtoms` rather than `blobHashesFromContent`, because this needs
 * the atom's `size` and not only its digest. A node declaring nothing
 * contributes 0, which `rootByteCost` treats as absent - "declares nothing" is
 * not "declares zero".
 */
registerExtraImageSizeSource({
  declaredSizes: () => {
    const sizeByHash = new Map<string, number>();
    for (const content of mirroredComposerContents()) {
      for (const atom of collectImageAtoms(content)) {
        if (atom.hash === null) continue;
        if (!sizeByHash.has(atom.hash)) {
          sizeByHash.set(atom.hash, atom.size ?? 0);
        }
      }
    }
    return sizeByHash;
  },
});

export type { DraftWrite };
