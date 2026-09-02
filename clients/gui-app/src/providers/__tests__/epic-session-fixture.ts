import * as Y from "yjs";
import type {
  EarlyMetaEpic,
  SnapshotMetaEpic,
} from "@traycer/protocol/host/epic/snapshot-meta";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { EPIC_LANE_METHODS } from "@traycer-clients/shared/epic-lanes";
import type {
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
  ArtifactStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/runtime/legacy-epic-stream-adapter";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { EpicRuntimeStreamFactories } from "@/stores/epics/open-epic/runtime/worker/epic-runtime-composition";
import type {
  EpicLaneSelectionSources,
  EpicLaneUnaries,
} from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  EpicStateSnapshotFrame,
  EpicStateStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import { fakeDurableStreamTransports } from "@/lib/host/test-support/fake-durable-stream-transport";

export type EpicSessionFixtureArm = "legacy" | "lanes";

interface LegacyStream {
  readonly callbacks: EpicStreamCallbacks;
  closeCount: number;
}

interface StateStream {
  readonly callbacks: EpicStateStreamCallbacks;
  closeCount: number;
}

interface StatusStream {
  readonly callbacks: EpicStatusStreamCallbacks;
  closeCount: number;
}

interface ArtifactStream {
  readonly callbacks: ArtifactStreamCallbacks;
  closeCount: number;
}

export interface EpicSessionFixture {
  readonly arm: EpicSessionFixtureArm;
  readonly sourceRoot: Y.Doc;
  readonly manifest: ReadonlyArray<{
    readonly method: keyof HostStreamRpcRegistry & string;
    readonly support: StreamMethodSupport;
  }>;
  readonly supportReads: ReadonlyArray<string>;
  readonly transportSupportReads: ReadonlyArray<string>;
  readonly support: (method: string) => StreamMethodSupport;
  readonly factories: EpicRuntimeStreamFactories;
  readonly laneSelection: EpicLaneSelectionSources | null;
  readonly legacyStreams: ReadonlyArray<LegacyStream>;
  readonly stateStreams: ReadonlyArray<StateStream>;
  readonly statusStreams: ReadonlyArray<StatusStream>;
  readonly artifactStreams: ReadonlyArray<ArtifactStream>;
  readonly opens: {
    legacy: number;
    state: number;
    status: number;
    artifact: number;
  };
  openLegacyStream(index: number): void;
  deliverLegacySnapshot(index: number, roomId: string): void;
  openLaneStreams(index: number): void;
  deliverLaneSnapshots(index: number): void;
  dispose(): void;
}

const AUTHORITY_EPOCH = "fixture-authority-epoch";

const EARLY_META: EarlyMetaEpic = {
  epicLight: null,
  permissionRole: "editor",
  repos: [],
  workspaces: [],
  repoMapping: [],
  workspaceFolders: [],
  unresolvedRepos: [],
};

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

function stateSnapshot(): EpicStateSnapshotFrame {
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
      meta: { title: "Fixture Epic", updatedAt: 1 },
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

function laneUnaries(): EpicLaneUnaries {
  return {
    getWorkspaceContext: () => Promise.resolve(EARLY_META),
    retryMigration: () => Promise.resolve(),
  };
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
  const support = (method: string): StreamMethodSupport => {
    supportReads.push(method);
    return (
      manifest.find((entry) => entry.method === method)?.support ?? "unknown"
    );
  };
  const legacyStreams: LegacyStream[] = [];
  const stateStreams: StateStream[] = [];
  const statusStreams: StatusStream[] = [];
  const artifactStreams: ArtifactStream[] = [];
  const opens = { legacy: 0, state: 0, status: 0, artifact: 0 };
  const legacyStreamClientFactory: EpicStreamClientFactory = (
    _epicId,
    callbacks,
  ) => {
    const stream: LegacyStream = {
      callbacks,
      closeCount: 0,
    };
    legacyStreams.push(stream);
    opens.legacy += 1;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => {
        stream.closeCount += 1;
      },
    };
  };
  const stateStreamClientFactory: EpicStateStreamClientFactory = (
    _epicId,
    callbacks,
  ) => {
    const stream: StateStream = { callbacks, closeCount: 0 };
    stateStreams.push(stream);
    opens.state += 1;
    return {
      close: () => {
        stream.closeCount += 1;
      },
    };
  };
  const statusStreamClientFactory: EpicStatusStreamClientFactory = (
    _epicId,
    callbacks,
  ) => {
    const stream: StatusStream = { callbacks, closeCount: 0 };
    statusStreams.push(stream);
    opens.status += 1;
    return {
      close: () => {
        stream.closeCount += 1;
      },
    };
  };
  const artifactStreamClientFactory: ArtifactStreamClientFactory = (
    request,
  ) => {
    const stream: ArtifactStream = {
      callbacks: request.callbacks,
      closeCount: 0,
    };
    artifactStreams.push(stream);
    opens.artifact += 1;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => {
        stream.closeCount += 1;
      },
    };
  };
  const laneSelection: EpicLaneSelectionSources | null =
    arm === "lanes"
      ? {
          support,
          subscribeSupport: () => () => undefined,
          stateStreamClientFactory,
          statusStreamClientFactory,
          artifactStreamClientFactory,
          unaries: laneUnaries(),
        }
      : null;
  const factories: EpicRuntimeStreamFactories = {
    streamClientFactory: legacyStreamClientFactory,
    laneSelection,
  };
  const durableTransports = fakeDurableStreamTransports();
  const previousOpener = durableTransports.opener;
  const opener = (hostId: string) => {
    const transport = previousOpener(hostId);
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
    factories,
    laneSelection,
    legacyStreams,
    stateStreams,
    statusStreams,
    artifactStreams,
    opens,
    openLegacyStream: (index) => {
      const stream = legacyStreams.at(index);
      if (stream === undefined) throw new Error("expected a legacy stream");
      stream.callbacks.onConnectionStatus("open", null);
    },
    deliverLegacySnapshot: (index, roomId) => {
      const stream = legacyStreams.at(index);
      if (stream === undefined) throw new Error("expected a legacy stream");
      stream.callbacks.onSnapshot(
        legacySnapshotMeta(roomId),
        Y.encodeStateAsUpdate(sourceRoot),
      );
    },
    openLaneStreams: (index) => {
      const status = statusStreams.at(index);
      const state = stateStreams.at(index);
      if (status === undefined || state === undefined) {
        throw new Error("expected state and status streams");
      }
      status.callbacks.onConnectionStatus("open", null);
      state.callbacks.onConnectionStatus("open", null);
    },
    deliverLaneSnapshots: (index) => {
      const status = statusStreams.at(index);
      const state = stateStreams.at(index);
      if (status === undefined || state === undefined) {
        throw new Error("expected state and status streams");
      }
      status.callbacks.onSnapshot(statusSnapshot());
      state.callbacks.onSnapshot(stateSnapshot());
    },
    dispose: () => {
      sourceRoot.destroy();
      if (durableTransports.opener === opener) {
        durableTransports.opener = previousOpener;
      }
    },
  };
}
