/**
 * s4-promotion-trigger-retry: the stream client must forward the additive
 * `promotionState` field from a cloudSyncStatus frame as the fourth callback
 * argument. Store/badge coverage alone cannot prove the wire path.
 */
import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { EpicPromotionState } from "@traycer/protocol/host/epic/subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  EpicStreamClient,
  type EpicStreamCallbacks,
} from "../epic-stream-client";
import type { IStreamClient } from "../i-stream-client";
import type { IStreamSession, StreamFrameEnvelope } from "../i-stream-session";

/** The `epic.subscribe` minor this suite's frames are shaped for. */
const NEGOTIATED_SCHEMA_VERSION: SchemaVersion = { major: 1, minor: 3 };

function makeSessionWithInjector(): {
  readonly session: IStreamSession;
  readonly inject: (
    envelope: StreamFrameEnvelope,
    binary: Uint8Array | null,
  ) => void;
} {
  let frameHandler:
    | ((envelope: StreamFrameEnvelope, binary: Uint8Array | null) => void)
    | null = null;
  const session: IStreamSession = {
    onServerFrame(handler) {
      frameHandler = handler;
    },
    onStatusChange() {},
    sendClientFrame() {},
    requestReconnect() {},
    // Matches the version `makeTypedStreamClient` negotiates below: this
    // suite drives frames through a session that has already handshaken, so
    // the per-session version is known rather than the pre-handshake `null`.
    getNegotiatedSchemaVersion: () => NEGOTIATED_SCHEMA_VERSION,
    close() {},
  };
  return {
    session,
    inject: (envelope, binary) => {
      if (frameHandler === null) {
        throw new Error("no frame handler");
      }
      frameHandler(envelope, binary);
    },
  };
}

/**
 * A real typed `IStreamClient` stand-in — `subscribe` +
 * `getMethodSchemaVersion` only, no `as unknown as` cast.
 */
function makeTypedStreamClient(
  session: IStreamSession,
): IStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => session,
    getMethodSchemaVersion: () => NEGOTIATED_SCHEMA_VERSION,
  };
}

function noopCallbacks(
  overrides: Partial<EpicStreamCallbacks>,
): EpicStreamCallbacks {
  return {
    onSnapshot: () => undefined,
    onEarlyMeta: () => undefined,
    onUpdate: () => undefined,
    onAwareness: () => undefined,
    onPermissionChanged: () => undefined,
    onCloudSyncStatus: () => undefined,
    onArtifactRoomSnapshot: () => undefined,
    onArtifactRoomUpdate: () => undefined,
    onArtifactRoomAwareness: () => undefined,
    onArtifactRoomState: () => undefined,
    onArtifactRoomDirty: () => undefined,
    onRootDirty: () => undefined,
    onDirtySnapshot: () => undefined,
    onMigrationStarted: () => undefined,
    onMigrationProgress: () => undefined,
    onMigrationFailed: () => undefined,
    onMigrationNotAllowed: () => undefined,
    onConnectionStatus: () => undefined,
    onEpicDeleted: () => undefined,
    ...overrides,
  };
}

describe("EpicStreamClient cloudSyncStatus promotionState wire field", () => {
  it("forwards the durability legs as one onCloudSyncStatus value", () => {
    const { session, inject } = makeSessionWithInjector();
    const wsStreamClient = makeTypedStreamClient(session);

    const received: Array<{
      readonly status: string;
      readonly durability: string | undefined;
      readonly pauseReason: string | undefined;
      readonly promotionState: EpicPromotionState | undefined;
      readonly localProtection: string | undefined;
    }> = [];

    const client = new EpicStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      callbacks: noopCallbacks({
        onCloudSyncStatus: (status, durable) => {
          received.push({
            status,
            durability: durable.durability,
            pauseReason: durable.pauseReason,
            promotionState: durable.promotionState,
            localProtection: durable.localProtection,
          });
        },
      }),
    });

    inject(
      {
        kind: "cloudSyncStatus",
        epicId: "epic-1",
        status: "connected",
        durability: "promoting",
        promotionState: "pending",
        hasBinaryPayload: false,
      },
      null,
    );
    inject(
      {
        kind: "cloudSyncStatus",
        epicId: "epic-1",
        status: "connected",
        durability: "promoting",
        promotionState: "active",
        hasBinaryPayload: false,
      },
      null,
    );

    expect(received).toEqual([
      {
        status: "connected",
        durability: "promoting",
        pauseReason: undefined,
        promotionState: "pending",
      },
      {
        status: "connected",
        durability: "promoting",
        pauseReason: undefined,
        promotionState: "active",
      },
    ]);
    client.close();
  });
});
