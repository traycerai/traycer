/**
 * The address invariant `artifact.subscribe@1.0` states and the client must
 * ENFORCE.
 *
 * Every non-`pong` server frame names the artifact it belongs to, and the
 * schema is explicit that a frame naming a different one "is a host bug, not a
 * routing instruction". Bodies share a single multiplexed connection with every
 * other open tile's lane, and the lane adapter above this client relabels each
 * frame with its OWN captured artifact id - so an unchecked misroute installs
 * one body's bytes into another's replica and retires coverage a body never
 * sent. Both are silent document corruptions, which is why the client drops
 * rather than honouring the wire address.
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
    this.statusChangeHandler(status, reason);
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

interface Seen {
  readonly doc: string[];
  readonly docUpdate: string[];
  readonly docAck: string[];
  readonly awareness: string[];
  readonly unavailable: string[];
}

function attach(): { session: StubSession; seen: Seen } {
  const session = new StubSession();
  const seen: Seen = {
    doc: [],
    docUpdate: [],
    docAck: [],
    awareness: [],
    unavailable: [],
  };
  new ArtifactStreamClient({
    wsStreamClient: makeWsStreamClient(session),
    epicId: "epic-1",
    artifactId: OURS,
    authorityEpoch: EPOCH,
    seedOfferProvider: () => null,
    callbacks: {
      onDoc: (frame) => seen.doc.push(frame.artifactId),
      onDocUpdate: (frame) => seen.docUpdate.push(frame.artifactId),
      onDocAck: (frame) => seen.docAck.push(frame.artifactId),
      onAwareness: (frame) => seen.awareness.push(frame.artifactId),
      onUnavailable: (frame) => seen.unavailable.push(frame.artifactId),
      onConnectionStatus: () => {},
    },
  });
  return { session, seen };
}

const bytes = new Uint8Array([1, 2, 3]);

describe("ArtifactStreamClient - frame addressing", () => {
  it("delivers frames addressed to this stream's artifact", () => {
    const { session, seen } = attach();

    session.emitFrame(
      {
        kind: "doc",
        authorityEpoch: EPOCH,
        artifactId: OURS,
        docGuid: "guid-1",
        stateVectorBase64: "",
        hasBinaryPayload: true,
      },
      bytes,
    );
    session.emitFrame(
      {
        kind: "docAck",
        authorityEpoch: EPOCH,
        artifactId: OURS,
        docGuid: "guid-1",
        coverageStateVectorBase64: "",
        hasBinaryPayload: false,
      },
      null,
    );

    // The control. Without it a guard that dropped EVERYTHING would pass the
    // refusals below while breaking the lane outright.
    expect(seen.doc).toEqual([OURS]);
    expect(seen.docAck).toEqual([OURS]);
  });

  it("drops every non-pong frame naming a different artifact", () => {
    const { session, seen } = attach();

    session.emitFrame(
      {
        kind: "doc",
        authorityEpoch: EPOCH,
        artifactId: THEIRS,
        docGuid: "guid-2",
        stateVectorBase64: "",
        hasBinaryPayload: true,
      },
      bytes,
    );
    session.emitFrame(
      {
        kind: "docUpdate",
        authorityEpoch: EPOCH,
        artifactId: THEIRS,
        docGuid: "guid-2",
        hasBinaryPayload: true,
      },
      bytes,
    );
    session.emitFrame(
      {
        kind: "docAck",
        authorityEpoch: EPOCH,
        artifactId: THEIRS,
        docGuid: "guid-2",
        coverageStateVectorBase64: "",
        hasBinaryPayload: false,
      },
      null,
    );
    session.emitFrame(
      {
        kind: "awareness",
        authorityEpoch: EPOCH,
        artifactId: THEIRS,
        hasBinaryPayload: true,
      },
      bytes,
    );
    session.emitFrame(
      {
        kind: "unavailable",
        authorityEpoch: EPOCH,
        artifactId: THEIRS,
        code: "bodyUnavailable",
        reason: "not served",
        terminal: false,
        hasBinaryPayload: false,
      },
      null,
    );

    // A `doc` here would install another body's seed over this replica, and a
    // `docAck` would retire coverage this body never sent - the two silent
    // corruptions the guard exists for.
    expect(seen).toEqual({
      doc: [],
      docUpdate: [],
      docAck: [],
      awareness: [],
      unavailable: [],
    });
  });
});
