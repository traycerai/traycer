import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { ArtifactStreamClient } from "../artifact-stream-client";
import { resetNegotiatedStreamVersions } from "../negotiated-stream-version-registry";
import { resetStreamMethodSupportMemo } from "../stream-method-support-registry";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import { WsStreamClient } from "../ws-stream-client";

class RecordingPeer implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly textSent: string[] = [];

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.textSent.push(data);
  }

  close(): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(frame: Record<string, unknown>): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(frame) });
  }

  fireBinary(bytes: Uint8Array): void {
    this.onmessage?.({ type: "binary", data: bytes });
  }
}

function parseText(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("expected an object stream frame");
  return parsed as Record<string, unknown>;
}

function schemaVersionOf(frame: Record<string, unknown>): {
  readonly major: number;
  readonly minor: number;
} {
  const value = frame.schemaVersion;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("SUBSCRIBE omitted its schema version");
  const major = Reflect.get(value, "major");
  const minor = Reflect.get(value, "minor");
  if (typeof major !== "number" || typeof minor !== "number")
    throw new Error("SUBSCRIBE has an invalid schema version");
  return { major, minor };
}

describe("ArtifactStreamClient negotiated minor", () => {
  afterEach(() => {
    resetNegotiatedStreamVersions();
    resetStreamMethodSupportMemo();
  });

  it.each([2, 3] as const)(
    "uses the real session negotiation for @1.%i document fields",
    async (minor) => {
      let resolvePeer: (peer: RecordingPeer) => void = () => {
        throw new Error("peer factory was not initialized");
      };
      const peerCreated = new Promise<RecordingPeer>((resolve) => {
        resolvePeer = resolve;
      });
      const peer = new RecordingPeer();
      const webSocketFactory: IStreamWebSocketFactory = {
        create() {
          resolvePeer(peer);
          return peer;
        },
      };
      const bearer = {
        identity: { userId: AUTHENTICATED_USER_FIXTURE_ID },
        getBearerToken: () => "synthetic-stream-bearer",
      };
      const streamClient = new WsStreamClient({
        clientIdentity: TEST_CLIENT_IDENTITY,
        registry: hostStreamRpcRegistry,
        endpoint: () => mockLocalHostEntry,
        hostId: mockLocalHostEntry.hostId,
        bearer: () => bearer,
        userId: AUTHENTICATED_USER_FIXTURE_ID,
        auth: null,
        clock: null,
        hostCredentialMint: null,
        onHostCredentialState: null,
        evidence: NO_TRANSPORT_EVIDENCE,
        webSocketFactory,
        dialTimeoutMs: 1_000,
        openAckTimeoutMs: 1_000,
        pingIntervalMs: 25_000,
        pongTimeoutMs: 50_000,
        initialBackoffMs: 10,
        maxBackoffMs: 1_000,
      });
      const subscribe = vi.spyOn(streamClient, "subscribeWithParamsProvider");
      const readOnlyMarks: boolean[] = [];
      const artifact = new ArtifactStreamClient({
        wsStreamClient: streamClient,
        epicId: "synthetic-task",
        artifactId: "synthetic-artifact",
        authorityEpoch: "synthetic-epoch",
        seedOfferProvider: () => null,
        callbacks: {
          onDoc: (frame) =>
            readOnlyMarks.push("readOnly" in frame && frame.readOnly === true),
          onDocUpdate: () => {},
          onDocAck: () => {},
          onAwareness: () => {},
          onUnavailable: () => {},
          onBodySync: () => {},
          onConnectionStatus: () => {},
        },
      });

      try {
        const connectedPeer = await peerCreated;
        connectedPeer.fireOpen();
        const hostManifest = {
          ...buildStreamManifest(
            hostStreamRpcRegistry,
            SERVES_EVERY_INSTALLED_MAJOR,
          ),
          "artifact.subscribe": { major: 1, minor },
        };
        connectedPeer.fireText({ kind: "openAck", manifest: hostManifest });

        const subscribeFrame = parseText(connectedPeer.textSent[1] ?? "null");
        expect(subscribeFrame).toMatchObject({
          kind: "subscribe",
          method: "artifact.subscribe",
          schemaVersion: { major: 1, minor },
        });
        const receivedVersion = schemaVersionOf(subscribeFrame);
        expect(receivedVersion).toEqual({ major: 1, minor });

        const openedSession = subscribe.mock.results[0];
        if (openedSession?.type !== "return")
          throw new Error(
            "ArtifactStreamClient did not open its stream session",
          );
        expect(openedSession.value.getNegotiatedSchemaVersion()).toEqual({
          major: 1,
          minor: receivedVersion.minor,
        });

        const docFrame = {
          kind: "doc",
          authorityEpoch: "synthetic-epoch",
          artifactId: "synthetic-artifact",
          docGuid: `synthetic-guid-${receivedVersion.minor}`,
          stateVectorBase64: "",
          hasBinaryPayload: true,
        };
        connectedPeer.fireText({
          ...docFrame,
          ...(receivedVersion.minor === 3 ? { readOnly: true } : {}),
        });
        connectedPeer.fireBinary(new Uint8Array([1, 2, 3]));

        if (receivedVersion.minor === 2) {
          connectedPeer.fireText({
            ...docFrame,
            docGuid: "synthetic-guid-v12-extra-field",
            readOnly: true,
          });
          connectedPeer.fireBinary(new Uint8Array([4, 5, 6]));
        }

        expect(readOnlyMarks).toEqual(
          receivedVersion.minor === 3 ? [true] : [false, false],
        );
      } finally {
        artifact.close();
        streamClient.close("artifact negotiation fixture complete");
      }
    },
  );
});
