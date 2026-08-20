import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { TimerHandle } from "@traycer-clients/shared/host-transport/timer-handle";
import {
  draftsSubscribeServerFrameSchemaV10,
  type DraftDocument,
  type DraftHeldRevisionState,
  type DraftWrite,
  type DraftsDeleteResponse,
  type DraftsListResponse,
  type DraftsSubscribeServerFrameV10,
  type DraftsUpsertResponse,
} from "@traycer/protocol/host";
import { appLogger, describeLogError } from "@/lib/logger";
import { isDraftsCapabilityMissing } from "./draft-capability";
import { clientDraftSubscribeFrameApplies } from "./draft-subscribe-apply";
import {
  DEFAULT_DRAFT_MIRROR_TIMING,
  type DraftMirrorTiming,
} from "./draft-mirror-timing";

export interface DraftDirtyWrite {
  readonly write: DraftWrite;
  readonly generation: number;
}

export interface DraftMirrorSink {
  isDirty(draftId: string): boolean;
  applyUpsert(document: DraftDocument): void;
  applyDelete(draftId: string): void;
  collectDirtyWrites(hostId: string): Promise<readonly DraftDirtyWrite[]>;
  rememberSynced(
    draftId: string,
    hostRevision: number,
    collectedGeneration: number,
  ): void;
  prepareWrite(write: DraftWrite): Promise<DraftWrite>;
  dropAbsentFromList(hostId: string, listedIds: ReadonlySet<string>): void;
  /**
   * Adopt dirty unadopted landing drafts onto this host before collecting
   * writes. `wanted` is the upsert filter (`null` = every dirty id).
   */
  adoptUnadoptedLandingDrafts(
    hostId: string,
    wanted: ReadonlySet<string> | null,
  ): void;
}

export interface DraftsHostRpc {
  list(): Promise<DraftsListResponse>;
  upsert(write: DraftWrite): Promise<DraftsUpsertResponse>;
  delete(draftId: string): Promise<DraftsDeleteResponse>;
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

  private snapshotSeq = 0;
  private readonly held = new Map<string, DraftHeldRevisionState>();
  private readonly pending = new Map<string, PendingFlush>();
  private streamSession: IStreamSession | null = null;
  private closed = false;
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
    void this.bootstrap();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bootGeneration += 1;
    this.clearAllTimers();
    this.streamSession?.close();
    this.streamSession = null;
  }

  noteDirty(draftId: string): void {
    if (this.isAbandoned()) return;
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
    // that sentinel from a client with nothing pending (T6 is making the host
    // half a no-op; both sides stay defensive).
    if (ids.length === 0) return;
    this.sendFlushFrame(ids);
  }

  async deleteOnHost(draftId: string): Promise<void> {
    if (this.closed || this.capabilityMissing) return;
    this.clearTimer(draftId);
    try {
      const response = await this.rpc.delete(draftId);
      if (!response.deleted) return;
      this.held.set(draftId, {
        kind: "tombstone",
        revision: this.revisionOfHeld(draftId) + 1,
        storeSeq: this.snapshotSeq,
      });
      this.sink.rememberSynced(draftId, 0, Number.POSITIVE_INFINITY);
    } catch (error: unknown) {
      if (isDraftsCapabilityMissing(error)) {
        this.markUnsupported();
        return;
      }
      appLogger.warn("[draft-mirror] drafts.delete failed", {
        error: describeLogError(error),
      });
    }
  }

  private async bootstrap(): Promise<void> {
    if (this.bootPromise !== null) return this.bootPromise;
    const generation = this.bootGeneration;
    this.bootPromise = this.runBootstrap(generation).finally(() => {
      if (this.bootGeneration === generation) this.bootPromise = null;
    });
    return this.bootPromise;
  }

  private async runBootstrap(generation: number): Promise<void> {
    if (this.closed || generation !== this.bootGeneration) return;
    try {
      const listed = await this.rpc.list();
      if (this.isClosed() || generation !== this.bootGeneration) return;
      this.snapshotSeq = listed.snapshotSeq;
      this.held.clear();
      const listedIds = new Set<string>();
      for (const document of listed.drafts) {
        listedIds.add(document.draftId);
        this.held.set(document.draftId, {
          kind: "row",
          revision: document.revision,
        });
        if (!this.sink.isDirty(document.draftId)) {
          this.sink.applyUpsert(document);
          this.sink.rememberSynced(
            document.draftId,
            document.revision,
            Number.POSITIVE_INFINITY,
          );
        }
      }
      for (const tombstone of listed.tombstones) {
        listedIds.add(tombstone.draftId);
        this.held.set(tombstone.draftId, {
          kind: "tombstone",
          revision: tombstone.revision,
          storeSeq: listed.snapshotSeq,
        });
        if (!this.sink.isDirty(tombstone.draftId)) {
          this.sink.applyDelete(tombstone.draftId);
          this.sink.rememberSynced(
            tombstone.draftId,
            tombstone.revision,
            Number.POSITIVE_INFINITY,
          );
        }
      }
      // Absence from live rows is a mirror drop, not a content delete.
      // Tombstone ids are in `listedIds` so they are not also dropped.
      this.sink.dropAbsentFromList(this.hostId, listedIds);
      if (this.streamSession === null) this.openSubscribe();
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
      this.handleServerFrame(envelope);
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

  private handleServerFrame(envelope: {
    readonly kind: string;
    readonly hasBinaryPayload: boolean;
    readonly [key: string]: unknown;
  }): void {
    if (this.closed || this.capabilityMissing) return;
    const parsed = draftsSubscribeServerFrameSchemaV10.safeParse(envelope);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === "pong") return;
    this.applySubscribeFrame(frame);
  }

  private applySubscribeFrame(frame: DraftsSubscribeServerFrameV10): void {
    if (frame.kind !== "upsert" && frame.kind !== "delete") return;
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
      this.sink.applyUpsert(frame.draft);
      this.sink.rememberSynced(
        frame.draftId,
        frame.revision,
        Number.POSITIVE_INFINITY,
      );
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

  private armTimer(entry: PendingFlush): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    const elapsed = this.now() - entry.firstScheduledAt;
    const wait = Math.max(
      0,
      Math.min(this.timing.debounceMs, this.timing.maxWaitMs - elapsed),
    );
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.upsertDirty([entry.draftId]);
    }, wait);
  }

  private async upsertDirty(
    draftIds: ReadonlyArray<string> | null,
  ): Promise<void> {
    if (this.isAbandoned()) return;
    const wanted = draftIds === null ? null : new Set(draftIds);
    // Decision #9: adopt lazily on the first debounced sync, not on mount.
    this.sink.adoptUnadoptedLandingDrafts(this.hostId, wanted);
    const writes = await this.sink.collectDirtyWrites(this.hostId);
    for (const entry of writes) {
      if (wanted !== null && !wanted.has(entry.write.draftId)) continue;
      if (this.isAbandoned()) return;
      try {
        const prepared = await this.sink.prepareWrite(entry.write);
        const response = await this.rpc.upsert(prepared);
        this.held.set(response.draft.draftId, {
          kind: "row",
          revision: response.draft.revision,
        });
        this.sink.rememberSynced(
          response.draft.draftId,
          response.draft.revision,
          entry.generation,
        );
        this.pending.delete(entry.write.draftId);
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
        if (this.sink.isDirty(entry.write.draftId)) {
          this.scheduleRetry(entry.write.draftId);
        }
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
