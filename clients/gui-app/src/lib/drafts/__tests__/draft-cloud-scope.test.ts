import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IStreamSession,
  ServerFrameHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { DraftWrite } from "@traycer/protocol/host";
import {
  acquireDraftMirrorSession,
  draftsCloudScopeId,
  flushAbsentOwnCloudDrafts,
  releaseDraftMirrorSession,
  reserveCloudDraftIngestFence,
  resetDraftMirrorCoordinatorForTests,
  subscribeDraftsCloudScope,
} from "@/lib/drafts/draft-mirror-coordinator";
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

  it("does not nudge a row applied after the directory snapshot was dispatched", async () => {
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
      drafts: [publishedOwnRow("fresh-own", {})],
      activeDraftId: null,
    });
    // Reserved after the snapshot's fence (0): newer than the directory.
    reserveCloudDraftIngestFence("fresh-own");

    expect(flushAbsentOwnCloudDrafts(new Map(), 0, new Set())).toEqual([]);
    expect(stream.sentFrames).toEqual([]);
    releaseDraftMirrorSession(HOST_ID);
  });
});
