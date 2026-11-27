import {
  canonicalJsonStringify,
  isJsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import type { OrdinaryComposerDraftWrite } from "./draft-write-codec";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { TimerHandle } from "@traycer-clients/shared/host-transport/timer-handle";
import {
  draftsSubscribeServerFrameSchemaV11,
  draftsUpsertRequestSchemaV30,
  type DraftBase,
  type DraftCloudDocument,
  type DraftCloudTombstone,
  type DraftDocument,
  type DraftHeldRevisionState,
  type DraftListTombstone,
  type DraftWrite,
  type DraftsDeleteResponse,
  type DraftsRetractResponse,
  type DraftsListResponse,
  type DraftsListResponseV30,
  type DraftsSubscribeServerFrameV11,
  type DraftsSubscribeOpenRequestV20,
  type DraftsSubscribeServerFrameV20,
  type DraftsUpsertResponse,
  type DraftsUpsertRequestV30,
} from "@traycer/protocol/host";
import { appLogger, describeLogError } from "@/lib/logger";
import { isDraftsCapabilityMissing } from "./draft-capability";
import {
  currentDraftBlobOwnerId,
  forgetBlobUnsupportedHost,
  forgetConfirmedDraftBlobs,
  invalidateDraftBlobConfirmations,
  putDraftBlobs,
  readWholeDraftBlobs,
  type DraftBlobClient,
} from "./draft-blob-transport";
import { forgetCloudDraftPayloadUnsupportedHost } from "./cloud-draft-image-recovery";
import { clientDraftSubscribeFrameApplies } from "./draft-subscribe-apply";
import {
  DEFAULT_DRAFT_MIRROR_TIMING,
  type DraftMirrorTiming,
} from "./draft-mirror-timing";

export interface LocalOrdinaryDraft {
  readonly write: OrdinaryComposerDraftWrite;
  readonly localRevision: number;
  readonly occurrence: string;
}

export interface OrdinaryDraftSnapshot extends LocalOrdinaryDraft {
  readonly scopeId: string;
  readonly base: DraftBase | null;
}

export interface PlacedOrdinaryDraft {
  readonly status: "placed";
  readonly draftId: string;
  readonly operationId: string;
  readonly base: DraftBase;
}

export type OrdinaryDraftPlacement =
  | PlacedOrdinaryDraft
  | { readonly status: "unsettled" };

export type OrdinaryDraftUpsert = DraftsUpsertRequestV30;

export type OrdinaryDraftHeadEvidence =
  | { readonly kind: "absent" }
  | {
      readonly kind: "tombstone";
      readonly tombstone: { readonly base: DraftBase };
    }
  | {
      readonly kind: "live";
      readonly draft: {
        readonly base: DraftBase;
        readonly operationId: string | null;
        readonly write: OrdinaryComposerDraftWrite;
      };
    };

/** The negotiated peer supplies current cloud evidence for its private scope. */
export interface OrdinaryDraftPeer {
  readonly hostId: string;
  readonly scopeId: string;
  readonly client: DraftBlobClient;
  readonly read?: {
    readonly port: OrdinaryDraftReadPort;
    readonly sink: OrdinaryDraftReadSink;
  };
  editingBase(draftId: string): DraftBase | null | undefined;
  readCurrent(
    draftId: string,
    signal: AbortSignal,
  ): Promise<OrdinaryDraftHeadEvidence>;
  upsert(
    request: OrdinaryDraftUpsert,
    signal: AbortSignal,
  ): Promise<{
    readonly status: "conflict" | "committed";
    readonly current: OrdinaryDraftHeadEvidence;
  }>;
  /** Settle only if the receipt still names this peer's current head. */
  settle(
    snapshot: OrdinaryDraftSnapshot,
    receipt: PlacedOrdinaryDraft,
  ): boolean;
}

interface OrdinaryDraftConnection {
  readonly peer: OrdinaryDraftPeer;
  readonly owner: string | null;
  readonly controller: AbortController;
  readonly feed: OrdinaryDraftReadFeed | null;
}

let ordinaryDraftConnection: OrdinaryDraftConnection | null = null;
const placingOrdinaryDrafts = new Map<string, OrdinaryDraftConnection>();
const unsettledOrdinaryWrites = new Map<string, OrdinaryDraftUpsert>();
interface OrdinaryDraftReceiptBinding {
  readonly connection: OrdinaryDraftConnection;
  readonly snapshot: OrdinaryDraftSnapshot;
}
const ordinaryDraftReceiptBindings = new WeakMap<
  PlacedOrdinaryDraft,
  OrdinaryDraftReceiptBinding
>();

export function attachOrdinaryDraftPeer(peer: OrdinaryDraftPeer): () => void {
  retireOrdinaryDraftConnection(ordinaryDraftConnection);
  forgetConfirmedDraftBlobs(peer.hostId);
  const feed =
    peer.read === undefined
      ? null
      : new OrdinaryDraftReadFeed(peer.scopeId, peer.read.port, peer.read.sink);
  const connection = {
    peer,
    owner: currentDraftBlobOwnerId(),
    controller: new AbortController(),
    feed,
  };
  ordinaryDraftConnection = connection;
  if (feed !== null) void feed.refresh();
  return () => {
    retireOrdinaryDraftConnection(connection);
    if (ordinaryDraftConnection === connection) ordinaryDraftConnection = null;
  };
}

function retireOrdinaryDraftConnection(
  connection: OrdinaryDraftConnection | null,
): void {
  connection?.controller.abort();
  connection?.feed?.close();
}

function currentOrdinaryDraftConnection(): OrdinaryDraftConnection | null {
  const connection = ordinaryDraftConnection;
  if (connection === null || connection.owner === null) return null;
  if (
    connection.controller.signal.aborted ||
    currentDraftBlobOwnerId() !== connection.owner ||
    !authorizesCloudCapability(useAuthStore.getState().status)
  )
    return null;
  return connection;
}

export function currentOrdinaryDraftPeer(): OrdinaryDraftPeer | null {
  return currentOrdinaryDraftConnection()?.peer ?? null;
}

export function ordinaryDraftReceiptPeer(
  receipt: PlacedOrdinaryDraft,
  snapshot: OrdinaryDraftSnapshot,
): OrdinaryDraftPeer | null {
  const connection = currentOrdinaryDraftConnection();
  const binding = ordinaryDraftReceiptBindings.get(receipt);
  if (
    connection === null ||
    binding?.connection !== connection ||
    !sameOrdinaryDraftPayload(binding.snapshot, snapshot)
  )
    return null;
  return connection.peer;
}

export function resetOrdinaryDraftPlacements(): void {
  retireOrdinaryDraftConnection(ordinaryDraftConnection);
  ordinaryDraftConnection = null;
  placingOrdinaryDrafts.clear();
  unsettledOrdinaryWrites.clear();
}

const ordinaryDraftUnsettled: OrdinaryDraftPlacement = { status: "unsettled" };

export async function placeOrdinaryDraft(
  snapshot: OrdinaryDraftSnapshot,
  operationId: string,
): Promise<OrdinaryDraftPlacement> {
  const connection = currentOrdinaryDraftConnection();
  if (connection === null || connection.peer.scopeId !== snapshot.scopeId)
    return ordinaryDraftUnsettled;
  const captured = structuredClone(snapshot);
  const request = draftsUpsertRequestSchemaV30.safeParse({
    scopeId: captured.scopeId,
    draft: captured.write,
    base: captured.base,
    operationId,
  });
  if (
    !request.success ||
    !sameOrdinaryDraftPayload(request.data.draft, captured.write)
  ) {
    return ordinaryDraftUnsettled;
  }
  const receipt = await placeOnOrdinaryDraftConnection(
    connection,
    request.data,
  );
  if (
    currentOrdinaryDraftConnection() !== connection ||
    receipt.status === "unsettled"
  ) {
    return ordinaryDraftUnsettled;
  }
  ordinaryDraftReceiptBindings.set(receipt, { connection, snapshot: captured });
  return receipt;
}

async function placeOnOrdinaryDraftConnection(
  connection: OrdinaryDraftConnection,
  request: OrdinaryDraftUpsert,
): Promise<OrdinaryDraftPlacement> {
  const key = JSON.stringify([
    connection.owner,
    request.scopeId,
    request.draft.draftId,
  ]);
  if (placingOrdinaryDrafts.get(key) === connection)
    return ordinaryDraftUnsettled;
  placingOrdinaryDrafts.set(key, connection);
  try {
    const pending = unsettledOrdinaryWrites.get(key);
    const replay = pending ?? request;
    const result = await writeWholeOrdinaryDraft(connection, replay, key);
    if (
      currentOrdinaryDraftConnection() !== connection ||
      result.status === "unsettled" ||
      !sameOrdinaryDraftPayload(replay, request)
    ) {
      return ordinaryDraftUnsettled;
    }
    return result;
  } finally {
    if (placingOrdinaryDrafts.get(key) === connection)
      placingOrdinaryDrafts.delete(key);
  }
}

async function writeWholeOrdinaryDraft(
  connection: OrdinaryDraftConnection,
  request: OrdinaryDraftUpsert,
  key: string,
): Promise<OrdinaryDraftPlacement> {
  const { peer, controller } = connection;
  const { signal } = controller;
  try {
    const current = await peer.readCurrent(request.draft.draftId, signal);
    if (currentOrdinaryDraftConnection() !== connection)
      return ordinaryDraftUnsettled;
    const recovered = ordinaryDraftReceipt(current, request);
    if (recovered !== null) {
      if (
        !(await confirmOrdinaryDraftBlobs(
          connection,
          request.draft.portable.blobHashes,
          false,
        ))
      )
        return ordinaryDraftUnsettled;
      if (
        !(await ordinaryPlacementStillCurrent(connection, request, recovered))
      )
        return ordinaryDraftUnsettled;
      if (currentOrdinaryDraftConnection() !== connection)
        return ordinaryDraftUnsettled;
      unsettledOrdinaryWrites.delete(key);
      return recovered;
    }
    const currentBase = ordinaryDraftBase(current);
    if (!sameOrdinaryDraftBase(currentBase, request.base)) {
      unsettledOrdinaryWrites.delete(key);
      return ordinaryDraftUnsettled;
    }
    if (
      !(await confirmOrdinaryDraftBlobs(
        connection,
        request.draft.portable.blobHashes,
        true,
      ))
    ) {
      return ordinaryDraftUnsettled;
    }
    if (currentOrdinaryDraftConnection() !== connection)
      return ordinaryDraftUnsettled;
    unsettledOrdinaryWrites.set(key, request);
    const outcome = await peer.upsert(request, signal);
    if (currentOrdinaryDraftConnection() !== connection)
      return ordinaryDraftUnsettled;
    if (outcome.status === "conflict") {
      unsettledOrdinaryWrites.delete(key);
      return ordinaryDraftUnsettled;
    }
    const receipt = ordinaryDraftReceipt(outcome.current, request);
    if (
      receipt === null ||
      !(await ordinaryPlacementStillCurrent(connection, request, receipt))
    ) {
      return ordinaryDraftUnsettled;
    }
    if (currentOrdinaryDraftConnection() !== connection)
      return ordinaryDraftUnsettled;
    unsettledOrdinaryWrites.delete(key);
    return receipt;
  } catch (error: unknown) {
    if (!signal.aborted) {
      appLogger.warn("[draft-mirror] ordinary placement unsettled", {
        error: describeLogError(error),
      });
    }
    return ordinaryDraftUnsettled;
  }
}

async function ordinaryPlacementStillCurrent(
  connection: OrdinaryDraftConnection,
  request: OrdinaryDraftUpsert,
  receipt: PlacedOrdinaryDraft,
): Promise<boolean> {
  if (currentOrdinaryDraftConnection() !== connection) return false;
  const latest = await connection.peer.readCurrent(
    request.draft.draftId,
    connection.controller.signal,
  );
  if (currentOrdinaryDraftConnection() !== connection) return false;
  const verified = ordinaryDraftReceipt(latest, request);
  return (
    verified !== null && sameOrdinaryDraftBase(verified.base, receipt.base)
  );
}

async function confirmOrdinaryDraftBlobs(
  connection: OrdinaryDraftConnection,
  hashes: readonly string[],
  upload: boolean,
): Promise<boolean> {
  if (hashes.length === 0)
    return currentOrdinaryDraftConnection() === connection;
  const { peer, owner, controller } = connection;
  if (upload) await putDraftBlobs(peer.hostId, peer.client, hashes, owner);
  if (currentOrdinaryDraftConnection() !== connection) return false;
  const verified = await readWholeDraftBlobs({
    client: peer.client,
    hashes,
    signal: controller.signal,
  });
  if (currentOrdinaryDraftConnection() !== connection) return false;
  if (verified === null) invalidateDraftBlobConfirmations(peer.hostId, hashes);
  return verified !== null;
}

function ordinaryDraftBase(
  current: OrdinaryDraftHeadEvidence,
): DraftBase | null {
  if (current.kind === "live") return current.draft.base;
  if (current.kind === "tombstone") return current.tombstone.base;
  return null;
}

function ordinaryDraftReceipt(
  current: OrdinaryDraftHeadEvidence,
  request: OrdinaryDraftUpsert,
): PlacedOrdinaryDraft | null {
  if (
    current.kind !== "live" ||
    current.draft.operationId !== request.operationId
  )
    return null;
  if (!sameOrdinaryDraftPayload(current.draft.write, request.draft))
    return null;
  const { base } = current.draft;
  if (
    base.headSha256 === null ||
    (request.base !== null && base.revision <= request.base.revision)
  )
    return null;
  return {
    status: "placed",
    draftId: request.draft.draftId,
    operationId: request.operationId,
    base,
  };
}

function sameOrdinaryDraftBase(
  left: DraftBase | null,
  right: DraftBase | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.headSha256 === right.headSha256 &&
        left.ownerEpoch === right.ownerEpoch &&
        left.revision === right.revision;
}

export function sameOrdinaryDraftPayload(
  left: unknown,
  right: unknown,
): boolean {
  return (
    isJsonValue(left) &&
    isJsonValue(right) &&
    canonicalJsonStringify(left) === canonicalJsonStringify(right)
  );
}

export type OrdinaryDraftFeedEntry = DraftCloudDocument | DraftCloudTombstone;

export interface OrdinaryDraftReadPort {
  list(signal: AbortSignal): Promise<DraftsListResponseV30>;
  subscribe(
    frontier: DraftsSubscribeOpenRequestV20,
    signal: AbortSignal,
    receive: (frame: DraftsSubscribeServerFrameV20) => void,
    requestSnapshot: () => void,
  ): void;
}

/**
 * An upsert prepares verified bytes and their local custody before returning
 * a commit. The feed fences the peer, head and editor again before that
 * synchronous commit changes the visible draft.
 */
export interface OrdinaryDraftReadSink {
  /** Undefined holds a dirty row. Null means no editor has this row. */
  localOccurrence(entry: OrdinaryDraftFeedEntry): string | null | undefined;
  prepare(
    scopeId: string,
    entry: OrdinaryDraftFeedEntry,
    signal: AbortSignal,
  ): Promise<OrdinaryDraftPreparedEntry | null>;
}

interface OrdinaryDraftPreparedEntry {
  commit(): void;
  release(): void;
}

interface OrdinaryDraftFeedCandidate {
  readonly entry: OrdinaryDraftFeedEntry;
  readonly controller: AbortController;
}

interface OrdinaryDraftFeedRun {
  readonly controller: AbortController;
  readonly candidates: Map<string, OrdinaryDraftFeedCandidate>;
  readonly owner: string;
  seq: number;
}

export class OrdinaryDraftReadFeed {
  private active: OrdinaryDraftFeedRun | null = null;

  constructor(
    private readonly scopeId: string,
    private readonly port: OrdinaryDraftReadPort,
    private readonly sink: OrdinaryDraftReadSink,
  ) {}

  close(): void {
    const previous = this.active;
    this.active = null;
    if (previous === null) return;
    previous.controller.abort();
    for (const candidate of previous.candidates.values()) {
      candidate.controller.abort();
    }
  }

  async refresh(): Promise<void> {
    this.close();
    const owner = currentDraftBlobOwnerId();
    if (
      owner === null ||
      !authorizesCloudCapability(useAuthStore.getState().status)
    )
      return;
    const run: OrdinaryDraftFeedRun = {
      controller: new AbortController(),
      candidates: new Map(),
      owner,
      seq: 0,
    };
    this.active = run;
    try {
      const snapshot = await this.port.list(run.controller.signal);
      if (!this.isCurrent(run)) return;
      if (snapshot.scopeId !== this.scopeId) {
        this.close();
        return;
      }
      run.seq = snapshot.snapshotSeq;
      // Register the entire snapshot before opening the stream. Projection may
      // await bytes while the same draft is replaced by a tail frame.
      for (const draft of snapshot.drafts) this.observe(run, draft);
      for (const tombstone of snapshot.tombstones) this.observe(run, tombstone);
      this.port.subscribe(
        { scopeId: snapshot.scopeId, afterSeq: run.seq },
        run.controller.signal,
        (frame) => this.receive(run, frame),
        // Reconnect and renewed custody or edit eligibility restart from a
        // consistent snapshot, including heads withheld by this projection.
        () => {
          if (this.isCurrent(run)) void this.refresh();
        },
      );
    } catch (error: unknown) {
      if (this.active !== run) return;
      this.close();
      appLogger.warn("[draft-mirror] ordinary snapshot unavailable", {
        error: describeLogError(error),
      });
    }
  }

  private isCurrent(run: OrdinaryDraftFeedRun): boolean {
    return (
      this.active === run &&
      currentDraftBlobOwnerId() === run.owner &&
      authorizesCloudCapability(useAuthStore.getState().status)
    );
  }

  private receive(
    run: OrdinaryDraftFeedRun,
    frame: DraftsSubscribeServerFrameV20,
  ): void {
    if (!this.isCurrent(run) || frame.kind === "pong") return;
    if (frame.kind === "reset") {
      void this.refresh();
      return;
    }
    if (frame.seq <= run.seq) return;
    run.seq = frame.seq;
    this.observe(run, frame.kind === "upsert" ? frame.draft : frame.tombstone);
  }

  private observe(
    run: OrdinaryDraftFeedRun,
    entry: OrdinaryDraftFeedEntry,
  ): void {
    if (!this.isCurrent(run)) return;
    run.candidates.get(entry.draftId)?.controller.abort();
    const candidate = { entry, controller: new AbortController() };
    run.candidates.set(entry.draftId, candidate);
    void this.prepare(run, candidate);
  }

  private async prepare(
    run: OrdinaryDraftFeedRun,
    candidate: OrdinaryDraftFeedCandidate,
  ): Promise<void> {
    const { entry, controller } = candidate;
    let prepared: OrdinaryDraftPreparedEntry | null = null;
    try {
      const occurrence = this.sink.localOccurrence(entry);
      if (occurrence === undefined) return;
      prepared = await this.sink.prepare(
        this.scopeId,
        entry,
        controller.signal,
      );
      if (
        this.isCurrent(run) &&
        run.candidates.get(entry.draftId) === candidate &&
        this.sink.localOccurrence(entry) === occurrence
      ) {
        prepared?.commit();
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        appLogger.warn("[draft-mirror] ordinary head withheld", {
          error: describeLogError(error),
        });
      }
    } finally {
      prepared?.release();
      if (run.candidates.get(entry.draftId) === candidate) {
        run.candidates.delete(entry.draftId);
      }
    }
  }
}

export interface DraftDirtyWrite {
  readonly write: DraftWrite;
  readonly generation: number;
}

/**
 * A request the sink still owes a host for a retired id: a `drafts.delete`
 * of a row that host owns, or (`retract`) a `drafts.retract` of a cloud row
 * it does not, retried on the same schedule until the host answers.
 */
export interface PendingHostDelete {
  readonly draftId: string;
  readonly retract: boolean;
}

export interface DraftMirrorSink {
  isDirty(draftId: string): boolean;
  isDeletePending(draftId: string): boolean;
  pendingDeletesForHost(hostId: string): readonly PendingHostDelete[];
  /**
   * A pending delete retried by this session got an answer from `hostId`
   * (never `failed`). The sink decides what the answer means per store: a
   * landing retirement treats `absent` as "route elsewhere", not "done".
   */
  settleDelete(
    hostId: string,
    draftId: string,
    outcome: Exclude<DraftDeleteOutcome, "failed">,
  ): void;
  applyUpsert(document: DraftDocument): Promise<void>;
  applyDelete(draftId: string): void;
  collectDirtyWrites(hostId: string): Promise<readonly DraftDirtyWrite[]>;
  /**
   * `ownerHostId` is the host that OWNS this row, which is what makes the
   * revision meaningful: a revision numbers a row on ONE host, so a store
   * comparing revisions has to know whose. Without it a locally-created
   * draft that has only ever been ACKed carries `hostRevision > 0` with no
   * owner recorded, and every owner-keyed frontier check silently opts out.
   *
   * It is the DOCUMENT's owner, never blindly this session's host: a
   * `replica` row is mirrored here from another host and keeps that host's
   * numbering, so attributing its revision to the session that delivered it
   * would file one host's count under another's.
   *
   * `null` where the caller genuinely cannot know - a tombstone carries no
   * document. The stores treat it as "leave the owner alone", and keep
   * clamping rather than assume a new line.
   */
  rememberSynced(
    draftId: string,
    hostRevision: number,
    collectedGeneration: number,
    ownerHostId: string | null,
  ): void;
  prepareWrite(hostId: string, write: DraftWrite): Promise<DraftWrite>;
  dropAbsentFromList(hostId: string, listedIds: ReadonlySet<string>): void;
  /**
   * Adopt dirty unadopted landing drafts onto this host before collecting
   * writes. `wanted` is the upsert filter (`null` = every dirty id).
   * Uploads landing image bytes after flipping adoption.
   */
  adoptUnadoptedLandingDrafts(
    hostId: string,
    wanted: ReadonlySet<string> | null,
  ): Promise<void>;
  /**
   * Advisory personal-scope id from a `kind: "scope"` subscribe frame.
   * Not a store mutation — do not merge against snapshotSeq.
   */
  applyCloudScope(hostId: string, scopeId: string): void;
}

export interface DraftsHostRpc {
  list(): Promise<DraftsListResponse>;
  upsert(write: DraftWrite): Promise<DraftsUpsertResponse>;
  delete(draftId: string): Promise<DraftsDeleteResponse>;
  retract(draftId: string): Promise<DraftsRetractResponse>;
}

export interface DraftsStreamSubscribe {
  subscribe(
    method: "drafts.subscribe",
    params: Record<string, never>,
  ): IStreamSession;
}

export interface DraftMirrorSessionOptions {
  readonly hostId: string;
  readonly rpc: DraftsHostRpc;
  readonly streamClient: DraftsStreamSubscribe;
  readonly sink: DraftMirrorSink;
  readonly timing: Partial<DraftMirrorTiming> | undefined;
  readonly now: (() => number) | undefined;
}

type PendingFlush = {
  readonly draftId: string;
  timer: TimerHandle | null;
  firstScheduledAt: number;
  retryCount: number;
};

/** One active write and at most one latest, not-yet-started snapshot. */
type PendingSend = {
  promise: Promise<void>;
  highestGeneration: number;
  next: DraftDirtyWrite | null;
};

/**
 * How a `drafts.delete` ended: `deleted` (the host removed its row),
 * `absent` (the host does not hold the row), `unsupported` (the host has no
 * drafts capability; nothing to delete), `failed` (closed or transport
 * error; retry later).
 */
export type DraftDeleteOutcome =
  | "deleted"
  | "absent"
  | "unsupported"
  | "failed";

/**
 * One host's live draft mirror: `drafts.list` snapshot + `drafts.subscribe`
 * frames, debounced upsert, delete. Unreachable / `E_HOST_UNSUPPORTED` leaves
 * the sink's local persist as the source of truth.
 */
export class DraftMirrorSession {
  readonly hostId: string;
  private readonly rpc: DraftsHostRpc;
  private readonly streamClient: DraftsStreamSubscribe;
  private readonly sink: DraftMirrorSink;
  private readonly timing: DraftMirrorTiming;
  private readonly now: () => number;

  /**
   * Per-draft send worker. Two `upsertDirty` runs can overlap (a debounce
   * timer firing while a `flush` is awaiting `collectDirtyWrites`), and the
   * request coordinator keys its FIFO queue by the FULL params - so two
   * writes for the same draft carry different params and land in different
   * queues. The host applies an upsert as a whole-document LWW, so an older
   * body reaching it last wins. Ordering therefore has to be owned here.
   *
   * Waiting snapshots are replaced, not appended: slow image uploads must
   * not turn every keystroke into a queued whole-document write.
   * The entry lives only while a send for that draft is outstanding, so no
   * generation bookkeeping survives a drained chain - a store that later
   * restarts its own generation counter (a re-created row) is unaffected.
   */
  private readonly sendChain = new Map<string, PendingSend>();
  private readonly deleteChain = new Map<string, Promise<DraftDeleteOutcome>>();
  private readonly retiredDraftIds = new Set<string>();

  private snapshotSeq = 0;
  private listedScopeId: string | null = null;
  private readonly held = new Map<string, DraftHeldRevisionState>();
  private readonly pending = new Map<string, PendingFlush>();
  private streamSession: IStreamSession | null = null;
  private closed = false;
  /** See `start()`: the account this session was established for. */
  private sessionOwner: string | null = null;
  private capabilityMissing = false;
  private bootGeneration = 0;
  private bootPromise: Promise<void> | null = null;
  private sawSubscribeOpen = false;

  constructor(options: DraftMirrorSessionOptions) {
    this.hostId = options.hostId;
    this.rpc = options.rpc;
    this.streamClient = options.streamClient;
    this.sink = options.sink;
    this.timing = {
      ...DEFAULT_DRAFT_MIRROR_TIMING,
      ...(options.timing ?? {}),
    };
    this.now = options.now ?? Date.now;
  }

  start(): void {
    // The ACCOUNT this session belongs to, for its whole life.
    //
    // A stream established under A keeps delivering after a switch or a
    // sign-out, because closing it is passive cleanup and cleanup is
    // asynchronous. Every frame handler that asks "who holds the window now?"
    // gets the answer B, and installs A's private text under B with each check
    // agreeing. A session cannot be told whose it is by its own frames; it
    // knows because it was started by someone.
    this.sessionOwner = currentDraftBlobOwnerId();
    void this.bootstrap();
  }

  /**
   * Has the account this session was started for gone away? Frames delivered
   * after that are A's, whoever holds the window now.
   */
  private sessionOwnerChanged(): boolean {
    return currentDraftBlobOwnerId() !== this.sessionOwner;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Fence the blob memo too, not just the bootstrap generation. An upload
    // already on the wire when this mirror closes can be acknowledged
    // afterwards, and without this that late ACK re-confirmed a digest for a
    // connection that no longer exists - leaving the send gate confident about
    // bytes on a host this client has stopped talking to. Losing host
    // readiness closes the mirror without any later acquisition, so relying on
    // the next acquire to clear it left that whole lifetime unfenced.
    forgetConfirmedDraftBlobs(this.hostId);
    this.bootGeneration += 1;
    this.clearAllTimers();
    this.sendChain.clear();
    this.streamSession?.close();
    this.streamSession = null;
  }

  noteDirty(draftId: string): void {
    if (this.isAbandoned() || this.writeIsRetired(draftId)) return;
    this.schedule(draftId);
  }

  async flush(draftIds: ReadonlyArray<string> | null): Promise<void> {
    if (this.closed || this.capabilityMissing) return;
    const ids = draftIds === null ? [...this.pending.keys()] : [...draftIds];
    for (const draftId of ids) {
      this.clearTimer(draftId);
    }
    await this.upsertDirty(ids);
    // Host treats `draftIds: []` as "publish every dirty draft". Never send
    // that sentinel from a client with nothing pending (the host half is being
    // made a no-op too; both sides stay defensive).
    if (ids.length === 0) return;
    this.sendFlushFrame(ids);
  }

  /**
   * Personal drafts-scope id from the last `drafts.list` or a later
   * advisory `kind: "scope"` frame. `null` when the host omitted it
   * (old host / free-tier / publication not ready / never resolved).
   */
  cloudScopeId(): string | null {
    return this.listedScopeId;
  }

  /**
   * Stash entries are immutable: upsert once, never edit.
   * A second call for an id already held as a live row is a no-op.
   */
  async publishImmutable(write: DraftWrite): Promise<void> {
    if (this.isAbandoned()) return;
    const held = this.held.get(write.draftId);
    if (held !== undefined && held.kind === "row") return;
    try {
      const prepared = await this.sink.prepareWrite(this.hostId, write);
      const response = await this.rpc.upsert(prepared);
      this.held.set(response.draft.draftId, {
        kind: "row",
        revision: response.draft.revision,
      });
      await this.sink.applyUpsert(response.draft);
      this.sink.rememberSynced(
        response.draft.draftId,
        response.draft.revision,
        Number.POSITIVE_INFINITY,
        response.draft.ownerHostId,
      );
    } catch (error: unknown) {
      if (isDraftsCapabilityMissing(error)) {
        this.markUnsupported();
        return;
      }
      appLogger.warn("[draft-mirror] immutable drafts.upsert failed", {
        error: describeLogError(error),
      });
    }
  }

  /**
   * @returns `true` when the host answered (including `deleted: false`)
   * or the method is unsupported — the caller may drop its binding.
   * `false` on closed/transport failure: keep the binding so a retry
   * can still find the row.
   */
  async deleteOnHost(draftId: string): Promise<boolean> {
    return (await this.deleteOnHostOutcome(draftId)) !== "failed";
  }

  /**
   * `deleteOnHost` with the host's answer kept apart: `absent` (the host
   * does not hold the row) is "done" for the send; the sink decides what
   * it means for the receipt.
   */
  async deleteOnHostOutcome(draftId: string): Promise<DraftDeleteOutcome> {
    return this.removeOnHost(draftId, () => this.runDeleteOnHost(draftId));
  }

  /**
   * `drafts.retract` of a cloud row this host does not own, on the user's
   * authority, with the same chaining as a delete (the id is retired for
   * this session, and the request queues behind an in-flight upsert of the
   * same id). `retracted: false` is `absent` - the row was already gone.
   * A host without the method answers `unsupported` for THIS request only:
   * the drafts capability itself is intact, so the session stays up.
   */
  async retractOnHostOutcome(draftId: string): Promise<DraftDeleteOutcome> {
    return this.removeOnHost(draftId, () => this.runRetractOnHost(draftId));
  }

  private removeOnHost(
    draftId: string,
    run: () => Promise<DraftDeleteOutcome>,
  ): Promise<DraftDeleteOutcome> {
    this.retiredDraftIds.add(draftId);
    this.clearTimer(draftId);
    const pending = this.sendChain.get(draftId);
    if (pending !== undefined) pending.next = null;
    const outstanding = this.deleteChain.get(draftId);
    if (outstanding !== undefined) return outstanding;
    const removing = run().finally(() => {
      if (this.deleteChain.get(draftId) === removing) {
        this.deleteChain.delete(draftId);
      }
    });
    this.deleteChain.set(draftId, removing);
    return removing;
  }

  private async runRetractOnHost(draftId: string): Promise<DraftDeleteOutcome> {
    this.clearTimer(draftId);
    await this.sendChain.get(draftId)?.promise;
    if (this.closed) return "failed";
    if (this.capabilityMissing) return "unsupported";
    try {
      const response = await this.rpc.retract(draftId);
      return response.retracted ? "deleted" : "absent";
    } catch (error: unknown) {
      if (isDraftsCapabilityMissing(error)) return "unsupported";
      appLogger.warn("[draft-mirror] drafts.retract failed", {
        error: describeLogError(error),
      });
      return "failed";
    }
  }

  private async runDeleteOnHost(draftId: string): Promise<DraftDeleteOutcome> {
    this.clearTimer(draftId);
    // An upsert may already have passed its send-time fence. Serialize the
    // tombstone behind it so the host can never observe create-after-delete.
    await this.sendChain.get(draftId)?.promise;
    if (this.closed) return "failed";
    if (this.capabilityMissing) return "unsupported";
    try {
      const response = await this.rpc.delete(draftId);
      if (!response.deleted) return "absent";
      this.held.set(draftId, {
        kind: "tombstone",
        revision: this.revisionOfHeld(draftId) + 1,
        storeSeq: this.snapshotSeq,
      });
      this.sink.rememberSynced(draftId, 0, Number.POSITIVE_INFINITY, null);
      return "deleted";
    } catch (error: unknown) {
      if (isDraftsCapabilityMissing(error)) {
        this.markUnsupported();
        return "unsupported";
      }
      appLogger.warn("[draft-mirror] drafts.delete failed", {
        error: describeLogError(error),
      });
      return "failed";
    }
  }

  private async bootstrap(): Promise<void> {
    if (this.bootPromise !== null) return this.bootPromise;
    // A genuinely new bootstrap - not one joining the in-flight promise above -
    // starts a new conversation with this host, so every verdict the previous
    // one collected about it is now unproven. Placed after the dedupe so a
    // joined caller does not invalidate the confirmations the bootstrap it
    // joined is still gathering.
    // `forgetBlobUnsupportedHost` is the whole blob-side reset (confirmations,
    // the withholds-the-methods flag, and the per-hash unbridgeable formats),
    // and the cloud-payload memo is its sibling for the read this host pipes.
    // Acquisition already calls both on exactly this reasoning - "a new session
    // is a new host connection, and a host that upgraded mid-lifetime must not
    // stay short-circuited" - and this is the path acquisition does not cover:
    // the reconnect handler re-lists without re-acquiring, which is both when a
    // restarted host has silently LOST its blob store and when it has come back
    // on a build that GAINED the methods. Being wrong here costs one refused
    // RPC per reconnect; not clearing costs a draft whose images can never be
    // fetched until the tile hierarchy unmounts.
    forgetBlobUnsupportedHost(this.hostId);
    forgetCloudDraftPayloadUnsupportedHost(this.hostId);
    const generation = this.bootGeneration;
    this.bootPromise = this.runBootstrap(generation).finally(() => {
      if (this.bootGeneration === generation) this.bootPromise = null;
    });
    return this.bootPromise;
  }

  private async runBootstrap(generation: number): Promise<void> {
    if (this.closed || generation !== this.bootGeneration) return;
    // The ACCOUNT this bootstrap belongs to, captured before the first await.
    //
    // Closing is how a sign-out or a user switch is SUPPOSED to reach this
    // session, and it does - eventually. The teardown is asynchronous, so
    // between the switch and the close this session is still open, still on its
    // original generation, and still applying rows: account A's drafts land in
    // account B's window with every existing guard answering "yes, carry on".
    // Neither `closed` nor the generation can see that, because the thing that
    // moved is neither.
    const bootOwner = this.sessionOwner;
    try {
      const listed = await this.rpc.list();
      if (this.isSupersededBoot(generation, bootOwner)) return;
      this.snapshotSeq = listed.snapshotSeq;
      this.listedScopeId = listed.scopeId ?? null;
      this.held.clear();
      const listedIds = new Set<string>();
      if (
        !(await this.applyListedRows(
          listed.drafts,
          generation,
          bootOwner,
          listedIds,
        ))
      ) {
        return;
      }
      // AWAITING the loop is itself a suspension point, whatever the loop did.
      // Its own guard fires after each row's apply, so it cannot answer for the
      // hop this `await` opens on the way out - and that hop is the whole story
      // when the loop had nothing to await: an empty listing, or one whose rows
      // are all dirty, still yields here, and a close landing in that window
      // reached the tombstones and the absence sweep below.
      if (this.isSupersededBoot(generation, bootOwner)) return;
      this.applyListedTombstones(
        listed.tombstones,
        listed.snapshotSeq,
        listedIds,
      );
      // Absence from live rows is a mirror drop, not a content delete.
      // Tombstone ids are in `listedIds` so they are not also dropped.
      this.sink.dropAbsentFromList(this.hostId, listedIds);
      if (this.streamSession === null) this.openSubscribe();
      await this.retryPendingDeletes();
      await this.upsertDirty(null);
    } catch (error: unknown) {
      if (isDraftsCapabilityMissing(error)) {
        this.markUnsupported();
        return;
      }
      appLogger.warn("[draft-mirror] drafts.list failed; staying local", {
        error: describeLogError(error),
      });
    }
  }

  private openSubscribe(): void {
    if (this.closed || this.capabilityMissing) return;
    this.streamSession?.close();
    const session = this.streamClient.subscribe("drafts.subscribe", {});
    this.streamSession = session;
    session.onServerFrame((envelope) => {
      void this.handleServerFrame(envelope);
    });
    session.onStatusChange((status) => {
      if (this.closed) return;
      if (status !== "open") return;
      // The session re-declares on reconnect; we only re-list, never
      // re-subscribe. Skip the first open — start() already listed.
      if (!this.sawSubscribeOpen) {
        this.sawSubscribeOpen = true;
        return;
      }
      void this.bootstrap();
    });
  }

  private async handleServerFrame(envelope: {
    readonly kind: string;
    readonly hasBinaryPayload: boolean;
    readonly [key: string]: unknown;
  }): Promise<void> {
    if (this.closed || this.capabilityMissing) return;
    const parsed = draftsSubscribeServerFrameSchemaV11.safeParse(envelope);
    if (!parsed.success) {
      // A shape this client version does not accept stops convergence with
      // no other signal at all - the drafts simply stop moving. Name it in
      // dev rather than leaving the next reader to infer it.
      if (import.meta.env.DEV) {
        appLogger.warn("[draft-mirror] dropped unparsable subscribe frame", {
          kind: envelope.kind,
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "pong") return;
    if (frame.kind === "scope") {
      this.listedScopeId = frame.scopeId;
      this.sink.applyCloudScope(this.hostId, frame.scopeId);
      return;
    }
    await this.applySubscribeFrame(frame);
  }

  private async applySubscribeFrame(
    frame: DraftsSubscribeServerFrameV11,
  ): Promise<void> {
    if (frame.kind !== "upsert" && frame.kind !== "delete") return;
    // Before anything is read OR written: this frame belongs to whoever this
    // stream was opened for, and if that account is gone the frame is not this
    // window's to apply. `closed` cannot answer it - the close is on its way.
    if (this.sessionOwnerChanged()) return;
    const localDirty = this.sink.isDirty(frame.draftId);
    const held = this.held.get(frame.draftId) ?? { kind: "absent" };
    const applies = clientDraftSubscribeFrameApplies({
      held,
      frame: { revision: frame.revision, storeSeq: frame.storeSeq },
      snapshotSeq: this.snapshotSeq,
      localDirty,
    });
    if (!applies) return;
    if (frame.kind === "upsert") {
      this.held.set(frame.draftId, {
        kind: "row",
        revision: frame.revision,
      });
      await this.sink.applyUpsert(frame.draft);
      // Re-checked on the far side of the apply's own awaits, like the
      // bootstrap's row loop: the switch can land inside the blob read.
      if (this.sessionOwnerChanged()) return;
      this.rememberIncomingSynced(frame.draft);
      return;
    }
    this.held.set(frame.draftId, {
      kind: "tombstone",
      revision: frame.revision,
      storeSeq: frame.storeSeq,
    });
    this.sink.applyDelete(frame.draftId);
    this.sink.rememberSynced(
      frame.draftId,
      frame.revision,
      Number.POSITIVE_INFINITY,
      null,
    );
  }

  private schedule(draftId: string): void {
    const existing = this.pending.get(draftId);
    const now = this.now();
    if (existing === undefined) {
      const entry: PendingFlush = {
        draftId,
        timer: null,
        firstScheduledAt: now,
        retryCount: 0,
      };
      this.pending.set(draftId, entry);
      this.armTimer(entry);
      return;
    }
    existing.retryCount = 0;
    this.armTimer(existing);
  }

  private rememberIncomingSynced(document: DraftDocument): void {
    const held = this.held.get(document.draftId);
    // Awaiting images can admit a newer frame or local edit. An old apply
    // must neither lower the frontier nor acknowledge those unsent edits.
    if (
      this.isAbandoned() ||
      this.writeIsRetired(document.draftId) ||
      held?.kind !== "row" ||
      held.revision !== document.revision ||
      this.sink.isDirty(document.draftId)
    )
      return;
    this.sink.rememberSynced(
      document.draftId,
      document.revision,
      Number.POSITIVE_INFINITY,
      document.ownerHostId,
    );
  }

  private armTimer(entry: PendingFlush): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    const elapsed = this.now() - entry.firstScheduledAt;
    const wait = Math.max(
      0,
      Math.min(this.timing.debounceMs, this.timing.maxWaitMs - elapsed),
    );
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.firstScheduledAt = this.now();
      void this.upsertDirty([entry.draftId]);
    }, wait);
  }

  private async upsertDirty(
    draftIds: ReadonlyArray<string> | null,
  ): Promise<void> {
    if (this.isAbandoned()) return;
    const wanted = draftIds === null ? null : new Set(draftIds);
    // Adopt lazily on the first debounced sync, not on mount.
    await this.sink.adoptUnadoptedLandingDrafts(this.hostId, wanted);
    const writes = await this.sink.collectDirtyWrites(this.hostId);
    for (const entry of writes) {
      if (wanted !== null && !wanted.has(entry.write.draftId)) continue;
      if (this.isAbandoned()) return;
      await this.sendUpsert(entry);
    }
  }

  /**
   * One draft's latest upsert, replacing any snapshot still waiting to send.
   * Collection order and send order are not the same order, so a body an
   * equal-or-newer generation already covers is dropped rather than queued
   * behind it - re-sending it would hand the host the older document last.
   */
  private sendUpsert(entry: DraftDirtyWrite): Promise<void> {
    const draftId = entry.write.draftId;
    if (this.writeIsRetired(draftId)) return Promise.resolve();
    const outstanding = this.sendChain.get(draftId);
    if (
      outstanding !== undefined &&
      outstanding.highestGeneration >= entry.generation
    ) {
      return outstanding.promise;
    }
    if (outstanding !== undefined) {
      outstanding.highestGeneration = entry.generation;
      outstanding.next = entry;
      return outstanding.promise;
    }
    const pending: PendingSend = {
      promise: Promise.resolve(),
      highestGeneration: entry.generation,
      next: entry,
    };
    pending.promise = Promise.resolve()
      .then(async () => {
        while (pending.next !== null) {
          const next = pending.next;
          pending.next = null;
          await this.runUpsert(next);
        }
        // Retire the worker before its promise settles: a collector resumed
        // in the following microtask must start a new worker, not append to
        // one whose loop has already finished.
        if (this.sendChain.get(draftId) === pending) {
          this.sendChain.delete(draftId);
        }
      })
      .finally(() => {
        if (this.sendChain.get(draftId) === pending) {
          this.sendChain.delete(draftId);
        }
      });
    this.sendChain.set(draftId, pending);
    return pending.promise;
  }

  private async runUpsert(entry: DraftDirtyWrite): Promise<void> {
    if (this.isAbandoned()) return;
    const draftId = entry.write.draftId;
    if (this.writeIsRetired(draftId)) return;
    try {
      const prepared = await this.sink.prepareWrite(this.hostId, entry.write);
      // Blob preparation is asynchronous. Submission can fence the row while
      // this write is waiting there, so gate again at actual RPC dispatch.
      if (this.isAbandoned() || this.writeIsRetired(draftId)) return;
      const response = await this.rpc.upsert(prepared);
      if (this.isAbandoned()) return;
      // A committed write still advances the host frontier after retirement.
      // Deletion derives its tombstone from this frontier, and another stream
      // may already have delivered a newer row or tombstone while RPC awaited.
      if (response.draft.revision > this.revisionOfHeld(draftId)) {
        this.held.set(draftId, {
          kind: "row",
          revision: response.draft.revision,
        });
      }
      if (this.writeIsRetired(draftId)) return;
      this.sink.rememberSynced(
        response.draft.draftId,
        response.draft.revision,
        entry.generation,
        response.draft.ownerHostId,
      );
      // `clearTimer`, not `pending.delete`: `schedule()` can have re-armed
      // this draft while the upsert was in flight, and a bare map delete
      // leaves that handle out of `clearAllTimers()`'s reach - it would then
      // fire after `close()`.
      this.clearTimer(draftId);
      if (this.sink.isDirty(response.draft.draftId)) {
        this.schedule(response.draft.draftId);
      }
    } catch (error: unknown) {
      if (isDraftsCapabilityMissing(error)) {
        this.markUnsupported();
        return;
      }
      appLogger.warn("[draft-mirror] drafts.upsert failed; staying local", {
        error: describeLogError(error),
      });
      // Dirty gate is correct (keep suppressing host frames) but it must
      // have a live retry behind it — re-arm with bounded backoff.
      if (!this.writeIsRetired(draftId) && this.sink.isDirty(draftId)) {
        this.scheduleRetry(draftId);
      }
    }
  }

  private writeIsRetired(draftId: string): boolean {
    return (
      this.retiredDraftIds.has(draftId) || this.sink.isDeletePending(draftId)
    );
  }

  private async retryPendingDeletes(): Promise<void> {
    for (const pending of this.sink.pendingDeletesForHost(this.hostId)) {
      const outcome = pending.retract
        ? await this.retractOnHostOutcome(pending.draftId)
        : await this.deleteOnHostOutcome(pending.draftId);
      if (outcome !== "failed") {
        this.sink.settleDelete(this.hostId, pending.draftId, outcome);
      }
    }
  }

  private scheduleRetry(draftId: string): void {
    if (this.closed || this.capabilityMissing) return;
    const now = this.now();
    const existing = this.pending.get(draftId);
    const entry: PendingFlush = existing ?? {
      draftId,
      timer: null,
      firstScheduledAt: now,
      retryCount: 0,
    };
    if (existing === undefined) this.pending.set(draftId, entry);
    entry.retryCount += 1;
    if (entry.timer !== null) clearTimeout(entry.timer);
    const shift = Math.min(entry.retryCount - 1, 8);
    const wait = Math.min(
      this.timing.retryBackoffMs * 2 ** shift,
      this.timing.maxRetryBackoffMs,
    );
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.upsertDirty([draftId]);
    }, wait);
  }

  private sendFlushFrame(draftIds: ReadonlyArray<string>): void {
    const session = this.streamSession;
    if (session === null) return;
    session.sendClientFrame(
      {
        kind: "flush",
        hasBinaryPayload: false,
        draftIds: [...draftIds],
      },
      null,
    );
  }

  private markUnsupported(): void {
    this.capabilityMissing = true;
    this.clearAllTimers();
    this.streamSession?.close();
    this.streamSession = null;
    for (const pending of this.sink.pendingDeletesForHost(this.hostId)) {
      this.sink.settleDelete(this.hostId, pending.draftId, "unsupported");
    }
  }

  /**
   * Has this bootstrap lost the right to mutate anything? Either the session
   * closed under it, or a newer bootstrap superseded it. Both answers mean the
   * same thing to every caller, and every caller is on the far side of an
   * await.
   */
  private isSupersededBoot(
    generation: number,
    bootOwner: string | null,
  ): boolean {
    if (this.isClosed() || generation !== this.bootGeneration) return true;
    return currentDraftBlobOwnerId() !== bootOwner;
  }

  /**
   * Apply the listing's live rows. `false` means this bootstrap was superseded
   * part way through and its caller must stop - NOT that the listing was empty.
   *
   * Each apply awaits its own blob read, and this session can be closed - by a
   * sign-out, a user switch, or an ordinary release - inside any one of them.
   * The loop used to simply carry on: the interrupted row was dropped by the
   * apply's own guard and the NEXT row then captured whatever identity now held
   * the window, installing one account's private draft under another. A guard
   * inside the apply cannot see that, because by then it is a fresh call with a
   * fresh capture.
   *
   * ONE check, immediately after the await, covers both halves - and it is
   * placed there rather than at the top of the iteration on purpose. That apply
   * is the only await in this loop, so between the end of one iteration and the
   * start of the next nothing else can run; a check at the top of the body
   * could never observe anything this one had not already observed, which makes
   * it an inert guard that reads as load-bearing. Stopping here also stops the
   * caller, which is the half that was missing: closing during the LAST row
   * reached `rememberIncomingSynced`, the tombstones and the absence sweep,
   * with the apply itself correctly abandoned.
   */
  private async applyListedRows(
    drafts: ReadonlyArray<DraftDocument>,
    generation: number,
    bootOwner: string | null,
    listedIds: Set<string>,
  ): Promise<boolean> {
    for (const document of drafts) {
      listedIds.add(document.draftId);
      this.held.set(document.draftId, {
        kind: "row",
        revision: document.revision,
      });
      if (this.sink.isDirty(document.draftId)) continue;
      await this.sink.applyUpsert(document);
      if (this.isSupersededBoot(generation, bootOwner)) return false;
      this.rememberIncomingSynced(document);
    }
    return true;
  }

  /**
   * Apply the listing's tombstones as held deletes. Synchronous throughout, so
   * the caller's guard before it still holds at the end of it.
   */
  private applyListedTombstones(
    tombstones: ReadonlyArray<DraftListTombstone>,
    snapshotSeq: number,
    listedIds: Set<string>,
  ): void {
    for (const tombstone of tombstones) {
      listedIds.add(tombstone.draftId);
      this.held.set(tombstone.draftId, {
        kind: "tombstone",
        revision: tombstone.revision,
        storeSeq: snapshotSeq,
      });
      if (this.sink.isDirty(tombstone.draftId)) continue;
      this.sink.applyDelete(tombstone.draftId);
      this.sink.rememberSynced(
        tombstone.draftId,
        tombstone.revision,
        Number.POSITIVE_INFINITY,
        null,
      );
    }
  }

  /**
   * Read through a method so post-await checks are not CFA-narrowed to
   * the pre-await `false`. `close()` / `markUnsupported()` can run
   * while `list`/`upsert` are in flight.
   */
  private isClosed(): boolean {
    return this.closed;
  }

  private isAbandoned(): boolean {
    return this.closed || this.capabilityMissing;
  }

  private revisionOfHeld(draftId: string): number {
    const held = this.held.get(draftId);
    if (held === undefined || held.kind === "absent") return 0;
    return held.revision;
  }

  private clearTimer(draftId: string): void {
    const entry = this.pending.get(draftId);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.pending.delete(draftId);
  }

  private clearAllTimers(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}
