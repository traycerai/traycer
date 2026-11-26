import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/runtime/legacy-epic-stream-adapter";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "@traycer-clients/shared/host-transport/ws-stream-factory";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "@traycer-clients/shared/host-transport/ws-factory";
import type { AttributableDurableStreamTransport } from "@/lib/host/durable-stream-transport";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import {
  poolHostDirectoryEntry,
  POOL_HOST_ID,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  createPoolHostTransport,
  type RemoteHostTransport,
} from "@traycer-clients/shared/host-transport/remote/index";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/capability-manifest";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  MuxFrameType,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
  decodeMuxFrame,
  encodeMuxFrame,
  type MuxFrame,
} from "@traycer/protocol/host-transport/mux";
import {
  ChunkReassembler,
  OutboundChunkSource,
  type OutboundMessage,
} from "@traycer/protocol/host-transport/chunking";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { epicStatusSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/status-subscribe";
import { epicStateSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/state-subscribe";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import type { ArtifactLaneStreamClient } from "@traycer-clients/shared/epic-lanes";
import { act } from "@testing-library/react";
import type { EpicRuntimeStreamFactories } from "@/stores/epics/open-epic/runtime/worker/epic-runtime-composition";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import {
  createInProcessEpicRuntimeWorker,
  type InProcessEpicRuntimeWorker,
} from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";
import { absentLaneUnaries } from "@/stores/epics/open-epic/test-support/absent-lane-unaries";
import { __setEpicRuntimeWorkerFactoryForTests } from "@/lib/registries/epic-runtime-worker-factory-slot";

export type TestLaneSupport = "unknown" | "supported" | "unsupported";

export interface TestLaneManifest {
  readonly "epic.state.subscribe": TestLaneSupport;
  readonly "artifact.subscribe": TestLaneSupport;
  readonly "epic.status.subscribe": TestLaneSupport;
}

export const COMPLETE_TEST_LANE_MANIFEST: TestLaneManifest = {
  "epic.state.subscribe": "supported",
  "artifact.subscribe": "supported",
  "epic.status.subscribe": "supported",
};

export interface PublicationReplacementWireInput {
  readonly boundaryRows: readonly number[];
  readonly boundary: string;
  readonly direction: "pool-to-computer" | "computer-to-pool";
  readonly storage: "room" | "object";
  readonly coveringAckReceived: boolean;
  readonly successorSeedContainsEdit: boolean;
  readonly objectSuccessorRevision: "previous" | "edit" | null;
  readonly convergesWhenSourceReturns: boolean;
}

/** App wire facts for the ten A4 boundaries; T7 owns the publisher-side proof. */
export const PUBLICATION_REPLACEMENT_WIRE_INPUTS = [
  {
    boundaryRows: [1],
    boundary: "room projection accepted; provider unconfirmed",
    direction: "pool-to-computer",
    storage: "room",
    coveringAckReceived: false,
    successorSeedContainsEdit: false,
    objectSuccessorRevision: null,
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [2],
    boundary: "room provider confirmed; covering ack missing",
    direction: "pool-to-computer",
    storage: "room",
    coveringAckReceived: false,
    successorSeedContainsEdit: true,
    objectSuccessorRevision: null,
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [3],
    boundary: "room covering ack received",
    direction: "pool-to-computer",
    storage: "room",
    coveringAckReceived: true,
    successorSeedContainsEdit: true,
    objectSuccessorRevision: null,
    convergesWhenSourceReturns: false,
  },
  // Both barriers give a pointer-first computer the previous root and no ack.
  {
    boundaryRows: [4, 5],
    boundary: "object CAS pending or landed behind a held root",
    direction: "pool-to-computer",
    storage: "object",
    coveringAckReceived: false,
    successorSeedContainsEdit: false,
    objectSuccessorRevision: "previous",
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [6],
    boundary: "object root confirmed; covering ack missing",
    direction: "pool-to-computer",
    storage: "object",
    coveringAckReceived: false,
    successorSeedContainsEdit: true,
    objectSuccessorRevision: "edit",
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [7],
    boundary: "object covering ack received",
    direction: "pool-to-computer",
    storage: "object",
    coveringAckReceived: true,
    successorSeedContainsEdit: true,
    objectSuccessorRevision: "edit",
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [8],
    boundary: "computer room before local ack",
    direction: "computer-to-pool",
    storage: "room",
    coveringAckReceived: false,
    successorSeedContainsEdit: false,
    objectSuccessorRevision: null,
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [8],
    boundary: "computer object before local ack",
    direction: "computer-to-pool",
    storage: "object",
    coveringAckReceived: false,
    successorSeedContainsEdit: false,
    objectSuccessorRevision: "previous",
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [9],
    boundary: "computer room local ack before provider publication",
    direction: "computer-to-pool",
    storage: "room",
    coveringAckReceived: true,
    successorSeedContainsEdit: false,
    objectSuccessorRevision: null,
    convergesWhenSourceReturns: true,
  },
  {
    boundaryRows: [9],
    boundary: "computer object local ack before CAS",
    direction: "computer-to-pool",
    storage: "object",
    coveringAckReceived: true,
    successorSeedContainsEdit: false,
    objectSuccessorRevision: "previous",
    convergesWhenSourceReturns: true,
  },
  {
    boundaryRows: [9],
    boundary: "computer object CAS landed; root publication held",
    direction: "computer-to-pool",
    storage: "object",
    coveringAckReceived: true,
    successorSeedContainsEdit: true,
    objectSuccessorRevision: "edit",
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [10],
    boundary: "computer room provider confirmed; ack missing",
    direction: "computer-to-pool",
    storage: "room",
    coveringAckReceived: false,
    successorSeedContainsEdit: true,
    objectSuccessorRevision: null,
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [10],
    boundary: "computer room covering ack received",
    direction: "computer-to-pool",
    storage: "room",
    coveringAckReceived: true,
    successorSeedContainsEdit: true,
    objectSuccessorRevision: null,
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [10],
    boundary: "computer object root confirmed; ack missing",
    direction: "computer-to-pool",
    storage: "object",
    coveringAckReceived: false,
    successorSeedContainsEdit: true,
    objectSuccessorRevision: "edit",
    convergesWhenSourceReturns: false,
  },
  {
    boundaryRows: [10],
    boundary: "computer object covering ack received",
    direction: "computer-to-pool",
    storage: "object",
    coveringAckReceived: true,
    successorSeedContainsEdit: true,
    objectSuccessorRevision: "edit",
    convergesWhenSourceReturns: false,
  },
] as const satisfies readonly PublicationReplacementWireInput[];

export interface CapturedPoolBodyLane {
  readonly artifactId: string;
  readonly authorityEpoch: string;
  readonly callbacks: ArtifactStreamCallbacks;
  readonly updates: Array<{
    readonly docGuid: string;
    readonly update: Uint8Array;
  }>;
  closed: boolean;
}

export interface CapturedPoolTaskSession {
  status: EpicStatusStreamCallbacks | null;
  state: EpicStateStreamCallbacks | null;
  readonly bodyLanes: CapturedPoolBodyLane[];
  statusClosed: boolean;
  stateClosed: boolean;
}

export interface PoolTaskTransportSpy {
  readonly sessions: CapturedPoolTaskSession[];
  readonly legacyOpenEpicIds: string[];
  readonly workers: InProcessEpicRuntimeWorker[];
}

export function assertPoolTaskLanes(
  session: CapturedPoolTaskSession | undefined,
  message: string,
): asserts session is CapturedPoolTaskSession & {
  status: EpicStatusStreamCallbacks;
  state: EpicStateStreamCallbacks;
} {
  if (
    session === undefined ||
    session.status === null ||
    session.state === null
  ) {
    throw new Error(message);
  }
}

export function assertTestFixture<T>(
  value: T,
  message: string,
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
}

export function installPoolTaskTransportSpy(
  initialManifest: TestLaneManifest,
): PoolTaskTransportSpy {
  const spy: PoolTaskTransportSpy = {
    sessions: [],
    legacyOpenEpicIds: [],
    workers: [],
  };
  const supportByMethod = new Map<string, TestLaneSupport>([
    ["epic.state.subscribe", initialManifest["epic.state.subscribe"]],
    ["artifact.subscribe", initialManifest["artifact.subscribe"]],
    ["epic.status.subscribe", initialManifest["epic.status.subscribe"]],
  ]);
  const streamClientFactory: EpicStreamClientFactory = (epicId) => {
    spy.legacyOpenEpicIds.push(epicId);
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const laneSelection: Pick<
    EpicLaneSelectionSources,
    "support" | "subscribeSupport" | "unaries"
  > = {
    support: (method) => supportByMethod.get(method) ?? "unknown",
    subscribeSupport: () => () => undefined,
    unaries: absentLaneUnaries(),
  };
  __setEpicRuntimeWorkerFactoryForTests(() => {
    const workerSession: { current: CapturedPoolTaskSession | null } = {
      current: null,
    };
    const ensureSession = (): CapturedPoolTaskSession => {
      if (workerSession.current !== null) return workerSession.current;
      const session: CapturedPoolTaskSession = {
        status: null,
        state: null,
        bodyLanes: [],
        statusClosed: false,
        stateClosed: false,
      };
      workerSession.current = session;
      spy.sessions.push(session);
      return session;
    };
    const workerLaneSelection: EpicLaneSelectionSources = {
      ...laneSelection,
      stateStreamClientFactory: (_epicId, callbacks) => {
        const session = ensureSession();
        session.state = callbacks;
        return {
          close: () => {
            session.stateClosed = true;
          },
        };
      },
      statusStreamClientFactory: (_epicId, callbacks) => {
        const session = ensureSession();
        session.status = callbacks;
        return {
          close: () => {
            session.statusClosed = true;
          },
        };
      },
      artifactStreamClientFactory: (request) => {
        const session = ensureSession();
        const lane: CapturedPoolBodyLane = {
          artifactId: request.artifactId,
          authorityEpoch: request.authorityEpoch,
          callbacks: request.callbacks,
          updates: [],
          closed: false,
        };
        session.bodyLanes.push(lane);
        const client: ArtifactLaneStreamClient = {
          applyUpdate: (docGuid, update) =>
            lane.updates.push({ docGuid, update }),
          awareness: () => undefined,
          close: () => {
            lane.closed = true;
          },
        };
        return client;
      },
    };
    const factories: EpicRuntimeStreamFactories = {
      streamClientFactory,
      laneSelection: workerLaneSelection,
    };
    const worker = createInProcessEpicRuntimeWorker(factories);
    spy.workers.push(worker);
    return worker.createWorker();
  });
  return spy;
}

export interface PoolTaskSubscription {
  readonly method: string;
  readonly streamId: number;
}

export function poolStatusLaneSnapshot(authorityEpoch: string) {
  const frame = epicStatusSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    securityEpoch: 1,
    permissionRole: "owner",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (frame.kind !== "snapshot") throw new Error("expected status snapshot");
  return frame;
}

export function poolStateLaneSnapshot(authorityEpoch: string, title: string) {
  const frame = epicStateSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    basis: "cold",
    authorityEpoch,
    position: 0,
    reconciledWithCloud: false,
    epicMeta: { revision: 0, meta: { title, updatedAt: 1000 } },
    artifactRecords: [],
    deletedArtifacts: [],
    roleClaims: { revision: 0, claims: [] },
    commentThreads: [],
  });
  if (frame.kind !== "snapshot") throw new Error("expected state snapshot");
  return frame;
}

export function sendPoolTaskSnapshots(
  socket: PoolEndpointSocket,
  authorityEpoch: string,
  title: string,
): void {
  const status = socket.subscriptions
    .filter(({ method }) => method === "epic.status.subscribe")
    .at(-1);
  const state = socket.subscriptions
    .filter(({ method }) => method === "epic.state.subscribe")
    .at(-1);
  if (status === undefined || state === undefined) {
    throw new Error("expected the pool task status and state subscriptions");
  }
  act(() => {
    socket.sendStreamFrame(
      status.streamId,
      poolStatusLaneSnapshot(authorityEpoch),
      null,
    );
    socket.sendStreamFrame(
      state.streamId,
      poolStateLaneSnapshot(authorityEpoch, title),
      null,
    );
  });
}

export interface PoolOpenObservation {
  readonly bearer: string;
  readonly authzPresent: boolean;
  readonly authz: unknown;
}

export interface PoolEndpointSocket extends StreamWebSocketLike {
  readonly endpoint: FakePoolEndpoint;
  readonly backendId: string;
  readonly clientReassembler: ChunkReassembler;
  readonly subscriptions: PoolTaskSubscription[];
  readonly opens: PoolOpenObservation[];
  readonly openAckStreamMethods: string[][];
  readonly clientClosedStreamIds: number[];
  readonly clientCloseCount: number;
  readonly clientSocketClosed: boolean;
  readonly serverClosed: boolean;
  closeFromServer(): void;
  sendOpenAck(): void;
  sendStreamFrame(
    streamId: number,
    envelope: Record<string, unknown>,
    binary: Uint8Array | null,
  ): void;
  sendFatal(streamId: number, details: Record<string, unknown>): void;
}

export interface PoolTransportForTest {
  readonly durableTransport: AttributableDurableStreamTransport;
  readonly remoteTransport: RemoteHostTransport<
    HostRpcRegistry,
    HostStreamRpcRegistry
  >;
}

export class FakePoolEndpoint {
  readonly sockets: PoolEndpointSocket[] = [];
  readonly sendAttempts: PoolEndpointSocket[] = [];
  private readonly websocketFactory: IStreamWebSocketFactory = {
    create: () => {
      const backendId = this.backendForPhysicalDial(this.sockets.length);
      const socket = new FakePoolEndpointSocket(this, backendId);
      this.sockets.push(socket);
      queueMicrotask(() => socket.openFromServer());
      return socket;
    },
  };
  private readonly rpcManifests = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  private readonly completeStreamManifest: Readonly<
    Record<string, { readonly major: number; readonly minor: number }>
  >;
  private readonly omittedStreamMethods: readonly string[];
  private readonly omittedStreamMethodsByBackend: Readonly<
    Record<string, readonly string[]>
  >;
  private acknowledgeOpen: boolean;
  private readonly backendForPhysicalDial: (dialIndex: number) => string;

  constructor(
    readonly url: string,
    options: {
      readonly omittedStreamMethods: readonly string[];
      readonly omittedStreamMethodsByBackend?: Readonly<
        Record<string, readonly string[]>
      >;
      readonly acknowledgeOpen: boolean;
      readonly backendForPhysicalDial?: (dialIndex: number) => string;
    },
  ) {
    this.backendForPhysicalDial =
      options.backendForPhysicalDial ?? (() => "pool-endpoint");
    const completeManifest = buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    this.completeStreamManifest = completeManifest;
    this.omittedStreamMethods = options.omittedStreamMethods;
    this.omittedStreamMethodsByBackend =
      options.omittedStreamMethodsByBackend ?? {};
    this.acknowledgeOpen = options.acknowledgeOpen;
  }

  setAcknowledgeOpen(acknowledge: boolean): void {
    this.acknowledgeOpen = acknowledge;
  }

  openTransport(
    userId: string,
    bearer: BearerSourceProvider,
  ): PoolTransportForTest {
    const entry = poolHostDirectoryEntry(this.url);
    if (entry === null || entry.hostId !== POOL_HOST_ID) {
      throw new Error("expected a pool directory entry");
    }
    const remoteTransport = createPoolHostTransport({
      entry,
      userId,
      bearer,
      cloudAuthorized: () => true,
      auth: null,
      clock: null,
      rpcRegistry: hostRpcRegistry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: this.websocketFactory,
      requestId: (() => {
        let sequence = 0;
        return () => `pool-test-${(sequence += 1)}`;
      })(),
      clientIdentity: TEST_CLIENT_IDENTITY,
      proactiveWakeEligible: true,
    });
    if (remoteTransport === null) {
      throw new Error("expected the real pool transport to build");
    }
    remoteTransport.session.start();
    const durableTransport: AttributableDurableStreamTransport = {
      wsStreamClient: remoteTransport.streamClient,
      close: () => remoteTransport.streamClient.close("pool-test-close"),
      closeWithReason: (reason) => remoteTransport.streamClient.close(reason),
    };
    return { durableTransport, remoteTransport };
  }

  receiveClientFrame(socket: PoolEndpointSocket, bytes: Uint8Array): void {
    const frame = decodeMuxFrame(bytes);
    const message = socket.clientReassembler.accept(frame);
    if (message === null) return;
    if (
      message.type === MuxFrameType.OPEN &&
      message.streamId === SESSION_CONTROL_STREAM_ID
    ) {
      const open = message.json;
      socket.opens.push({
        bearer: typeof open?.bearer === "string" ? open.bearer : "",
        authzPresent:
          open !== null && Object.prototype.hasOwnProperty.call(open, "authz"),
        authz: open?.authz ?? null,
      });
      if (this.acknowledgeOpen) {
        queueMicrotask(() => socket.sendOpenAck());
      }
      return;
    }
    if (message.type === MuxFrameType.CLOSE) {
      socket.clientClosedStreamIds.push(message.streamId);
      return;
    }
    if (message.type !== MuxFrameType.SUBSCRIBE) return;
    const method = message.json?.method;
    if (typeof method !== "string") return;
    const subscription: PoolTaskSubscription = {
      method,
      streamId: message.streamId,
    };
    socket.subscriptions.push(subscription);
  }

  openAckPayload(backendId: string) {
    const omittedStreamMethods = new Set([
      ...this.omittedStreamMethods,
      ...(this.omittedStreamMethodsByBackend[backendId] ?? []),
    ]);
    return {
      manifest: {
        rpc: this.rpcManifests.manifest,
        optionalRpc: this.rpcManifests.optionalManifest,
        stream: Object.fromEntries(
          Object.entries(this.completeStreamManifest).filter(
            ([method]) => !omittedStreamMethods.has(method),
          ),
        ),
      },
      capabilities: [],
    };
  }
}

class FakePoolEndpointSocket implements PoolEndpointSocket {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly clientReassembler = new ChunkReassembler(undefined);
  readonly subscriptions: PoolTaskSubscription[] = [];
  readonly opens: PoolOpenObservation[] = [];
  readonly openAckStreamMethods: string[][] = [];
  readonly clientClosedStreamIds: number[] = [];
  clientCloseCount = 0;
  private readonly serverSequenceByStream = new Map<number, number>();
  private closedByServer = false;
  private closedByClient = false;

  constructor(
    readonly endpoint: FakePoolEndpoint,
    readonly backendId: string,
  ) {}

  send(data: string | Uint8Array): void {
    this.endpoint.sendAttempts.push(this);
    if (typeof data === "string") {
      throw new Error("the direct pool transport must send mux binary frames");
    }
    if (!this.closedByServer && !this.closedByClient) {
      this.endpoint.receiveClientFrame(this, data);
    }
  }

  get serverClosed(): boolean {
    return this.closedByServer;
  }

  get clientSocketClosed(): boolean {
    return this.closedByClient;
  }

  close(_code: number, _reason: string): void {
    this.clientCloseCount += 1;
    this.closedByClient = true;
  }

  openFromServer(): void {
    if (this.closedByServer || this.closedByClient) return;
    this.onopen?.({ type: "open" });
  }

  closeFromServer(): void {
    if (this.closedByServer || this.closedByClient) return;
    this.closedByServer = true;
    this.onclose?.({ code: 1011, reason: "endpoint-closed", wasClean: false });
  }

  sendOpenAck(): void {
    const payload = this.endpoint.openAckPayload(this.backendId);
    this.openAckStreamMethods.push(Object.keys(payload.manifest.stream));
    this.sendServerFrame(
      MuxFrameType.OPEN_ACK,
      SESSION_CONTROL_STREAM_ID,
      payload,
      null,
    );
  }

  sendStreamFrame(
    streamId: number,
    envelope: Record<string, unknown>,
    binary: Uint8Array | null,
  ): void {
    this.sendServerFrame(MuxFrameType.STREAM_FRAME, streamId, envelope, binary);
  }

  sendFatal(streamId: number, details: Record<string, unknown>): void {
    this.sendServerFrame(MuxFrameType.FATAL, streamId, { details }, null);
  }

  private sendServerFrame(
    type: MuxFrame["type"],
    streamId: number,
    json: Record<string, unknown>,
    binary: Uint8Array | null,
  ): void {
    const message: OutboundMessage = {
      type,
      streamId,
      qos: QosClass.INTERACTIVE,
      json,
      binary,
    };
    const source = new OutboundChunkSource(
      message,
      () => {
        const sequence = this.serverSequenceByStream.get(streamId) ?? 0;
        this.serverSequenceByStream.set(streamId, sequence + 1);
        return sequence;
      },
      false,
    );
    while (!source.done) {
      const bytes = encodeMuxFrame(source.nextFrame());
      this.onmessage?.({ type: "binary", data: bytes });
    }
  }
}
