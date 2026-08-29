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
  StatusChangeHandler,
  StreamFrameEnvelope,
} from "../i-stream-session";

/**
 * The `epic.subscribe` minor this suite's frames are shaped for. `1.6`, not
 * `1.3`: `promotionState` and the durability legs do not exist below it, so a
 * `1.3` session could never send the frames injected here and the suite was
 * asserting behaviour for an input the wire cannot produce.
 */
const NEGOTIATED_SCHEMA_VERSION: SchemaVersion = { major: 1, minor: 6 };

/**
 * Mainline's own `epic.subscribe` work, which landed as an independent MAJOR
 * rather than as further minors on the 1.x line. It carries a typed
 * metadata/body plane and no `cloudSyncStatus` durability frame at all, so
 * "2.0" is emphatically not "1.6 and then some".
 */
const V2_SCHEMA_VERSION: SchemaVersion = { major: 2, minor: 0 };

function makeSessionWithInjector(negotiated: SchemaVersion): {
  readonly session: IStreamSession;
  readonly inject: (
    envelope: StreamFrameEnvelope,
    binary: Uint8Array | null,
  ) => void;
  readonly emitOpen: () => void;
} {
  let frameHandler:
    | ((envelope: StreamFrameEnvelope, binary: Uint8Array | null) => void)
    | null = null;
  let statusHandler: StatusChangeHandler | null = null;
  const session: IStreamSession = {
    onServerFrame(handler) {
      frameHandler = handler;
    },
    onStatusChange(handler) {
      statusHandler = handler;
    },
    sendClientFrame() {},
    requestReconnect() {},
    // Matches the version `makeTypedStreamClient` negotiates below: this
    // suite drives frames through a session that has already handshaken, so
    // the per-session version is known rather than the pre-handshake `null`.
    getNegotiatedSchemaVersion: () => negotiated,
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
    emitOpen: () => {
      if (statusHandler === null) {
        throw new Error("no status handler");
      }
      statusHandler("open", null);
    },
  };
}

/**
 * A real typed `IStreamClient` stand-in — `subscribe`,
 * `subscribeWithParamsProvider` and `getMethodSchemaVersion`, no
 * `as unknown as` cast. The provider arm returns the same session: this suite
 * is about the durability legs on `cloudSyncStatus`, not about what the open
 * request carried.
 */
function makeTypedStreamClient(
  session: IStreamSession,
  negotiated: SchemaVersion,
): IStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => session,
    subscribeWithParamsProvider: () => session,
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
  it("forwards the durability legs as one onCloudSyncStatus value", () => {
    const { session, inject } = makeSessionWithInjector(
      NEGOTIATED_SCHEMA_VERSION,
    );
    const wsStreamClient = makeTypedStreamClient(
      session,
      NEGOTIATED_SCHEMA_VERSION,
    );

    const received: Array<{
      readonly status: string;
      readonly durability: string | undefined;
      readonly pauseReason: string | undefined;
      readonly promotionState: EpicPromotionState | undefined;
      readonly localProtection: string | undefined;
      readonly peerSpeaksDurabilityLegs: boolean;
    }> = [];

    const client = new EpicStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      // No offer: this suite drives `cloudSyncStatus` frames, and a cold open
      // is the case where a seed offer is absent by construction.
      seedOfferProvider: () => null,
      callbacks: noopCallbacks({
        onCloudSyncStatus: (status, durable) => {
          received.push({
            status,
            durability: durable.durability,
            pauseReason: durable.pauseReason,
            promotionState: durable.promotionState,
            localProtection: durable.localProtection,
            peerSpeaksDurabilityLegs: durable.peerSpeaksDurabilityLegs,
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

    // Every recorded key is stated, `localProtection` included. Omitting it
    // read as an assertion about five fields while `toEqual` quietly treats an
    // own property holding `undefined` as absent - so a regression that began
    // populating it, or one that dropped a field this suite means to pin,
    // would have passed unremarked.
    expect(received).toEqual([
      {
        status: "connected",
        durability: "promoting",
        pauseReason: undefined,
        promotionState: "pending",
        localProtection: undefined,
        peerSpeaksDurabilityLegs: true,
      },
      {
        status: "connected",
        durability: "promoting",
        pauseReason: undefined,
        promotionState: "active",
        localProtection: undefined,
        peerSpeaksDurabilityLegs: true,
      },
    ]);
    client.close();
  });

  it("does not read an independent major as a durability floor", () => {
    // A minor floor describes one major line and nothing else. `@2.0` is not
    // "@1.6 and then some": it is mainline's separate contract, with a typed
    // metadata/body plane and no `cloudSyncStatus` durability frame at all.
    // Answering `2 > 1` here told the renderer durability had been negotiated
    // on a line that never defined it, leaving comment availability stuck in
    // `checking` and absent v1 legs read as guarantees v2 never made.
    const { session, inject, emitOpen } =
      makeSessionWithInjector(V2_SCHEMA_VERSION);
    const wsStreamClient = makeTypedStreamClient(session, V2_SCHEMA_VERSION);

    const durabilityNegotiatedAtOpen: boolean[] = [];
    const legsClaimed: boolean[] = [];

    const client = new EpicStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      seedOfferProvider: () => null,
      callbacks: noopCallbacks({
        onConnectionStatus: (_status, _reason, durabilityStatusNegotiated) => {
          durabilityNegotiatedAtOpen.push(durabilityStatusNegotiated);
        },
        onCloudSyncStatus: (_status, durable) => {
          legsClaimed.push(durable.peerSpeaksDurabilityLegs);
        },
      }),
    });

    // Both predicates, at their two distinct observation points: the
    // status-change projection and the per-frame durability envelope.
    emitOpen();
    expect(durabilityNegotiatedAtOpen).toEqual([false]);

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
    expect(legsClaimed).toEqual([false]);
    client.close();
  });
});
