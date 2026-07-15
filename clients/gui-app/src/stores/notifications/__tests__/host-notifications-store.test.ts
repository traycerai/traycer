import { beforeEach, describe, expect, it } from "vitest";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  hostNotificationsSubscribeClientFrameSchema,
  type HostNotificationEntry,
  type HostNotificationsSubscribeClientFrame,
} from "@traycer/protocol/host/notifications/contracts";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  __resetHostNotificationsStoreForTests,
  openHostNotificationsStream,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";

function entry(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
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

function promptEntry(id: string): HostNotificationEntry {
  return {
    id,
    updatedAt: 10,
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

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  readonly clientFrames: HostNotificationsSubscribeClientFrame[] = [];
  closed = false;

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

  close(): void {
    this.closed = true;
  }

  emitServerFrame(envelope: StreamFrameEnvelope): void {
    if (this.serverFrameHandler === null) return;
    this.serverFrameHandler(envelope, null);
  }

  emitOpen(): void {
    if (this.statusChangeHandler === null) return;
    this.statusChangeHandler("open", null);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly session = new MockStreamSession();

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
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return this.session;
  }
}

describe("host notifications store", () => {
  beforeEach(() => {
    __resetHostNotificationsStoreForTests();
  });

  it("overwrites upserted rows by id, reorders by updatedAt, and flips read rows unread", () => {
    const store = useHostNotificationsStore.getState();

    store.replaceFromSnapshot(
      [entry("older", 10, null), entry("target", 20, 30)],
      50,
    );

    expect(useHostNotificationsStore.getState().orderedIds).toEqual([
      "target",
      "older",
    ]);
    expect(useHostNotificationsStore.getState().unreadCount).toBe(1);

    useHostNotificationsStore.getState().upsert(entry("target", 40, null));

    expect(useHostNotificationsStore.getState().orderedIds).toEqual([
      "target",
      "older",
    ]);
    expect(useHostNotificationsStore.getState().byId.target.updatedAt).toBe(40);
    expect(useHostNotificationsStore.getState().unreadCount).toBe(2);
  });

  it("wipes and replaces stale rows on a new snapshot", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([entry("stale", 10, null)], 50);

    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([entry("fresh", 20, null)], 50);

    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["fresh"]);
    expect(useHostNotificationsStore.getState().byId.stale).toBeUndefined();
    expect(useHostNotificationsStore.getState().snapshotEpoch).toBe(2);
  });

  it("patches resolvedAt with read-state frames without changing entry order", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([promptEntry("question")], 50);
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;

    useHostNotificationsStore
      .getState()
      .applyReadState(["question"], 20, 20, snapshotEpoch);

    expect(useHostNotificationsStore.getState().byId.question).toMatchObject({
      readAt: 20,
      resolvedAt: 20,
      updatedAt: 10,
    });
    expect(useHostNotificationsStore.getState().orderedIds).toEqual([
      "question",
    ]);
  });

  it("preserves frame read state over an equal-timestamp pagination row", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([promptEntry("question")], 50);
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;

    useHostNotificationsStore
      .getState()
      .applyReadState(["question"], 20, 20, snapshotEpoch);
    useHostNotificationsStore
      .getState()
      .mergePage([promptEntry("question")], null, snapshotEpoch);

    expect(useHostNotificationsStore.getState().byId.question).toMatchObject({
      readAt: 20,
      resolvedAt: 20,
    });
  });

  it("allows a genuinely newer upsert to replace a prior read state", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([entry("target", 10, null)], 50);
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;
    useHostNotificationsStore
      .getState()
      .applyReadState(["target"], 20, undefined, snapshotEpoch);

    useHostNotificationsStore.getState().upsert(entry("target", 11, null));

    expect(useHostNotificationsStore.getState().byId.target.readAt).toBeNull();
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

  it("merges back-pages by id and keeps newer upsert state", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot(
        [entry("same", 100, null), entry("top", 120, null)],
        2,
      );

    useHostNotificationsStore.getState().upsert(entry("same", 130, null));
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;

    useHostNotificationsStore.getState().mergePage(
      [entry("same", 90, 95), entry("older", 80, null)],
      {
        updatedAt: 80,
        id: "older",
      },
      snapshotEpoch,
    );

    expect(useHostNotificationsStore.getState().orderedIds).toEqual([
      "same",
      "top",
      "older",
    ]);
    expect(useHostNotificationsStore.getState().byId.same.updatedAt).toBe(130);
    expect(useHostNotificationsStore.getState().nextCursor).toEqual({
      updatedAt: 80,
      id: "older",
    });
  });

  it("discards stale list and mark-read results after a snapshot bump", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot(
        [entry("old", 100, null), entry("older", 90, null)],
        2,
      );
    const staleEpoch = useHostNotificationsStore.getState().snapshotEpoch;

    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([entry("fresh", 200, null)], 50);

    useHostNotificationsStore.getState().mergePage(
      [entry("resurrected", 80, null)],
      {
        updatedAt: 80,
        id: "resurrected",
      },
      staleEpoch,
    );
    useHostNotificationsStore
      .getState()
      .applyReadState(["fresh"], 250, undefined, staleEpoch);

    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["fresh"]);
    expect(
      useHostNotificationsStore.getState().byId.resurrected,
    ).toBeUndefined();
    expect(useHostNotificationsStore.getState().byId.fresh.readAt).toBeNull();
    expect(useHostNotificationsStore.getState().nextCursor).toBeNull();
  });

  it("clears only rows at or before the requested boundary", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot(
        [entry("old", 10, null), entry("boundary", 20, null)],
        2,
      );
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;
    useHostNotificationsStore.getState().upsert(entry("new", 21, null));

    useHostNotificationsStore.getState().clearBeforeLocally(20, snapshotEpoch);

    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["new"]);
    expect(useHostNotificationsStore.getState().unreadCount).toBe(1);
    expect(useHostNotificationsStore.getState().nextCursor).toBeNull();
  });

  it("ignores a clear request from a stale snapshot epoch", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([entry("old", 10, null)], 2);
    const staleEpoch = useHostNotificationsStore.getState().snapshotEpoch;

    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([entry("fresh", 20, null)], 50);

    useHostNotificationsStore.getState().clearBeforeLocally(20, staleEpoch);

    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["fresh"]);
    expect(useHostNotificationsStore.getState().unreadCount).toBe(1);
  });

  it("applies clear frames from another window without removing newer rows", () => {
    const client = new MockWsStreamClient();
    const frames: Array<{ readonly kind: string }> = [];
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot(
        [entry("old", 10, null), entry("new", 30, null)],
        50,
      );
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
    });

    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["new"]);
    expect(frames).toEqual([
      { kind: "cleared", hasBinaryPayload: false, beforeUpdatedAt: 20 },
    ]);
    close();
  });

  it("uses channelEmission as the only host-source display path", () => {
    const client = new MockWsStreamClient();
    const displayed: Array<ReadonlyArray<HostNotificationEntry>> = [];
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
    });

    expect(displayed).toEqual([]);
    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["live"]);

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
    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["live"]);

    close();
  });

  it("uses the latest feed copy for renderer channel emissions", () => {
    const client = new MockWsStreamClient();
    const displayed: Array<ReadonlyArray<HostNotificationEntry>> = [];
    const staleEmissionEntry = entry("live", 200, null);
    if (staleEmissionEntry.kind !== "agent.stopped") {
      throw new Error("Expected an agent-stopped notification fixture");
    }
    const richFeedEntry: HostNotificationEntry = {
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
    const displayed: Array<ReadonlyArray<HostNotificationEntry>> = [];
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
    expect(useHostNotificationsStore.getState().orderedIds).toEqual([]);

    close();
  });

  it("sends flat presence frames initially and when the stream opens", () => {
    const client = new MockWsStreamClient();

    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 456,
      displayChannelEmission: () => undefined,
      onFeedFrame: () => undefined,
      onPresenceChanged: () => undefined,
      onStreamOpened: () => undefined,
    });

    const initialPresenceFrame = client.session.clientFrames[0];
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

    client.session.emitOpen();

    expect(client.session.clientFrames).toHaveLength(2);
    expect(client.session.clientFrames[1]).toMatchObject({
      kind: "presence",
      windowId: "window-1",
      at: 456,
    });

    close();
  });
});
