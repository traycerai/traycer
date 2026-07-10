import { beforeEach, describe, expect, it } from "vitest";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  hostNotificationsSubscribeClientFrameV11Schema,
  type HostNotificationEntryV11,
  type HostNotificationsSubscribeClientFrameV11,
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
): HostNotificationEntryV11 {
  return {
    id,
    updatedAt,
    readAt,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    payload: {
      epicId: "epic-1",
      chatId: "chat-1",
      outcome: "completed",
    },
  };
}

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  readonly clientFrames: HostNotificationsSubscribeClientFrameV11[] = [];
  closed = false;

  sendClientFrame(envelope: StreamFrameEnvelope): void {
    this.clientFrames.push(
      hostNotificationsSubscribeClientFrameV11Schema.parse(envelope),
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
      .applyReadState(["fresh"], 250, staleEpoch);

    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["fresh"]);
    expect(
      useHostNotificationsStore.getState().byId.resurrected,
    ).toBeUndefined();
    expect(useHostNotificationsStore.getState().byId.fresh.readAt).toBeNull();
    expect(useHostNotificationsStore.getState().nextCursor).toBeNull();
  });

  it("uses channelEmission as the only host-source display path", () => {
    const client = new MockWsStreamClient();
    const displayed: Array<ReadonlyArray<HostNotificationEntryV11>> = [];
    const liveEntry = entry("live", 200, null);

    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 123,
      displayChannelEmission: (entries) => {
        displayed.push(entries);
      },
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

  it("ignores non-renderer channelEmission frames for in-app display", () => {
    const client = new MockWsStreamClient();
    const displayed: Array<ReadonlyArray<HostNotificationEntryV11>> = [];
    const liveEntry = entry("webhook-live", 240, null);

    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 123,
      displayChannelEmission: (entries) => {
        displayed.push(entries);
      },
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

  it("sends v1.1 presence frames initially and when the stream opens", () => {
    const client = new MockWsStreamClient();

    const close = openHostNotificationsStream(client, null, {
      windowId: "window-1",
      now: () => 456,
      displayChannelEmission: () => undefined,
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
