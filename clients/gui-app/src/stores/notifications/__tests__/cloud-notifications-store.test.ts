import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  HostNotificationsCloudFeedRow,
  HostNotificationsCloudFeedSummary,
} from "@traycer/protocol/host/notifications/contracts";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  createHostReconnectEngine,
  HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS,
} from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  cloudNotificationFeedId,
  openCloudNotificationsStream,
  selectCloudEntityReadTargets,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";

const reconnectEngine = createHostReconnectEngine();

const summary: HostNotificationsCloudFeedSummary = {
  totalCount: 1,
  unreadCount: 1,
  attentionCount: 0,
};

const staleSummary: HostNotificationsCloudFeedSummary = {
  totalCount: 99,
  unreadCount: 99,
  attentionCount: 99,
};

function cloudRow(
  entryId: string,
  createdAt: number,
  originHostId: string,
): HostNotificationsCloudFeedRow {
  return {
    entryId,
    originHostId,
    coalesceKey: "agent.stopped:chat-1",
    entry: {
      id: entryId,
      updatedAt: createdAt,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: "mention-1",
      severity: "info",
      outcome: "errored",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Build agent",
        outcome: "errored",
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

function cloudFailureRow(
  entryId: string,
  createdAt: number,
): HostNotificationsCloudFeedRow {
  const row = cloudRow(entryId, createdAt, "host-a");
  return {
    ...row,
    entry: {
      ...row.entry,
      severity: "failure",
    },
  };
}

function cloudPromptRow(
  entryId: string,
  createdAt: number,
): HostNotificationsCloudFeedRow {
  return {
    entryId,
    originHostId: "host-a",
    coalesceKey: `approval.requested:${entryId}`,
    entry: {
      id: entryId,
      updatedAt: createdAt,
      readAt: null,
      kind: "approval.requested",
      sourceRef: entryId,
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "approval",
        epicId: "epic-1",
        chatId: "chat-1",
        approvalId: entryId,
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

class ControlledSession implements IStreamSession {
  private statusChangeHandler: StatusChangeHandler | null = null;
  private serverFrameHandler: ServerFrameHandler | null = null;
  closed = false;

  sendClientFrame(
    _envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  /** Never negotiates: this fake exercises no version-dependent path. */
  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {}

  close(): void {
    this.closed = true;
  }

  emitClosed(reason: StreamCloseReason): void {
    this.statusChangeHandler?.("closed", reason);
  }

  emitServerFrame(envelope: StreamFrameEnvelope): void {
    this.serverFrameHandler?.(envelope, null);
  }
}

class ControlledWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly sessions: ControlledSession[] = [];
  readonly subscribedMethods: string[] = [];

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: {
        create: () => {
          throw new Error(
            "ControlledWsStreamClient should not open a websocket",
          );
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
    method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribedMethods.push(method);
    const session = new ControlledSession();
    this.sessions.push(session);
    return session;
  }
}

function fatalClose(code: string): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code,
      reason: `test close: ${code}`,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

describe("cloud notifications store", () => {
  beforeEach(() => {
    useCloudNotificationsStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces the whole feed on every snapshot - an entry absent from it is gone", () => {
    const first = cloudRow("entry-a", 1, "host-a");
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [first],
      summary,
      version: 10,
    });
    expect(useCloudNotificationsStore.getState().rows).toEqual({
      [cloudNotificationFeedId("entry-a")]: first,
    });

    const second = cloudRow("entry-b", 2, "host-a");
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [second],
      summary,
      version: 11,
    });

    // No removal frame said so. A snapshot IS the statement of what exists,
    // which is why there is nothing here to apply out of order or double-apply.
    expect(useCloudNotificationsStore.getState().rows).toEqual({
      [cloudNotificationFeedId("entry-b")]: second,
    });
    expect(useCloudNotificationsStore.getState().version).toBe(11);
  });

  it("keys a row by entryId alone, so the same entry relayed by another host is one row", () => {
    const viaHostA = cloudRow("entry-a", 1, "host-a");
    const viaHostB = cloudRow("entry-a", 1, "host-b");
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [viaHostA],
      summary,
      version: 1,
    });
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [viaHostB],
      summary,
      version: 2,
    });

    expect(useCloudNotificationsStore.getState().rows).toEqual({
      [cloudNotificationFeedId("entry-a")]: viaHostB,
    });
  });

  it("selects focused entity reads from only the focused origin host", () => {
    const hostA = cloudFailureRow("failure-a", 1);
    const hostB = {
      ...cloudFailureRow("failure-b", 2),
      originHostId: "host-b",
    };
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [hostA, hostB],
      summary: { ...summary, totalCount: 2, unreadCount: 2 },
      version: 1,
    });

    expect(
      selectCloudEntityReadTargets(
        useCloudNotificationsStore.getState(),
        { epicId: "epic-1", chatId: "chat-1" },
        "host-a",
      ),
    ).toEqual(["failure-a"]);
  });

  it("adopts a newer version from a content-identical snapshot", () => {
    const row = cloudRow("entry-a", 1, "host-a");
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [row],
      summary,
      version: 10,
    });

    // The relay only sends this when the feed genuinely moved. The rendered
    // rows can still be identical - an entry this build cannot display may
    // have been superseded by another it also cannot display - and the
    // version is the part that changed. Holding the old one would make this
    // client's own `clearAll` name a feed that no longer exists and quietly
    // leave the newcomer uncleared.
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [row],
      summary,
      version: 11,
    });

    const cloud = useCloudNotificationsStore.getState();
    expect(cloud.version).toBe(11);
    expect(cloud.rows).toEqual({ [cloudNotificationFeedId("entry-a")]: row });
    expect(cloud.summary).toEqual(summary);
  });

  it("reports only post-baseline entry arrivals from accepted snapshot diffs", () => {
    const baseline = cloudRow("entry-a", 1, "host-a");
    expect(
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [baseline],
        summary,
        version: 10,
      }),
    ).toEqual([]);

    const arrived = cloudRow("entry-b", 2, "host-b");
    expect(
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [baseline, arrived],
        summary,
        version: 11,
      }),
    ).toEqual([arrived]);

    expect(
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [baseline, arrived],
        summary,
        version: 11,
      }),
    ).toEqual([]);
    expect(
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [cloudRow("entry-stale", 0, "host-a")],
        summary: staleSummary,
        version: 9,
      }),
    ).toBeNull();
  });

  it("ignores a delayed snapshot from below the version already rendered", () => {
    const newest = cloudRow("entry-b", 10, "host-a");
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [newest],
      summary,
      version: 10,
    });

    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudRow("entry-a", 9, "host-a")],
      summary: staleSummary,
      version: 9,
    });

    const cloud = useCloudNotificationsStore.getState();
    expect(cloud.rows).toEqual({
      [cloudNotificationFeedId("entry-b")]: newest,
    });
    expect(cloud.version).toBe(10);
    expect(cloud.summary).toEqual(summary);
  });

  it("starts a new ownership epoch on reset, so a lower version is accepted again", () => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudRow("entry-b", 10, "host-a")],
      summary,
      version: 10,
    });
    const epochBefore = useCloudNotificationsStore.getState().sessionEpoch;

    useCloudNotificationsStore.getState().reset();
    const fresh = cloudRow("entry-a", 1, "host-a");
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [fresh],
      summary,
      version: 1,
    });

    const cloud = useCloudNotificationsStore.getState();
    expect(cloud.sessionEpoch).toBe(epochBefore + 1);
    expect(cloud.version).toBe(1);
    expect(cloud.rows).toEqual({ [cloudNotificationFeedId("entry-a")]: fresh });
  });

  it("retains its rows when the relay reports the cloud unreachable", () => {
    const row = cloudRow("entry-a", 1, "host-a");
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [row],
      summary,
      version: 4,
    });

    useCloudNotificationsStore.getState().setConnectionState("reconnecting");

    // Degraded is not empty: the last snapshot is still the best answer the
    // client has, and dropping it would blank the center on a transient blip.
    const cloud = useCloudNotificationsStore.getState();
    expect(cloud.connectionState).toBe("reconnecting");
    expect(cloud.rows).toEqual({ [cloudNotificationFeedId("entry-a")]: row });
    expect(cloud.version).toBe(4);
  });

  it("removes an unread failure from both optimistic summary counts when marked read", () => {
    const failure = cloudFailureRow("entry-failure", 10);
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [failure],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 1 },
      version: 1,
    });

    useCloudNotificationsStore.getState().markReadLocally(failure.entryId, 20);

    const cloud = useCloudNotificationsStore.getState();
    expect(
      cloud.rows[cloudNotificationFeedId(failure.entryId)]?.entry.readAt,
    ).toBe(20);
    expect(cloud.summary).toEqual({
      totalCount: 1,
      unreadCount: 0,
      attentionCount: 0,
    });
  });

  it("moves unresolved needs-action rows out of attention after optimistic mark-all-read", () => {
    const failure = cloudFailureRow("entry-failure", 10);
    const prompt = cloudPromptRow("entry-prompt", 20);
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [failure, prompt],
      summary: { totalCount: 2, unreadCount: 2, attentionCount: 2 },
      version: 1,
    });

    useCloudNotificationsStore.getState().markAllReadLocally(30);

    const cloud = useCloudNotificationsStore.getState();
    expect(cloud.summary).toEqual({
      totalCount: 2,
      unreadCount: 0,
      attentionCount: 0,
    });
    expect(Object.values(cloud.rows).map((row) => row?.entry.readAt)).toEqual([
      30, 30,
    ]);
  });

  it("clears summary-only attention after optimistic mark-all-read", () => {
    const failure = cloudFailureRow("entry-failure", 10);
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [failure],
      // The relay summary also covers one unrenderable unresolved prompt.
      summary: { totalCount: 2, unreadCount: 2, attentionCount: 2 },
      version: 1,
    });

    useCloudNotificationsStore.getState().markAllReadLocally(30);

    expect(useCloudNotificationsStore.getState().summary).toEqual({
      totalCount: 2,
      unreadCount: 0,
      attentionCount: 0,
    });
  });

  it("decrements optimistic attention for every read-based attention row during entity-read fan-out", () => {
    const failure = cloudFailureRow("entry-failure", 10);
    const prompt = cloudPromptRow("entry-prompt", 20);
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [failure, prompt],
      summary: { totalCount: 2, unreadCount: 2, attentionCount: 2 },
      version: 1,
    });

    useCloudNotificationsStore
      .getState()
      .beginEntityRead([failure.entryId, prompt.entryId], 30);

    expect(useCloudNotificationsStore.getState().summary).toEqual({
      totalCount: 2,
      unreadCount: 0,
      attentionCount: 0,
    });
  });

  it("opens the distinct cloud method and creates a fresh session after terminal failure", () => {
    vi.useFakeTimers();
    const client = new ControlledWsStreamClient();
    const close = openCloudNotificationsStream(
      reconnectEngine,
      client,
      null,
      null,
      null,
    );

    expect(client.subscribedMethods).toEqual([
      "host.notifications.cloudFeed.subscribe",
    ]);
    expect(useCloudNotificationsStore.getState().connectionState).toBe(
      "connecting",
    );
    client.sessions[0].emitClosed(fatalClose("INTERNAL"));
    expect(useCloudNotificationsStore.getState().connectionState).toBe(
      "unavailable",
    );

    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(client.sessions).toHaveLength(2);
    expect(client.sessions[0].closed).toBe(true);
    close();
  });

  it("does not retry an incompatible cloud-feed method", () => {
    vi.useFakeTimers();
    const client = new ControlledWsStreamClient();
    const close = openCloudNotificationsStream(
      reconnectEngine,
      client,
      null,
      null,
      null,
    );

    client.sessions[0].emitClosed(fatalClose("INCOMPATIBLE"));
    vi.advanceTimersByTime(2 * HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);

    expect(useCloudNotificationsStore.getState().connectionState).toBe(
      "unavailable",
    );
    expect(client.sessions).toHaveLength(1);
    close();
  });

  it("reports a terminal entitlement denial to the session owner", () => {
    vi.useFakeTimers();
    const client = new ControlledWsStreamClient();
    const onEntitlementDenied = vi.fn();
    const close = openCloudNotificationsStream(
      reconnectEngine,
      client,
      null,
      onEntitlementDenied,
      null,
    );

    client.sessions[0].emitClosed(fatalClose("FREE_TIER_NO_CLOUD_SYNC"));

    expect(onEntitlementDenied).toHaveBeenCalledTimes(1);
    expect(useCloudNotificationsStore.getState().connectionState).toBe(
      "unavailable",
    );
    vi.advanceTimersByTime(2 * HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(client.sessions).toHaveLength(1);
    close();
  });

  it("parses authoritative frames and remains unavailable before its first snapshot", () => {
    const client = new ControlledWsStreamClient();
    const close = openCloudNotificationsStream(
      reconnectEngine,
      client,
      null,
      null,
      null,
    );
    const session = client.sessions[0];

    session.emitServerFrame({
      kind: "connectionState",
      hasBinaryPayload: false,
      connectionState: "reconnecting",
    });
    expect(useCloudNotificationsStore.getState().connectionState).toBe(
      "unavailable",
    );

    const row = cloudRow("entry-a", 4, "host-a");
    session.emitServerFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      connectionState: "connected",
      version: 4,
      rows: [row],
      summary,
    });
    expect(useCloudNotificationsStore.getState().connectionState).toBe(
      "connected",
    );
    expect(useCloudNotificationsStore.getState().rows).toEqual({
      [cloudNotificationFeedId("entry-a")]: row,
    });

    session.emitServerFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      connectionState: "connected",
      version: 5,
      rows: [],
      summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
    });
    expect(useCloudNotificationsStore.getState().rows).toEqual({});
    close();
  });

  it("reports baseline rows as a snapshot even when there are no arrivals", () => {
    const client = new ControlledWsStreamClient();
    const onSnapshot = vi.fn();
    const close = openCloudNotificationsStream(
      reconnectEngine,
      client,
      null,
      null,
      onSnapshot,
    );
    const row = cloudRow("entry-a", 4, "host-a");

    client.sessions[0].emitServerFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      connectionState: "connected",
      version: 4,
      rows: [row],
      summary,
    });

    expect(onSnapshot).toHaveBeenCalledWith({ rows: [row], arrivals: [] });
    close();
  });

  it("does not forward a lower-version snapshot after rejecting its rewind", () => {
    const client = new ControlledWsStreamClient();
    const onSnapshot = vi.fn();
    const close = openCloudNotificationsStream(
      reconnectEngine,
      client,
      null,
      null,
      onSnapshot,
    );
    const accepted = cloudRow("entry-current", 10, "host-a");

    client.sessions[0].emitServerFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      connectionState: "connected",
      version: 10,
      rows: [accepted],
      summary,
    });
    onSnapshot.mockClear();

    client.sessions[0].emitServerFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      connectionState: "connected",
      version: 9,
      rows: [cloudRow("entry-stale", 9, "host-a")],
      summary: staleSummary,
    });

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(useCloudNotificationsStore.getState().rows).toEqual({
      [cloudNotificationFeedId("entry-current")]: accepted,
    });
    close();
  });

  it("ignores a snapshot from a relay controller whose ownership epoch was replaced", () => {
    const oldClient = new ControlledWsStreamClient();
    const closeOld = openCloudNotificationsStream(
      reconnectEngine,
      oldClient,
      null,
      null,
      null,
    );
    const oldSession = oldClient.sessions[0];

    useCloudNotificationsStore.getState().reset();
    const replacementClient = new ControlledWsStreamClient();
    const closeReplacement = openCloudNotificationsStream(
      reconnectEngine,
      replacementClient,
      null,
      null,
      null,
    );
    const replacementRow = cloudRow("entry-new", 2, "host-b");

    oldSession.emitServerFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      connectionState: "connected",
      version: 99,
      rows: [cloudRow("entry-stale", 1, "host-a")],
      summary,
    });
    expect(useCloudNotificationsStore.getState().rows).toEqual({});

    replacementClient.sessions[0].emitServerFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      connectionState: "connected",
      version: 1,
      rows: [replacementRow],
      summary,
    });
    expect(useCloudNotificationsStore.getState().rows).toEqual({
      [cloudNotificationFeedId("entry-new")]: replacementRow,
    });

    closeOld();
    closeReplacement();
  });
});
