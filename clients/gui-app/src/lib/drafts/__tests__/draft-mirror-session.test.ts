import { afterEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  IStreamSession,
  ServerFrameHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  DraftDocument,
  DraftWrite,
  DraftsListResponse,
  DraftsSubscribeServerFrameV10,
} from "@traycer/protocol/host";
import {
  DraftMirrorSession,
  type DraftDirtyWrite,
  type DraftMirrorSink,
  type DraftsHostRpc,
  type DraftsStreamSubscribe,
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
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { cloudDraftsDirectoryIsVisible } from "@/lib/drafts/cloud-drafts-visibility";

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
  };
}

function landingWrite(draftId: string, revision: number): DraftWrite {
  return {
    draftId,
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision,
    lastTouchedAt: 1,
    workspace: null,
    portable: {
      content: EMPTY_DOC,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
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
  readonly sent: Array<{ readonly kind: string; readonly draftIds?: unknown }>;
  readonly subscribeCalls: { count: number };
} {
  let onFrame: ServerFrameHandler | null = null;
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
    onStatusChange: () => undefined,
    requestReconnect: () => undefined,
    close: () => undefined,
    getNegotiatedSchemaVersion: () => ({ major: 1, minor: 0 }),
  };
  return {
    emit: (frame) => {
      onFrame?.(frame, null);
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
}): DraftsHostRpc {
  return {
    list: handlers.list,
    upsert: handlers.upsert,
    delete: handlers.delete,
  };
}

function createSink(options: {
  readonly dirty: Set<string>;
  readonly writes: DraftDirtyWrite[];
  readonly dropAbsentFromList?: DraftMirrorSink["dropAbsentFromList"];
}): DraftMirrorSink & {
  readonly upserts: DraftDocument[];
  readonly deletes: string[];
  readonly scopes: string[];
  readonly synced: ReadonlyArray<{
    readonly draftId: string;
    readonly hostRevision: number;
  }>;
} {
  const upserts: DraftDocument[] = [];
  const deletes: string[] = [];
  const scopes: string[] = [];
  const synced: Array<{
    readonly draftId: string;
    readonly hostRevision: number;
  }> = [];
  return {
    upserts,
    deletes,
    scopes,
    synced,
    isDirty: (draftId) => options.dirty.has(draftId),
    applyUpsert: (document) => {
      upserts.push(document);
      return Promise.resolve();
    },
    applyDelete: (draftId) => {
      deletes.push(draftId);
    },
    collectDirtyWrites: () => Promise.resolve(options.writes),
    rememberSynced: (draftId, hostRevision) => {
      synced.push({ draftId, hostRevision });
    },
    prepareWrite: (_hostId, write) => Promise.resolve(write),
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

afterEach(() => {
  vi.useRealTimers();
  useComposerDraftStore.setState({ drafts: {} });
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
    await session.deleteOnHost("d1");
    expect(sink.synced).toEqual([]);
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
          publication: null,
        },
      },
    });
    const boundHostByChatId = new Map([["chat-x", "host-a"]]);
    let hostBDropped = false;
    const sink: DraftMirrorSink = {
      isDirty: (draftId) => composerDraftIsDirty(draftId),
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
          publication: null,
        },
      },
    });
    const boundHostByChatId = new Map([["chat-x", HOST_ID]]);
    const sink: DraftMirrorSink = {
      isDirty: (draftId) => composerDraftIsDirty(draftId),
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
        },
      },
    });
    expect(useComposerDraftStore.getState().drafts["chat-x"]?.content).toEqual(
      typed,
    );
    session.close();
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("upserts a landing draft created after bootstrap by adopting on the sync path", async () => {
    resetDraftMirrorCoordinatorForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    bindLandingAdoptionHost(HOST_ID);
    const upserted: string[] = [];
    const sink: DraftMirrorSink = {
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
});
