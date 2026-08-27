/**
 * Byte-pass-through wrapper for `epic.subscribe@2`.
 *
 * The GUI store owns epoch/seq fences and the @1 fallback adapter. This class
 * only opens the method, drops frames unless THIS session negotiated major 2
 * (not the client-wide version query), and routes typed envelopes.
 */
import { describe, expect, it, vi } from "vitest";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamFrameEnvelope,
} from "../i-stream-session";
import type { IStreamClient } from "../i-stream-client";
import type { ParamsOf } from "../ws-stream-client";
import {
  EpicV2StreamClient,
  type EpicV2StreamCallbacks,
} from "../epic-v2-stream-client";

const EPIC_ID = "epic-1";
const STREAM_EPOCH = "epoch-a";

const SPEC_RECORD = {
  kind: "spec" as const,
  id: "spec-1",
  folderName: "overview",
  title: "Overview",
  createdAt: 1,
  updatedAt: 2,
  createdManually: false,
  parentId: null,
};

class StubSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler = () => undefined;
  private statusChangeHandler: StatusChangeHandler = () => undefined;
  negotiatedSchemaVersion: SchemaVersion | null = { major: 2, minor: 0 };
  readonly sent: Array<{
    readonly envelope: StreamFrameEnvelope;
    readonly binaryPayload: Uint8Array | null;
  }> = [];
  readonly close = vi.fn();

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    this.sent.push({ envelope, binaryPayload });
  }

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
    frame: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    this.serverFrameHandler(frame, binaryPayload);
  }

  emitStatus(
    status: Parameters<StatusChangeHandler>[0],
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler(status, reason);
  }
}

class StubStreamClient implements IStreamClient<HostStreamRpcRegistry> {
  readonly subscribeCalls: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];
  /**
   * Deliberately a connection-wide lie. `RemoteStreamClient` answers this
   * with `null`; a local client may answer another session's version. The
   * wrapper must ignore it and read `session.getNegotiatedSchemaVersion()`.
   */
  clientWideSchemaVersion: SchemaVersion | null = { major: 2, minor: 0 };

  constructor(private readonly session: IStreamSession) {}

  subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribeCalls.push({ method, params });
    return this.session;
  }

  subscribeWithParamsProvider<
    Method extends keyof HostStreamRpcRegistry & string,
  >(
    _method: Method,
    _paramsProvider: () => ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return this.session;
  }

  getMethodSchemaVersion<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
  ): SchemaVersion | null {
    return this.clientWideSchemaVersion;
  }
}

function makeCallbacks(): EpicV2StreamCallbacks {
  return {
    onEpicStateSnapshot: vi.fn(),
    onArtifactRecordUpsert: vi.fn(),
    onArtifactRecordRemove: vi.fn(),
    onEpicMetaChanged: vi.fn(),
    onRoleClaimsChanged: vi.fn(),
    onCommentThreadsChanged: vi.fn(),
    onEarlyMeta: vi.fn(),
    onPermissionChanged: vi.fn(),
    onCloudSyncStatus: vi.fn(),
    onMigrationStarted: vi.fn(),
    onMigrationProgress: vi.fn(),
    onMigrationFailed: vi.fn(),
    onMigrationNotAllowed: vi.fn(),
    onEpicDeleted: vi.fn(),
    onArtifactDoc: vi.fn(),
    onArtifactDocUpdate: vi.fn(),
    onArtifactDocAck: vi.fn(),
    onArtifactDocAwareness: vi.fn(),
    onArtifactUnavailable: vi.fn(),
    onConnectionStatus: vi.fn(),
  };
}

function harness(): {
  readonly session: StubSession;
  readonly wsStreamClient: StubStreamClient;
  readonly callbacks: EpicV2StreamCallbacks;
  readonly client: EpicV2StreamClient;
} {
  const session = new StubSession();
  const wsStreamClient = new StubStreamClient(session);
  const callbacks = makeCallbacks();
  const client = new EpicV2StreamClient({
    wsStreamClient,
    epicId: EPIC_ID,
    callbacks,
  });
  return { session, wsStreamClient, callbacks, client };
}

describe("EpicV2StreamClient", () => {
  it("subscribes to epic.subscribe with the epic id", () => {
    const h = harness();
    expect(h.wsStreamClient.subscribeCalls).toEqual([
      { method: "epic.subscribe", params: { epicId: EPIC_ID } },
    ]);
    h.client.close();
  });

  it("routes typed metadata and pairs body frames with their binary payload", () => {
    const h = harness();
    const snapshot = {
      kind: "epicStateSnapshot",
      artifactRecords: [SPEC_RECORD],
      deletedArtifacts: [],
      roleClaims: [],
      epicMeta: { title: "Epic", updatedAt: 1 },
      streamEpoch: STREAM_EPOCH,
      seq: 0,
      hasBinaryPayload: false,
    };
    const bytes = new Uint8Array([1, 2, 3]);

    h.session.emitFrame(snapshot, null);
    h.session.emitFrame(
      {
        kind: "artifactDoc",
        artifactId: "spec-1",
        docGuid: "guid-1",
        stateVectorBase64: "AQ==",
        streamEpoch: STREAM_EPOCH,
        hasBinaryPayload: true,
      },
      bytes,
    );
    h.session.emitFrame(
      {
        kind: "pong",
        streamEpoch: STREAM_EPOCH,
        hasBinaryPayload: false,
      },
      null,
    );

    expect(h.callbacks.onEpicStateSnapshot).toHaveBeenCalledWith(snapshot);
    expect(h.callbacks.onArtifactDoc).toHaveBeenCalledWith(
      {
        kind: "artifactDoc",
        artifactId: "spec-1",
        docGuid: "guid-1",
        stateVectorBase64: "AQ==",
        streamEpoch: STREAM_EPOCH,
        hasBinaryPayload: true,
      },
      bytes,
    );
    expect(h.callbacks.onArtifactDocUpdate).not.toHaveBeenCalled();
    h.client.close();
  });

  it("drops binary body frames that arrive without a payload", () => {
    const h = harness();
    h.session.emitFrame(
      {
        kind: "artifactDocUpdate",
        artifactId: "spec-1",
        docGuid: "guid-1",
        streamEpoch: STREAM_EPOCH,
        hasBinaryPayload: true,
      },
      null,
    );
    expect(h.callbacks.onArtifactDocUpdate).not.toHaveBeenCalled();
    h.client.close();
  });

  it("ignores frames unless THIS session negotiated major 2", () => {
    const h = harness();
    const snapshot = {
      kind: "epicStateSnapshot",
      artifactRecords: [],
      deletedArtifacts: [],
      roleClaims: [],
      epicMeta: { title: "Epic", updatedAt: 1 },
      streamEpoch: STREAM_EPOCH,
      seq: 0,
      hasBinaryPayload: false,
    };

    h.session.negotiatedSchemaVersion = { major: 1, minor: 3 };
    h.session.emitFrame(snapshot, null);
    expect(h.callbacks.onEpicStateSnapshot).not.toHaveBeenCalled();

    h.session.negotiatedSchemaVersion = null;
    h.session.emitFrame(snapshot, null);
    expect(h.callbacks.onEpicStateSnapshot).not.toHaveBeenCalled();

    h.session.negotiatedSchemaVersion = { major: 2, minor: 0 };
    h.session.emitFrame(snapshot, null);
    expect(h.callbacks.onEpicStateSnapshot).toHaveBeenCalledTimes(1);
    h.client.close();
  });

  it("does not consult the client-wide method version (RemoteStreamClient is null there)", () => {
    const h = harness();
    h.wsStreamClient.clientWideSchemaVersion = { major: 2, minor: 0 };
    h.session.negotiatedSchemaVersion = null;
    h.session.emitFrame(
      {
        kind: "artifactRecordRemove",
        artifactId: "spec-1",
        streamEpoch: STREAM_EPOCH,
        seq: 1,
        hasBinaryPayload: false,
      },
      null,
    );
    expect(h.callbacks.onArtifactRecordRemove).not.toHaveBeenCalled();
    h.client.close();
  });

  it("drops @1 root-doc frames even on a major-2 session", () => {
    const h = harness();
    h.session.emitFrame(
      {
        kind: "snapshot",
        epicId: EPIC_ID,
        hasBinaryPayload: true,
      },
      new Uint8Array([1]),
    );
    expect(h.callbacks.onEpicStateSnapshot).not.toHaveBeenCalled();
    h.client.close();
  });

  it("sends attach/detach/body/retry frames without a payload epicId", () => {
    const h = harness();
    const update = new Uint8Array([9]);
    const awareness = new Uint8Array([7]);
    h.client.attachArtifact("spec-1", null);
    h.client.attachArtifact("spec-1", {
      knownDocGuid: "guid-1",
      stateVectorBase64: "AQ==",
    });
    h.client.detachArtifact("spec-1");
    h.client.applyArtifactDocUpdate("spec-1", "guid-1", update);
    h.client.artifactDocAwareness("spec-1", awareness);
    h.client.retryMigration();

    expect(h.session.sent).toEqual([
      {
        envelope: {
          kind: "attachArtifact",
          artifactId: "spec-1",
          hasBinaryPayload: false,
        },
        binaryPayload: null,
      },
      {
        envelope: {
          kind: "attachArtifact",
          artifactId: "spec-1",
          knownDocGuid: "guid-1",
          stateVectorBase64: "AQ==",
          hasBinaryPayload: false,
        },
        binaryPayload: null,
      },
      {
        envelope: {
          kind: "detachArtifact",
          artifactId: "spec-1",
          hasBinaryPayload: false,
        },
        binaryPayload: null,
      },
      {
        envelope: {
          kind: "artifactDocApplyUpdate",
          artifactId: "spec-1",
          docGuid: "guid-1",
          hasBinaryPayload: true,
        },
        binaryPayload: update,
      },
      {
        envelope: {
          kind: "artifactDocAwareness",
          artifactId: "spec-1",
          hasBinaryPayload: true,
        },
        binaryPayload: awareness,
      },
      {
        envelope: { kind: "retryMigration", hasBinaryPayload: false },
        binaryPayload: null,
      },
    ]);
    for (const sent of h.session.sent) {
      expect("epicId" in sent.envelope).toBe(false);
    }
    h.client.close();
  });

  it("propagates status and ignores traffic after close", () => {
    const h = harness();
    const reason: StreamCloseReason = { kind: "caller" };
    h.session.emitStatus("reconnecting", null);
    h.session.emitStatus("closed", reason);
    expect(h.callbacks.onConnectionStatus).toHaveBeenNthCalledWith(
      1,
      "reconnecting",
      null,
    );
    expect(h.callbacks.onConnectionStatus).toHaveBeenNthCalledWith(
      2,
      "closed",
      reason,
    );

    h.client.close();
    h.client.attachArtifact("spec-1", null);
    h.client.retryMigration();
    h.client.close();
    expect(h.session.sent).toEqual([]);
    expect(h.session.close).toHaveBeenCalledTimes(1);

    // The RECEIVE half of the same contract: the session can still deliver a
    // frame already in flight after `close()`, and the store callbacks must
    // not hear it.
    h.session.emitFrame(
      {
        kind: "epicMetaChanged",
        epicMeta: { title: "Late", updatedAt: 9 },
        streamEpoch: STREAM_EPOCH,
        hasBinaryPayload: false,
      },
      null,
    );
    expect(h.callbacks.onEpicMetaChanged).not.toHaveBeenCalled();
  });
});
