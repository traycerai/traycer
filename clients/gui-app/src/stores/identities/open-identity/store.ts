/**
 * One OPEN IDENTITY's runtime: the index lane, the body lanes and the body
 * tier composed into a Zustand store the surface reads.
 *
 * The reduced counterpart of `open-epic/store.ts`. It runs on the main thread
 * rather than in a worker - an identity is a handful of small markdown files,
 * and the worker relocation exists for canvas-sized epics - but the SEAMS are
 * the shared ones (`LaneAdapter`, `AdapterHost`, `ReplicaApplyOutcome`), so
 * nothing about the wire is decided here. When T5's host lands, this store
 * needs no change: the stream-client factories it is given are the real
 * `IdentityStateStreamClient` / `IdentityFileStreamClient` in production and
 * fakes in tests, and both drive the same adapters.
 *
 * ## The state lane owns the epoch; bodies follow it
 *
 * `agentIdentity.file.subscribe` requires an `authorityEpoch` on its open
 * request and the only place to learn one is the index lane's snapshot. So
 * every body lane reads the epoch LIVE off the state replica, and every
 * replica change runs `lanes.syncToAuthorityEpoch()` - which is how a body
 * leased before the first snapshot opens by itself once the epoch lands.
 *
 * ## Replacement is decided once, here
 *
 * Both the state adapter (a snapshot with `basis: "authorityEpochChanged"`)
 * and any body adapter (`staleAuthorityEpoch`) can discover that the authority
 * moved, and both report it through `requestReplacement` with the SAME
 * transition token. The store coalesces on the token, resets the replica,
 * detaches every body, and re-subscribes the index lane cold - after which the
 * new snapshot names the new epoch and the demanded bodies reopen under it.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  AdapterStatus,
  DocReplicaEvent,
  ReplicaReplacementReason,
  ReplicaTransitionToken,
  RuntimeEnvironment,
  SeedTrust,
} from "@traycer-clients/shared/replica-runtime";
import {
  authorityEpochTransition,
  sessionKeyOf,
} from "@traycer-clients/shared/replica-runtime";
import type {
  IdentityFileStreamClientFactory,
  IdentityStateStreamClientFactory,
} from "@traycer-clients/shared/identity-lanes";
import { createIdentityStateLaneAdapter } from "@traycer-clients/shared/identity-lanes";
import type { IdentityRecordFields } from "@traycer-clients/shared/identity-lanes";
import { isMethodIncompatibleClose } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import { createIdentityStateReplica } from "./identity-state-replica";
import { createIdentityBodyLanes } from "./identity-body-lanes";
import {
  createIdentityBodyTier,
  identityBodyHolderId,
  type IdentityBodyBudgetSink,
} from "./identity-body-tier";
import {
  AWAITING_SEED_AVAILABILITY,
  EMPTY_ARRAY,
  EMPTY_IDENTITY_DOCUMENTS_SLICE,
  EMPTY_IDENTITY_FILES_SLICE,
  type IdentityConnectionState,
  type IdentityDocumentsSlice,
  type IdentityFileBodyAvailability,
  type IdentityFilesSlice,
  type IdentityShardState,
} from "./types";

export interface OpenIdentityState {
  readonly identity: IdentityRecordFields | null;
  readonly documents: IdentityDocumentsSlice;
  readonly files: IdentityFilesSlice;
  /** Shard room id → state, replaced wholesale on every report. */
  readonly shards: Readonly<Record<string, IdentityShardState>>;
  readonly trust: SeedTrust | null;
  readonly connection: IdentityConnectionState;
  /** Whether the first index snapshot has landed. */
  readonly hydrated: boolean;
  /**
   * Bumped whenever a body's doc identity, availability or dirtiness changes,
   * so a selector reading a body through the handle's imperative getters
   * re-runs. The docs themselves are not store state - a `Y.Doc` is mutable
   * and a Zustand slice is not.
   */
  readonly bodyRevision: number;
  readonly bodyAvailabilityByPath: Readonly<
    Record<string, IdentityFileBodyAvailability | undefined>
  >;
  readonly dirtyPaths: readonly string[];
}

export interface OpenIdentityStoreHandle {
  readonly hostId: string;
  readonly identityId: string;
  readonly store: UseBoundStore<StoreApi<OpenIdentityState>>;
  /**
   * Hold a body open. Returns the release. Ref-counted: the doc and its lane
   * live until the last holder releases.
   */
  acquireFileBodyLease(path: string): () => void;
  /** The live fragment for a leased markdown file, or `null` until seeded. */
  getFileFragment(path: string): Y.XmlFragment | null;
  getFileDoc(path: string): Y.Doc | null;
  getFileAwareness(path: string): Awareness | null;
  getFileBodyAvailability(path: string): IdentityFileBodyAvailability;
  /** Is the document at `path` still leased and holding a live doc? For tests. */
  attachedBodyPaths(): readonly string[];
  closeTransport(): void;
  openTransport(): void;
  dispose(): void;
}

export interface OpenIdentityStoreSources {
  readonly hostId: string;
  readonly identityId: string;
  readonly environment: RuntimeEnvironment;
  readonly stateStreamClientFactory: IdentityStateStreamClientFactory;
  readonly fileStreamClientFactory: IdentityFileStreamClientFactory;
  readonly getCurrentUserId: () => string | null;
  /** The process memory runtime, or `null` in tests that do not model it. */
  readonly memory: ProcessMemoryRuntime | null;
}

function shardsRecord(
  shards: readonly { shardRoomId: string; state: IdentityShardState }[],
): Readonly<Record<string, IdentityShardState>> {
  const record: Record<string, IdentityShardState> = {};
  for (const shard of shards) record[shard.shardRoomId] = shard.state;
  return record;
}

export function createOpenIdentityStore(
  sources: OpenIdentityStoreSources,
): OpenIdentityStoreHandle {
  const {
    hostId,
    identityId,
    environment,
    stateStreamClientFactory,
    fileStreamClientFactory,
    getCurrentUserId,
    memory,
  } = sources;

  let disposed = false;
  const isDisposed = (): boolean => disposed;
  const runtimeToken = memory === null ? "0" : memory.nextRuntimeToken();
  const budgetTierKey = sessionKeyOf([
    "identity",
    hostId,
    identityId,
    runtimeToken,
  ]);

  const store = create<OpenIdentityState>()(() => ({
    identity: null,
    documents: EMPTY_IDENTITY_DOCUMENTS_SLICE,
    files: EMPTY_IDENTITY_FILES_SLICE,
    shards: {},
    trust: null,
    connection: "connecting",
    hydrated: false,
    bodyRevision: 0,
    bodyAvailabilityByPath: {},
    dirtyPaths: EMPTY_ARRAY,
  }));

  // ── Index lane ────────────────────────────────────────────────────────

  const replica = createIdentityStateReplica({
    getCurrentUserId,
    isDisposed,
    onChanged: () => publishSlices(),
  });

  /**
   * The incarnation last seen per document path, so a recreated file at a
   * path a body lane is serving is noticed here (finding 2): the epoch does
   * not move for path reuse, so nothing else would reopen the lane.
   */
  const incarnationByPath = new Map<string, string>();

  function noteIncarnations(documents: IdentityDocumentsSlice): void {
    const changed: string[] = [];
    for (const path of documents.allPaths) {
      const incarnation = documents.byPath[path]?.incarnation;
      if (incarnation === undefined) continue;
      const previous = incarnationByPath.get(path);
      incarnationByPath.set(path, incarnation);
      if (previous !== undefined && previous !== incarnation)
        changed.push(path);
    }
    for (const path of Array.from(incarnationByPath.keys())) {
      if (documents.byPath[path] === undefined) incarnationByPath.delete(path);
    }
    for (const path of changed) lanes.reopen(path);
  }

  function publishSlices(): void {
    if (disposed) return;
    const slices = replica.slices();
    store.setState({
      identity: slices.identity,
      documents: slices.documents,
      files: slices.files,
      shards: shardsRecord(replica.shards()),
      trust: replica.trust(),
      hydrated: replica.authorityEpoch() !== null,
    });
    // Bodies leased before the epoch was known open here; bodies built under
    // a superseded epoch are rebuilt here. Cheap when nothing moved.
    lanes.syncToAuthorityEpoch();
    noteIncarnations(slices.documents);
  }

  const stateAdapter = createIdentityStateLaneAdapter({
    identityId,
    streamClientFactory: stateStreamClientFactory,
    readAppliedCursor: () => replica.appliedCursor(),
    isDisposed,
  });

  /**
   * The transition currently being rebuilt for, so two lanes reporting one
   * epoch change coalesce into a single replacement instead of racing two.
   */
  let replacingFor: ReplicaTransitionToken | null = null;

  function requestReplacement(
    reason: ReplicaReplacementReason,
    transition: ReplicaTransitionToken,
  ): void {
    if (disposed) return;
    if (replacingFor === transition) return;
    replacingFor = transition;
    environment.logger.debug("open-identity: replacing replica", {
      identityId,
      reason,
      transition,
    });
    // Bodies first: every open body lane was attached under the epoch being
    // replaced and will be refused terminally. Demand survives `detachAll`,
    // so the next snapshot's `syncToAuthorityEpoch` reopens them.
    lanes.detachAll("superseded");
    replica.reset({ origin: "authority", reason });
    // Close BEFORE the reset is observable to the resume provider and open
    // AFTER: the re-subscribe reads `appliedCursor`, which is now `null`, so
    // the host answers with a cold snapshot naming the epoch it serves.
    stateAdapter.closeTransport();
    stateAdapter.openTransport();
  }

  function noteConnection(status: AdapterStatus): void {
    if (disposed) return;
    if (isMethodIncompatibleClose(status.closeReason)) {
      // The host does not serve this method at all. Terminal for the session:
      // nothing re-dials, and the surface renders the family as absent.
      store.setState({ connection: "unsupported" });
      lanes.detachAll("disposed");
      return;
    }
    if (store.getState().connection === "unsupported") return;
    store.setState({ connection: status.connection });
    lanes.noteTransportStatus(status.connection);
    if (status.connection === "open") tier.flushPending();
  }

  // ── Bodies ────────────────────────────────────────────────────────────

  const tier = createIdentityBodyTier({
    hostId,
    identityId,
    runtimeToken,
    send: (request) =>
      request.kind === "update"
        ? lanes.sendUpdate(request.path, request.update)
        : lanes.sendAwareness(request.path, request.frame),
    canSendBodyWrites: () =>
      !disposed && store.getState().connection === "open",
    onChanged: (path) => publishBody(path),
    isDisposed,
    budget: budgetSinkFor(memory),
  });

  function budgetSinkFor(
    runtime: ProcessMemoryRuntime | null,
  ): IdentityBodyBudgetSink | null {
    if (runtime === null) return null;
    return {
      settle: (holderId, bytes) =>
        runtime.hotDocs.settle(runtime.accountant, holderId, bytes),
      chargeProvisional: (holderId, bytes) =>
        runtime.hotDocs.chargeProvisional(runtime.accountant, holderId, bytes),
      release: (holderId) =>
        runtime.hotDocs.release(runtime.accountant, holderId),
    };
  }

  if (memory !== null) {
    // Every body this tier holds is leased - it exists only while an editor
    // shows it - so an eviction pass can reclaim nothing here and is told so
    // as protected bytes rather than answered with a demotion that frees
    // nothing.
    memory.hotDocs.attach({
      key: budgetTierKey,
      materializedIds: () =>
        tier
          .materializedPaths()
          .map((path) =>
            identityBodyHolderId(hostId, identityId, runtimeToken, path),
          ),
      demoteColdestUnpinned: () => ({
        reclaimedBytes: 0,
        deferredBytes: 0,
        protectedBytesByKind: [
          {
            kind: "leased",
            bytes: tier
              .materializedPaths()
              .reduce((sum, path) => sum + tier.chargedBytes(path), 0),
          },
        ],
      }),
    });
  }

  /**
   * Paths whose last VIEW is gone but whose lane is kept open because the
   * tier still retains edits no lane could carry (finding 1). The lane is the
   * only way those bytes reach the host; demand is released the moment the
   * tier reports them flushed.
   */
  const retainedForFlush = new Set<string>();

  function releaseLaneIfFlushed(path: string): void {
    if (!retainedForFlush.has(path)) return;
    if (tier.hasPendingBytes(path)) return;
    retainedForFlush.delete(path);
    lanes.release(path, "disposed");
  }

  function publishBody(path: string): void {
    if (disposed) return;
    releaseLaneIfFlushed(path);
    const state = store.getState();
    const availability = tier.availability(path);
    const dirty = tier.isDirty(path);
    const wasDirty = state.dirtyPaths.includes(path);
    let dirtyPaths = state.dirtyPaths;
    if (dirty !== wasDirty) {
      dirtyPaths = dirty
        ? [...state.dirtyPaths, path]
        : state.dirtyPaths.filter((held) => held !== path);
    }
    const held = state.bodyAvailabilityByPath[path];
    const bodyAvailabilityByPath =
      held === availability
        ? state.bodyAvailabilityByPath
        : { ...state.bodyAvailabilityByPath, [path]: availability };
    store.setState({
      bodyRevision: state.bodyRevision + 1,
      bodyAvailabilityByPath,
      dirtyPaths: dirtyPaths.length === 0 ? EMPTY_ARRAY : dirtyPaths,
    });
  }

  function onBodyEvent(event: DocReplicaEvent): void {
    switch (event.kind) {
      case "doc-snapshot":
        tier.applySnapshot({
          path: event.docId,
          docGuid: event.docGuid,
          update: event.update,
          hostStateVectorBase64: event.hostStateVectorBase64,
          seed: event.seed,
        });
        return;
      case "doc-update":
        tier.applyUpdate(event.docId, event.docGuid, event.update);
        return;
      case "doc-coverage-ack":
        tier.applyCoverage(
          event.docId,
          event.docGuid,
          event.coverageStateVectorBase64,
        );
        return;
      case "doc-awareness":
        tier.applyAwareness(event.docId, event.frame);
        return;
      case "doc-ready":
        tier.markReady(event.docId);
        return;
      case "doc-unavailable":
        tier.markUnavailable(
          event.docId,
          event.code,
          event.terminal,
          event.reason,
        );
        return;
    }
  }

  const lanes = createIdentityBodyLanes({
    identityId,
    environment,
    streamClientFactory: fileStreamClientFactory,
    readAuthorityEpoch: () => replica.authorityEpoch(),
    readDocSeed: (path) => tier.seedOffer(path),
    isDisposed,
    onBodyEvent,
    onReplacementRequested: requestReplacement,
    onLaneUnsupported: () =>
      noteConnection({ connection: "closed", closeReason: null }),
  });

  // ── Attach ────────────────────────────────────────────────────────────

  stateAdapter.attach({
    environment,
    emit: (event) => {
      const outcome = replica.apply(event);
      if (outcome.kind === "requires-replacement") {
        const epoch =
          event.kind === "record-transaction"
            ? event.cursor.authorityEpoch
            : replica.authorityEpoch();
        requestReplacement(
          outcome.reason,
          authorityEpochTransition(epoch ?? ""),
        );
      }
    },
    reportResume: (outcome) => {
      // A lead frame arrived: whatever replacement was in flight is done, and
      // the next epoch change must be able to start a new one.
      replacingFor = null;
      environment.logger.debug("open-identity: resume", {
        identityId,
        outcome: outcome.kind,
      });
    },
    reportStatus: noteConnection,
    requestReplacement,
  });

  return {
    hostId,
    identityId,
    store,

    acquireFileBodyLease(path): () => void {
      if (disposed) return () => {};
      tier.acquire(path);
      lanes.ensureAttached(path);
      publishBody(path);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        tier.release(path);
        if (tier.hasPendingBytes(path) && !retainedForFlush.has(path)) {
          // Keep write ownership: the retained edits need this lane. A later
          // re-lease of the path simply adds demand on top; the flush-side
          // release below pairs with THIS demand.
          retainedForFlush.add(path);
          return;
        }
        lanes.release(path, "disposed");
      };
    },

    getFileFragment(path): Y.XmlFragment | null {
      const doc = tier.doc(path);
      if (doc === null) return null;
      // The fragment name is CARRIED on the document row, never derived from
      // the path: a host mid-rename holds an entry whose fragment still has
      // the old name (see `identityDocumentEntrySchema`).
      const document = store.getState().documents.byPath[path];
      if (document === undefined) return null;
      return doc.getXmlFragment(document.fragmentName);
    },

    getFileDoc: (path) => tier.doc(path),
    getFileAwareness: (path) => tier.awareness(path),
    getFileBodyAvailability: (path) =>
      store.getState().bodyAvailabilityByPath[path] ??
      AWAITING_SEED_AVAILABILITY,
    attachedBodyPaths: () => lanes.attachedPaths(),

    closeTransport(): void {
      if (disposed) return;
      stateAdapter.closeTransport();
      lanes.closeTransport();
    },

    openTransport(): void {
      if (disposed) return;
      stateAdapter.openTransport();
      lanes.openTransport();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      retainedForFlush.clear();
      lanes.detachAll("disposed");
      stateAdapter.detach("disposed");
      tier.dispose();
      if (memory !== null) memory.hotDocs.detach(budgetTierKey);
    },
  };
}
