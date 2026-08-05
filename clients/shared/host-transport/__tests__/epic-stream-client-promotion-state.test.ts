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
import type {
  IStreamSession,
  StreamFrameEnvelope,
} from "../i-stream-session";

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
  const negotiated: SchemaVersion = { major: 1, minor: 3 };
  return {
    subscribe: () => session,
    getMethodSchemaVersion: () => negotiated,
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
  it("forwards promotionState as the fourth onCloudSyncStatus argument", () => {
    const { session, inject } = makeSessionWithInjector();
    const wsStreamClient = makeTypedStreamClient(session);

    const received: Array<{
      readonly status: string;
      readonly durability: string | undefined;
      readonly pauseReason: string | undefined;
      readonly promotionState: EpicPromotionState | undefined;
    }> = [];

    const client = new EpicStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      callbacks: noopCallbacks({
        onCloudSyncStatus: (
          status,
          durability,
          pauseReason,
          promotionState,
        ) => {
          received.push({
            status,
            durability,
            pauseReason,
            promotionState,
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
