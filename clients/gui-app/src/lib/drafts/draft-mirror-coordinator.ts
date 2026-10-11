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
import type { ImageBytes } from "@/lib/attachments/image-bytes";
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
import { cloudDraftIdentityKey } from "./cloud-draft-identity";
import {
  forgetCloudDraftPayloadUnsupportedHost,
  rebindCloudDraftImageClientForHost,
  cloudDraftImageSourcesRecorded,
  recordCloudDraftImageSources,
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
 * takes the next one when its request is DISPATCHED. A row applied after
 * that (by another mount, through another host) is not absent from that
 * snapshot in any sense the snapshot can attest to.
 */
let cloudIngestSeq = 0;
const cloudIngestSeqByDraft = new Map<string, number>();
/**
 * The same ordering fence, reserved for every headed row a directory LISTS,
 * whichever host owns it and whether or not the walking mount applies it
 * (another mount is reading the head, it is settled, or it is this host's
 * own row, which another host's directory lists as foreign). Stamped at the
 * listing snapshot's DISPATCH position, never at the walk: a walk of a
 * cached snapshot can run after a newer request was dispatched, and a stamp
 * taken then would outrank that newer response's absence. Kept apart from
 * `cloudIngestSeqByDraft` because that map is also the apply's supersession
 * check: an apply abandons itself when the row's sequence moved under its
 * blob reads, which is right for a newer apply or a newer head's read and
 * wrong for a mount that merely walked a directory listing the row. The
 * sweep and the flush read the later of the two.
 */
const cloudSweepFenceByRow = new Map<string, number>();
/**
 * The same listing fence under the bare id, the later of every owner's: for
 * a mirror WITHOUT an owner, which the absence predicate treats as listed
 * under any owner, so a positive listing of the id by any owner must hold
 * an older snapshot's absence off it the same way.
 */
const cloudSweepFenceByDraftId = new Map<string, number>();

/**
 * The sweep fence is keyed by the ROW (owner plus id), not the bare id: cloud
 * ids are host-minted, so two owners can list the same id, and owner A's
 * listing must not keep owner B's absent mirror from being swept. The ingest
 * fence stays keyed by id because an apply is for whichever row the mirror
 * under that id is.
 */
function cloudSweepFenceKey(draftId: string, ownerHostId: string): string {
  // Encoded, not joined: the wire accepts any non-empty string for either
  // half, so no delimiter character is one a half cannot contain.
  return JSON.stringify([ownerHostId, draftId]);
}

/**
 * The later of the row's two fences for a mirror. A mirror with no owner is
 * treated as listed under any owner by the absence predicate, so its sweep
 * fence is the id's under any owner.
 */
function cloudDraftFenceSeq(
  draftId: string,
  ownerHostId: string | null,
): number {
  return Math.max(
    cloudIngestSeqByDraft.get(draftId) ?? 0,
    ownerHostId === null
      ? (cloudSweepFenceByDraftId.get(draftId) ?? 0)
      : (cloudSweepFenceByRow.get(cloudSweepFenceKey(draftId, ownerHostId)) ??
          0),
  );
}
/**
 * What this renderer knows about one foreign cloud draft row's head: the
 * `headSha256` it is reading or has settled, and for a settled landing head
 * the id of the mirror it installed, so the guard can tell when that mirror
 * has since left the store. One entry per row (`cloudDraftIdentityKey`); a
 * new head for the row overwrites the old one. A mirror's record ends with
 * the mirror; a settled record without one stays until the row's head
 * changes, so the map is bounded by the rows this renderer has ever been
 * shown, not by the directory's current size.
 */
type CloudDraftHeadRecord = {
  readonly headSha256: string | null;
  /**
   * The listing's `publishedAt` for that head: the server's publication
   * order for the row, which is the one ordering fact a listing carries
   * (`throughRecordSeq` is not one: a fork or a rewrite renumbers). Two
   * host-scoped directory caches can list successive heads of one row at
   * once, and a mount walking the older cache must neither read the older
   * head nor replace the record of the newer one. Never an authority
   * decision: the apply still refuses by revision.
   */
  readonly publishedAt: number | null;
  /** `reading`: a mount has the head read in flight; `settled`: decided. */
  readonly state: "reading" | "settled";
  readonly mirrorId: string | null;
  /**
   * The image hashes the installed document names. A mount on another host
   * that skips this head still registers its host as a source for them
   * (`noteCloudDraftHeadHost`), as its own ingest did when every mount read
   * every head: once the ingesting host's mirror is released its requester
   * is closed, and without this the images have no live source. Which hosts
   * ARE recorded is the image-source registry's to say
   * (`cloudDraftImageSourcesRecorded`), not this record's: the registry caps
   * the sources per hash and evicts the oldest, and a list kept here would
   * go on naming an evicted host as registered.
   */
  readonly imageHashes: readonly string[];
};
/** What a decided head is remembered with. */
type CloudDraftHeadSettlement = {
  readonly mirrorId: string | null;
  readonly imageHashes: readonly string[];
};
const SETTLED_WITHOUT_MIRROR: CloudDraftHeadSettlement = {
  mirrorId: null,
  imageHashes: [],
};
const cloudDraftHeadAbandonListeners = new Set<
  (summary: CloudChatSummary, cause: CloudDraftHeadAbandonCause) => void
>();
/**
 * Process-wide on purpose. The ingest hook used to keep this guard on its own
 * instance, and it is mounted by the landing page and again by every tab, so
 * each Task open re-read every foreign draft head through the host - about
 * sixty `api/chats/resolve` on an account with two hosts, queued ahead of the
 * chat the person was opening - and N tabs restored into one Task read every
 * head N times at once. A head is read once per renderer lifetime and again
 * only when its `headSha256` changes or the same digest is republished later,
 * when the sweep drops its mirror, when the mirror is gone from the store by
 * any other road, or when the one read in flight was torn down or gave up
 * (and then by one mount: the wake a teardown sends is taken after the
 * commit, so a delivery that re-runs every mount at once hands the reads to
 * the new runs, not down the chain of old ones).
 */
const cloudDraftHeads = new Map<string, CloudDraftHeadRecord>();
/**
 * The hosts whose mounts have shown each ROW, keyed as `cloudDraftHeads` is:
 * the host that ingested a head, and every host whose mount skipped or noted
 * one. They are the row's, not a head's or a record's, and they outlive both:
 * a mount whose host-scoped directory is cached at an older head runs no
 * note again until its next delivery, so every head of the row that settles
 * with images registers these hosts as sources for its hashes then, whatever
 * records were claimed, settled, released or abandoned in between (a stash
 * entry, converted before its head settles, asks one of them for the bytes
 * its reading host missed, `recoverCloudStashImages`). Whether a
 * host IS recorded for a hash is the registry's to say
 * (`cloudDraftImageSourcesRecorded`), and a host whose session is gone is
 * skipped at registration; this map only names who to ask for. Bounded by
 * the rows ever shown times the hosts on the account.
 */
const cloudDraftRowHosts = new Map<string, Set<string>>();

/** Remember `hostId` as a host of the row `key`; true when it was not yet. */
function rememberCloudDraftRowHost(key: string, hostId: string): boolean {
  const hosts = cloudDraftRowHosts.get(key);
  if (hosts === undefined) {
    cloudDraftRowHosts.set(key, new Set([hostId]));
    return true;
  }
  if (hosts.has(hostId)) return false;
  hosts.add(hostId);
  return true;
}
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
 * `applyHostDocument` read verified blobs through `readDraftBlobsIntoLocalStore`
 * before calling here. A full partition may have kept them ephemeral; the
 * conversion imports from this map under its own batch reservation.
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
  cloudSweepFenceByRow.clear();
  cloudSweepFenceByDraftId.clear();
  cloudDraftHeads.clear();
  cloudDraftRowHosts.clear();
  cloudDraftHeadAbandonListeners.clear();
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
  // re-ran this. Settled for this head: the decision is about the KIND, so
  // nothing a later mount could read would change it.
  if (draftKindIsHostBound(input.document.kind)) {
    settleCloudDraftHead(input.summary, SETTLED_WITHOUT_MIRROR);
    return;
  }
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
  // A head read under another account decides nothing about this one: the
  // claim is released, like every refusal about the moment, or a reader
  // that switched A -> B -> A would find its own stale claim and never ask.
  if (currentDraftBlobOwnerId() !== ingestOwner) {
    releaseCloudDraftHeadRead(input.summary);
    return;
  }
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
  if (fetchesStashImages && currentDraftBlobOwnerId() !== ingestOwner) {
    releaseCloudDraftHeadRead(input.summary);
    return;
  }
  // A newer head of the row claimed or installed while this read was in
  // flight (two host-scoped directory caches list successive heads at once).
  // The settle below would leave that record alone, but the apply has to be
  // refused too: a cloud document carries a synthetic revision, so the store
  // would take the older head over the newer one and the row would show it
  // for as long as the newer record stands.
  if (!cloudDraftHeadClaimStands(input.summary)) return;
  const installed = await applyHostDocument(input.document, stashImages);
  // What the guard remembers about this head. An installed landing head is
  // remembered WITH its mirror's id, so the record ends when that mirror
  // leaves the store. An installed new-chat or stash document has no mirror
  // the store can vouch for and is settled for this renderer: a patch the
  // user discards locally comes back on the next head, not the next mount
  // (stash already worked this way, `retiredStashIdsThisSession`). A landing
  // head refused because its id is RETIRED here is settled too (a landing
  // pending delete is such a retirement receipt). Every other refusal - a
  // newer apply, an identity that changed under the read, a dirty local row
  // - is about this moment, not this head, so the record is released and
  // the next mount asks again, as it always did.
  if (installed) {
    settleCloudDraftHead(input.summary, installedHeadSettlement(input));
  } else if (
    input.document.kind === "landing" &&
    landingDraftIsRetired(input.document.draftId)
  ) {
    settleCloudDraftHead(input.summary, SETTLED_WITHOUT_MIRROR);
  } else if (
    input.document.kind === "landing" &&
    !cloudIngestSeqByDraft.has(input.document.draftId)
  ) {
    // An absence sweep dropped the row while the apply waited on its images
    // (it removed the apply's reservation). A mount that lists the row again
    // skipped this head as already reading, so it is woken rather than left
    // until its next directory delivery.
    abandonCloudDraftHeadRead(input.summary, "released");
  } else {
    releaseCloudDraftHeadRead(input.summary);
  }
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
  if (currentDraftBlobOwnerId() === ingestOwner) {
    recoverIngestedCloudDraftImages(input);
  }
  // The ingesting host is a host of the ROW too: a later head of the row
  // installed through another host registers it for that head's images when
  // its directory is still cached at this one. Noted AFTER its own sources
  // are recorded above, so the note's registration for this head is the
  // registry's no-op; when the account moved and recovery was skipped, the
  // note still marks the host on the row and registers nothing.
  noteCloudDraftHeadHost(input.summary, input.hostId);
}

/**
 * Remember the published image addresses of a cloud-ingested draft without
 * pulling image bytes into this window during bootstrap.
 *
 * This is the ONLY path where that can be true. A document that arrives on
 * `drafts.subscribe` came from a host this window holds a mirror on, so
 * `applyHostDocument` has already read its blobs off that host; a document that
 * arrives here is owned by a host this window is not mirroring, which is the
 * second-window and offline-owner case the replica exists for.
 *
 * Run AFTER the apply so the row already roots these hashes. Visible-draft
 * idle prefetch and render/submit resolution use these addresses later.
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
 * The stash twin of {@link recoverIngestedCloudDraftImages} runs before apply:
 * a stash row is CONVERTED, and conversion needs its bytes in the handed map.
 *
 * The transfer verifies each digest. An unrooted stash hash stays ephemeral
 * until conversion admits it through the landing image budget.
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
  // One account check ahead of every record below: the registry refuses a
  // source from another account per record, with a line each, and a row of
  // an account this window no longer serves has nothing worth asking for.
  if (input.summary.identity.ownerUserId !== currentDraftBlobOwnerId()) {
    return null;
  }
  let recovered: ReadonlyMap<string, ImageBytes>;
  try {
    recovered = await recoverCloudDraftImages({
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
  // A byte the reading host's pipe missed is asked of another mounted host
  // of the row. A stash entry is converted before its head settles, and its
  // settlement keeps no image hashes, so the hosts whose mounts skipped
  // this head (`noteCloudDraftHeadHost` remembers them on the row) would
  // otherwise never be a source for it - and the conversion retires the
  // source row, so the miss would be for good. One host at a time, each
  // asked only for the hashes still missing, until nothing is missing or
  // the row's hosts are exhausted. A hash NO host of the row can serve ends
  // with the row's addresses recorded over an earlier draft's for the same
  // bytes (the registry keeps three per hash): accepted, since it takes
  // three mounted hosts, a shared hash, and that earlier draft's bytes
  // still readable where this row's are not, against a conversion that
  // would otherwise lose a recoverable image. Each pass is the registry's
  // own walk over every address it holds for the hash, so a later pass may
  // ask the reading host again for a hash it already missed: bounded by the
  // walk's attempt cap, and it loses nothing (the miss may have been a
  // transient of that pipe).
  let missing = hashes.filter((hash) => !recovered.has(hash));
  // The row's hosts are re-read before every turn, and each host's
  // requester is looked up as its turn comes, never ahead of the earlier
  // hosts' awaits: a mount that starts during the pass notes its host on
  // the row then and is asked too, and a session released and re-acquired
  // meanwhile has a new requester (the old one would be recorded over the
  // rebind and fail for nothing). A remembered host without a session is
  // not counted as asked, so one that mounts later in the pass gets its
  // turn.
  const asked = new Set<string>([input.hostId]);
  while (missing.length !== 0) {
    const fallback = nextStashImageFallbackHost(input.summary, asked);
    if (fallback === null) break;
    asked.add(fallback.hostId);
    try {
      const more = await recoverCloudDraftImages({
        identity: input.summary.identity,
        hostId: fallback.hostId,
        client: fallback.client,
        hashes: missing,
      });
      recovered = new Map([...recovered, ...more]);
      missing = missing.filter((hash) => !recovered.has(hash));
    } catch (error: unknown) {
      appLogger.warn(
        "[draft-mirror] cloud stash image recovery through another host failed",
        { error: describeLogError(error) },
      );
    }
  }
  const images = new Map<string, ImageBlob>();
  for (const hash of hashes) {
    const bytes = recovered.get(hash);
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

/**
 * The first host remembered on the row, in the order they were remembered,
 * that is not in `asked` and has a session mounted here, with the requester
 * it holds right now; `null` when there is none.
 */
function nextStashImageFallbackHost(
  summary: CloudChatSummary,
  asked: ReadonlySet<string>,
): { hostId: string; client: HostRequester<HostRpcRegistry> } | null {
  const key = cloudDraftIdentityKey(summary);
  for (const rowHostId of cloudDraftRowHosts.get(key) ?? []) {
    if (asked.has(rowHostId)) continue;
    const client = sessionClients.get(rowHostId);
    if (client !== undefined) return { hostId: rowHostId, client };
  }
  return null;
}

function recoverIngestedCloudDraftImages(input: {
  readonly hostId: string;
  readonly summary: CloudChatSummary;
  readonly document: DraftDocument;
}): void {
  const { document } = input;
  if (document.kind !== "landing" && document.kind !== "new-chat") return;
  const hashes = blobHashesOfDocument(document);
  if (hashes.length === 0) return;
  // The INGESTING host's requester: the cloud read is a byte pipe through
  // whatever host this device runs, and this is the one we know is mounted -
  // every site that runs the cloud ingest acquires this mirror alongside it.
  const client = sessionClients.get(input.hostId);
  if (client === undefined) return;
  // Already recorded when this host was on the row's host set at the settle
  // just above (it ingested an earlier head of the row); one record per host
  // per head, whichever path reaches the registry first.
  if (
    cloudDraftImageSourcesRecorded(input.summary.identity, input.hostId, hashes)
  ) {
    return;
  }
  recordCloudDraftImageSources({
    identity: input.summary.identity,
    hostId: input.hostId,
    client,
    hashes,
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

/**
 * A directory request's position in the ingest sequence, taken at its
 * dispatch. Fresh for every request, so two snapshots never share one: the
 * sweep fence a walk of the older snapshot reserves at that snapshot's
 * position must outrank only the requests dispatched before it.
 */
export function cloudDraftIngestSeq(): number {
  cloudIngestSeq += 1;
  return cloudIngestSeq;
}

/**
 * The row's identity plus the head it currently publishes: the key a mount
 * tracks its own in-flight reads under. `headSha256` is part of it because
 * the identity alone is stable across publishes: a newer head for the same
 * draft must be a new key, or the replica goes stale.
 */
export function cloudDraftHeadKey(summary: CloudChatSummary): string {
  return `${cloudDraftIdentityKey(summary)}:${summary.headSha256}`;
}

/**
 * Whether a mount may skip the head a directory row lists: another mount is
 * reading it now, or this renderer has settled it. A head settled with a
 * mirror id answers true only while that mirror is still in the landing
 * store; a mirror removed by any road ends the record, and the next mount
 * reads the head again. A record for a DIFFERENT head of the same row is not
 * this head's and answers false.
 */
export function cloudDraftHeadSettled(summary: CloudChatSummary): boolean {
  const key = cloudDraftIdentityKey(summary);
  const record = cloudDraftHeads.get(key);
  if (record === undefined) return false;
  if (record.headSha256 !== summary.headSha256) {
    // A listing older than the record is a stale cache, not a new head:
    // nothing to read, and the record stands.
    return listingIsOlderThanRecord(record, summary);
  }
  if (record.state === "reading") {
    advanceCloudDraftHeadStamp(key, record, summary);
    return true;
  }
  if (record.mirrorId === null) {
    // Settled WITHOUT a mirror: a terminal read refusal, a host-bound kind,
    // an installed new-chat or stash document. A later publication of the
    // same digest is a new fact about the row - the read's `unpublished` or
    // `missing` answer was a retraction the owner has since undone with the
    // same content - so the settlement does not carry over it: the head is
    // read again. An installed landing head below needs no re-read for
    // identical bytes; it only advances its stamp.
    if (listingIsLaterThanRecord(record, summary)) {
      cloudDraftHeads.delete(key);
      return false;
    }
    return true;
  }
  const mirrorId = record.mirrorId;
  const mirror = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === mirrorId);
  // Present AND this row's. Cloud ids are host-minted, so another owner's
  // row under the same id installs over this mirror's id; the record is
  // keyed per row and would otherwise keep answering "settled" for a mirror
  // that now shows the other owner's draft. An unowned mirror matches, as
  // the absence sweep's owner check has it.
  const present =
    mirror !== undefined &&
    (mirror.ownerHostId === null || mirror.ownerHostId === summary.ownerHostId);
  if (!present) {
    cloudDraftHeads.delete(key);
    return false;
  }
  advanceCloudDraftHeadStamp(key, record, summary);
  return true;
}

/**
 * The same digest listed again at a later publication time: a row that
 * published A, then B, then byte-identical A again. The content is settled,
 * but the record's order stamp must move to the republication, or a stale
 * cache delivering B afterwards reads as newer than the record and rolls
 * the mirror back to it.
 */
function advanceCloudDraftHeadStamp(
  key: string,
  record: CloudDraftHeadRecord,
  summary: CloudChatSummary,
): void {
  const publishedAt = laterPublication(record.publishedAt, summary.publishedAt);
  if (publishedAt === record.publishedAt) return;
  cloudDraftHeads.set(key, { ...record, publishedAt });
}

/**
 * Whether `summary` is a LATER publication of the same digest than the
 * record holds. Unknown on either side compares as not later.
 */
function listingIsLaterThanRecord(
  record: CloudDraftHeadRecord,
  summary: CloudChatSummary,
): boolean {
  return (
    record.headSha256 === summary.headSha256 &&
    publishedLaterThan(summary.publishedAt, record.publishedAt)
  );
}

/**
 * Whether `later` is a LATER publication time than `earlier`: the one rule
 * for "the same digest was republished since". Unknown on either side
 * compares as not later.
 */
function publishedLaterThan(
  later: number | null,
  earlier: number | null,
): boolean {
  return later !== null && earlier !== null && later > earlier;
}

/** The later of two publication times; an unknown side yields the other. */
function laterPublication(
  current: number | null,
  listed: number | null,
): number | null {
  if (current === null) return listed;
  if (listed === null) return current;
  return listed > current ? listed : current;
}

/**
 * Whether another mount of this renderer is reading the head a row lists
 * right now. A mount that skips such a head still reserves the row's SWEEP
 * fence on its walk, as every listed head is: the reader's apply must not
 * meet a replica this mount's absence sweep dropped in the meantime. The
 * ingest fence is the reader's own.
 */
export function cloudDraftHeadReading(summary: CloudChatSummary): boolean {
  const record = cloudDraftHeads.get(cloudDraftIdentityKey(summary));
  return (
    record !== undefined &&
    record.state === "reading" &&
    record.headSha256 === summary.headSha256
  );
}

/**
 * A mount is about to read this head: other mounts skip it from here on. One
 * record per row, so a read of a newer head displaces whatever the row held.
 */
export function beginCloudDraftHeadRead(summary: CloudChatSummary): void {
  const key = cloudDraftIdentityKey(summary);
  const current = cloudDraftHeads.get(key);
  // A read started from a stale listing must not displace the newer head's
  // record (the hook asks `cloudDraftHeadSettled` first and will not start
  // one; this holds for any caller).
  if (current !== undefined && listingIsOlderThanRecord(current, summary)) {
    return;
  }
  cloudDraftHeads.set(key, {
    headSha256: summary.headSha256,
    // A record of the SAME digest may already carry a later republication
    // stamp than the listing this read starts from; the stamp never moves
    // back.
    publishedAt:
      current !== undefined && current.headSha256 === summary.headSha256
        ? laterPublication(current.publishedAt, summary.publishedAt)
        : summary.publishedAt,
    state: "reading",
    mirrorId: null,
    imageHashes: [],
  });
}

/**
 * Whether `summary` lists an OLDER head of the row than `record` holds: a
 * different digest published earlier. Unknown on either side (an unpublished
 * row) compares as not older, which is the pre-existing behaviour: a
 * different digest is read.
 */
function listingIsOlderThanRecord(
  record: CloudDraftHeadRecord,
  summary: CloudChatSummary,
): boolean {
  return (
    record.headSha256 !== summary.headSha256 &&
    record.publishedAt !== null &&
    summary.publishedAt !== null &&
    summary.publishedAt < record.publishedAt
  );
}

/**
 * The mount that was reading this head is gone (its tile closed, its host or
 * scope changed) with the read undecided, or its read ran out of attempts.
 * The claim is released as {@link releaseCloudDraftHeadRead} does, and every
 * mount still listening is told, so one of them picks the head up now rather
 * than at its next directory delivery. A read that gave up wakes the others
 * because its failure is its host's: two mounts bound to different hosts read
 * through different byte pipes, and the directory has no polling interval to
 * bring the healthy one back on its own. The wake names its cause: a mount
 * that ran out of attempts on a publication ignores `exhausted` wakes for the
 * head while its run still lists that publication, until its next delivery
 * (its own wake, and a sibling's that met the same answer), so the head is
 * not traded between failing mounts at the ladder's pace, and takes a
 * `released` one (a sibling torn down with the head undecided),
 * because that sibling's leaving says nothing about whether the read would
 * succeed now. A read refused for the moment, or answered an ambiguous
 * identity, still releases silently ({@link releaseCloudDraftHeadRead}): the
 * other mount would meet the same answer.
 */
export function abandonCloudDraftHeadRead(
  summary: CloudChatSummary,
  cause: CloudDraftHeadAbandonCause,
): void {
  const key = cloudDraftIdentityKey(summary);
  const record = cloudDraftHeads.get(key);
  if (
    record === undefined ||
    record.state !== "reading" ||
    record.headSha256 !== summary.headSha256
  ) {
    return;
  }
  cloudDraftHeads.delete(key);
  notifyCloudDraftHeadAbandoned(summary, cause);
}

/**
 * Why a head's reader let it go: `exhausted` when its read ran out of
 * attempts, `released` when the mount was torn down with the read undecided
 * or its refusal answered for a publication the record had moved past
 * ({@link settleCloudDraftHeadWithoutApply}).
 */
export type CloudDraftHeadAbandonCause = "exhausted" | "released";

/**
 * Tell every listening mount a head needs a reader now, and why its last
 * reader let it go. Each one reads what its own directory lists under the
 * head's key, after asking the guard.
 */
function notifyCloudDraftHeadAbandoned(
  summary: CloudChatSummary,
  cause: CloudDraftHeadAbandonCause,
): void {
  for (const listener of [...cloudDraftHeadAbandonListeners]) {
    listener(summary, cause);
  }
}

/** Hear every {@link abandonCloudDraftHeadRead}; returns the unsubscribe. */
export function subscribeCloudDraftHeadAbandoned(
  listener: (
    summary: CloudChatSummary,
    cause: CloudDraftHeadAbandonCause,
  ) => void,
): () => void {
  cloudDraftHeadAbandonListeners.add(listener);
  return () => {
    cloudDraftHeadAbandonListeners.delete(listener);
  };
}

/**
 * A mount on `hostId` skipped this head: register that host's requester as a
 * source for the head's images, once per host, if its mirror session is
 * mounted. Before the coordinator held the record, that mount's own ingest
 * did this; a window whose only mounted session is on another host than the
 * one that ingested the head would otherwise have no live source for those
 * images once the ingesting host's session is released. A head still being
 * read keeps the host on its record and registers it when the read settles:
 * nothing calls this again for that mount until its next directory
 * delivery, and the ingesting mount can be gone by then.
 */
export function noteCloudDraftHeadHost(
  summary: CloudChatSummary,
  hostId: string,
): void {
  const key = cloudDraftIdentityKey(summary);
  // A host of the row from here on, whatever the record does: every head of
  // the row that settles with images registers it then.
  rememberCloudDraftRowHost(key, hostId);
  const record = cloudDraftHeads.get(key);
  if (record === undefined || record.state === "reading") return;
  // Registered now for the head the record holds when that is the head the
  // guard skipped: this very digest, or a STALE listing of the row (an older
  // head, from a host-scoped directory cache not yet refreshed) that the
  // guard answered as settled because the record holds a newer one. A
  // listing of a newer head than the record's is read, never noted.
  if (
    record.headSha256 !== summary.headSha256 &&
    !listingIsOlderThanRecord(record, summary)
  ) {
    return;
  }
  registerCloudDraftHeadHost(key, summary.identity, hostId);
}

/**
 * Record `hostId`'s requester as a source for the settled head's images, if
 * the head names any, the registry does not already hold this host for all
 * of them, the host's session is mounted and the account is still served. A
 * host not recorded here is recorded by a later {@link noteCloudDraftHeadHost}
 * once it can be, and one the registry evicts since (it keeps three hosts per
 * hash) is recorded again by the next walk, because the registry is asked
 * each time rather than a list kept here.
 */
function registerCloudDraftHeadHost(
  key: string,
  identity: CloudChatSummary["identity"],
  hostId: string,
): void {
  // The record is the row's (the key names it), and its images are the ones
  // this host is a source for, whichever head the caller's listing named.
  const record = cloudDraftHeads.get(key);
  if (
    record === undefined ||
    record.state !== "settled" ||
    record.imageHashes.length === 0 ||
    cloudDraftImageSourcesRecorded(identity, hostId, record.imageHashes)
  ) {
    return;
  }
  const client = sessionClients.get(hostId);
  if (client === undefined) return;
  // The registry refuses a source for an account this window no longer
  // serves (a cached directory rendered across a switch), and its refusal
  // is what the next walk's query sees, so the account's return registers
  // the host then.
  if (identity.ownerUserId !== currentDraftBlobOwnerId()) return;
  recordCloudDraftImageSources({
    identity,
    hostId,
    client,
    hashes: record.imageHashes,
  });
}

function imageHashesOfDocument(document: DraftDocument): readonly string[] {
  if (document.kind !== "landing" && document.kind !== "new-chat") return [];
  return blobHashesOfDocument(document);
}

/**
 * The read of this head ended without a decision and without a wake: an
 * apply refused for a reason about the moment, or an ambiguous identity,
 * which another mount asking now would meet too; the mounts that skipped the
 * head hold neither a record nor a key for it and ask again at their next
 * directory delivery. A reader torn down or out of attempts goes through
 * {@link abandonCloudDraftHeadRead} instead.
 * Only a record still READING this head is dropped: a decision another
 * mount reached in the meantime, or a newer head's read, stays. The claim is
 * identified by row and digest, not by the mount that made it, so a release
 * from a torn-down continuation can drop another mount's live read of the
 * same head; that mount's next attempt claims the head again when it finds
 * nobody holding it (the ingest hook's retry), and otherwise the cost is one
 * duplicate read by a third mount.
 */
export function releaseCloudDraftHeadRead(summary: CloudChatSummary): void {
  const key = cloudDraftIdentityKey(summary);
  const record = cloudDraftHeads.get(key);
  if (
    record !== undefined &&
    record.state === "reading" &&
    record.headSha256 === summary.headSha256
  ) {
    cloudDraftHeads.delete(key);
  }
}

/**
 * The read answered a settled refusal - unpublished, corrupt, needs a newer
 * app, the wrong owner - which is terminal for THIS head: a head that later
 * publishes arrives under a new `headSha256`. Without this record the row
 * was resolved again on every mount, forever, which for an app older than the
 * heads it is shown was the whole fan-out over again.
 */
export function settleCloudDraftHeadWithoutApply(
  summary: CloudChatSummary,
): void {
  const key = cloudDraftIdentityKey(summary);
  const current = cloudDraftHeads.get(key);
  // The refusal answers for the publication the read STARTED from. A record
  // advanced to a later republication of the same digest while that read was
  // in flight (A at 5 retracted and republished unchanged at 9, with a
  // directory listing 9 answered first) must not take the refusal as the
  // republication's: it is the one exception to the stamp never moving back,
  // because the later stamp was a fact about a listing nobody has read. The
  // record settles the publication it answered for, and the mounts listing
  // the republication are woken to read it now, as after an abandoned read;
  // their walk finds the same digest listed later than the record and reads
  // it, while the mount whose listing was refused finds it settled.
  if (
    current !== undefined &&
    current.state === "reading" &&
    current.headSha256 === summary.headSha256 &&
    recordIsLaterThanListing(current, summary)
  ) {
    cloudDraftHeads.set(key, {
      headSha256: summary.headSha256,
      publishedAt: summary.publishedAt,
      state: "settled",
      mirrorId: null,
      imageHashes: [],
    });
    notifyCloudDraftHeadAbandoned(summary, "released");
    return;
  }
  settleCloudDraftHead(summary, SETTLED_WITHOUT_MIRROR);
}

/**
 * Whether the record names a LATER publication of the same digest than the
 * listing a read started from. Unknown on either side compares as not later.
 */
function recordIsLaterThanListing(
  record: CloudDraftHeadRecord,
  summary: CloudChatSummary,
): boolean {
  return (
    record.headSha256 === summary.headSha256 &&
    publishedLaterThan(record.publishedAt, summary.publishedAt)
  );
}

/**
 * What an INSTALLED head is remembered with: a landing head with its mirror's
 * id (the record ends when that mirror leaves the store) and the image hashes
 * the document names. Which hosts are sources for them is the registry's
 * record: `recoverIngestedCloudDraftImages` records the ingesting host when
 * it can, and `noteCloudDraftHeadHost` asks the registry before recording
 * another.
 */
function installedHeadSettlement(input: {
  readonly summary: CloudChatSummary;
  readonly document: DraftDocument;
}): CloudDraftHeadSettlement {
  return {
    mirrorId:
      input.document.kind === "landing" ? input.summary.identity.chatId : null,
    imageHashes: imageHashesOfDocument(input.document),
  };
}

/**
 * Whether this read's head is still the one the row's record names: no
 * record (released or abandoned, and nothing newer claimed), or a record for
 * this very digest. A record for another digest means a newer head was
 * claimed or installed since this read began.
 */
function cloudDraftHeadClaimStands(summary: CloudChatSummary): boolean {
  const record = cloudDraftHeads.get(cloudDraftIdentityKey(summary));
  return record === undefined || record.headSha256 === summary.headSha256;
}

/**
 * Guarded by the head: a record for ANOTHER head of the row is left alone.
 * Two host-scoped directories can list successive heads for one row at
 * once, and a read of the older head that completes after the newer head
 * was claimed or installed must not replace that record, or the next mount
 * reads the newer head again. A row with no record is settled as asked.
 */
function settleCloudDraftHead(
  summary: CloudChatSummary,
  settlement: CloudDraftHeadSettlement,
): void {
  const key = cloudDraftIdentityKey(summary);
  const current = cloudDraftHeads.get(key);
  if (current !== undefined && current.headSha256 !== summary.headSha256) {
    return;
  }
  cloudDraftHeads.set(key, {
    headSha256: summary.headSha256,
    // The read may have started from an earlier listing of a digest whose
    // record was since advanced to a republication; keep the later stamp.
    publishedAt:
      current === undefined
        ? summary.publishedAt
        : laterPublication(current.publishedAt, summary.publishedAt),
    state: "settled",
    mirrorId: settlement.mirrorId,
    imageHashes: settlement.imageHashes,
  });
  // The row's hosts register as sources now that this head's images are
  // known (a no-op for a host the registry already holds, and for a head
  // without images).
  const hosts = cloudDraftRowHosts.get(key);
  if (hosts !== undefined) {
    for (const hostId of hosts) {
      registerCloudDraftHeadHost(key, summary.identity, hostId);
    }
  }
}

/** Forget every head whose mirror is one of `draftIds`. */
function forgetCloudDraftHeadsOfMirrors(draftIds: ReadonlySet<string>): void {
  for (const [key, record] of cloudDraftHeads) {
    if (record.mirrorId !== null && draftIds.has(record.mirrorId)) {
      cloudDraftHeads.delete(key);
    }
  }
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
 * Reserve the absence-sweep fence for a headed row a directory lists, at
 * that directory's dispatch position (`listedAtSeq`, the snapshot's
 * `fenceSeq`). A positive listing has to order against older snapshots (a
 * later-dispatched response that lists the row can run before an
 * earlier-dispatched one that omits it) and must NOT outrank a newer one (a
 * walk of a cached snapshot can run after a newer request was dispatched,
 * and that response's absence is the later fact), so the stamp is the
 * listing's own position, never the walk's, and never moves back. This
 * reservation must not supersede an apply of the row that another mount has
 * in flight, which {@link reserveCloudDraftIngestFence} would: it keeps its
 * own map, keyed by the row (owner plus id), so one owner's listing protects
 * only its own mirror - and, under the bare id, a mirror without an owner,
 * which the absence predicate treats as listed under any owner.
 */
export function reserveCloudDraftSweepFence(
  draftId: string,
  ownerHostId: string,
  listedAtSeq: number,
): void {
  const key = cloudSweepFenceKey(draftId, ownerHostId);
  const current = cloudSweepFenceByRow.get(key) ?? 0;
  if (listedAtSeq > current) cloudSweepFenceByRow.set(key, listedAtSeq);
  const currentById = cloudSweepFenceByDraftId.get(draftId) ?? 0;
  if (listedAtSeq > currentById) {
    cloudSweepFenceByDraftId.set(draftId, listedAtSeq);
  }
}

/**
 * Drop local mirrors of cloud rows a settled directory no longer lists.
 * `fenceSeq` is the position that directory's request took when it was
 * dispatched: a row ingested, or listed by a later-dispatched directory,
 * since then is kept. A replica qualifies once clean. An OWN row
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
  const dropped = dropForeignLandingMirrorsAbsent(hostId, listed, (draft) => {
    if (cloudDraftFenceSeq(draft.id, draft.ownerHostId) > fenceSeq) {
      return false;
    }
    if (draft.origin === "replica") return true;
    // A row with no recorded publication state is treated as unpublished.
    return (
      draft.publication !== null &&
      draft.publication.status !== "unpublished" &&
      draft.adoption.state === "adopted" &&
      !sessions.has(draft.adoption.hostId)
    );
  });
  // A dropped mirror's head is no longer settled here: the same head listed
  // again later (a row that reappears) is read and applied again.
  // An apply of the row still parked on its blob reads started before this
  // directory was dispatched, so it is superseded too, or it would install
  // the row the directory just removed: its reservation goes, which is also
  // how its ingest tells this refusal from the others
  // (`ingestCloudDraftSummary`). Removed rather than advanced, so the row's
  // fence is what it would be had the apply never run.
  for (const id of dropped) cloudIngestSeqByDraft.delete(id);
  if (dropped.length > 0) forgetCloudDraftHeadsOfMirrors(new Set(dropped));
  return dropped;
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
    if (cloudDraftFenceSeq(draft.id, draft.ownerHostId) > fenceSeq) continue;
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
 * absent from the partition, such a root prices at ZERO. Both the cloud and
 * host recovery readers now reserve residency before writing those bytes;
 * this declaration lets that reservation account for a restored root.
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
