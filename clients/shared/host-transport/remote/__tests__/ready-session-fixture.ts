import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { PoolHostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/capability-manifest";
import type {
  ConnectionManifest,
  FatalErrorDetails,
} from "@traycer/protocol/framework/ws-protocol";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  MuxFrameType,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
  decodeMuxFrame,
  encodeMuxFrame,
} from "@traycer/protocol/host-transport/mux";
import {
  ChunkReassembler,
  OutboundChunkSource,
  type OutboundMessage,
} from "@traycer/protocol/host-transport/chunking";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { expect, vi } from "vitest";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../../ws-stream-factory";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../../ws-factory";
import {
  createPoolHostTransport,
  type RemoteHostTransport,
} from "../create-remote-transport";

const FLOOR_RPC_MANIFEST = splitConnectionManifest(
  hostRpcRegistry,
  RELEASED_FLOOR_METHOD_NAMES,
  SERVES_EVERY_INSTALLED_MAJOR,
).manifest;

type PoolTransport = RemoteHostTransport<
  typeof hostRpcRegistry,
  typeof hostStreamRpcRegistry
>;

interface RecordedSubscribe {
  readonly streamId: number;
  readonly json: Record<string, unknown>;
}

class ReadyPoolSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly reassembler = new ChunkReassembler(undefined);
  closed = false;
  private readonly nextServerSeq = new Map<number, number>();
  private readonly receive: (
    socket: ReadyPoolSocket,
    data: string | Uint8Array,
  ) => void;

  constructor(
    receive: (socket: ReadyPoolSocket, data: string | Uint8Array) => void,
  ) {
    this.receive = receive;
  }

  send(data: string | Uint8Array): void {
    this.receive(this, data);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }

  open(): void {
    if (this.closed) return;
    this.onopen?.({ type: "open" });
  }

  drop(): void {
    this.close(1006, "fixture-drop");
  }

  receiveBinary(data: Uint8Array): void {
    if (this.closed) return;
    this.onmessage?.({ type: "binary", data });
  }

  sendMessage(message: OutboundMessage): void {
    const sequence = this.nextServerSeq.get(message.streamId) ?? 0;
    const source = new OutboundChunkSource(
      message,
      () => {
        const current = this.nextServerSeq.get(message.streamId) ?? sequence;
        this.nextServerSeq.set(message.streamId, current + 1);
        return current;
      },
      false,
    );
    while (!source.done) {
      this.receiveBinary(encodeMuxFrame(source.nextFrame()));
    }
  }
}

export class ReadyPoolPeer {
  private manifest: ConnectionManifest;
  private readonly autoAcknowledge: boolean;
  private readonly sockets: ReadyPoolSocket[] = [];
  readonly opens: number[] = [];
  readonly subscribeFrames: RecordedSubscribe[] = [];

  constructor(
    chatSubscribeVersion: SchemaVersion | null,
    autoAcknowledge: boolean,
  ) {
    this.manifest = streamManifest(chatSubscribeVersion);
    this.autoAcknowledge = autoAcknowledge;
  }

  readonly factory: IStreamWebSocketFactory = {
    create: () => {
      const socket = new ReadyPoolSocket((connection, data) => {
        this.receive(connection, data);
      });
      this.sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
  };

  setChatSubscribeVersion(version: SchemaVersion | null): void {
    this.manifest = streamManifest(version);
  }

  acknowledgeOpen(): void {
    const socket = this.liveSocket();
    if (!this.opens.includes(this.sockets.indexOf(socket))) {
      throw new Error("the pool client has not sent OPEN on this socket");
    }
    this.sendOpenAck(socket);
  }

  dropLive(): void {
    this.liveSocket().drop();
  }

  sendStreamFrame(streamId: number, json: Record<string, unknown>): void {
    this.liveSocket().sendMessage({
      type: MuxFrameType.STREAM_FRAME,
      streamId,
      qos: QosClass.INTERACTIVE,
      json,
      binary: null,
    });
  }

  sendStreamFatal(streamId: number, details: FatalErrorDetails): void {
    this.liveSocket().sendMessage({
      type: MuxFrameType.FATAL,
      streamId,
      qos: QosClass.INTERACTIVE,
      json: { details: { ...details } },
      binary: null,
    });
  }

  private receive(socket: ReadyPoolSocket, data: string | Uint8Array): void {
    if (typeof data === "string" || socket.closed) return;
    const message = socket.reassembler.accept(decodeMuxFrame(data));
    if (message === null) return;
    if (message.type === MuxFrameType.OPEN) {
      this.opens.push(this.sockets.indexOf(socket));
      if (this.autoAcknowledge) this.sendOpenAck(socket);
      return;
    }
    if (message.type === MuxFrameType.SUBSCRIBE) {
      this.subscribeFrames.push({
        streamId: message.streamId,
        json: message.json ?? {},
      });
    }
  }

  private sendOpenAck(socket: ReadyPoolSocket): void {
    socket.sendMessage({
      type: MuxFrameType.OPEN_ACK,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: {
        manifest: {
          rpc: FLOOR_RPC_MANIFEST,
          optionalRpc: {},
          stream: this.manifest,
        },
        capabilities: [],
      },
      binary: null,
    });
  }

  private liveSocket(): ReadyPoolSocket {
    const socket = [...this.sockets]
      .reverse()
      .find((candidate) => !candidate.closed);
    if (socket === undefined)
      throw new Error("pool session has no live socket");
    return socket;
  }
}

export interface PoolSessionFixtureOptions {
  readonly entry: PoolHostDirectoryEntry;
  readonly userId: string;
  readonly bearer: OpenFrameBearerSource;
  readonly chatSubscribeVersion: SchemaVersion | null;
  readonly authPolicy: "durable" | "one-shot";
  readonly autoAcknowledge: boolean;
}

export interface ReadyPoolSessionFixture {
  readonly entry: PoolHostDirectoryEntry;
  readonly authPolicy: "durable" | "one-shot";
  readonly transport: PoolTransport;
  readonly peer: ReadyPoolPeer;
  readonly acquire: () => PoolTransport;
  readonly currentHandshake: () => ReadonlyMap<string, SchemaVersion> | null;
  readonly start: () => void;
  readonly acknowledgeOpen: () => void;
  readonly setChatSubscribeVersion: (version: SchemaVersion | null) => void;
  readonly dropLive: () => void;
  readonly sendStreamFrame: (
    streamId: number,
    json: Record<string, unknown>,
  ) => void;
  readonly sendStreamFatal: (
    streamId: number,
    details: FatalErrorDetails,
  ) => void;
  readonly close: () => void;
}

/** Creates a real cached pool transport but leaves its first OPEN_ACK controlled. */
export function mountPoolSessionFixture(
  options: PoolSessionFixtureOptions,
): ReadyPoolSessionFixture {
  const peer = new ReadyPoolPeer(
    options.chatSubscribeVersion,
    options.autoAcknowledge,
  );
  const auth: StreamAuthRevalidator | null =
    options.authPolicy === "durable"
      ? { revalidateForReconnect: async () => "network-error" }
      : null;
  let nextRequestId = 0;
  const acquiredTransports: PoolTransport[] = [];
  const acquire = (): PoolTransport => {
    const transport = createPoolHostTransport({
      entry: options.entry,
      userId: options.userId,
      bearer: () => options.bearer,
      cloudAuthorized: () => true,
      auth,
      clock: null,
      rpcRegistry: hostRpcRegistry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: peer.factory,
      requestId: () => `ready-pool-fixture-${(nextRequestId += 1)}`,
      clientIdentity: TEST_CLIENT_IDENTITY,
      proactiveWakeEligible: true,
    });
    if (transport === null) throw new Error("pool transport must build");
    acquiredTransports.push(transport);
    return transport;
  };
  const transport = acquire();

  return {
    entry: options.entry,
    authPolicy: options.authPolicy,
    transport,
    peer,
    acquire,
    currentHandshake: () =>
      transport.streamClient.getReadyPoolStreamHandshake(),
    start: () => transport.session.start(),
    acknowledgeOpen: () => peer.acknowledgeOpen(),
    setChatSubscribeVersion: (version) => peer.setChatSubscribeVersion(version),
    dropLive: () => peer.dropLive(),
    sendStreamFrame: (streamId, json) => peer.sendStreamFrame(streamId, json),
    sendStreamFatal: (streamId, details) =>
      peer.sendStreamFatal(streamId, details),
    close: () => {
      for (const acquired of acquiredTransports) acquired.session.close();
    },
  };
}

/** Creates and waits for a durable pool session with a real negotiated ack. */
export async function mountReadyRemoteSession(
  options: Omit<PoolSessionFixtureOptions, "autoAcknowledge" | "authPolicy">,
): Promise<ReadyPoolSessionFixture> {
  const fixture = mountPoolSessionFixture({
    ...options,
    autoAcknowledge: true,
    authPolicy: "durable",
  });
  fixture.start();
  try {
    await vi.waitFor(() => {
      expect(fixture.transport.session.isReady()).toBe(true);
    });
  } catch (cause) {
    fixture.close();
    throw cause;
  }
  return fixture;
}

function streamManifest(
  chatSubscribeVersion: SchemaVersion | null,
): ConnectionManifest {
  const manifest = buildStreamManifest(
    hostStreamRpcRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  if (chatSubscribeVersion === null) {
    const { "chat.subscribe": _removed, ...withoutChatSubscribe } = manifest;
    return withoutChatSubscribe;
  }
  return { ...manifest, "chat.subscribe": chatSubscribeVersion };
}
