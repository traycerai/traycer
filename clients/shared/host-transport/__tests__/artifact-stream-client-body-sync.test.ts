/**
 * `artifact.subscribe@1.1`'s `bodySync` frame at the client (O2): delivered
 * to `onBodySync`, dropped when it rides with a binary payload, dropped when
 * it names another artifact.
 */
import { describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
} from "../i-stream-session";
import { ArtifactStreamClient } from "../artifact-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { WsStreamClient } from "../ws-stream-client";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

const OURS = "artifact-ours";
const THEIRS = "artifact-theirs";
const EPOCH = "epoch-1";

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

  emitFrame(
    frame: Parameters<ServerFrameHandler>[0],
    payload: Uint8Array | null,
  ): void {
    this.serverFrameHandler(frame, payload);
  }

  emitStatus(
    status: Parameters<StatusChangeHandler>[0],
    reason: Parameters<StatusChangeHandler>[1],
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
    evidence: NO_TRANSPORT_EVIDENCE,
    endpoint: () => null,
    hostId: null,
    bearer: () => null,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
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
  vi.spyOn(client, "subscribeWithParamsProvider").mockReturnValue(session);
  return client;
}

const OURS_EPOCH = EPOCH;

function attach(): {
  session: StubSession;
  seen: Array<{ artifactId: string; state: string; epoch: string }>;
} {
  const session = new StubSession();
  const seen: Array<{ artifactId: string; state: string; epoch: string }> = [];
  new ArtifactStreamClient({
    wsStreamClient: makeWsStreamClient(session),
    epicId: "epic-1",
    artifactId: OURS,
    authorityEpoch: EPOCH,
    seedOfferProvider: () => null,
    callbacks: {
      onDoc: () => {},
      onDocUpdate: () => {},
      onDocAck: () => {},
      onAwareness: () => {},
      onUnavailable: () => {},
      onBodySync: (frame) =>
        seen.push({
          artifactId: frame.artifactId,
          state: frame.state,
          epoch: frame.authorityEpoch,
        }),
      onConnectionStatus: () => {},
    },
  });
  return { session, seen };
}

function bodySyncFrame(artifactId: string, state: "syncing" | "synced") {
  return {
    kind: "bodySync" as const,
    authorityEpoch: OURS_EPOCH,
    artifactId,
    state,
    hasBinaryPayload: false as const,
  };
}

describe("ArtifactStreamClient - bodySync", () => {
  it("delivers a bodySync frame addressed to this artifact, in order", () => {
    const { session, seen } = attach();
    session.emitFrame(bodySyncFrame(OURS, "syncing"), null);
    session.emitFrame(bodySyncFrame(OURS, "synced"), null);
    expect(seen).toEqual([
      { artifactId: OURS, state: "syncing", epoch: OURS_EPOCH },
      { artifactId: OURS, state: "synced", epoch: OURS_EPOCH },
    ]);
  });

  it("drops a bodySync frame that arrives with a binary payload", () => {
    const { session, seen } = attach();
    session.emitFrame(bodySyncFrame(OURS, "syncing"), new Uint8Array([1]));
    expect(seen).toEqual([]);
  });

  it("drops a bodySync frame addressed to another artifact", () => {
    const { session, seen } = attach();
    session.emitFrame(bodySyncFrame(THEIRS, "syncing"), null);
    expect(seen).toEqual([]);
  });
});
