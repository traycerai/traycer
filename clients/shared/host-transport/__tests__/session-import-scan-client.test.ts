import { describe, expect, it, vi, type Mock } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
} from "../i-stream-session";
import { SessionImportScanClient } from "../session-import-scan-client";
import {
  prepareStreamSubscribeRequest,
  WsStreamClient,
} from "../ws-stream-client";
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
    this.statusChangeHandler(status, reason);
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

function harness(): {
  readonly session: StubSession;
  readonly client: SessionImportScanClient;
  readonly onImportedSupport: Mock;
  readonly onConnectionStatus: Mock;
} {
  const session = new StubSession();
  const wsStreamClient = makeWsStreamClient(session);
  const onImportedSupport = vi.fn();
  const onConnectionStatus = vi.fn();
  const client = new SessionImportScanClient({
    wsStreamClient,
    providers: null,
    updatedAfter: null,
    callbacks: {
      onImportedSupport,
      onStarted: vi.fn(),
      onGroup: vi.fn(),
      onProviderFailed: vi.fn(),
      onComplete: vi.fn(),
      onConnectionStatus,
    },
  });
  return { session, client, onImportedSupport, onConnectionStatus };
}

describe("SessionImportScanClient imported-row compatibility", () => {
  it.each([
    {
      label: "client 1.0 and host 1.0",
      client: { major: 1, minor: 0 },
      host: { major: 1, minor: 0 },
      wire: { major: 1, minor: 0 },
    },
    {
      label: "client 1.0 and host 1.1",
      client: { major: 1, minor: 0 },
      host: { major: 1, minor: 1 },
      wire: { major: 1, minor: 0 },
    },
    {
      label: "client 1.1 and host 1.0",
      client: { major: 1, minor: 1 },
      host: { major: 1, minor: 0 },
      wire: { major: 1, minor: 0 },
    },
    {
      label: "client 1.1 and host 1.1",
      client: { major: 1, minor: 1 },
      host: { major: 1, minor: 1 },
      wire: { major: 1, minor: 1 },
    },
  ])(
    "keeps the scan request payload stable for $label",
    ({ client, host, wire }) => {
      const params = { providers: ["claude"], updatedAfter: null };
      const prepared = prepareStreamSubscribeRequest(
        hostStreamRpcRegistry,
        "sessionImport.scan",
        client,
        host,
        params,
      );

      expect(prepared.onWireVersion).toEqual(wire);
      expect(prepared.onWirePayload).toEqual(params);
    },
  );

  it("reports unknown until negotiation, then supports scan 1.1 and resets to unknown after disconnect", () => {
    const h = harness();

    h.session.emitStatus("connecting", null);
    expect(h.onImportedSupport).not.toHaveBeenCalled();

    h.session.negotiatedSchemaVersion = { major: 1, minor: 1 };
    h.session.emitFrame({ kind: "pong", hasBinaryPayload: false });
    expect(h.onImportedSupport).toHaveBeenLastCalledWith("supported");

    h.session.negotiatedSchemaVersion = null;
    const reason: StreamCloseReason = { kind: "caller" };
    h.session.emitStatus("closed", reason);
    expect(h.onImportedSupport).toHaveBeenLastCalledWith("unknown");
    expect(h.onConnectionStatus).toHaveBeenCalledWith("closed", reason);

    h.client.close();
  });

  it("reports 1.0 as unsupported and does not confuse another minor with support", () => {
    const h = harness();

    h.session.negotiatedSchemaVersion = { major: 1, minor: 0 };
    h.session.emitFrame({ kind: "pong", hasBinaryPayload: false });
    expect(h.onImportedSupport).toHaveBeenLastCalledWith("unsupported");

    h.session.negotiatedSchemaVersion = { major: 2, minor: 1 };
    h.session.emitFrame({ kind: "pong", hasBinaryPayload: false });
    expect(h.onImportedSupport).toHaveBeenLastCalledWith("unsupported");

    h.client.close();
  });

  it("resets support during a reconnect and reports upgraded host support", () => {
    const h = harness();

    h.session.negotiatedSchemaVersion = { major: 1, minor: 0 };
    h.session.emitFrame({ kind: "pong", hasBinaryPayload: false });
    expect(h.onImportedSupport).toHaveBeenLastCalledWith("unsupported");

    h.session.negotiatedSchemaVersion = null;
    h.session.emitStatus("reconnecting", null);
    expect(h.onImportedSupport).toHaveBeenLastCalledWith("unknown");

    h.session.negotiatedSchemaVersion = { major: 1, minor: 1 };
    h.session.emitFrame({ kind: "pong", hasBinaryPayload: false });
    expect(h.onImportedSupport).toHaveBeenLastCalledWith("supported");

    h.client.close();
  });
});
