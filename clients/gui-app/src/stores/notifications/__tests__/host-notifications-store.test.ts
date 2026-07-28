import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  hostNotificationsSubscribeClientFrameSchema,
  type HostNotificationEntryV21,
  type HostNotificationsAttentionCursor,
  type HostNotificationsChronologicalCursor,
  type HostNotificationsSubscribeClientFrame,
  type HostNotificationsSummary,
} from "@traycer/protocol/host/notifications/contracts";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS,
  NOTIFICATIONS_STREAM_REOPEN_MAX_BACKOFF_MS,
} from "@/lib/notifications/notification-stream-reopen";
import {
  __resetHostNotificationsStoreForTests,
  compareHostNotificationEntries,
  HOST_NOTIFICATIONS_PRESENCE_HEARTBEAT_MS,
  openHostNotificationsStream,
  selectHostNotificationIds,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";

const EMPTY_SUMMARY: HostNotificationsSummary = {
  unreadCount: 0,
  attentionCount: 0,
};

function entry(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntryV21 {
  return {
    id,
    updatedAt,
    readAt,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      epicId: "epic-1",
      chatId: "chat-1",
      outcome: "completed",
    },
  };
}

function promptEntry(id: string): HostNotificationEntryV21 {
  return promptOccurrence(id, 10);
}

function promptOccurrence(
  id: string,
  updatedAt: number,
): HostNotificationEntryV21 {
  return {
    id,
    updatedAt,
    readAt: null,
    kind: "interview.requested",
    sourceRef: id,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    epicId: "epic-1",
    chatId: "chat-1",
    payload: { epicId: "epic-1", chatId: "chat-1" },
  };
}

function chronologicalCursor(
  updatedAt: number,
  id: string,
): HostNotificationsChronologicalCursor {
  return { kind: "chronological", updatedAt, id };
}

function attentionCursor(
  updatedAt: number,
  id: string,
): HostNotificationsAttentionCursor {
  return { kind: "attention", tier: "blocking", updatedAt, id };
}

function defaultSummaryFor(
  entries: ReadonlyArray<HostNotificationEntryV21>,
): HostNotificationsSummary {
  return {
    unreadCount: entries.filter((item) => item.readAt === null).length,
    attentionCount: entries.filter((item) => item.severity === "needs_action")
      .length,
  };
}

function applySimpleSnapshot(input: {
  readonly entries: ReadonlyArray<HostNotificationEntryV21>;
  readonly summary: HostNotificationsSummary;
  readonly recentCursor: HostNotificationsChronologicalCursor | null;
  readonly attentionNext: HostNotificationsAttentionCursor | null;
}): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: {
      entries: input.entries.filter(
        (item) =>
          item.severity === "needs_action" || item.severity === "failure",
      ),
      nextCursor: input.attentionNext,
    },
    recent: { entries: input.entries, nextCursor: input.recentCursor },
    summary: input.summary,
  });
}

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  readonly clientFrames: HostNotificationsSubscribeClientFrame[] = [];
  closed = false;
  requestReconnectCount = 0;

  sendClientFrame(envelope: StreamFrameEnvelope): void {
    this.clientFrames.push(
      hostNotificationsSubscribeClientFrameSchema.parse(envelope),
    );
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  requestReconnect(): void {
    this.requestReconnectCount += 1;
  }

  close(): void {
    this.closed = true;
  }

  emitServerFrame(envelope: StreamFrameEnvelope): void {
    if (this.serverFrameHandler === null) return;
    this.serverFrameHandler(envelope, null);
  }

  emitServerFrameWithBinary(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array,
  ): void {
    if (this.serverFrameHandler === null) return;
    this.serverFrameHandler(envelope, binaryPayload);
  }

  emitOpen(): void {
    if (this.statusChangeHandler === null) return;
    this.statusChangeHandler("open", null);
  }

  emitStatus(status: "connecting" | "open" | "closed" | "reconnecting"): void {
    if (this.statusChangeHandler === null) return;
    this.statusChangeHandler(status, null);
  }

  emitClosed(reason: StreamCloseReason | null): void {
    if (this.statusChangeHandler === null) return;
    this.statusChangeHandler("closed", reason);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  session = new MockStreamSession();
  readonly sessions: MockStreamSession[] = [];
  subscribeCount = 0;
  lastSubscribeParams: unknown = null;

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      webSocketFactory: {
        create: () => {
          throw new Error("MockWsStreamClient should not open a websocket");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribeCount += 1;
    this.lastSubscribeParams = params;
    const session = new MockStreamSession();
    this.session = session;
    this.sessions.push(session);
    return session;
  }
}

describe("host notifications store", () => {
  beforeEach(() => {
    __resetHostNotificationsStoreForTests();
  });

  it("replaces byId, both cursors, and summary atomically and resets unreadRecentCursor", () => {
    useHostNotificationsStore
      .getState()
      .mergeUnreadRecentPage(
        [entry("prior-unread", 5, null)],
        chronologicalCursor(5, "prior-unread"),
        {
          snapshotEpoch: 0,
          liveLifecycleRevision:
            useHostNotificationsStore.getState().liveLifecycleRevision,
          cursor: null,
        },
      );
    expect(
      useHostNotificationsStore.getState().unreadRecentCursor,
    ).not.toBeNull();

    applySimpleSnapshot({
      entries: [entry("older", 10, null), entry("target", 20, 30)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: chronologicalCursor(10, "older"),
      attentionNext: null,
    });

    const state = useHostNotificationsStore.getState();
    expect(selectHostNotificationIds(state)).toEqual(["target", "older"]);
    expect(state.summary).toEqual({ unreadCount: 1, attentionCount: 0 });
    expect(state.recentCursor).toEqual(chronologicalCursor(10, "older"));
    expect(state.attentionCursor).toBeNull();
    expect(state.unreadRecentCursor).toBeNull();
    expect(state.unreadRecentHasLoadedOnce).toBe(false);
    expect(state.attentionStatus).toBe("idle");
    expect(state.recentStatus).toBe("idle");
    expect(state.unreadRecentStatus).toBe("idle");
    expect(state.snapshotEpoch).toBe(1);
  });

  describe("unreadRecentHasLoadedOnce", () => {
    it("starts false and is set true by a successful merge regardless of nextCursor", () => {
      expect(
        useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
      ).toBe(false);

      applySimpleSnapshot({
        entries: [entry("anchor", 100, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionNext: null,
      });
      expect(
        useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
      ).toBe(false);

      const epoch = useHostNotificationsStore.getState().snapshotEpoch;
      const revision =
        useHostNotificationsStore.getState().liveLifecycleRevision;

      // Successful first page with remaining cursor still marks loaded-once.
      useHostNotificationsStore
        .getState()
        .mergeUnreadRecentPage(
          [entry("page-1", 90, null)],
          chronologicalCursor(90, "page-1"),
          {
            snapshotEpoch: epoch,
            liveLifecycleRevision: revision,
            cursor: null,
          },
        );
      expect(
        useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
      ).toBe(true);
      expect(useHostNotificationsStore.getState().unreadRecentCursor).toEqual(
        chronologicalCursor(90, "page-1"),
      );

      // applySnapshot clears the flag for a fresh Unread-only session.
      applySimpleSnapshot({
        entries: [entry("fresh", 200, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionNext: null,
      });
      expect(
        useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
      ).toBe(false);
      expect(
        useHostNotificationsStore.getState().unreadRecentCursor,
      ).toBeNull();

      const nextEpoch = useHostNotificationsStore.getState().snapshotEpoch;
      const nextRevision =
        useHostNotificationsStore.getState().liveLifecycleRevision;

      // Successful terminal page (null nextCursor) also marks loaded-once.
      useHostNotificationsStore
        .getState()
        .mergeUnreadRecentPage([entry("last", 50, null)], null, {
          snapshotEpoch: nextEpoch,
          liveLifecycleRevision: nextRevision,
          cursor: null,
        });
      expect(
        useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
      ).toBe(true);
      expect(
        useHostNotificationsStore.getState().unreadRecentCursor,
      ).toBeNull();
    });

    it("does not set true when mergeUnreadRecentPage is stale-rejected", () => {
      applySimpleSnapshot({
        entries: [entry("anchor", 100, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionNext: null,
      });
      const staleEpoch = useHostNotificationsStore.getState().snapshotEpoch;
      const staleRevision =
        useHostNotificationsStore.getState().liveLifecycleRevision;

      // Bump epoch so the captured token is stale.
      applySimpleSnapshot({
        entries: [entry("fresh", 200, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionNext: null,
      });
      expect(
        useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
      ).toBe(false);

      useHostNotificationsStore
        .getState()
        .mergeUnreadRecentPage(
          [entry("stale-page", 10, null)],
          chronologicalCursor(10, "stale-page"),
          {
            snapshotEpoch: staleEpoch,
            liveLifecycleRevision: staleRevision,
            cursor: null,
          },
        );

      const state = useHostNotificationsStore.getState();
      expect(state.unreadRecentHasLoadedOnce).toBe(false);
      expect(state.unreadRecentCursor).toBeNull();
      expect(state.byId["stale-page"]).toBeUndefined();
      expect(state.unreadRecentStatus).toBe("idle");
    });
  });

  it("applies upsert, read-state, and removal frames atomically with exact summary", () => {
    applySimpleSnapshot({
      entries: [entry("target", 20, null), entry("gone", 10, null)],
      summary: { unreadCount: 2, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });

    useHostNotificationsStore
      .getState()
      .applyUpsertFrame(entry("target", 40, null), ["gone"], {
        unreadCount: 1,
        attentionCount: 0,
      });

    let state = useHostNotificationsStore.getState();
    expect(selectHostNotificationIds(state)).toEqual(["target"]);
    expect(state.byId.gone).toBeUndefined();
    expect(state.summary).toEqual({ unreadCount: 1, attentionCount: 0 });

    useHostNotificationsStore.getState().applyReadStateFrame(["target"], {
      readAt: 50,
      resolvedAt: null,
      removedIds: [],
      summary: { unreadCount: 0, attentionCount: 0 },
    });
    state = useHostNotificationsStore.getState();
    expect(state.byId.target.readAt).toBe(50);
    expect(state.summary).toEqual({ unreadCount: 0, attentionCount: 0 });

    useHostNotificationsStore
      .getState()
      .applyRemovalFrame(["target"], EMPTY_SUMMARY);
    state = useHostNotificationsStore.getState();
    expect(state.byId.target).toBeUndefined();
    expect(state.summary).toEqual(EMPTY_SUMMARY);
  });

  it("does not add a just-pruned backdated upsert whose id is in removedIds", () => {
    applySimpleSnapshot({
      entries: [entry("kept", 10, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });

    useHostNotificationsStore
      .getState()
      .applyUpsertFrame(entry("pruned-self", 20, null), ["pruned-self"], {
        unreadCount: 1,
        attentionCount: 0,
      });

    const state = useHostNotificationsStore.getState();
    expect(state.byId["pruned-self"]).toBeUndefined();
    expect(selectHostNotificationIds(state)).toEqual(["kept"]);
    expect(state.summary).toEqual({ unreadCount: 1, attentionCount: 0 });
  });

  it("keeps exact summary independent of byId contents", () => {
    applySimpleSnapshot({
      entries: [entry("a", 10, null)],
      summary: { unreadCount: 99, attentionCount: 7 },
      recentCursor: null,
      attentionNext: null,
    });
    expect(useHostNotificationsStore.getState().summary).toEqual({
      unreadCount: 99,
      attentionCount: 7,
    });

    useHostNotificationsStore
      .getState()
      .applyUpsertFrame(entry("b", 20, null), [], {
        unreadCount: 3,
        attentionCount: 1,
      });
    // byId has 2 unread rows, but summary is authoritative.
    expect(useHostNotificationsStore.getState().summary).toEqual({
      unreadCount: 3,
      attentionCount: 1,
    });
    expect(
      Object.values(useHostNotificationsStore.getState().byId).filter(
        (item) => item.readAt === null,
      ),
    ).toHaveLength(2);
  });

  it("patches resolvedAt with read-state frames", () => {
    applySimpleSnapshot({
      entries: [promptEntry("question")],
      summary: defaultSummaryFor([promptEntry("question")]),
      recentCursor: null,
      attentionNext: null,
    });
    useHostNotificationsStore.getState().applyReadStateFrame(["question"], {
      readAt: 20,
      resolvedAt: 20,
      removedIds: [],
      summary: { unreadCount: 0, attentionCount: 0 },
    });

    expect(useHostNotificationsStore.getState().byId.question).toMatchObject({
      readAt: 20,
      resolvedAt: 20,
      updatedAt: 10,
    });
  });

  it("preserves frame read state over an equal-timestamp pagination row", () => {
    applySimpleSnapshot({
      entries: [promptEntry("question")],
      summary: defaultSummaryFor([promptEntry("question")]),
      recentCursor: null,
      attentionNext: null,
    });
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;
    useHostNotificationsStore.getState().applyReadStateFrame(["question"], {
      readAt: 20,
      resolvedAt: 20,
      removedIds: [],
      summary: { unreadCount: 0, attentionCount: 0 },
    });
    useHostNotificationsStore
      .getState()
      .mergeRecentPage([promptEntry("question")], null, {
        snapshotEpoch,
        liveLifecycleRevision:
          useHostNotificationsStore.getState().liveLifecycleRevision,
        cursor: null,
      });

    expect(useHostNotificationsStore.getState().byId.question).toMatchObject({
      readAt: 20,
      resolvedAt: 20,
    });
  });

  it("allows a genuinely newer upsert to replace a prior local read state", () => {
    applySimpleSnapshot({
      entries: [entry("target", 10, null)],
      summary: defaultSummaryFor([entry("target", 10, null)]),
      recentCursor: null,
      attentionNext: null,
    });
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;
    useHostNotificationsStore
      .getState()
      .markReadLocally(["target"], 20, snapshotEpoch);

    useHostNotificationsStore
      .getState()
      .applyUpsertFrame(entry("target", 11, null), [], {
        unreadCount: 1,
        attentionCount: 0,
      });

    expect(useHostNotificationsStore.getState().byId.target.readAt).toBeNull();
  });

  it("lets a newer same-id upsert re-open Attention after a resolve frame", () => {
    // Approval/interview ids are stable per chat; a later prompt reuses the id
    // with a fresh updatedAt. With no optimistic resolve write, the client
    // simply trusts frames: resolve then a newer unresolved upsert must leave
    // the row pending again (the new occurrence wins).
    const stableId = "approval.requested:chat-1";
    const older = promptOccurrence(stableId, 100);
    const newer = promptOccurrence(stableId, 200);
    applySimpleSnapshot({
      entries: [older],
      summary: defaultSummaryFor([older]),
      recentCursor: null,
      attentionNext: null,
    });

    useHostNotificationsStore.getState().applyReadStateFrame([stableId], {
      readAt: 150,
      resolvedAt: 150,
      removedIds: [],
      summary: { unreadCount: 0, attentionCount: 0 },
    });
    expect(useHostNotificationsStore.getState().byId[stableId]).toMatchObject({
      updatedAt: 100,
      readAt: 150,
      resolvedAt: 150,
    });

    useHostNotificationsStore.getState().applyUpsertFrame(newer, [], {
      unreadCount: 1,
      attentionCount: 1,
    });

    expect(useHostNotificationsStore.getState().byId[stableId]).toMatchObject({
      updatedAt: 200,
      readAt: null,
      resolvedAt: null,
    });
    expect(useHostNotificationsStore.getState().summary).toEqual({
      unreadCount: 1,
      attentionCount: 1,
    });
  });

  it("merges pages into byId and advances only the matching cursor track", () => {
    applySimpleSnapshot({
      entries: [entry("same", 100, null), entry("top", 120, null)],
      summary: { unreadCount: 2, attentionCount: 0 },
      recentCursor: chronologicalCursor(100, "same"),
      attentionNext: null,
    });
    useHostNotificationsStore
      .getState()
      .applyUpsertFrame(entry("same", 130, null), [], {
        unreadCount: 2,
        attentionCount: 0,
      });
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;
    const recentCursor = useHostNotificationsStore.getState().recentCursor;

    useHostNotificationsStore
      .getState()
      .mergeRecentPage(
        [entry("same", 90, 95), entry("older", 80, null)],
        chronologicalCursor(80, "older"),
        {
          snapshotEpoch,
          liveLifecycleRevision:
            useHostNotificationsStore.getState().liveLifecycleRevision,
          cursor: recentCursor,
        },
      );

    const state = useHostNotificationsStore.getState();
    expect(selectHostNotificationIds(state)).toEqual(["same", "top", "older"]);
    expect(state.byId.same.updatedAt).toBe(130);
    expect(state.recentCursor).toEqual(chronologicalCursor(80, "older"));
    expect(state.attentionCursor).toBeNull();
    expect(state.unreadRecentCursor).toBeNull();
  });

  it("discards a stale-epoch page response entirely", () => {
    applySimpleSnapshot({
      entries: [entry("old", 100, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: chronologicalCursor(100, "old"),
      attentionNext: null,
    });
    const staleEpoch = useHostNotificationsStore.getState().snapshotEpoch;
    const staleCursor = useHostNotificationsStore.getState().recentCursor;

    applySimpleSnapshot({
      entries: [entry("fresh", 200, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: chronologicalCursor(200, "fresh"),
      attentionNext: null,
    });
    const currentEpoch = useHostNotificationsStore.getState().snapshotEpoch;
    const currentCursor = useHostNotificationsStore.getState().recentCursor;

    useHostNotificationsStore
      .getState()
      .mergeRecentPage(
        [entry("stale-page", 50, null)],
        chronologicalCursor(50, "stale-page"),
        {
          snapshotEpoch: staleEpoch,
          liveLifecycleRevision:
            useHostNotificationsStore.getState().liveLifecycleRevision,
          cursor: staleCursor,
        },
      );

    const state = useHostNotificationsStore.getState();
    expect(state.byId["stale-page"]).toBeUndefined();
    expect(state.byId.fresh).toBeDefined();
    expect(state.recentCursor).toEqual(currentCursor);
    expect(state.recentCursor).not.toEqual(
      chronologicalCursor(50, "stale-page"),
    );
    // markReadLocally is epoch-guarded: stale epoch is a no-op.
    useHostNotificationsStore
      .getState()
      .markReadLocally(["fresh"], 250, staleEpoch);
    expect(useHostNotificationsStore.getState().byId.fresh.readAt).toBeNull();

    // The next request built from the CURRENT token still merges normally -
    // the discard path does not leave the store permanently stuck.
    useHostNotificationsStore
      .getState()
      .mergeRecentPage(
        [entry("retry-page", 40, null)],
        chronologicalCursor(40, "retry-page"),
        {
          snapshotEpoch: currentEpoch,
          liveLifecycleRevision:
            useHostNotificationsStore.getState().liveLifecycleRevision,
          cursor: currentCursor,
        },
      );
    const retried = useHostNotificationsStore.getState();
    expect(retried.byId["retry-page"]).toBeDefined();
    expect(retried.recentCursor).toEqual(chronologicalCursor(40, "retry-page"));
  });

  it("discards a stale-cursor page response entirely", () => {
    applySimpleSnapshot({
      entries: [entry("anchor", 100, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: chronologicalCursor(100, "anchor"),
      attentionNext: null,
    });
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;
    const staleCursor = useHostNotificationsStore.getState().recentCursor;

    // Live frame advances the recent cursor conceptually by a later merge.
    useHostNotificationsStore
      .getState()
      .mergeRecentPage(
        [entry("page-1", 90, null)],
        chronologicalCursor(90, "page-1"),
        {
          snapshotEpoch,
          liveLifecycleRevision:
            useHostNotificationsStore.getState().liveLifecycleRevision,
          cursor: staleCursor,
        },
      );
    const liveCursor = useHostNotificationsStore.getState().recentCursor;
    expect(liveCursor).toEqual(chronologicalCursor(90, "page-1"));

    // Stale response still carrying the pre-live cursor must not rewind it,
    // nor merge any of its rows.
    useHostNotificationsStore
      .getState()
      .mergeRecentPage(
        [entry("late", 80, null)],
        chronologicalCursor(80, "late"),
        {
          snapshotEpoch,
          liveLifecycleRevision:
            useHostNotificationsStore.getState().liveLifecycleRevision,
          cursor: staleCursor,
        },
      );

    const state = useHostNotificationsStore.getState();
    expect(state.byId.late).toBeUndefined();
    expect(state.recentCursor).toEqual(liveCursor);

    // The next request built from the CURRENT (post-live-frame) token still
    // merges normally.
    useHostNotificationsStore
      .getState()
      .mergeRecentPage(
        [entry("retry-page", 70, null)],
        chronologicalCursor(70, "retry-page"),
        {
          snapshotEpoch,
          liveLifecycleRevision:
            useHostNotificationsStore.getState().liveLifecycleRevision,
          cursor: liveCursor,
        },
      );
    const retried = useHostNotificationsStore.getState();
    expect(retried.byId["retry-page"]).toBeDefined();
    expect(retried.recentCursor).toEqual(chronologicalCursor(70, "retry-page"));
  });

  it("guards attention, recent, and unreadRecent tracks independently", () => {
    applySimpleSnapshot({
      entries: [promptEntry("prompt"), entry("done", 20, null)],
      summary: { unreadCount: 2, attentionCount: 1 },
      recentCursor: chronologicalCursor(10, "prompt"),
      attentionNext: attentionCursor(10, "prompt"),
    });
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;

    useHostNotificationsStore.getState().setPageStatus("attention", "loading");
    useHostNotificationsStore.getState().setPageStatus("recent", "error");
    useHostNotificationsStore
      .getState()
      .setPageStatus("unreadRecent", "loading");

    let state = useHostNotificationsStore.getState();
    expect(state.attentionStatus).toBe("loading");
    expect(state.recentStatus).toBe("error");
    expect(state.unreadRecentStatus).toBe("loading");

    useHostNotificationsStore
      .getState()
      .mergeAttentionPage(
        [promptEntry("older-prompt")],
        attentionCursor(5, "older-prompt"),
        {
          snapshotEpoch,
          liveLifecycleRevision:
            useHostNotificationsStore.getState().liveLifecycleRevision,
          cursor: attentionCursor(10, "prompt"),
        },
      );
    useHostNotificationsStore
      .getState()
      .mergeUnreadRecentPage(
        [entry("unread-page", 5, null)],
        chronologicalCursor(5, "unread-page"),
        {
          snapshotEpoch,
          liveLifecycleRevision:
            useHostNotificationsStore.getState().liveLifecycleRevision,
          cursor: null,
        },
      );

    state = useHostNotificationsStore.getState();
    expect(state.attentionCursor).toEqual(attentionCursor(5, "older-prompt"));
    expect(state.recentCursor).toEqual(chronologicalCursor(10, "prompt"));
    expect(state.unreadRecentCursor).toEqual(
      chronologicalCursor(5, "unread-page"),
    );
    expect(state.attentionStatus).toBe("idle");
    expect(state.recentStatus).toBe("error");
    expect(state.unreadRecentStatus).toBe("idle");
  });

  it("nulls summary when connection leaves open while preserving byId", () => {
    applySimpleSnapshot({
      entries: [entry("kept", 10, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    useHostNotificationsStore.getState().setConnectionStatus("open");
    expect(useHostNotificationsStore.getState().summary).toEqual({
      unreadCount: 1,
      attentionCount: 0,
    });

    useHostNotificationsStore.getState().setConnectionStatus("reconnecting");
    const state = useHostNotificationsStore.getState();
    expect(state.summary).toBeNull();
    expect(state.byId.kept).toBeDefined();
    expect(state.connectionStatus).toBe("reconnecting");
  });

  it("marks summary unknown and requests session reconnect after a malformed server frame", () => {
    const client = new MockWsStreamClient();
    applySimpleSnapshot({
      entries: [entry("kept", 10, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 123,
      displayChannelEmission: () => undefined,
      onFeedFrame: () => undefined,
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    expect(client.subscribeCount).toBe(1);
    expect(client.lastSubscribeParams).toEqual({
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });
    expect(client.sessions[0]?.closed).toBe(false);
    expect(client.sessions[0]?.requestReconnectCount).toBe(0);

    client.session.emitServerFrame({
      kind: "upserted",
      hasBinaryPayload: false,
      entry: entry("live", 20, null),
      // missing removedIds + summary → schema failure
    });

    // Integrity failure degrades the exact summary but keeps already-rendered
    // rows, and asks the existing session to redial through its own backoff
    // rather than close() + subscribe() a second session (hot redial loop).
    expect(useHostNotificationsStore.getState().summary).toBeNull();
    expect(useHostNotificationsStore.getState().byId.kept).toBeDefined();
    expect(client.subscribeCount).toBe(1);
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]?.closed).toBe(false);
    expect(client.sessions[0]?.requestReconnectCount).toBe(1);
    close();
  });

  it("discards an attention page that crosses a live removal revision", () => {
    const row = promptEntry("attention-row");
    applySimpleSnapshot({
      entries: [row],
      summary: { unreadCount: 1, attentionCount: 1 },
      recentCursor: null,
      attentionNext: attentionCursor(10, row.id),
    });
    const state = useHostNotificationsStore.getState();
    const expected = {
      snapshotEpoch: state.snapshotEpoch,
      liveLifecycleRevision: state.liveLifecycleRevision,
      cursor: state.attentionCursor,
    };
    state.setPageStatus("attention", "loading");
    state.applyRemovalFrame([row.id], EMPTY_SUMMARY);
    state.mergeAttentionPage([row], expected.cursor, expected);

    const after = useHostNotificationsStore.getState();
    expect(after.byId[row.id]).toBeUndefined();
    expect(after.summary).toEqual(EMPTY_SUMMARY);
    expect(after.attentionCursor).toEqual(expected.cursor);
    expect(after.attentionStatus).toBe("idle");
  });

  it("discards a recent page that crosses a live removal revision", () => {
    const row = entry("recent-row", 20, null);
    applySimpleSnapshot({
      entries: [row],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: chronologicalCursor(20, row.id),
      attentionNext: null,
    });
    const state = useHostNotificationsStore.getState();
    const expected = {
      snapshotEpoch: state.snapshotEpoch,
      liveLifecycleRevision: state.liveLifecycleRevision,
      cursor: state.recentCursor,
    };
    state.setPageStatus("recent", "loading");
    state.applyRemovalFrame([row.id], EMPTY_SUMMARY);
    state.mergeRecentPage([row], expected.cursor, expected);

    const after = useHostNotificationsStore.getState();
    expect(after.byId[row.id]).toBeUndefined();
    expect(after.summary).toEqual(EMPTY_SUMMARY);
    expect(after.recentCursor).toEqual(expected.cursor);
    expect(after.recentStatus).toBe("idle");
  });

  it("discards an unread-recent page that crosses a live removal revision", () => {
    const row = entry("unread-row", 30, null);
    applySimpleSnapshot({
      entries: [row],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    const state = useHostNotificationsStore.getState();
    const expected = {
      snapshotEpoch: state.snapshotEpoch,
      liveLifecycleRevision: state.liveLifecycleRevision,
      cursor: state.unreadRecentCursor,
    };
    state.setPageStatus("unreadRecent", "loading");
    state.applyRemovalFrame([row.id], EMPTY_SUMMARY);
    state.mergeUnreadRecentPage([row], expected.cursor, expected);

    const after = useHostNotificationsStore.getState();
    expect(after.byId[row.id]).toBeUndefined();
    expect(after.summary).toEqual(EMPTY_SUMMARY);
    expect(after.unreadRecentCursor).toBeNull();
    expect(after.unreadRecentStatus).toBe("idle");
  });

  // These three reproduce the exact ABA collision from the review's read-only
  // repro: a page-request token is captured, `reset()` fires, and a fresh
  // snapshot lands whose epoch/revision would equal the captured token again
  // if the counters were zeroed by reset. Because both counters are
  // monotonic across the store's entire lifetime (never reset to 0), the
  // post-reset epoch keeps climbing past the captured value, so the stale
  // response is discarded rather than resurrecting the prior identity's row.
  it("discards an attention page whose captured token collides with a post-reset snapshot (ABA)", () => {
    applySimpleSnapshot({
      entries: [promptEntry("prior-user")],
      summary: { unreadCount: 1, attentionCount: 1 },
      recentCursor: null,
      attentionNext: null,
    });
    const capturedToken = {
      snapshotEpoch: useHostNotificationsStore.getState().snapshotEpoch,
      liveLifecycleRevision:
        useHostNotificationsStore.getState().liveLifecycleRevision,
      cursor: useHostNotificationsStore.getState().attentionCursor,
    };

    useHostNotificationsStore.getState().reset();
    applySimpleSnapshot({
      entries: [promptEntry("fresh-user")],
      summary: { unreadCount: 1, attentionCount: 1 },
      recentCursor: null,
      attentionNext: null,
    });

    useHostNotificationsStore
      .getState()
      .mergeAttentionPage([promptEntry("stale-page")], null, capturedToken);

    const state = useHostNotificationsStore.getState();
    expect(state.byId["stale-page"]).toBeUndefined();
    expect(state.byId["prior-user"]).toBeUndefined();
    expect(state.byId["fresh-user"]).toBeDefined();

    // A retry built from the CURRENT token still merges normally afterward.
    const currentToken = {
      snapshotEpoch: state.snapshotEpoch,
      liveLifecycleRevision: state.liveLifecycleRevision,
      cursor: state.attentionCursor,
    };
    useHostNotificationsStore
      .getState()
      .mergeAttentionPage(
        [promptEntry("retry-page")],
        attentionCursor(5, "retry-page"),
        currentToken,
      );
    const retried = useHostNotificationsStore.getState();
    expect(retried.byId["retry-page"]).toBeDefined();
    expect(retried.attentionCursor).toEqual(attentionCursor(5, "retry-page"));
  });

  it("discards a recent page whose captured token collides with a post-reset snapshot (ABA)", () => {
    applySimpleSnapshot({
      entries: [entry("prior-user", 100, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    const capturedToken = {
      snapshotEpoch: useHostNotificationsStore.getState().snapshotEpoch,
      liveLifecycleRevision:
        useHostNotificationsStore.getState().liveLifecycleRevision,
      cursor: useHostNotificationsStore.getState().recentCursor,
    };

    // Same-host identity reset landing while the page request above is still
    // in flight: `reset()` fires, then a replacement snapshot for the new
    // identity lands BEFORE the old request's response resolves.
    useHostNotificationsStore.getState().reset();
    applySimpleSnapshot({
      entries: [entry("fresh-user", 50, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });

    // The old request's response resolves only now, carrying the pre-reset
    // token.
    useHostNotificationsStore
      .getState()
      .mergeRecentPage([entry("stale-page", 10, null)], null, capturedToken);

    const state = useHostNotificationsStore.getState();
    expect(state.byId["stale-page"]).toBeUndefined();
    expect(state.byId["prior-user"]).toBeUndefined();
    expect(state.byId["fresh-user"]).toBeDefined();

    // A retry built from the CURRENT token still merges normally afterward.
    const currentToken = {
      snapshotEpoch: state.snapshotEpoch,
      liveLifecycleRevision: state.liveLifecycleRevision,
      cursor: state.recentCursor,
    };
    useHostNotificationsStore
      .getState()
      .mergeRecentPage(
        [entry("retry-page", 5, null)],
        chronologicalCursor(5, "retry-page"),
        currentToken,
      );
    const retried = useHostNotificationsStore.getState();
    expect(retried.byId["retry-page"]).toBeDefined();
    expect(retried.recentCursor).toEqual(chronologicalCursor(5, "retry-page"));
  });

  it("discards an unread-recent page whose captured token collides with a post-reset snapshot (ABA)", () => {
    applySimpleSnapshot({
      entries: [entry("prior-user", 100, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    const capturedToken = {
      snapshotEpoch: useHostNotificationsStore.getState().snapshotEpoch,
      liveLifecycleRevision:
        useHostNotificationsStore.getState().liveLifecycleRevision,
      cursor: useHostNotificationsStore.getState().unreadRecentCursor,
    };

    useHostNotificationsStore.getState().reset();
    applySimpleSnapshot({
      entries: [entry("fresh-user", 50, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });

    useHostNotificationsStore
      .getState()
      .mergeUnreadRecentPage(
        [entry("stale-page", 10, null)],
        null,
        capturedToken,
      );

    const state = useHostNotificationsStore.getState();
    expect(state.byId["stale-page"]).toBeUndefined();
    expect(state.byId["prior-user"]).toBeUndefined();
    expect(state.byId["fresh-user"]).toBeDefined();

    // A retry built from the CURRENT token still merges normally afterward.
    const currentToken = {
      snapshotEpoch: state.snapshotEpoch,
      liveLifecycleRevision: state.liveLifecycleRevision,
      cursor: state.unreadRecentCursor,
    };
    useHostNotificationsStore
      .getState()
      .mergeUnreadRecentPage(
        [entry("retry-page", 5, null)],
        chronologicalCursor(5, "retry-page"),
        currentToken,
      );
    const retried = useHostNotificationsStore.getState();
    expect(retried.byId["retry-page"]).toBeDefined();
    expect(retried.unreadRecentCursor).toEqual(
      chronologicalCursor(5, "retry-page"),
    );
  });

  // Pre-snapshot reset interval: an in-flight null-cursor page resolves after
  // `reset()` but BEFORE any replacement snapshot. Reset must advance both
  // tokens immediately so the stale response cannot merge into the empty
  // replica; a current-token retry must still succeed afterward.
  it("discards a pre-snapshot-interval attention page after reset before any replacement snapshot", () => {
    applySimpleSnapshot({
      entries: [promptEntry("prior-user")],
      summary: { unreadCount: 1, attentionCount: 1 },
      recentCursor: null,
      attentionNext: null,
    });
    const capturedToken = {
      snapshotEpoch: useHostNotificationsStore.getState().snapshotEpoch,
      liveLifecycleRevision:
        useHostNotificationsStore.getState().liveLifecycleRevision,
      cursor: null as HostNotificationsAttentionCursor | null,
    };
    expect(useHostNotificationsStore.getState().attentionCursor).toBeNull();

    useHostNotificationsStore.getState().reset();
    // Intentionally no replacement snapshot - the cleared pre-snapshot window.

    useHostNotificationsStore
      .getState()
      .mergeAttentionPage(
        [promptEntry("stale-page")],
        attentionCursor(999, "stale-cursor-marker"),
        capturedToken,
      );

    const afterStale = useHostNotificationsStore.getState();
    expect(afterStale.byId).toEqual({});
    expect(afterStale.byId["stale-page"]).toBeUndefined();
    // Stale response carried a non-null nextCursor; rejection must not apply it.
    expect(afterStale.attentionCursor).toBeNull();
    expect(afterStale.attentionCursor).not.toEqual(
      attentionCursor(999, "stale-cursor-marker"),
    );
    expect(afterStale.attentionStatus).toBe("idle");

    const currentToken = {
      snapshotEpoch: afterStale.snapshotEpoch,
      liveLifecycleRevision: afterStale.liveLifecycleRevision,
      cursor: afterStale.attentionCursor,
    };
    useHostNotificationsStore
      .getState()
      .mergeAttentionPage(
        [promptEntry("retry-page")],
        attentionCursor(5, "retry-page"),
        currentToken,
      );
    const retried = useHostNotificationsStore.getState();
    expect(retried.byId["retry-page"]).toBeDefined();
    expect(retried.attentionCursor).toEqual(attentionCursor(5, "retry-page"));
    expect(retried.attentionStatus).toBe("idle");
  });

  it("discards a pre-snapshot-interval recent page after reset before any replacement snapshot", () => {
    applySimpleSnapshot({
      entries: [entry("prior-user", 100, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    const capturedToken = {
      snapshotEpoch: useHostNotificationsStore.getState().snapshotEpoch,
      liveLifecycleRevision:
        useHostNotificationsStore.getState().liveLifecycleRevision,
      cursor: null as HostNotificationsChronologicalCursor | null,
    };
    expect(useHostNotificationsStore.getState().recentCursor).toBeNull();

    useHostNotificationsStore.getState().reset();

    useHostNotificationsStore
      .getState()
      .mergeRecentPage(
        [entry("stale-page", 10, null)],
        chronologicalCursor(999, "stale-cursor-marker"),
        capturedToken,
      );

    const afterStale = useHostNotificationsStore.getState();
    expect(afterStale.byId).toEqual({});
    expect(afterStale.byId["stale-page"]).toBeUndefined();
    // Stale response carried a non-null nextCursor; rejection must not apply it.
    expect(afterStale.recentCursor).toBeNull();
    expect(afterStale.recentCursor).not.toEqual(
      chronologicalCursor(999, "stale-cursor-marker"),
    );
    expect(afterStale.recentStatus).toBe("idle");

    const currentToken = {
      snapshotEpoch: afterStale.snapshotEpoch,
      liveLifecycleRevision: afterStale.liveLifecycleRevision,
      cursor: afterStale.recentCursor,
    };
    useHostNotificationsStore
      .getState()
      .mergeRecentPage(
        [entry("retry-page", 5, null)],
        chronologicalCursor(5, "retry-page"),
        currentToken,
      );
    const retried = useHostNotificationsStore.getState();
    expect(retried.byId["retry-page"]).toBeDefined();
    expect(retried.recentCursor).toEqual(chronologicalCursor(5, "retry-page"));
    expect(retried.recentStatus).toBe("idle");
  });

  it("discards a pre-snapshot-interval unread-recent page after reset before any replacement snapshot", () => {
    applySimpleSnapshot({
      entries: [entry("prior-user", 100, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    const capturedToken = {
      snapshotEpoch: useHostNotificationsStore.getState().snapshotEpoch,
      liveLifecycleRevision:
        useHostNotificationsStore.getState().liveLifecycleRevision,
      cursor: null as HostNotificationsChronologicalCursor | null,
    };
    expect(useHostNotificationsStore.getState().unreadRecentCursor).toBeNull();

    useHostNotificationsStore.getState().reset();

    useHostNotificationsStore
      .getState()
      .mergeUnreadRecentPage(
        [entry("stale-page", 10, null)],
        chronologicalCursor(999, "stale-cursor-marker"),
        capturedToken,
      );

    const afterStale = useHostNotificationsStore.getState();
    expect(afterStale.byId).toEqual({});
    expect(afterStale.byId["stale-page"]).toBeUndefined();
    // Stale response carried a non-null nextCursor; rejection must not apply it.
    expect(afterStale.unreadRecentCursor).toBeNull();
    expect(afterStale.unreadRecentCursor).not.toEqual(
      chronologicalCursor(999, "stale-cursor-marker"),
    );
    expect(afterStale.unreadRecentStatus).toBe("idle");

    const currentToken = {
      snapshotEpoch: afterStale.snapshotEpoch,
      liveLifecycleRevision: afterStale.liveLifecycleRevision,
      cursor: afterStale.unreadRecentCursor,
    };
    useHostNotificationsStore
      .getState()
      .mergeUnreadRecentPage(
        [entry("retry-page", 5, null)],
        chronologicalCursor(5, "retry-page"),
        currentToken,
      );
    const retried = useHostNotificationsStore.getState();
    expect(retried.byId["retry-page"]).toBeDefined();
    expect(retried.unreadRecentCursor).toEqual(
      chronologicalCursor(5, "retry-page"),
    );
    expect(retried.unreadRecentStatus).toBe("idle");
  });

  it("marks summary unknown and requests session reconnect after an unexpected binary frame", () => {
    const client = new MockWsStreamClient();
    applySimpleSnapshot({
      entries: [entry("kept", 10, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    const close = openHostNotificationsStream(client, null, {
      windowId: "window-binary",
      now: () => 123,
      displayChannelEmission: () => undefined,
      onFeedFrame: () => undefined,
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    // Notification frames are text-only; a non-null binary companion is the
    // same connection-integrity failure as a schema-invalid envelope.
    client.session.emitServerFrameWithBinary(
      {
        kind: "snapshot",
        hasBinaryPayload: true,
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: EMPTY_SUMMARY,
      },
      new Uint8Array([1, 2, 3]),
    );

    expect(useHostNotificationsStore.getState().summary).toBeNull();
    expect(useHostNotificationsStore.getState().byId.kept).toBeDefined();
    expect(client.subscribeCount).toBe(1);
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]?.closed).toBe(false);
    expect(client.sessions[0]?.requestReconnectCount).toBe(1);
    close();
  });

  it("orders equal-updatedAt host rows by SQLite code-unit id ASC, not localeCompare", () => {
    // Stable premise: uppercase code units precede lowercase (Z=90, a=97).
    // Lock the comparator to the SQLite-exact code-unit path
    // (compareFeedIdAscending), not locale-sensitive collation.
    expect("Z".charCodeAt(0)).toBeLessThan("a".charCodeAt(0));

    applySimpleSnapshot({
      entries: [
        entry("a", 100, null),
        entry("Z", 100, null),
        entry("mid", 200, null),
        entry("old", 50, null),
      ],
      summary: { unreadCount: 4, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });

    expect(
      selectHostNotificationIds(useHostNotificationsStore.getState()),
    ).toEqual(["mid", "Z", "a", "old"]);

    expect(
      compareHostNotificationEntries(
        entry("Z", 100, null),
        entry("a", 100, null),
      ),
    ).toBeLessThan(0);
    expect(
      compareHostNotificationEntries(
        entry("a", 100, null),
        entry("Z", 100, null),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareHostNotificationEntries(
        entry("same", 100, null),
        entry("same", 100, null),
      ),
    ).toBe(0);
  });

  it("reset clears every host replica field except the monotonic lifecycle tokens", () => {
    applySimpleSnapshot({
      entries: [entry("x", 10, null)],
      summary: { unreadCount: 1, attentionCount: 0 },
      recentCursor: chronologicalCursor(10, "x"),
      attentionNext: attentionCursor(10, "x"),
    });
    useHostNotificationsStore
      .getState()
      .applyUpsertFrame(entry("x", 20, null), [], {
        unreadCount: 1,
        attentionCount: 0,
      });
    useHostNotificationsStore.getState().setConnectionStatus("open");
    useHostNotificationsStore.getState().setPageStatus("recent", "loading");
    const preResetEpoch = useHostNotificationsStore.getState().snapshotEpoch;
    const preResetRevision =
      useHostNotificationsStore.getState().liveLifecycleRevision;
    expect(preResetEpoch).toBeGreaterThan(0);
    expect(preResetRevision).toBeGreaterThan(0);

    useHostNotificationsStore.getState().reset();

    const state = useHostNotificationsStore.getState();
    expect(state).toMatchObject({
      byId: {},
      summary: null,
      attentionCursor: null,
      recentCursor: null,
      unreadRecentCursor: null,
      unreadRecentHasLoadedOnce: false,
      attentionStatus: "idle",
      recentStatus: "idle",
      unreadRecentStatus: "idle",
      connectionStatus: "connecting",
    });
    // Both counters advance by exactly one on every reset and never fall
    // back, so a captured pre-reset token cannot match again even before a
    // replacement snapshot lands (and cannot collide after one does).
    expect(state.snapshotEpoch).toBe(preResetEpoch + 1);
    expect(state.liveLifecycleRevision).toBe(preResetRevision + 1);
  });

  it("surfaces entity refs from read-state frames even when their ids are not loaded", () => {
    const client = new MockWsStreamClient();
    const frames: Array<{
      readonly kind: string;
      readonly entityRefs?: unknown;
    }> = [];
    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 123,
      displayChannelEmission: () => undefined,
      onFeedFrame: (frame) => frames.push(frame),
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    client.session.emitServerFrame({
      kind: "readStateChanged",
      hasBinaryPayload: false,
      ids: ["out-of-window"],
      entityRefs: [{ epicId: "epic-1", chatId: "chat-1" }],
      readAt: 20,
      resolvedAt: null,
      removedIds: [],
      summary: EMPTY_SUMMARY,
    });

    expect(frames).toEqual([
      expect.objectContaining({
        kind: "readStateChanged",
        entityRefs: [{ epicId: "epic-1", chatId: "chat-1" }],
      }),
    ]);
    expect(
      useHostNotificationsStore.getState().byId["out-of-window"],
    ).toBeUndefined();
    close();
  });

  it("applies cleared frames via exact removedIds rather than a timestamp watermark", () => {
    const client = new MockWsStreamClient();
    const frames: Array<{ readonly kind: string }> = [];
    applySimpleSnapshot({
      entries: [entry("old", 10, null), entry("new", 30, null)],
      summary: { unreadCount: 2, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 123,
      displayChannelEmission: () => undefined,
      onFeedFrame: (frame) => frames.push(frame),
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    client.session.emitServerFrame({
      kind: "cleared",
      hasBinaryPayload: false,
      beforeUpdatedAt: 20,
      removedIds: ["old"],
      summary: { unreadCount: 1, attentionCount: 0 },
    });

    expect(
      selectHostNotificationIds(useHostNotificationsStore.getState()),
    ).toEqual(["new"]);
    expect(useHostNotificationsStore.getState().summary).toEqual({
      unreadCount: 1,
      attentionCount: 0,
    });
    expect(frames).toEqual([
      expect.objectContaining({
        kind: "cleared",
        removedIds: ["old"],
      }),
    ]);
    close();
  });

  it("applies removed frames and notifies feed listeners", () => {
    const client = new MockWsStreamClient();
    const frames: Array<{ readonly kind: string }> = [];
    applySimpleSnapshot({
      entries: [entry("a", 10, null), entry("b", 20, null)],
      summary: { unreadCount: 2, attentionCount: 0 },
      recentCursor: null,
      attentionNext: null,
    });
    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 123,
      displayChannelEmission: () => undefined,
      onFeedFrame: (frame) => frames.push(frame),
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    client.session.emitServerFrame({
      kind: "removed",
      hasBinaryPayload: false,
      removedIds: ["a"],
      summary: { unreadCount: 1, attentionCount: 0 },
    });

    expect(useHostNotificationsStore.getState().byId.a).toBeUndefined();
    expect(useHostNotificationsStore.getState().byId.b).toBeDefined();
    expect(frames).toEqual([expect.objectContaining({ kind: "removed" })]);
    close();
  });

  it("uses channelEmission as the only host-source display path", () => {
    const client = new MockWsStreamClient();
    const displayed: Array<ReadonlyArray<HostNotificationEntryV21>> = [];
    const liveEntry = entry("live", 200, null);

    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 123,
      displayChannelEmission: (entries) => {
        displayed.push(entries);
      },
      onFeedFrame: () => undefined,
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    client.session.emitServerFrame({
      kind: "upserted",
      hasBinaryPayload: false,
      entry: liveEntry,
      removedIds: [],
      summary: { unreadCount: 1, attentionCount: 0 },
    });

    expect(displayed).toEqual([]);
    expect(
      selectHostNotificationIds(useHostNotificationsStore.getState()),
    ).toEqual(["live"]);

    client.session.emitServerFrame({
      kind: "channelEmission",
      hasBinaryPayload: false,
      emissionId: "emission-1",
      channelId: "renderer",
      severity: "done",
      rows: [liveEntry],
      reason: "new",
    });

    expect(displayed).toEqual([[liveEntry]]);
    close();
  });

  it("uses the latest feed copy for renderer channel emissions", () => {
    const client = new MockWsStreamClient();
    const displayed: Array<ReadonlyArray<HostNotificationEntryV21>> = [];
    const staleEmissionEntry = entry("live", 200, null);
    if (staleEmissionEntry.kind !== "agent.stopped") {
      throw new Error("Expected an agent-stopped notification fixture");
    }
    const richFeedEntry: HostNotificationEntryV21 = {
      ...staleEmissionEntry,
      updatedAt: 201,
      payload: {
        ...staleEmissionEntry.payload,
        agentName: "Investigate Harness Selection Issue",
        taskTitle: "Fix Chat Error Notification",
      },
    };

    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 123,
      displayChannelEmission: (entries) => {
        displayed.push(entries);
      },
      onFeedFrame: () => undefined,
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    client.session.emitServerFrame({
      kind: "upserted",
      hasBinaryPayload: false,
      entry: richFeedEntry,
      removedIds: [],
      summary: { unreadCount: 1, attentionCount: 0 },
    });
    client.session.emitServerFrame({
      kind: "channelEmission",
      hasBinaryPayload: false,
      emissionId: "emission-1",
      channelId: "renderer",
      severity: "done",
      rows: [staleEmissionEntry],
      reason: "new",
    });

    expect(displayed).toEqual([[richFeedEntry]]);
    close();
  });

  it("ignores non-renderer channelEmission frames for in-app display", () => {
    const client = new MockWsStreamClient();
    const displayed: Array<ReadonlyArray<HostNotificationEntryV21>> = [];
    const liveEntry = entry("webhook-live", 240, null);

    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 123,
      displayChannelEmission: (entries) => {
        displayed.push(entries);
      },
      onFeedFrame: () => undefined,
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    client.session.emitServerFrame({
      kind: "channelEmission",
      hasBinaryPayload: false,
      emissionId: "emission-webhook-1",
      channelId: "webhook",
      severity: "done",
      rows: [liveEntry],
      reason: "new",
    });

    expect(displayed).toEqual([]);
    expect(
      selectHostNotificationIds(useHostNotificationsStore.getState()),
    ).toEqual([]);
    close();
  });

  it("sends flat presence frames when the stream opens", () => {
    const client = new MockWsStreamClient();

    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 456,
      displayChannelEmission: () => undefined,
      onFeedFrame: () => undefined,
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    expect(client.session.clientFrames).toHaveLength(0);
    client.session.emitOpen();

    const initialPresenceFrame = client.session.clientFrames.at(0);
    if (initialPresenceFrame === undefined) {
      throw new Error("Expected initial notifications presence frame.");
    }
    if (initialPresenceFrame.kind !== "presence") {
      throw new Error("Expected initial notifications presence frame.");
    }
    expect(typeof initialPresenceFrame.focused).toBe("boolean");
    expect(initialPresenceFrame).toMatchObject({
      kind: "presence",
      hasBinaryPayload: false,
      windowId: "window-1",
      at: 456,
    });

    close();
  });

  it("re-sends unchanged presence on the heartbeat cadence and stops on close", () => {
    vi.useFakeTimers();
    try {
      const client = new MockWsStreamClient();

      const close = openHostNotificationsStream(client, null, {
        windowId: "window-1",
        now: () => 456,
        displayChannelEmission: () => undefined,
        onFeedFrame: () => undefined,
        onPresenceChanged: () => undefined,
        onStreamOpened: () => undefined,
      });

      client.session.emitOpen();
      expect(client.session.clientFrames).toHaveLength(1);

      // Nothing changed locally — the heartbeat must still refresh the
      // host's TTL'd presence record, bypassing the content dedupe.
      vi.advanceTimersByTime(HOST_NOTIFICATIONS_PRESENCE_HEARTBEAT_MS);
      expect(client.session.clientFrames).toHaveLength(2);
      expect(client.session.clientFrames[1]).toMatchObject({
        kind: "presence",
        windowId: "window-1",
      });

      vi.advanceTimersByTime(HOST_NOTIFICATIONS_PRESENCE_HEARTBEAT_MS);
      expect(client.session.clientFrames).toHaveLength(3);

      close();
      vi.advanceTimersByTime(3 * HOST_NOTIFICATIONS_PRESENCE_HEARTBEAT_MS);
      expect(client.session.clientFrames).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies presence locally on focus changes while the stream is not open", () => {
    const client = new MockWsStreamClient();
    const notified: HostNotificationsSubscribeClientFrame[] = [];
    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 456,
      displayChannelEmission: () => undefined,
      onFeedFrame: () => undefined,
      onPresenceChanged: (frame) => {
        notified.push(frame);
      },
      onStreamOpened: () => undefined,
    });
    try {
      // No open ack ever arrives: the transport send is impossible, but the
      // local consumer (unary-channel read-consumption) must still hear the
      // focus change — this is what keeps tab clicks clearing indicators
      // while the stream is down.
      useEpicCanvasStore.getState().openEpicTab("epic-presence-1", "Epic");

      expect(notified.length).toBeGreaterThan(0);
      expect(notified.every((frame) => frame.kind === "presence")).toBe(true);
      expect(client.session.clientFrames).toHaveLength(0);
    } finally {
      close();
      useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    }
  });

  it("reopens a replacement session with backoff after a terminal close", () => {
    vi.useFakeTimers();
    try {
      const client = new MockWsStreamClient();
      const close = openHostNotificationsStream(client, null, {
        windowId: "window-1",
        now: () => 456,
        displayChannelEmission: () => undefined,
        onFeedFrame: () => undefined,
        onPresenceChanged: () => undefined,
        onStreamOpened: () => undefined,
      });
      expect(client.subscribeCount).toBe(1);
      client.session.emitOpen();

      client.session.emitClosed({
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "gave up after bounded reconnects",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      expect(useHostNotificationsStore.getState().connectionStatus).toBe(
        "closed",
      );
      // The reopen waits out the backoff — no synchronous redial storm.
      expect(client.subscribeCount).toBe(1);
      vi.advanceTimersByTime(NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      expect(client.subscribeCount).toBe(2);

      // The replacement session owns the store projection from here.
      client.session.emitOpen();
      expect(useHostNotificationsStore.getState().connectionStatus).toBe(
        "open",
      );
      close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-sends presence and re-notifies the consumer when a replacement session opens", () => {
    vi.useFakeTimers();
    try {
      const client = new MockWsStreamClient();
      const notified: HostNotificationsSubscribeClientFrame[] = [];
      const close = openHostNotificationsStream(client, null, {
        windowId: "window-1",
        now: () => 456,
        displayChannelEmission: () => undefined,
        onFeedFrame: () => undefined,
        onPresenceChanged: (frame) => {
          notified.push(frame);
        },
        onStreamOpened: () => undefined,
      });
      const firstSession = client.session;
      firstSession.emitOpen();
      expect(firstSession.clientFrames).toHaveLength(1);
      expect(notified).toHaveLength(1);

      firstSession.emitClosed({
        kind: "fatalError",
        details: {
          code: "INTERNAL",
          reason: "host terminated the stream",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      vi.advanceTimersByTime(NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      const replacementSession = client.session;
      expect(replacementSession).not.toBe(firstSession);

      // Nothing about the local presence content changed across the reopen,
      // but the replacement session still needs the frame (its host-side
      // record starts empty) and the consumer still needs the notify:
      // `onStreamOpened` cleared its active entity, so an unchanged-key
      // dedupe would leave the focused entity permanently unconsumed.
      replacementSession.emitOpen();
      expect(replacementSession.clientFrames).toHaveLength(1);
      expect(replacementSession.clientFrames[0]).toMatchObject({
        kind: "presence",
        windowId: "window-1",
      });
      expect(notified).toHaveLength(2);
      expect(notified[1]).toMatchObject({ kind: "presence" });

      close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates the reopen backoff while closes repeat and resets it on a valid snapshot", () => {
    vi.useFakeTimers();
    try {
      const client = new MockWsStreamClient();
      const close = openHostNotificationsStream(client, null, {
        windowId: "window-1",
        now: () => 456,
        displayChannelEmission: () => undefined,
        onFeedFrame: () => undefined,
        onPresenceChanged: () => undefined,
        onStreamOpened: () => undefined,
      });
      const terminalClose = (): void => {
        client.session.emitClosed({
          kind: "fatalError",
          details: {
            code: "INTERNAL",
            reason: "host terminated the stream",
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        });
      };

      terminalClose();
      vi.advanceTimersByTime(NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      expect(client.subscribeCount).toBe(2);

      // Second consecutive terminal close: the delay has doubled.
      terminalClose();
      vi.advanceTimersByTime(NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      expect(client.subscribeCount).toBe(2);
      vi.advanceTimersByTime(NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      expect(client.subscribeCount).toBe(3);

      // A raw transport `open` is NOT proof of a usable stream (the host
      // resolver can still terminate during async init) — the backoff keeps
      // escalating: this close waits the quadrupled delay.
      client.session.emitOpen();
      terminalClose();
      vi.advanceTimersByTime(
        3 * NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS,
      );
      expect(client.subscribeCount).toBe(3);
      vi.advanceTimersByTime(NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      expect(client.subscribeCount).toBe(4);

      // A schema-valid snapshot resets the backoff to the initial delay.
      client.session.emitOpen();
      client.session.emitServerFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: EMPTY_SUMMARY,
      });
      terminalClose();
      vi.advanceTimersByTime(NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      expect(client.subscribeCount).toBe(5);

      close();
      vi.advanceTimersByTime(NOTIFICATIONS_STREAM_REOPEN_MAX_BACKOFF_MS);
      expect(client.subscribeCount).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reopens after caller, client-closed, or incompatible closes", () => {
    vi.useFakeTimers();
    try {
      for (const reason of [
        { kind: "caller" } as const,
        {
          kind: "fatalError" as const,
          details: {
            code: "CLIENT_CLOSED",
            reason: "stream client was already closed",
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        },
        {
          kind: "fatalError" as const,
          details: {
            code: "INCOMPATIBLE",
            reason: "method not supported by this host",
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        },
      ]) {
        const client = new MockWsStreamClient();
        const close = openHostNotificationsStream(client, null, {
          windowId: "window-1",
          now: () => 456,
          displayChannelEmission: () => undefined,
          onFeedFrame: () => undefined,
          onPresenceChanged: () => undefined,
          onStreamOpened: () => undefined,
        });
        client.session.emitClosed(reason);
        vi.advanceTimersByTime(4 * NOTIFICATIONS_STREAM_REOPEN_MAX_BACKOFF_MS);
        expect(client.subscribeCount).toBe(1);
        close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending reopen on dispose", () => {
    vi.useFakeTimers();
    try {
      const client = new MockWsStreamClient();
      const close = openHostNotificationsStream(client, null, {
        windowId: "window-1",
        now: () => 456,
        displayChannelEmission: () => undefined,
        onFeedFrame: () => undefined,
        onPresenceChanged: () => undefined,
        onStreamOpened: () => undefined,
      });
      client.session.emitClosed({
        kind: "fatalError",
        details: {
          code: "INTERNAL",
          reason: "host terminated the stream",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      close();
      vi.advanceTimersByTime(4 * NOTIFICATIONS_STREAM_REOPEN_MAX_BACKOFF_MS);
      expect(client.subscribeCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
