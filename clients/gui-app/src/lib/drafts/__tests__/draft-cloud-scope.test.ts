import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IStreamSession,
  ServerFrameHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  acquireDraftMirrorSession,
  cloudDraftIngestSeq,
  draftsCloudScopeId,
  flushAbsentOwnCloudDrafts,
  ingestCloudDraftSummary,
  releaseDraftMirrorSession,
  reserveCloudDraftIngestFence,
  reserveCloudDraftSweepFence,
  resetDraftMirrorCoordinatorForTests,
  subscribeDraftsCloudScope,
  sweepAbsentCloudDraftMirrors,
} from "@/lib/drafts/draft-mirror-coordinator";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { cloudDraftsDirectoryIsVisible } from "@/lib/drafts/cloud-drafts-visibility";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";

const HOST_ID = "host-scope";
const SCOPE_ID = "scp_testdraftsscopeid000001";

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

function streamHarness(): {
  readonly client: { subscribe: () => IStreamSession };
  readonly emit: (frame: {
    readonly kind: string;
    readonly hasBinaryPayload: boolean;
    readonly scopeId?: string;
  }) => void;
  readonly subscribeCalls: { count: number };
  readonly sentFrames: unknown[];
} {
  let onFrame: ServerFrameHandler | null = null;
  const subscribeCalls = { count: 0 };
  const sentFrames: unknown[] = [];
  const session: IStreamSession = {
    sendClientFrame: (frame) => {
      sentFrames.push(frame);
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
    subscribeCalls,
    sentFrames,
    client: {
      subscribe: () => {
        subscribeCalls.count += 1;
        return session;
      },
    },
  };
}

function listNullClient() {
  return {
    request: (method: string, params: unknown) => {
      void params;
      if (method === "drafts.list") {
        return Promise.resolve({
          drafts: [],
          tombstones: [],
          snapshotSeq: 0,
          scopeId: null,
        });
      }
      if (method === "drafts.upsert") {
        const write = (params as { draft: DraftWrite }).draft;
        return Promise.resolve({
          draft: {
            ...write,
            ownerHostId: HOST_ID,
            origin: "own" as const,
            adoption: { state: "adopted" as const, hostId: HOST_ID },
            publication: {
              status: "unpublished" as const,
              lastPublishedAt: null,
              publishedRevision: null,
              halted: null,
            },
            revision: 1,
          },
        });
      }
      return Promise.reject(new Error(`unexpected ${String(method)}`));
    },
  };
}

describe("cloud-drafts scope subscribe frame", () => {
  it("makes the cloud-drafts section visible after an advisory scope frame", async () => {
    const stream = streamHarness();
    acquireDraftMirrorSession({
      hostId: HOST_ID,
      client: listNullClient() as never,
      streamClient: stream.client as never,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    expect(draftsCloudScopeId(HOST_ID)).toBeNull();
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: draftsCloudScopeId(HOST_ID),
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
      expect(draftsCloudScopeId(HOST_ID)).toBe(SCOPE_ID);
    });
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: draftsCloudScopeId(HOST_ID),
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(true);
  });

  it("notifies scope subscribers on the frame and clears the scope on release", async () => {
    const stream = streamHarness();
    let notifications = 0;
    const unsubscribe = subscribeDraftsCloudScope(() => {
      notifications += 1;
    });
    acquireDraftMirrorSession({
      hostId: HOST_ID,
      client: listNullClient() as never,
      streamClient: stream.client as never,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    const beforeFrame = notifications;
    stream.emit({
      kind: "scope",
      hasBinaryPayload: false,
      scopeId: SCOPE_ID,
    });
    // `useCloudDraftsDirectory` reads the scope through
    // `useSyncExternalStore`, so the section only appears if the advisory
    // frame actually rings the subscription - not merely if the getter
    // would now answer.
    await vi.waitFor(() => {
      expect(notifications).toBeGreaterThan(beforeFrame);
    });
    expect(draftsCloudScopeId(HOST_ID)).toBe(SCOPE_ID);

    // The last release tears the session down; a scope left behind would
    // keep the section visible for a host that is no longer connected.
    releaseDraftMirrorSession(HOST_ID);
    expect(draftsCloudScopeId(HOST_ID)).toBeNull();
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: draftsCloudScopeId(HOST_ID),
        error: null,
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(false);
    unsubscribe();
  });
});

function publishedOwnRow(
  id: string,
  overrides: Partial<LandingDraftTab>,
): LandingDraftTab {
  return {
    id,
    content: EMPTY_LANDING_DRAFT_CONTENT,
    selection: null,
    lastTouchedAt: 1,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    ...freshLandingMirrorState(),
    adoption: { state: "adopted", hostId: HOST_ID },
    ownerHostId: HOST_ID,
    origin: "own",
    hostRevision: 1,
    publication: {
      status: "current",
      lastPublishedAt: 1,
      publishedRevision: 1,
      halted: null,
    },
    ...overrides,
  };
}

/**
 * A sweep fence stamped at a position dispatched after any snapshot the
 * tests sweep with (their fences are 0 or older): the position a directory
 * request dispatched now carries.
 */
function reserveSweepFenceAtNewDispatch(
  draftId: string,
  ownerHostId: string,
): void {
  reserveCloudDraftSweepFence(draftId, ownerHostId, cloudDraftIngestSeq());
}

/**
 * The two ways a row is reserved against an older directory snapshot. Both
 * order a positive listing (or an apply) against the sweep and the flush; only
 * the ingest fence is also an apply's supersession check.
 */
const RESERVERS: ReadonlyArray<
  readonly [string, (draftId: string, ownerHostId: string) => void]
> = [
  [
    "ingest fence",
    (draftId: string): void => {
      reserveCloudDraftIngestFence(draftId);
    },
  ],
  ["sweep fence", reserveSweepFenceAtNewDispatch],
];

describe("flushAbsentOwnCloudDrafts", () => {
  it("nudges a published own row the directory no longer lists with a subscribe flush for that row, and nothing else", async () => {
    const stream = streamHarness();
    acquireDraftMirrorSession({
      hostId: HOST_ID,
      client: listNullClient() as never,
      streamClient: stream.client as never,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    useLandingDraftStore.setState({
      drafts: [
        publishedOwnRow("absent-own", {}),
        publishedOwnRow("listed-own", {}),
        publishedOwnRow("unpublished-own", {
          publication: {
            status: "unpublished",
            lastPublishedAt: null,
            publishedRevision: null,
            halted: null,
          },
        }),
        publishedOwnRow("replica-row", {
          origin: "replica",
          ownerHostId: "host-other",
          adoption: { state: "adopted", hostId: "host-other" },
        }),
        publishedOwnRow("no-session", {
          adoption: { state: "adopted", hostId: "host-unmounted" },
          ownerHostId: "host-unmounted",
        }),
        publishedOwnRow("already-nudged", {}),
      ],
      activeDraftId: null,
    });
    const listed = new Map([["listed-own", new Set([HOST_ID])]]);

    const flushed = flushAbsentOwnCloudDrafts(
      listed,
      0,
      new Set(["already-nudged"]),
    );

    expect(flushed).toEqual(["absent-own"]);
    await vi.waitFor(() => {
      expect(stream.sentFrames).toEqual([
        { kind: "flush", hasBinaryPayload: false, draftIds: ["absent-own"] },
      ]);
    });
    // Nothing is deleted client-side: the owner host settles the row.
    expect(
      useLandingDraftStore
        .getState()
        .drafts.map((draft) => draft.id)
        .sort(),
    ).toEqual(
      [
        "absent-own",
        "already-nudged",
        "listed-own",
        "no-session",
        "replica-row",
        "unpublished-own",
      ].sort(),
    );
    releaseDraftMirrorSession(HOST_ID);
  });

  it.each(RESERVERS)(
    "does not nudge a row reserved after the directory snapshot was dispatched: %s",
    async (_name, reserve) => {
      const stream = streamHarness();
      acquireDraftMirrorSession({
        hostId: HOST_ID,
        client: listNullClient() as never,
        streamClient: stream.client as never,
        timing: undefined,
      });
      await vi.waitFor(() => {
        expect(stream.subscribeCalls.count).toBe(1);
      });
      useLandingDraftStore.setState({
        drafts: [
          publishedOwnRow("fresh-own", {}),
          publishedOwnRow("stale-own", {}),
        ],
        activeDraftId: null,
      });
      // Reserved after the snapshot's fence (0): newer than the directory.
      // `stale-own` is the control: the same row, never reserved.
      reserve("fresh-own", HOST_ID);

      expect(flushAbsentOwnCloudDrafts(new Map(), 0, new Set())).toEqual([
        "stale-own",
      ]);
      await vi.waitFor(() => {
        expect(stream.sentFrames).toEqual([
          { kind: "flush", hasBinaryPayload: false, draftIds: ["stale-own"] },
        ]);
      });
      releaseDraftMirrorSession(HOST_ID);
    },
  );

  it("honours a sweep fence only under the row's own owner: another owner's listing of the same id does not hold the nudge", async () => {
    const stream = streamHarness();
    acquireDraftMirrorSession({
      hostId: HOST_ID,
      client: listNullClient() as never,
      streamClient: stream.client as never,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    useLandingDraftStore.setState({
      drafts: [publishedOwnRow("shared-id", {})],
      activeDraftId: null,
    });
    // Reserved after the snapshot's fence (0), but under ANOTHER owner: the
    // id collides across owners, the row does not. The own row is still absent
    // from the snapshot and is nudged.
    reserveSweepFenceAtNewDispatch("shared-id", "host-other");
    expect(flushAbsentOwnCloudDrafts(new Map(), 0, new Set())).toEqual([
      "shared-id",
    ]);

    // The same reservation under the row's own owner holds the nudge.
    reserveSweepFenceAtNewDispatch("shared-id", HOST_ID);
    expect(flushAbsentOwnCloudDrafts(new Map(), 0, new Set())).toEqual([]);

    await vi.waitFor(() => {
      expect(stream.sentFrames).toEqual([
        { kind: "flush", hasBinaryPayload: false, draftIds: ["shared-id"] },
      ]);
    });
    releaseDraftMirrorSession(HOST_ID);
  });

  it("flushes an own row whose sweep fence was reserved at a cached listing's dispatch position when a later-dispatched snapshot omits it", async () => {
    const stream = streamHarness();
    acquireDraftMirrorSession({
      hostId: HOST_ID,
      client: listNullClient() as never,
      streamClient: stream.client as never,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    useLandingDraftStore.setState({
      drafts: [publishedOwnRow("cached-own", {})],
      activeDraftId: null,
    });
    // The older snapshot is dispatched (f0), then a newer request (f1); the
    // walk of the cached older snapshot runs after, and stamps the row at the
    // OLDER position.
    const f0 = cloudDraftIngestSeq();
    const f1 = cloudDraftIngestSeq();
    expect(f1).toBeGreaterThan(f0);
    reserveCloudDraftSweepFence("cached-own", HOST_ID, f0);

    // The newer snapshot's absence outranks the cached listing: flushed.
    expect(flushAbsentOwnCloudDrafts(new Map(), f1, new Set())).toEqual([
      "cached-own",
    ]);
    await vi.waitFor(() => {
      expect(stream.sentFrames).toEqual([
        { kind: "flush", hasBinaryPayload: false, draftIds: ["cached-own"] },
      ]);
    });
    releaseDraftMirrorSession(HOST_ID);
  });
});

describe("sweepAbsentCloudDraftMirrors: fences", () => {
  it("does not let a sweep fence reserved at a cached listing's dispatch position outrank a later-dispatched absence, but holds against an older snapshot", () => {
    const replica = (id: string): LandingDraftTab =>
      publishedOwnRow(id, {
        origin: "replica",
        ownerHostId: "host-other",
        adoption: { state: "adopted", hostId: "host-other" },
      });
    const seedReplica = (): void => {
      useLandingDraftStore.setState({
        drafts: [replica("cached-replica")],
        activeDraftId: null,
      });
    };
    // The older snapshot is dispatched (f0), then a newer request (f1); the
    // walk of the cached older snapshot runs after, and stamps the row at the
    // OLDER position.
    const f0 = cloudDraftIngestSeq();
    const f1 = cloudDraftIngestSeq();
    expect(f1).toBeGreaterThan(f0);
    reserveCloudDraftSweepFence("cached-replica", "host-other", f0);

    // The newer snapshot (f1) omits the row: its absence is the later fact,
    // so the replica mirror is dropped.
    seedReplica();
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), f1),
    ).toEqual(["cached-replica"]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);

    // An OLDER snapshot (dispatched before the listing that reserved) omitting
    // the row does not drop it.
    seedReplica();
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), f0 - 1),
    ).toEqual([]);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "cached-replica",
    ]);
  });

  it("never moves a sweep fence back: a later reservation at an older position keeps the newer stamp", () => {
    const replica = publishedOwnRow("stamped-replica", {
      origin: "replica",
      ownerHostId: "host-other",
      adoption: { state: "adopted", hostId: "host-other" },
    });
    const older = cloudDraftIngestSeq();
    const newer = cloudDraftIngestSeq();
    reserveCloudDraftSweepFence("stamped-replica", "host-other", newer);
    reserveCloudDraftSweepFence("stamped-replica", "host-other", older);

    // Still reserved at `newer`: a snapshot dispatched at `older` cannot drop
    // the row, one dispatched at `newer` can.
    useLandingDraftStore.setState({ drafts: [replica], activeDraftId: null });
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), older),
    ).toEqual([]);
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), newer),
    ).toEqual(["stamped-replica"]);
  });

  it("holds an older snapshot's absence off an owner-less mirror when ANY owner listed the id after it, and keeps the newest listing across owners", () => {
    // A mirror with no recorded owner is treated as listed under any owner by
    // the absence predicate, so its fence is the id's under any owner: a
    // listing by host-a protects it, where it used to carry no fence at all.
    const ownerless = publishedOwnRow("ownerless-replica", {
      origin: "replica",
      ownerHostId: null,
      adoption: { state: "adopted", hostId: "host-other" },
    });
    const seedOwnerless = (): void => {
      useLandingDraftStore.setState({
        drafts: [ownerless],
        activeDraftId: null,
      });
    };
    const older = cloudDraftIngestSeq();
    const newer = cloudDraftIngestSeq();
    expect(newer).toBeGreaterThan(older);

    // Control: with no listing reserved for the id, the snapshot's absence
    // drops the owner-less mirror, whatever position it was dispatched at.
    seedOwnerless();
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), older - 1),
    ).toEqual(["ownerless-replica"]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);

    // host-a listed the id at `older`: a snapshot dispatched before that
    // listing omitting the id does not drop the owner-less mirror.
    reserveCloudDraftSweepFence("ownerless-replica", "host-a", older);
    seedOwnerless();
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), older - 1),
    ).toEqual([]);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "ownerless-replica",
    ]);

    // A snapshot dispatched after the listing is the later fact: dropped.
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), newer),
    ).toEqual(["ownerless-replica"]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);

    // Max semantics across owners: host-b listing at `newer`, then host-a
    // listing again at the older position, leaves the id fence at `newer`.
    reserveCloudDraftSweepFence("ownerless-replica", "host-b", newer);
    reserveCloudDraftSweepFence("ownerless-replica", "host-a", older);
    seedOwnerless();
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), older),
    ).toEqual([]);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "ownerless-replica",
    ]);
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), newer),
    ).toEqual(["ownerless-replica"]);
  });

  it("does not lower the owner-less fence of an id when a later owner reserves a smaller position", () => {
    const ownerless = publishedOwnRow("lowered-id", {
      origin: "replica",
      ownerHostId: null,
      adoption: { state: "adopted", hostId: "host-other" },
    });
    const smaller = cloudDraftIngestSeq();
    const larger = cloudDraftIngestSeq();
    reserveCloudDraftSweepFence("lowered-id", "host-a", larger);
    reserveCloudDraftSweepFence("lowered-id", "host-b", smaller);

    // Still held at `larger`: a snapshot dispatched at `smaller` cannot drop
    // the owner-less mirror.
    useLandingDraftStore.setState({ drafts: [ownerless], activeDraftId: null });
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), smaller),
    ).toEqual([]);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

  it.each(RESERVERS)(
    "keeps a replica reserved after the snapshot's fence and drops the same row unreserved: %s",
    (_name, reserve) => {
      const replica = (id: string): LandingDraftTab =>
        publishedOwnRow(id, {
          origin: "replica",
          ownerHostId: "host-other",
          adoption: { state: "adopted", hostId: "host-other" },
        });
      useLandingDraftStore.setState({
        drafts: [replica("reserved-replica"), replica("unreserved-replica")],
        activeDraftId: null,
      });
      // Reserved after the snapshot's fence (0): newer than the directory.
      reserve("reserved-replica", "host-other");

      const dropped = sweepAbsentCloudDraftMirrors(
        "host-ingesting",
        new Map(),
        0,
      );

      expect(dropped).toEqual(["unreserved-replica"]);
      expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
        "reserved-replica",
      ]);
    },
  );

  it("honours a sweep fence only under the mirror's own owner: another owner's listing of the same id does not keep an absent replica", () => {
    const replicaOf = (ownerHostId: string): LandingDraftTab =>
      publishedOwnRow("shared-id", {
        origin: "replica",
        ownerHostId,
        adoption: { state: "adopted", hostId: ownerHostId },
      });

    // Owner A listed the id after the snapshot's fence (0); owner B's replica
    // under the same id is absent from the listing and must still be swept.
    useLandingDraftStore.setState({
      drafts: [replicaOf("host-b")],
      activeDraftId: null,
    });
    reserveSweepFenceAtNewDispatch("shared-id", "host-a");
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0),
    ).toEqual(["shared-id"]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);

    // The same reservation under B's own owner keeps B's replica.
    useLandingDraftStore.setState({
      drafts: [replicaOf("host-b")],
      activeDraftId: null,
    });
    reserveSweepFenceAtNewDispatch("shared-id", "host-b");
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0),
    ).toEqual([]);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "shared-id",
    ]);
  });

  it("keys the sweep fence by the row's two halves injectively: a NUL inside one half does not alias another row", () => {
    const replicaOf = (draftId: string, ownerHostId: string): LandingDraftTab =>
      publishedOwnRow(draftId, {
        origin: "replica",
        ownerHostId,
        adoption: { state: "adopted", hostId: ownerHostId },
      });
    // Joined by a NUL, both pairs read "a\0b\0c".
    const nulInOwner = { draftId: "c", ownerHostId: "a\u0000b" };
    const nulInDraft = { draftId: "b\u0000c", ownerHostId: "a" };

    // The fence reserved for one row keeps that row's own replica...
    useLandingDraftStore.setState({
      drafts: [replicaOf(nulInOwner.draftId, nulInOwner.ownerHostId)],
      activeDraftId: null,
    });
    reserveSweepFenceAtNewDispatch(nulInOwner.draftId, nulInOwner.ownerHostId);
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0),
    ).toEqual([]);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);

    // ...and does not protect the other row, whose absent replica is swept.
    useLandingDraftStore.setState({
      drafts: [replicaOf(nulInDraft.draftId, nulInDraft.ownerHostId)],
      activeDraftId: null,
    });
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0),
    ).toEqual([nulInDraft.draftId]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);

    // The other way round: a fence for the NUL-in-draft row leaves the
    // NUL-in-owner row unprotected (each side starts from a fresh fence map).
    resetDraftMirrorCoordinatorForTests();
    useLandingDraftStore.setState({
      drafts: [replicaOf(nulInOwner.draftId, nulInOwner.ownerHostId)],
      activeDraftId: null,
    });
    reserveSweepFenceAtNewDispatch(nulInDraft.draftId, nulInDraft.ownerHostId);
    expect(
      sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0),
    ).toEqual([nulInOwner.draftId]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });
});

describe("a fence reservation while a landing apply awaits its blob read", () => {
  const OWNER_HOST_ID = "host-owner";
  const INGEST_HOST_ID = "host-ingest";
  const DRAFT_ID = "draft-in-flight";
  const BLOB_HASH = "ef".repeat(32);

  function landingDocumentNamingBlob(): DraftDocument {
    return {
      draftId: DRAFT_ID,
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 2,
      workspace: null,
      supersedes: null,
      ownerHostId: OWNER_HOST_ID,
      origin: "replica",
      adoption: { state: "adopted", hostId: OWNER_HOST_ID },
      publication: {
        status: "current",
        lastPublishedAt: 1,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [BLOB_HASH],
        closed: false,
      },
    };
  }

  function cloudSummaryOf(document: DraftDocument): CloudChatSummary {
    return {
      identity: {
        taskId: SCOPE_ID,
        chatId: document.draftId,
        ownerUserId: "user-1",
      },
      ownerHostId: document.ownerHostId,
      createdAt: 1,
      visibility: "private",
      title: null,
      isTitleEditedByUser: false,
      parentChatId: null,
      isArchived: false,
      runSettingsSummary: null,
      metadataUpdatedAt: 1,
      headSha256: "ab".repeat(32),
      publishedAt: 1,
      throughRecordSeq: 1,
      isOwnedByViewer: true,
    };
  }

  /**
   * Mounts the OWNER host's mirror session (the apply's blob prefetch reads
   * through `sessionClients.get(document.ownerHostId)`) with a client whose
   * `drafts.readBlob` parks until `releaseBlobRead` answers it "missing".
   */
  function mountOwnerHostWithParkedBlobRead(): {
    readonly blobReadRequested: () => boolean;
    readonly releaseBlobRead: () => void;
  } {
    let requested = false;
    let release: () => void = () => undefined;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    acquireDraftMirrorSession({
      hostId: OWNER_HOST_ID,
      client: {
        request: (method: string) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: [],
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.readBlob") {
            requested = true;
            return parked.then(() => ({
              ok: false as const,
              reason: "missing" as const,
            }));
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: streamHarness().client as never,
      timing: undefined,
    });
    return {
      blobReadRequested: () => requested,
      releaseBlobRead: release,
    };
  }

  /** Starts the ingest and returns once its blob read is parked. */
  async function startIngestAwaitingBlobRead(): Promise<{
    readonly ingest: Promise<void>;
    readonly releaseBlobRead: () => void;
  }> {
    installFreshIndexedDb();
    const owner = mountOwnerHostWithParkedBlobRead();
    await Promise.resolve(); // let the session's bootstrap `list` settle
    const document = landingDocumentNamingBlob();
    const ingest = ingestCloudDraftSummary({
      hostId: INGEST_HOST_ID,
      summary: cloudSummaryOf(document),
      document,
      readOwner: null,
    });
    await vi.waitFor(() => {
      expect(owner.blobReadRequested()).toBe(true);
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    return { ingest, releaseBlobRead: owner.releaseBlobRead };
  }

  it("installs the row when only the SWEEP fence was reserved for it meanwhile", async () => {
    const inFlight = await startIngestAwaitingBlobRead();

    // Another mount's walk lists the row and orders it against older
    // snapshots; it must not supersede the apply this mount has in flight.
    reserveSweepFenceAtNewDispatch(DRAFT_ID, OWNER_HOST_ID);
    inFlight.releaseBlobRead();
    await inFlight.ingest;

    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      DRAFT_ID,
    ]);
    releaseDraftMirrorSession(OWNER_HOST_ID);
  });

  it("abandons the apply when the INGEST fence was reserved for the row meanwhile", async () => {
    const inFlight = await startIngestAwaitingBlobRead();

    // A newer head's read starting is a supersession: whoever reserved last
    // wins the row, and this older apply installs nothing.
    reserveCloudDraftIngestFence(DRAFT_ID);
    inFlight.releaseBlobRead();
    await inFlight.ingest;

    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    releaseDraftMirrorSession(OWNER_HOST_ID);
  });
});
