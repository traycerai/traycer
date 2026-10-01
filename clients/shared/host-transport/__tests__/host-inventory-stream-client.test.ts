/**
 * `host.hostInventory.subscribe@1.0`'s typed client.
 *
 * The class owns exactly one thing - turning wire envelopes into typed
 * snapshots - so that is what these pin: the ceiling is pinned against the
 * registry (the promise the module's own doc comment makes), a frame this
 * build cannot parse for the session's negotiated minor is DROPPED rather
 * than guessed at, and a `pong` control frame is inert.
 *
 * Doubles mirror `chat-records-stream-client.test.ts` in this same
 * directory - that file's `StubSession` / `makeWsStreamClient` pair is the
 * established pattern for driving a typed stream client against a fake
 * `IStreamSession` without a real socket.
 */
import { describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
} from "../i-stream-session";
import {
  HOST_INVENTORY_STREAM_PARSED_MINOR_CEILING,
  HostInventoryStreamClient,
  type HostInventorySnapshot,
} from "../host-inventory-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

class StubSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler = () => undefined;
  private statusChangeHandler: StatusChangeHandler = () => undefined;
  negotiatedSchemaVersion: SchemaVersion | null = null;

  readonly close = vi.fn();

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.negotiatedSchemaVersion;
  }

  requestReconnect(): void {}

  emitFrame(frame: Parameters<ServerFrameHandler>[0]): void {
    this.serverFrameHandler(frame, null);
  }

  emitStatus(
    status: Parameters<StatusChangeHandler>[0],
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler(status, reason, null);
  }
}

function makeWsStreamClient(
  session: IStreamSession,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => null,
    hostId: null,
    bearer: () => null,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: {
      create: () => {
        throw new Error("unexpected WebSocket creation");
      },
    },
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
  });
  vi.spyOn(client, "subscribe").mockReturnValue(session);
  return client;
}

function buildRow(hostId: string): HostListItem {
  return {
    hostId,
    displayName: null,
    platform: null,
    kind: "personal",
    publicKey: "pub-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    updatePolicy: "manual",
  };
}

interface StatusCall {
  readonly status: StreamConnectionStatus;
  readonly reason: StreamCloseReason | null;
}

interface Harness {
  readonly session: StubSession;
  readonly snapshots: HostInventorySnapshot[];
  readonly statuses: StatusCall[];
  readonly client: HostInventoryStreamClient;
  readonly wsStreamClient: WsStreamClient<typeof hostStreamRpcRegistry>;
}

function harness(): Harness {
  const session = new StubSession();
  const wsStreamClient = makeWsStreamClient(session);
  const snapshots: HostInventorySnapshot[] = [];
  const statuses: StatusCall[] = [];
  const client = new HostInventoryStreamClient({
    wsStreamClient,
    callbacks: {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onConnectionStatus: (status, reason) => statuses.push({ status, reason }),
    },
  });
  return { session, snapshots, statuses, client, wsStreamClient };
}

describe("HostInventoryStreamClient", () => {
  it("subscribes to the host-scoped method with an empty open request", () => {
    const h = harness();
    expect(h.wsStreamClient.subscribe).toHaveBeenCalledWith(
      "host.hostInventory.subscribe",
      {},
    );
    h.client.close();
  });

  it("delivers a snapshot as typed fields, hosts included verbatim", () => {
    const h = harness();
    const hosts = [buildRow("host-1"), buildRow("host-2")];
    h.session.emitFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      hosts,
      fetchedAtMs: 1_000,
      stale: false,
    });

    expect(h.snapshots).toEqual([{ hosts, fetchedAtMs: 1_000, stale: false }]);
    h.client.close();
  });

  describe("D1: the ceiling is pinned against the registry - the promise the module's doc comment makes", () => {
    it('equals hostStreamRpcRegistry["host.hostInventory.subscribe"][1].latestMinor', () => {
      // THE LOUD ARM. Registering a minor is an edit in the protocol package;
      // negotiation derives `min(mine, theirs)` from the registry and never
      // consults this client. Without this assertion a new minor is
      // negotiated, parsed by the arm below it (or, since this client has
      // only ONE arm, parsed by an arm that does not exist for it and
      // dropped outright), silently regressing every consumer of a widened
      // frame the moment the registry moves - exactly the class of bug
      // `chat-records-stream-client.ts`'s own ceiling test exists to catch.
      expect(HOST_INVENTORY_STREAM_PARSED_MINOR_CEILING).toBe(
        hostStreamRpcRegistry["host.hostInventory.subscribe"][1].latestMinor,
      );
    });
  });

  describe("D2: a frame is parsed by the NEGOTIATED minor, not the newest schema this build has", () => {
    it("delivers the snapshot when the session negotiated the exact ceiling (major 1, minor 0)", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = {
        major: 1,
        minor: HOST_INVENTORY_STREAM_PARSED_MINOR_CEILING,
      };
      const hosts = [buildRow("host-1")];
      h.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        hosts,
        fetchedAtMs: 2_000,
        stale: false,
      });

      expect(h.snapshots).toEqual([
        { hosts, fetchedAtMs: 2_000, stale: false },
      ]);
      h.client.close();
    });

    it("delivers the snapshot when the handshake has not settled (negotiated === null) - the conservative pre-handshake parse", () => {
      const h = harness();
      // `negotiatedSchemaVersion` starts `null` in the harness; asserted
      // rather than relied upon, since the whole point of this case is that
      // path (`parseNegotiatedFrame`'s `negotiated !== null` guard).
      expect(h.session.negotiatedSchemaVersion).toBeNull();
      const hosts = [buildRow("host-1")];
      h.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        hosts,
        fetchedAtMs: 3_000,
        stale: true,
      });

      expect(h.snapshots).toEqual([{ hosts, fetchedAtMs: 3_000, stale: true }]);
      h.client.close();
    });

    it("DROPS the frame when the session negotiated a minor above this build's ceiling, instead of parsing it with the newest arm", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = {
        major: 1,
        minor: HOST_INVENTORY_STREAM_PARSED_MINOR_CEILING + 1,
      };
      h.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        hosts: [buildRow("host-1")],
        fetchedAtMs: 4_000,
        stale: false,
      });

      // Dropped, and the poll carries the table meanwhile - this class's
      // declared degrade (same rule `chat-records-stream-client.ts` pins).
      // The alternative - succeeding with the unknown minor's fields
      // silently stripped - has no symptom at all.
      expect(h.snapshots).toEqual([]);
      h.client.close();
    });

    it("DROPS the frame when the session negotiated a different major, regardless of minor", () => {
      const h = harness();
      h.session.negotiatedSchemaVersion = { major: 2, minor: 0 };
      h.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        hosts: [buildRow("host-1")],
        fetchedAtMs: 5_000,
        stale: false,
      });

      expect(h.snapshots).toEqual([]);
      h.client.close();
    });
  });

  it("D3: treats pong as inert - the transport owns the heartbeat, and it never reaches onSnapshot", () => {
    const h = harness();
    h.session.emitFrame({ kind: "pong", hasBinaryPayload: false });
    expect(h.snapshots).toEqual([]);
    h.client.close();
  });

  it("reports connection status and closes its session idempotently", () => {
    const h = harness();
    const reason: StreamCloseReason = { kind: "caller" };
    h.session.emitStatus("reconnecting", null);
    h.session.emitStatus("closed", reason);
    expect(h.statuses).toEqual([
      { status: "reconnecting", reason: null },
      { status: "closed", reason },
    ]);

    h.client.close();
    h.client.close();
    expect(h.session.close).toHaveBeenCalledTimes(1);
  });
});
