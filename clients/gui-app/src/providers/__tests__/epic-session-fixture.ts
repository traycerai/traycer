import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { EPIC_LANE_METHODS } from "@traycer-clients/shared/epic-lanes";
import type { EpicStateSnapshotFrame } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicStatusSnapshotFrame } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  createRecordingStreamClient,
  type RecordedSession,
} from "@traycer-clients/shared/replica-runtime/worker/test-support/recording-stream-client";
import type {
  ParamsOf,
  StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import { fakeDurableStreamTransports } from "@/lib/host/test-support/fake-durable-stream-transport";

export type EpicSessionFixtureArm = "legacy" | "lanes";

export interface EpicSessionFixture {
  readonly arm: EpicSessionFixtureArm;
  /** The host-side source from which both legacy and lane snapshots are built. */
  readonly sourceRoot: Y.Doc;
  readonly manifest: ReadonlyArray<{
    readonly method: keyof HostStreamRpcRegistry & string;
    readonly support: StreamMethodSupport;
  }>;
  readonly supportReads: ReadonlyArray<string>;
  readonly transportSupportReads: ReadonlyArray<string>;
  readonly support: (method: string) => StreamMethodSupport;
  readonly legacyStreams: ReadonlyArray<RecordedSession>;
  readonly stateStreams: ReadonlyArray<RecordedSession>;
  readonly statusStreams: ReadonlyArray<RecordedSession>;
  readonly artifactStreams: ReadonlyArray<RecordedSession>;
  readonly opens: {
    readonly legacy: number;
    readonly state: number;
    readonly status: number;
    readonly artifact: number;
  };
  openLegacyStream(index: number): void;
  deliverLegacySnapshot(index: number, roomId: string): void;
  openLaneStreams(index: number): void;
  deliverLaneSnapshots(index: number): void;
  dispose(): void;
}

const AUTHORITY_EPOCH = "fixture-authority-epoch";

function legacySnapshotMeta(roomId: string): SnapshotMetaEpic {
  return {
    schemaVersion: "2.0.0",
    roomId,
    epicLight: null,
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

/**
 * The host's state-lane boundary, represented in the fixture by the same
 * JSON-only frame contract the real `EpicLaneSession.snapshotFrame` emits.
 *
 * Reading the title from `sourceRoot` makes the source relationship
 * observable in the provider test. The root's `attachments` map has no field
 * in this contract, so it cannot cross this boundary with the projected state.
 */
function stateSnapshot(sourceRoot: Y.Doc): EpicStateSnapshotFrame {
  const title: unknown = sourceRoot.getMap("epic").get("title");
  if (typeof title !== "string") {
    throw new Error("expected the source root to hold an epic title");
  }
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: AUTHORITY_EPOCH,
    basis: "cold",
    position: 1,
    reconciledWithCloud: true,
    artifactRecords: [],
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: 1, claims: [] },
    epicMeta: {
      revision: 1,
      meta: { title, updatedAt: 1 },
    },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a state snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function statusSnapshot(): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: AUTHORITY_EPOCH,
    securityEpoch: 1,
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a status snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function buildSupport(arm: EpicSessionFixtureArm): ReadonlyArray<{
  readonly method: keyof HostStreamRpcRegistry & string;
  readonly support: StreamMethodSupport;
}> {
  const methods: Array<keyof HostStreamRpcRegistry & string> = [
    "epic.subscribe",
    ...EPIC_LANE_METHODS,
  ];
  const laneSupport: StreamMethodSupport =
    arm === "lanes" ? "supported" : "unsupported";
  return methods.map((method) => ({
    method,
    support: method === "epic.subscribe" ? "supported" : laneSupport,
  }));
}

export function createEpicSessionFixture(
  arm: EpicSessionFixtureArm,
): EpicSessionFixture {
  const sourceRoot = new Y.Doc();
  sourceRoot.getMap("epic").set("title", "Fixture Epic");
  const manifest = buildSupport(arm);
  const supportReads: string[] = [];
  const transportSupportReads: string[] = [];
  const openedSessions: RecordedSession[] = [];
  const support = (method: string): StreamMethodSupport => {
    supportReads.push(method);
    return (
      manifest.find((entry) => entry.method === method)?.support ?? "unknown"
    );
  };
  const sessionsFor = (method: string): ReadonlyArray<RecordedSession> =>
    openedSessions.filter((session) => session.method === method);
  const opens = {
    get legacy(): number {
      return sessionsFor("epic.subscribe").length;
    },
    get state(): number {
      return sessionsFor("epic.state.subscribe").length;
    },
    get status(): number {
      return sessionsFor("epic.status.subscribe").length;
    },
    get artifact(): number {
      return sessionsFor("artifact.subscribe").length;
    },
  };

  const durableTransports = fakeDurableStreamTransports();
  const previousOpener = durableTransports.opener;
  const opener = (hostId: string) => {
    const transport = previousOpener(hostId);
    const recording = createRecordingStreamClient();
    const capture = (open: () => IStreamSession): IStreamSession => {
      const previousCount = recording.opened().length;
      const session = open();
      const recorded = recording.opened().at(-1);
      if (
        recorded === undefined ||
        recording.opened().length !== previousCount + 1
      ) {
        throw new Error("expected one recorded stream session");
      }
      openedSessions.push(recorded);
      return session;
    };
    const subscribe = <Method extends keyof HostStreamRpcRegistry & string>(
      method: Method,
      params: ParamsOf<HostStreamRpcRegistry, Method>,
    ): IStreamSession =>
      capture(() => recording.client.subscribe(method, params));
    const subscribeWithParamsProvider = <
      Method extends keyof HostStreamRpcRegistry & string,
    >(
      method: Method,
      paramsProvider: () => ParamsOf<HostStreamRpcRegistry, Method>,
    ): IStreamSession =>
      capture(() =>
        recording.client.subscribeWithParamsProvider(method, paramsProvider),
      );
    transport.wsStreamClient.subscribe = subscribe;
    transport.wsStreamClient.subscribeWithParamsProvider =
      subscribeWithParamsProvider;
    transport.wsStreamClient.getMethodSupport = (method) => {
      transportSupportReads.push(method);
      return support(method);
    };
    return transport;
  };
  durableTransports.opener = opener;

  return {
    arm,
    sourceRoot,
    manifest,
    supportReads,
    transportSupportReads,
    support,
    get legacyStreams() {
      return sessionsFor("epic.subscribe");
    },
    get stateStreams() {
      return sessionsFor("epic.state.subscribe");
    },
    get statusStreams() {
      return sessionsFor("epic.status.subscribe");
    },
    get artifactStreams() {
      return sessionsFor("artifact.subscribe");
    },
    opens,
    openLegacyStream: (index) => {
      const stream = sessionsFor("epic.subscribe").at(index);
      if (stream === undefined) throw new Error("expected a legacy stream");
      stream.emitStatus("open", null);
    },
    deliverLegacySnapshot: (index, roomId) => {
      const stream = sessionsFor("epic.subscribe").at(index);
      if (stream === undefined) throw new Error("expected a legacy stream");
      stream.emitFrame(
        {
          kind: "snapshot",
          hasBinaryPayload: true,
          meta: legacySnapshotMeta(roomId),
        },
        Y.encodeStateAsUpdate(sourceRoot),
      );
    },
    openLaneStreams: (index) => {
      const status = sessionsFor("epic.status.subscribe").at(index);
      const state = sessionsFor("epic.state.subscribe").at(index);
      if (status === undefined || state === undefined) {
        throw new Error("expected state and status streams");
      }
      status.emitStatus("open", null);
      state.emitStatus("open", null);
    },
    deliverLaneSnapshots: (index) => {
      const status = sessionsFor("epic.status.subscribe").at(index);
      const state = sessionsFor("epic.state.subscribe").at(index);
      if (status === undefined || state === undefined) {
        throw new Error("expected state and status streams");
      }
      status.emitFrame(statusSnapshot(), null);
      state.emitFrame(stateSnapshot(sourceRoot), null);
    },
    dispose: () => {
      sourceRoot.destroy();
      if (durableTransports.opener === opener) {
        durableTransports.opener = previousOpener;
      }
    },
  };
}
