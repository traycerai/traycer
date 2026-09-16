import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  DraftDocument,
  DraftWrite,
  DraftsListResponse,
  DraftsSubscribeServerFrameV10,
} from "@traycer/protocol/host";
import {
  DraftMirrorSession,
  type DraftDeleteOutcome,
  type DraftDirtyWrite,
  type DraftMirrorSink,
  type DraftsHostRpc,
  type DraftsStreamSubscribe,
  type PendingHostDelete,
} from "@/lib/drafts/draft-mirror-session";
import {
  applyComposerHostDelete,
  applyComposerHostDocument,
  composerDraftIsDirty,
  dropComposerAbsentFromList,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  adoptUnadoptedLandingDraftsForHost,
  bindLandingAdoptionHost,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  composerDraftWrite,
  landingTarget,
} from "@/lib/drafts/draft-write-codec";
import {
  collectLandingDirtyWrites,
  landingDraftIsDirty,
  landingDraftRememberSynced,
  rememberLandingBlobsOnHost,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { cloudDraftsDirectoryIsVisible } from "@/lib/drafts/cloud-drafts-visibility";
import {
  hostWithholdsDraftBlobs,
  isDraftBlobConfirmed,
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

const HOST_ID = "host-1";
const SCOPE_ID = "scp_testdraftsscopeid000001";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

function landingDocument(input: {
  readonly draftId: string;
  readonly revision: number;
}): DraftDocument {
  return {
    draftId: input.draftId,
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision: input.revision,
    lastTouchedAt: 1,
    workspace: null,
    supersedes: null,
    ownerHostId: HOST_ID,
    origin: "own",
    adoption: { state: "adopted", hostId: HOST_ID },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
    portable: {
      content: EMPTY_DOC,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

const EMPTY_LIST_TOMBSTONES: DraftsListResponse["tombstones"] = [];

function listResponse(
  drafts: readonly DraftDocument[],
  snapshotSeq: number,
  tombstones: DraftsListResponse["tombstones"],
): DraftsListResponse {
  return {
    drafts: [...drafts],
    tombstones: [...tombstones],
    snapshotSeq,
    scopeId: null,
  };
}

function landingWrite(
  draftId: string,
  revision: number,
): Extract<DraftWrite, { readonly kind: "landing" }> {
  return {
    draftId,
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision,
    lastTouchedAt: 1,
    workspace: null,
    supersedes: null,
    portable: {
      content: EMPTY_DOC,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

function unsupportedError(method: string): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "old host",
    requestId: "req-1",
    method,
    fatalDetails: null,
  });
}

function createStreamHarness(): {
  readonly client: DraftsStreamSubscribe;
  readonly emit: (frame: DraftsSubscribeServerFrameV10) => void;
  /** Drive the session's own status handler - how a reconnect is staged. */
  readonly emitStatus: (status: StreamConnectionStatus) => void;
  readonly sent: Array<{ readonly kind: string; readonly draftIds?: unknown }>;
  readonly subscribeCalls: { count: number };
} {
  let onFrame: ServerFrameHandler | null = null;
  let onStatus: StatusChangeHandler | null = null;
  const subscribeCalls = { count: 0 };
  const sent: Array<{ readonly kind: string; readonly draftIds?: unknown }> =
    [];
  const session: IStreamSession = {
    sendClientFrame: (envelope, _binary) => {
      sent.push({
        kind: typeof envelope.kind === "string" ? envelope.kind : "",
        draftIds: "draftIds" in envelope ? envelope.draftIds : undefined,
      });
      void _binary;
    },
    onServerFrame: (handler) => {
      onFrame = handler;
    },
    onStatusChange: (handler) => {
      onStatus = handler;
    },
    requestReconnect: () => undefined,
    close: () => undefined,
    getNegotiatedSchemaVersion: () => ({ major: 1, minor: 0 }),
  };
  return {
    emit: (frame) => {
      onFrame?.(frame, null);
    },
    emitStatus: (status) => {
      onStatus?.(status, null, null);
    },
    sent,
    subscribeCalls,
    client: {
      subscribe: () => {
        subscribeCalls.count += 1;
        return session;
      },
    },
  };
}

function createRpc(handlers: {
  readonly list: () => Promise<DraftsListResponse>;
  readonly upsert: (
    write: DraftWrite,
  ) => Promise<{ readonly draft: DraftDocument }>;
  readonly delete: (draftId: string) => Promise<{ readonly deleted: boolean }>;
  readonly retract?: (
    draftId: string,
  ) => Promise<{ readonly retracted: boolean }>;
}): DraftsHostRpc {
  return {
    list: handlers.list,
    upsert: handlers.upsert,
    delete: handlers.delete,
    retract: handlers.retract ?? (() => Promise.resolve({ retracted: true })),
  };
}

function createSink(options: {
  readonly dirty: Set<string>;
  readonly writes: DraftDirtyWrite[];
  readonly pendingDeletes?: Set<string>;
  readonly prepareWrite?: DraftMirrorSink["prepareWrite"];
  readonly collectDirtyWrites?: DraftMirrorSink["collectDirtyWrites"];
  readonly rememberSynced?: DraftMirrorSink["rememberSynced"];
  readonly applyUpsert?: DraftMirrorSink["applyUpsert"];
  readonly dropAbsentFromList?: DraftMirrorSink["dropAbsentFromList"];
}): DraftMirrorSink & {
  readonly upserts: DraftDocument[];
  readonly deletes: string[];
  readonly scopes: string[];
  readonly synced: ReadonlyArray<{
    readonly draftId: string;
    readonly hostRevision: number;
  }>;
  readonly settles: ReadonlyArray<{
    readonly hostId: string;
    readonly draftId: string;
    readonly outcome: DraftDeleteOutcome;
  }>;
} {
  const upserts: DraftDocument[] = [];
  const deletes: string[] = [];
  const scopes: string[] = [];
  const synced: Array<{
    readonly draftId: string;
    readonly hostRevision: number;
  }> = [];
  const settles: Array<{
    readonly hostId: string;
    readonly draftId: string;
    readonly outcome: DraftDeleteOutcome;
  }> = [];
  return {
    upserts,
    deletes,
    scopes,
    synced,
    settles,
    isDirty: (draftId) => options.dirty.has(draftId),
    isDeletePending: (draftId) => options.pendingDeletes?.has(draftId) ?? false,
    pendingDeletesForHost: () =>
      [...(options.pendingDeletes ?? [])].map((draftId) => ({
        draftId,
        retract: false,
      })),
    settleDelete: (hostId, draftId, outcome) => {
      settles.push({ hostId, draftId, outcome });
      options.pendingDeletes?.delete(draftId);
    },
    applyUpsert:
      options.applyUpsert ??
      ((document) => {
        upserts.push(document);
        return Promise.resolve();
      }),
    applyDelete: (draftId) => {
      deletes.push(draftId);
    },
    collectDirtyWrites:
      options.collectDirtyWrites ?? (() => Promise.resolve(options.writes)),
    rememberSynced:
      options.rememberSynced ??
      ((draftId, hostRevision) => {
        synced.push({ draftId, hostRevision });
      }),
    prepareWrite:
      options.prepareWrite ?? ((_hostId, write) => Promise.resolve(write)),
    dropAbsentFromList:
      options.dropAbsentFromList ??
      ((_hostId, _listedIds) => {
        void _hostId;
        void _listedIds;
      }),
    adoptUnadoptedLandingDrafts: (_hostId, _wanted) => {
      void _hostId;
      void _wanted;
      return Promise.resolve();
    },
    applyCloudScope: (_hostId, scopeId) => {
      scopes.push(scopeId);
    },
  };
}

beforeEach(() => {
  installFreshIndexedDb();
});

/**
 * A minimal sink for exercising `pendingDeletesForHost` / `settleDelete`
 * against a caller-owned, mutable list of pending retract/delete entries -
 * used by the `drafts.retract` bootstrap-retry tests, where the interesting
 * behavior is entirely in which entries settle and what the rpc records.
 */
function createRetractTrackingSink(
  pendingEntries: PendingHostDelete[],
): DraftMirrorSink & {
  readonly settles: ReadonlyArray<{
    readonly hostId: string;
    readonly draftId: string;
    readonly outcome: DraftDeleteOutcome;
  }>;
} {
  const settles: Array<{
    readonly hostId: string;
    readonly draftId: string;
    readonly outcome: DraftDeleteOutcome;
  }> = [];
  return {
    settles,
    isDirty: (_draftId) => {
      void _draftId;
      return false;
    },
    isDeletePending: (_draftId) => {
      void _draftId;
      return false;
    },
    pendingDeletesForHost: (_hostId) => {
      void _hostId;
      return [...pendingEntries];
    },
    settleDelete: (hostId, draftId, outcome) => {
      settles.push({ hostId, draftId, outcome });
      const index = pendingEntries.findIndex(
        (entry) => entry.draftId === draftId,
      );
      if (index !== -1) pendingEntries.splice(index, 1);
    },
    applyUpsert: (_document) => {
      void _document;
      return Promise.resolve();
    },
    applyDelete: (_draftId) => {
      void _draftId;
    },
    collectDirtyWrites: (_hostId) => {
      void _hostId;
      return Promise.resolve([]);
    },
    rememberSynced: (_draftId, _hostRevision, _collectedGeneration) => {
      void _draftId;
      void _hostRevision;
      void _collectedGeneration;
    },
    prepareWrite: (_hostId, write) => {
      void _hostId;
      return Promise.resolve(write);
    },
    dropAbsentFromList: (_hostId, _listedIds) => {
      void _hostId;
      void _listedIds;
    },
    adoptUnadoptedLandingDrafts: (_hostId, _wanted) => {
      void _hostId;
      void _wanted;
      return Promise.resolve();
    },
    applyCloudScope: (_hostId, _scopeId) => {
      void _hostId;
      void _scopeId;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  useComposerDraftStore.setState({ drafts: {} });
  resetDraftBlobTransportForTests();
});

describe("DraftMirrorSession", () => {
  it("opens subscribe when drafts.list returns with a null scopeId", async () => {
    const stream = createStreamHarness();
    const sink = createSink({ dirty: new Set(), writes: [] });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve({
            drafts: [],
            tombstones: EMPTY_LIST_TOMBSTONES,
            snapshotSeq: 1,
            scopeId: null,
          }),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    expect(session.cloudScopeId()).toBeNull();
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: session.cloudScopeId(),
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(false);
    stream.emit({
      kind: "scope",
      hasBinaryPayload: false,
      scopeId: SCOPE_ID,
    });
    await vi.waitFor(() => {
      expect(sink.scopes).toEqual([SCOPE_ID]);
    });
    expect(session.cloudScopeId()).toBe(SCOPE_ID);
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: session.cloudScopeId(),
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(true);
    stream.emit({
      kind: "scope",
      hasBinaryPayload: false,
      scopeId: SCOPE_ID,
    });
    await Promise.resolve();
    expect(sink.scopes).toEqual([SCOPE_ID, SCOPE_ID]);
    session.close();
  });

  it("applies a late-joiner scope frame as the first subscribe message", async () => {
    const stream = createStreamHarness();
    const sink = createSink({ dirty: new Set(), writes: [] });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve({
            drafts: [],
            tombstones: EMPTY_LIST_TOMBSTONES,
            snapshotSeq: 1,
            scopeId: null,
          }),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    stream.emit({
      kind: "scope",
      hasBinaryPayload: false,
      scopeId: SCOPE_ID,
    });
    await vi.waitFor(() => {
      expect(session.cloudScopeId()).toBe(SCOPE_ID);
    });
    expect(sink.upserts).toEqual([]);
    expect(sink.deletes).toEqual([]);
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: session.cloudScopeId(),
        error: null,
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(true);
    session.close();
  });

  it("applies list rows that are not dirty and keeps dirty locals", async () => {
    const listed = landingDocument({ draftId: "d1", revision: 2 });
    const dirty = landingDocument({ draftId: "d2", revision: 1 });
    const sink = createSink({
      dirty: new Set(["d2"]),
      writes: [],
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(
            listResponse([listed, dirty], 9, EMPTY_LIST_TOMBSTONES),
          ),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.upserts.map((row) => row.draftId)).toEqual(["d1"]);
    });
  });

  it("drops a subscribe upsert of an omitted list id whose storeSeq is not newer", async () => {
    const sink = createSink({ dirty: new Set(), writes: [] });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(listResponse([], 21, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: false }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.upserts).toEqual([]);
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 21,
      draftId: "ghost",
      revision: 1,
      draft: landingDocument({ draftId: "ghost", revision: 1 }),
    });
    // Yield first: the frame handler is async, so asserting in the emitting
    // tick would pass even if the stale frame were accepted one await later.
    await Promise.resolve();
    expect(sink.upserts).toEqual([]);
  });

  it("stays local on E_HOST_UNSUPPORTED without applying or upserting", async () => {
    const sink = createSink({
      dirty: new Set(["d1"]),
      writes: [{ write: landingWrite("d1", 0), generation: 1 }],
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.reject(unsupportedError("drafts.list")),
        upsert: () => Promise.reject(unsupportedError("drafts.upsert")),
        delete: () => Promise.reject(unsupportedError("drafts.delete")),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    session.noteDirty("d1");
    await session.flush(["d1"]);
    expect(sink.upserts).toEqual([]);
  });

  it("does not send a flush frame with an empty draftIds list", async () => {
    const sink = createSink({ dirty: new Set(), writes: [] });
    const stream = createStreamHarness();
    let listed = false;
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => {
          listed = true;
          return Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES));
        },
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(listed).toBe(true);
    });
    await session.flush(null);
    expect(
      stream.sent.filter(
        (frame) =>
          frame.kind === "flush" &&
          Array.isArray(frame.draftIds) &&
          frame.draftIds.length === 0,
      ),
    ).toEqual([]);
  });

  it("re-arms a bounded retry after a failed upsert", async () => {
    let attempts = 0;
    let listed = false;
    const dirty = new Set<string>();
    const writes: DraftDirtyWrite[] = [];
    const sink = createSink({ dirty, writes });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => {
          listed = true;
          return Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES));
        },
        upsert: (write) => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("transient"));
          return Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          });
        },
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: {
        debounceMs: 0,
        maxWaitMs: 0,
        retryBackoffMs: 1_000,
        maxRetryBackoffMs: 4_000,
      },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(listed).toBe(true);
    });
    vi.useFakeTimers();
    dirty.add("d1");
    writes.push({ write: landingWrite("d1", 0), generation: 1 });
    session.noteDirty("d1");
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    session.close();
  });

  it("does not rememberSynced when drafts.delete reports deleted: false", async () => {
    const sink = createSink({ dirty: new Set(), writes: [] });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: false }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHost("d1")).resolves.toBe(true);
    expect(sink.synced).toEqual([]);
    session.close();
    await expect(session.deleteOnHost("d1")).resolves.toBe(false);
  });

  it("treats a missing drafts.delete capability as a completed deletion", async () => {
    const pendingDeletes = new Set(["d1"]);
    const sink = createSink({ dirty: new Set(), writes: [], pendingDeletes });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, [])),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.reject(unsupportedError("drafts.delete")),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    await expect(session.deleteOnHost("d1")).resolves.toBe(true);
    expect(pendingDeletes).toEqual(new Set());
    expect(sink.settles).toEqual([
      { hostId: HOST_ID, draftId: "d1", outcome: "unsupported" },
    ]);
  });

  it("reports deleteOnHostOutcome as deleted when the host removed its row", async () => {
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHostOutcome("d1")).resolves.toBe("deleted");
    session.close();
  });

  it("reports deleteOnHostOutcome as absent when the host does not hold the row, while deleteOnHost still resolves true", async () => {
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: false }),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHostOutcome("d1")).resolves.toBe("absent");
    await expect(session.deleteOnHost("d2")).resolves.toBe(true);
    session.close();
  });

  it("reports deleteOnHostOutcome as failed when the rpc rejects", async () => {
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.reject(new Error("transport error")),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHostOutcome("d1")).resolves.toBe("failed");
    session.close();
  });

  it("reports deleteOnHostOutcome as unsupported when the drafts capability is missing", async () => {
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.reject(unsupportedError("drafts.delete")),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHostOutcome("d1")).resolves.toBe(
      "unsupported",
    );
    session.close();
  });

  it("settles a bootstrap-retried pending delete as absent when the host does not hold the row", async () => {
    const pendingDeletes = new Set(["d1"]);
    const sink = createSink({ dirty: new Set(), writes: [], pendingDeletes });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: false }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "d1", outcome: "absent" },
      ]);
    });
    expect(pendingDeletes).toEqual(new Set());
    session.close();
  });

  it("settles a bootstrap-retried pending delete as deleted when the host removed its row", async () => {
    const pendingDeletes = new Set(["d1"]);
    const sink = createSink({ dirty: new Set(), writes: [], pendingDeletes });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "d1", outcome: "deleted" },
      ]);
    });
    expect(pendingDeletes).toEqual(new Set());
    session.close();
  });

  it("leaves a bootstrap-retried pending delete unsettled when the rpc rejects", async () => {
    const pendingDeletes = new Set(["d1"]);
    const sink = createSink({ dirty: new Set(), writes: [], pendingDeletes });
    let deleteAttempted = false;
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => {
          deleteAttempted = true;
          return Promise.reject(new Error("transport error"));
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(deleteAttempted).toBe(true);
    });
    expect(sink.settles).toEqual([]);
    expect(pendingDeletes).toEqual(new Set(["d1"]));
    session.close();
  });

  it("retries a pending retract with drafts.retract at bootstrap and settles deleted", async () => {
    const pendingEntries: PendingHostDelete[] = [
      { draftId: "r1", retract: true },
      { draftId: "d1", retract: false },
    ];
    const sink = createRetractTrackingSink(pendingEntries);
    const retractCalls: string[] = [];
    const deleteCalls: string[] = [];
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: (draftId) => {
          deleteCalls.push(draftId);
          return Promise.resolve({ deleted: true });
        },
        retract: (draftId) => {
          retractCalls.push(draftId);
          return Promise.resolve({ retracted: true });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "r1", outcome: "deleted" },
        { hostId: HOST_ID, draftId: "d1", outcome: "deleted" },
      ]);
    });
    expect(retractCalls).toEqual(["r1"]);
    expect(deleteCalls).toEqual(["d1"]);
    session.close();
  });

  it("retries a pending retract with drafts.retract at bootstrap and settles absent", async () => {
    const pendingEntries: PendingHostDelete[] = [
      { draftId: "r1", retract: true },
      { draftId: "d1", retract: false },
    ];
    const sink = createRetractTrackingSink(pendingEntries);
    const retractCalls: string[] = [];
    const deleteCalls: string[] = [];
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: (draftId) => {
          deleteCalls.push(draftId);
          return Promise.resolve({ deleted: true });
        },
        retract: (draftId) => {
          retractCalls.push(draftId);
          return Promise.resolve({ retracted: false });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "r1", outcome: "absent" },
        { hostId: HOST_ID, draftId: "d1", outcome: "deleted" },
      ]);
    });
    expect(retractCalls).toEqual(["r1"]);
    expect(deleteCalls).toEqual(["d1"]);
    session.close();
  });

  it("a host without drafts.retract settles the retract unsupported without tearing the session down", async () => {
    const pendingEntries: PendingHostDelete[] = [
      { draftId: "r1", retract: true },
    ];
    const sink = createRetractTrackingSink(pendingEntries);
    const retractCalls: string[] = [];
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
        retract: (draftId) => {
          retractCalls.push(draftId);
          if (draftId === "r1") {
            return Promise.reject(unsupportedError("drafts.retract"));
          }
          return Promise.resolve({ retracted: true });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "r1", outcome: "unsupported" },
      ]);
    });
    // The retract capability being missing does not tear the whole drafts
    // session down: a fresh retract still reaches the rpc instead of being
    // short-circuited to "unsupported" by a wrongly-flipped capability flag.
    await expect(session.retractOnHostOutcome("r2")).resolves.toBe("deleted");
    expect(retractCalls).toEqual(["r1", "r2"]);
    session.close();
  });

  it("a transport failure leaves the retract pending", async () => {
    const pendingEntries: PendingHostDelete[] = [
      { draftId: "r1", retract: true },
    ];
    const sink = createRetractTrackingSink(pendingEntries);
    let retractCalls = 0;
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
        retract: () => {
          retractCalls += 1;
          return Promise.reject(new Error("transport error"));
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(retractCalls).toBeGreaterThanOrEqual(1);
    });
    expect(sink.settles).toEqual([]);
    await expect(session.retractOnHostOutcome("r1")).resolves.toBe("failed");
    expect(sink.settles).toEqual([]);
    session.close();
  });

  it("does not erase a composer draft synced to host A when host B bootstraps", async () => {
    const typed = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "keep me" }],
        },
      ],
    };
    useComposerDraftStore.setState({
      drafts: {
        "chat-x": {
          content: typed,
          selection: { from: 1, to: 8 },
          browserAnnotations: [],
          resetEpoch: 3,
          revision: 2,
          draftId: "draft-x",
          hostRevision: 4,
          targetEpicId: "epic-1",
          lastTouchedAt: 1,
          generation: 1,
          syncedGeneration: 1,
          ownerHostId: null,
          origin: null,
          supersedes: null,
          publication: null,
        },
      },
    });
    const boundHostByChatId = new Map([["chat-x", "host-a"]]);
    let hostBDropped = false;
    const sink: DraftMirrorSink = {
      isDirty: (draftId) => composerDraftIsDirty(draftId),
      isDeletePending: () => false,
      pendingDeletesForHost: () => [],
      settleDelete: (_hostId, _draftId, _outcome) => {
        void _hostId;
        void _draftId;
        void _outcome;
      },
      applyUpsert: (document) => {
        applyComposerHostDocument(document);
        return Promise.resolve();
      },
      applyDelete: (draftId) => {
        applyComposerHostDelete(draftId);
      },
      collectDirtyWrites: () => Promise.resolve([]),
      rememberSynced: () => undefined,
      prepareWrite: (_hostId, write) => Promise.resolve(write),
      dropAbsentFromList: (hostId, listedIds) => {
        if (hostId === "host-b") hostBDropped = true;
        dropComposerAbsentFromList(hostId, listedIds, boundHostByChatId);
      },
      adoptUnadoptedLandingDrafts: (_hostId, _wanted) => {
        void _hostId;
        void _wanted;
        return Promise.resolve();
      },
      applyCloudScope: () => undefined,
    };
    const listed: DraftDocument = {
      draftId: "draft-x",
      kind: "chat-composer",
      target: { epicId: "epic-1", chatId: "chat-x", blockId: null },
      revision: 4,
      lastTouchedAt: 1,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: typed,
        selection: { from: 1, to: 8 },
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    const sessionA = new DraftMirrorSession({
      hostId: "host-a",
      rpc: createRpc({
        list: () =>
          Promise.resolve(listResponse([listed], 3, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    const sessionB = new DraftMirrorSession({
      hostId: "host-b",
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    sessionA.start();
    await vi.waitFor(() => {
      expect(useComposerDraftStore.getState().drafts["chat-x"]?.draftId).toBe(
        "draft-x",
      );
    });
    const epochAfterA =
      useComposerDraftStore.getState().drafts["chat-x"]?.resetEpoch ?? -1;
    sessionB.start();
    await vi.waitFor(() => {
      expect(hostBDropped).toBe(true);
    });
    const afterB = useComposerDraftStore.getState().drafts["chat-x"];
    expect(afterB?.content).toEqual(typed);
    expect(afterB?.resetEpoch).toBe(epochAfterA);
    expect(afterB?.selection).toEqual({ from: 1, to: 8 });
    sessionA.close();
    sessionB.close();
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("clears stale composer content from a list tombstone after missing the delete frame", async () => {
    const typed = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "already sent" }],
        },
      ],
    };
    useComposerDraftStore.setState({
      drafts: {
        "chat-x": {
          content: typed,
          selection: { from: 1, to: 13 },
          browserAnnotations: [],
          resetEpoch: 3,
          revision: 2,
          draftId: "draft-x",
          hostRevision: 4,
          targetEpicId: "epic-1",
          lastTouchedAt: 1,
          generation: 1,
          syncedGeneration: 1,
          ownerHostId: null,
          origin: null,
          supersedes: null,
          publication: null,
        },
      },
    });
    const boundHostByChatId = new Map([["chat-x", HOST_ID]]);
    const sink: DraftMirrorSink = {
      isDirty: (draftId) => composerDraftIsDirty(draftId),
      isDeletePending: () => false,
      pendingDeletesForHost: () => [],
      settleDelete: (_hostId, _draftId, _outcome) => {
        void _hostId;
        void _draftId;
        void _outcome;
      },
      applyUpsert: (document) => {
        applyComposerHostDocument(document);
        return Promise.resolve();
      },
      applyDelete: (draftId) => {
        applyComposerHostDelete(draftId);
      },
      collectDirtyWrites: () => Promise.resolve([]),
      rememberSynced: () => undefined,
      prepareWrite: (_hostId, write) => Promise.resolve(write),
      dropAbsentFromList: (hostId, listedIds) => {
        dropComposerAbsentFromList(hostId, listedIds, boundHostByChatId);
      },
      adoptUnadoptedLandingDrafts: (_hostId, _wanted) => {
        void _hostId;
        void _wanted;
        return Promise.resolve();
      },
      applyCloudScope: () => undefined,
    };
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(
            listResponse([], 20, [{ draftId: "draft-x", revision: 5 }]),
          ),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(
        useComposerDraftStore.getState().drafts["chat-x"]?.resetEpoch,
      ).toBe(4);
    });
    const after = useComposerDraftStore.getState().drafts["chat-x"];
    expect(after?.content).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    expect(after?.selection).toEqual({ from: 1, to: 1 });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 21,
      draftId: "draft-x",
      revision: 6,
      draft: {
        draftId: "draft-x",
        kind: "chat-composer",
        target: { epicId: "epic-1", chatId: "chat-x", blockId: null },
        revision: 6,
        lastTouchedAt: 2,
        workspace: null,
        supersedes: null,
        ownerHostId: HOST_ID,
        origin: "own",
        adoption: { state: "adopted", hostId: HOST_ID },
        publication: {
          status: "unpublished",
          lastPublishedAt: null,
          publishedRevision: null,
          halted: null,
        },
        portable: {
          content: typed,
          selection: { from: 1, to: 13 },
          runSettings: null,
          composerMode: "chat",
          blobHashes: [],
          closed: false,
        },
      },
    });
    expect(useComposerDraftStore.getState().drafts["chat-x"]?.content).toEqual(
      typed,
    );
    session.close();
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("orders deletion behind an already-dispatched upsert", async () => {
    let finishUpsert: () => void = () => {
      throw new Error("upsert did not start");
    };
    const order: string[] = [];
    const write = landingWrite("ordered", 0);
    const sink = createSink({
      dirty: new Set([write.draftId]),
      writes: [{ write, generation: 1 }],
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, [])),
        upsert: async () => {
          order.push("upsert-start");
          await new Promise<void>((resolve) => {
            finishUpsert = resolve;
          });
          order.push("upsert-end");
          return {
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          };
        },
        delete: () => {
          order.push("delete");
          return Promise.resolve({ deleted: true });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => expect(order).toEqual(["upsert-start"]));
    const deleting = session.deleteOnHost(write.draftId);
    await Promise.resolve();
    expect(order).toEqual(["upsert-start"]);
    finishUpsert();
    await deleting;
    expect(order).toEqual(["upsert-start", "upsert-end", "delete"]);
    session.close();
  });

  it("drops a collected write when submission fences it during preparation", async () => {
    let finishPrepare: () => void = () => {
      throw new Error("prepare did not start");
    };
    let prepareStarted = false;
    const pendingDeletes = new Set<string>();
    const write = landingWrite("collected-before-submit", 0);
    let upsertCount = 0;
    const sink = createSink({
      dirty: new Set([write.draftId]),
      writes: [{ write, generation: 1 }],
      pendingDeletes,
      prepareWrite: async (_hostId, prepared) => {
        prepareStarted = true;
        await new Promise<void>((resolve) => {
          finishPrepare = resolve;
        });
        return prepared;
      },
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, [])),
        upsert: () => {
          upsertCount += 1;
          return Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          });
        },
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => expect(prepareStarted).toBe(true));
    pendingDeletes.add(write.draftId);
    finishPrepare();
    await vi.waitFor(() => expect(sink.synced).toEqual([]));
    expect(upsertCount).toBe(0);
    session.close();
  });

  it("upserts a landing draft created after bootstrap by adopting on the sync path", async () => {
    resetDraftMirrorCoordinatorForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    bindLandingAdoptionHost(HOST_ID);
    const upserted: string[] = [];
    const sink: DraftMirrorSink = {
      isDeletePending: () => false,
      pendingDeletesForHost: () => [],
      settleDelete: (_hostId, _draftId, _outcome) => {
        void _hostId;
        void _draftId;
        void _outcome;
      },
      isDirty: (draftId) => landingDraftIsDirty(draftId),
      applyUpsert: () => Promise.resolve(),
      applyDelete: () => undefined,
      collectDirtyWrites: (hostId) =>
        Promise.resolve(
          collectLandingDirtyWrites(hostId).map(({ draft }) => ({
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
          })),
        ),
      rememberSynced: landingDraftRememberSynced,
      prepareWrite: (_hostId, write) => Promise.resolve(write),
      dropAbsentFromList: () => undefined,
      adoptUnadoptedLandingDrafts: (hostId, wanted) =>
        adoptUnadoptedLandingDraftsForHost(hostId, wanted),
      applyCloudScope: () => undefined,
    };
    let listed = false;
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => {
          listed = true;
          return Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES));
        },
        upsert: (write) => {
          upserted.push(write.draftId);
          return Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          });
        },
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(listed).toBe(true);
    });
    const id = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(
      id,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        ],
      },
      { from: 1, to: 6 },
    );
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "unadopted" });
    session.noteDirty(id);
    await vi.waitFor(() => {
      expect(upserted).toEqual([id]);
    });
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "adopted", hostId: HOST_ID });
    session.close();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetDraftMirrorCoordinatorForTests();
  });

  it("coalesces a newer landing save behind a stalled save to the latest snapshot", async () => {
    const draftId = "coalesced-landing";
    const first = landingWrite(draftId, 0);
    const latest: Extract<DraftWrite, { readonly kind: "landing" }> = {
      ...first,
      lastTouchedAt: 2,
      portable: {
        ...first.portable,
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "latest" }] },
          ],
        },
      },
    };
    const writes: DraftDirtyWrite[] = [{ write: first, generation: 1 }];
    const dirty = new Set([draftId]);
    let collectCalls = 0;
    let prepareCalls = 0;
    let finishFirstPrepare: (() => void) | undefined;
    const firstPrepare = new Promise<void>((resolve) => {
      finishFirstPrepare = resolve;
    });
    const sent: DraftWrite[] = [];
    const sink = createSink({
      dirty,
      writes,
      collectDirtyWrites: () => {
        collectCalls += 1;
        return Promise.resolve([...writes]);
      },
      prepareWrite: async (_hostId, write) => {
        prepareCalls += 1;
        if (prepareCalls === 1) await firstPrepare;
        return write;
      },
      rememberSynced: (draftId) => {
        dirty.delete(draftId);
      },
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) => {
          sent.push(write);
          return Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          });
        },
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    const firstFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(prepareCalls).toBe(1);
    });

    writes.splice(0, writes.length, { write: latest, generation: 2 });
    const latestFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(collectCalls).toBeGreaterThanOrEqual(2);
    });
    finishFirstPrepare?.();
    await Promise.all([firstFlush, latestFlush]);

    expect(sent).toEqual([first, latest]);
    session.close();
  });

  it("does not ACK an incoming landing row when a local edit lands during apply", async () => {
    const draftId = "incoming-apply-edit";
    const incoming = landingDocument({ draftId, revision: 2 });
    const stream = createStreamHarness();
    const dirty = new Set<string>();
    const applied: DraftDocument[] = [];
    let applyFinished = false;
    let finishApply: (() => void) | undefined;
    const applyGate = new Promise<void>((resolve) => {
      finishApply = resolve;
    });
    const sink = createSink({
      dirty,
      writes: [],
      applyUpsert: async (document) => {
        applied.push(document);
        await applyGate;
        applyFinished = true;
      },
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 0, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });

    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 1,
      draftId,
      revision: incoming.revision,
      draft: incoming,
    });
    await vi.waitFor(() => {
      expect(applied).toEqual([incoming]);
    });
    dirty.add(draftId);
    finishApply?.();
    await vi.waitFor(() => {
      expect(applyFinished).toBe(true);
    });
    await Promise.resolve();

    expect(sink.synced).toEqual([]);
    session.close();
  });

  it("advances the committed upsert frontier before acknowledging deletion", async () => {
    const draftId = "late-success-after-delete";
    const heldRow = landingDocument({ draftId, revision: 4 });
    const committedRow = landingDocument({ draftId, revision: 7 });
    const stream = createStreamHarness();
    const pendingDeletes = new Set<string>();
    const writes: DraftDirtyWrite[] = [];
    let upsertStarted = false;
    let resolveUpsert:
      | ((response: { readonly draft: DraftDocument }) => void)
      | undefined;
    const upsertResponse = new Promise<{ readonly draft: DraftDocument }>(
      (resolve) => {
        resolveUpsert = resolve;
      },
    );
    const sink = createSink({
      dirty: new Set(),
      writes,
      pendingDeletes,
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 0, EMPTY_LIST_TOMBSTONES)),
        upsert: () => {
          upsertStarted = true;
          return upsertResponse;
        },
        delete: (id) => {
          pendingDeletes.add(id);
          return Promise.resolve({ deleted: true });
        },
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 4,
      draftId,
      revision: heldRow.revision,
      draft: heldRow,
    });
    await Promise.resolve();
    expect(sink.upserts).toEqual([heldRow]);

    writes.push({ write: landingWrite(draftId, 4), generation: 1 });
    const upserting = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(upsertStarted).toBe(true);
    });
    const deleting = session.deleteOnHost(draftId);
    resolveUpsert?.({ draft: committedRow });
    await deleting;
    pendingDeletes.delete(draftId);
    await upserting;

    // The delete ACK clears the chat-style pending receipt. Deletion must
    // include committed r7 in its tombstone frontier to reject the late echo.
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 7,
      draftId,
      revision: committedRow.revision,
      draft: committedRow,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.upserts).toEqual([heldRow]);
    expect(sink.synced).toEqual([
      { draftId, hostRevision: 4 },
      { draftId, hostRevision: 0 },
    ]);
    session.close();
  });

  it("preserves a newer held row when an older retired upsert completes", async () => {
    const draftId = "late-upsert-after-delete";
    const heldRow = landingDocument({ draftId, revision: 4 });
    const committedRow = landingDocument({ draftId, revision: 7 });
    const stream = createStreamHarness();
    const pendingDeletes = new Set<string>();
    const writes: DraftDirtyWrite[] = [];
    let upsertStarted = false;
    let resolveUpsert:
      | ((response: { readonly draft: DraftDocument }) => void)
      | undefined;
    const upsertResponse = new Promise<{ readonly draft: DraftDocument }>(
      (resolve) => {
        resolveUpsert = resolve;
      },
    );
    const sink = createSink({
      dirty: new Set(),
      writes,
      pendingDeletes,
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 0, EMPTY_LIST_TOMBSTONES)),
        upsert: () => {
          upsertStarted = true;
          return upsertResponse;
        },
        delete: (id) => {
          pendingDeletes.add(id);
          return Promise.resolve({ deleted: true });
        },
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 4,
      draftId,
      revision: heldRow.revision,
      draft: heldRow,
    });
    await Promise.resolve();
    expect(sink.upserts).toEqual([heldRow]);

    writes.push({ write: landingWrite(draftId, 4), generation: 1 });
    const upserting = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(upsertStarted).toBe(true);
    });
    const deleting = session.deleteOnHost(draftId);
    const newerHeldRow = landingDocument({ draftId, revision: 9 });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 9,
      draftId,
      revision: newerHeldRow.revision,
      draft: newerHeldRow,
    });
    await Promise.resolve();
    expect(sink.upserts).toEqual([heldRow, newerHeldRow]);
    resolveUpsert?.({ draft: committedRow });
    await deleting;
    pendingDeletes.delete(draftId);
    await upserting;

    // The chat-style pending receipt is cleared after the ACK. The held
    // tombstone, not a durable landing receipt, must still reject this late
    // echo and any older response.
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 7,
      draftId,
      revision: committedRow.revision,
      draft: committedRow,
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 9,
      draftId,
      revision: newerHeldRow.revision,
      draft: newerHeldRow,
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 6,
      draftId,
      revision: 6,
      draft: landingDocument({ draftId, revision: 6 }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.upserts).toEqual([heldRow, newerHeldRow]);
    expect(sink.synced).toEqual([
      { draftId, hostRevision: 4 },
      { draftId, hostRevision: 0 },
    ]);
    session.close();
  });

  it("drops waiting landing saves at delete and gates generations appended after it", async () => {
    const draftId = "cancelled-landing";
    const first = landingWrite(draftId, 0);
    const second: Extract<DraftWrite, { readonly kind: "landing" }> = {
      ...first,
      lastTouchedAt: 2,
    };
    const third: Extract<DraftWrite, { readonly kind: "landing" }> = {
      ...first,
      lastTouchedAt: 3,
    };
    const writes: DraftDirtyWrite[] = [{ write: first, generation: 1 }];
    const dirty = new Set([draftId]);
    const pendingDeletes = new Set<string>();
    let collectCalls = 0;
    let finishFirstUpsert: (() => void) | undefined;
    let upsertStarted = false;
    const firstUpsert = new Promise<void>((resolve) => {
      finishFirstUpsert = resolve;
    });
    const sent: DraftWrite[] = [];
    const deletes: string[] = [];
    const sink = createSink({
      dirty,
      writes,
      pendingDeletes,
      collectDirtyWrites: () => {
        collectCalls += 1;
        return Promise.resolve([...writes]);
      },
      rememberSynced: (draftId) => {
        dirty.delete(draftId);
      },
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) => {
          sent.push(write);
          upsertStarted = true;
          return firstUpsert.then(() => ({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }));
        },
        delete: (draftId) => {
          deletes.push(draftId);
          return Promise.resolve({ deleted: true });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    const firstFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(upsertStarted).toBe(true);
    });

    writes.splice(0, writes.length, { write: second, generation: 2 });
    const secondFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(collectCalls).toBeGreaterThanOrEqual(2);
    });
    pendingDeletes.add(draftId);
    const deleting = session.deleteOnHost(draftId);

    writes.splice(0, writes.length, { write: third, generation: 3 });
    const thirdFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(collectCalls).toBeGreaterThanOrEqual(3);
    });
    finishFirstUpsert?.();
    await Promise.all([firstFlush, secondFlush, thirdFlush, deleting]);

    expect(sent).toEqual([first]);
    expect(deletes).toEqual([draftId]);
    session.close();
  });

  // ─── F6: close() fences the blob memo ───────────────────────────────────

  const BLOB_HOST = "host-close-fence";
  const BLOB_OWNER = "owner-close-fence";

  it("F6 (10): close() fences a late putBlob acknowledgement - a confirmation that lands after close is not recorded", async () => {
    // Real bytes, a real upload dispatched, `close()` called while it is
    // still on the wire, and only THEN the response resolves.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await putImage(bytes);
    let releaseUpload: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const client: DraftBlobClient = {
      request: (async (_method, _params) => {
        await gate;
        return { ok: true as const };
      }) as HostRequester<HostRpcRegistry>["request"],
    };

    const uploadPromise = putDraftBlobs(BLOB_HOST, client, [hash], BLOB_OWNER);
    // The request has dispatched (it is parked on `gate`, inside the
    // client's own `request` call) by the time we get here - synchronous up
    // to its first await, same as every other upload-in-flight fixture in
    // this suite.

    const session = new DraftMirrorSession({
      hostId: BLOB_HOST,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: () => Promise.reject(new Error("not used")),
        delete: () => Promise.reject(new Error("not used")),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.close();

    releaseUpload();
    const confirmed = await uploadPromise;

    // Reported UNCONFIRMED, not "confirmed but unmemoized". `close()` fenced
    // the acknowledgement, and the caller's own bookkeeping is the landing
    // draft's `confirmedHostBlobHashes` - the set that decides whether the
    // local bytes may be evicted. A digest here would let the only copy go.
    expect(confirmed).toEqual([]);
    // The memo agrees: the send gate must not trust bytes on a connection this
    // client has stopped talking to.
    expect(isDraftBlobConfirmed(BLOB_HOST, hash, BLOB_OWNER)).toBe(false);
  });

  it("a reconnect re-bootstrap re-probes the capability memos, not just the confirmations (DRIVE RED)", async () => {
    // A host that comes back on a reconnect can be a host that came back on a
    // new BUILD - a restart is how an upgrade lands. Acquisition already
    // re-probes for exactly that reason, and the reconnect path re-lists
    // without re-acquiring, so a host that GAINED `drafts.putBlob` stayed
    // short-circuited until the whole tile hierarchy unmounted.
    const host = "host-rebootstrap-capability";
    const hash = await putImage(new Uint8Array([13, 14, 15, 16]));

    // The host answers "I do not have these methods" once.
    let withholds = true;
    const client: DraftBlobClient = {
      request: ((_method, _params) =>
        withholds
          ? Promise.reject(unsupportedError("drafts.putBlob"))
          : Promise.resolve({
              ok: true as const,
            })) as HostRequester<HostRpcRegistry>["request"],
    };
    expect(await putDraftBlobs(host, client, [hash], BLOB_OWNER)).toEqual([]);
    expect(hostWithholdsDraftBlobs(host)).toBe(true);

    // The host restarts into a build that has them, and the mirror re-lists.
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: host,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: () => Promise.reject(new Error("not used")),
        delete: () => Promise.reject(new Error("not used")),
      }),
      streamClient: stream.client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await Promise.resolve();
    // The FIRST `open` is the subscribe itself, which `start()` already listed
    // for; the second is the reconnect that re-bootstraps.
    stream.emitStatus("open");
    stream.emitStatus("open");
    await Promise.resolve();

    expect(hostWithholdsDraftBlobs(host)).toBe(false);
    withholds = false;
    expect(await putDraftBlobs(host, client, [hash], BLOB_OWNER)).toEqual([
      hash,
    ]);
    session.close();
  });

  it("F6 consequence: a fenced acknowledgement never reaches a landing draft's confirmedHostBlobHashes", async () => {
    // The memo is not the only consumer of `putDraftBlobs`' answer.
    // `rememberLandingBlobsOnHost` feeds that same array into the set
    // `landingDraftPinsLocalImageBytes` reads, and a draft whose every hash is
    // in it stops pinning its local bytes - so an acknowledgement from a
    // retired conversation would let the LRU discard the only copy of the
    // image. This asserts the value at the boundary the eviction gate reads.
    const bytes = new Uint8Array([9, 10, 11, 12]);
    const hash = await putImage(bytes);
    let releaseUpload: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const client: DraftBlobClient = {
      request: (async (_method, _params) => {
        await gate;
        return { ok: true as const };
      }) as HostRequester<HostRpcRegistry>["request"],
    };
    const host = "host-close-fence-eviction";

    const uploadPromise = putDraftBlobs(host, client, [hash], BLOB_OWNER);
    const session = new DraftMirrorSession({
      hostId: host,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: () => Promise.reject(new Error("not used")),
        delete: () => Promise.reject(new Error("not used")),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.close();

    releaseUpload();
    const confirmed = await uploadPromise;

    const draftId = useLandingDraftStore.getState().createDraft(null);
    rememberLandingBlobsOnHost(draftId, confirmed);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === draftId)?.confirmedHostBlobHashes,
    ).toEqual([]);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  it("F6 positive control: without close(), the identical sequence DOES confirm", async () => {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const hash = await putImage(bytes);
    let releaseUpload: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const client: DraftBlobClient = {
      request: (async (_method, _params) => {
        await gate;
        return { ok: true as const };
      }) as HostRequester<HostRpcRegistry>["request"],
    };

    const uploadPromise = putDraftBlobs(
      "host-close-fence-control",
      client,
      [hash],
      BLOB_OWNER,
    );
    releaseUpload();
    const confirmed = await uploadPromise;

    expect(confirmed).toEqual([hash]);
    expect(
      isDraftBlobConfirmed("host-close-fence-control", hash, BLOB_OWNER),
    ).toBe(true);
  });
});
