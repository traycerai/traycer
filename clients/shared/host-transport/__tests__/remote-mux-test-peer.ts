import { Buffer } from "node:buffer";
import {
  createResponderHandshake,
  DEFAULT_REPLAY_WINDOW_SIZE,
  generateStaticKeyPair,
  NoiseSession,
  type NoiseKeyPair,
} from "@traycer/protocol/crypto/noise";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/capability-manifest";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  ChunkReassembler,
  OutboundChunkSource,
  type OutboundMessage,
} from "@traycer/protocol/host-transport/chunking";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  MuxFrameType,
  NOISE_PROLOGUE,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
} from "@traycer/protocol/host-transport/mux";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../ws-factory";

const EMPTY_AD = new Uint8Array(0);
const FLOOR_RPC_MANIFEST = splitConnectionManifest(
  hostRpcRegistry,
  RELEASED_FLOOR_METHOD_NAMES,
  SERVES_EVERY_INSTALLED_MAJOR,
).manifest;

interface RelayConnection {
  readonly socket: RelaySocket;
  readonly reassembler: ChunkReassembler;
  readonly outboundSeqByStream: Map<number, number>;
  noise: NoiseSession | null;
  closed: boolean;
  queue: Promise<void>;
}

class RelaySocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  constructor(
    private readonly onSend: (data: string | Uint8Array) => void,
    private readonly onClose: (code: number, reason: string) => void,
  ) {}

  send(data: string | Uint8Array): void {
    this.onSend(data);
  }

  close(code: number, reason: string): void {
    this.onClose(code, reason);
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireMessage(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.onmessage?.({ type: "text", data });
    } else {
      this.onmessage?.({ type: "binary", data });
    }
  }
}

/** A minimal encrypted relay host for tests of the real RemoteSession path. */
export class RemoteMuxTestPeer {
  readonly opens: Record<string, unknown>[] = [];
  readonly credentialUpdates: Record<string, unknown>[] = [];
  readonly errors: unknown[] = [];
  readonly closeReasons: Array<{
    readonly code: number;
    readonly reason: string;
  }> = [];
  openAckCapabilities: readonly string[] = [];
  private readonly hostKeys: NoiseKeyPair = generateStaticKeyPair();
  private readonly connections: RelayConnection[] = [];
  private firstOpenRefusal: FatalErrorDetails | null = null;

  get hostPublicKey(): string {
    return Buffer.from(this.hostKeys.publicKey).toString("hex");
  }

  get openCount(): number {
    return this.opens.length;
  }

  refuseFirstOpen(details: FatalErrorDetails): void {
    this.firstOpenRefusal = details;
  }

  readonly factory: IStreamWebSocketFactory = {
    create: (): StreamWebSocketLike => {
      let connection: RelayConnection;
      const socket = new RelaySocket(
        (data) => this.enqueue(connection, data),
        (code, reason) => {
          connection.closed = true;
          this.closeReasons.push({ code, reason });
        },
      );
      connection = {
        socket,
        reassembler: new ChunkReassembler(undefined),
        outboundSeqByStream: new Map(),
        noise: null,
        closed: false,
        queue: Promise.resolve(),
      };
      this.connections.push(connection);
      queueMicrotask(() => {
        if (connection.closed) return;
        socket.fireOpen();
        socket.fireMessage(
          JSON.stringify({ type: "attach_ack", role: "client", sid: 1 }),
        );
      });
      return socket;
    },
  };

  private enqueue(
    connection: RelayConnection,
    data: string | Uint8Array,
  ): void {
    if (typeof data === "string") return;
    connection.queue = connection.queue
      .then(() => this.handleBinary(connection, data))
      .catch((error: unknown) => {
        this.errors.push(error);
      });
  }

  private async handleBinary(
    connection: RelayConnection,
    data: Uint8Array,
  ): Promise<void> {
    if (connection.closed) return;
    if (connection.noise === null) {
      const handshake = await createResponderHandshake(
        this.hostKeys,
        NOISE_PROLOGUE,
      );
      await handshake.readMessage(data);
      const response = await handshake.writeMessage(new Uint8Array(0));
      connection.noise = NoiseSession.fromHandshake(
        handshake,
        DEFAULT_REPLAY_WINDOW_SIZE,
      );
      connection.socket.fireMessage(response);
      return;
    }
    const plain = await connection.noise.decrypt(data, EMPTY_AD);
    const frame = decodeMuxFrame(plain);
    const message = connection.reassembler.accept(frame);
    if (message === null || message.streamId !== SESSION_CONTROL_STREAM_ID) {
      return;
    }
    if (message.type === MuxFrameType.CREDENTIAL_UPDATE) {
      this.credentialUpdates.push(message.json ?? {});
      return;
    }
    if (message.type !== MuxFrameType.OPEN) return;
    const open = message.json ?? {};
    this.opens.push(open);
    if (this.opens.length === 1 && this.firstOpenRefusal !== null) {
      const refusal = this.firstOpenRefusal;
      this.firstOpenRefusal = null;
      await this.sendMessage(connection, {
        type: MuxFrameType.FATAL,
        streamId: SESSION_CONTROL_STREAM_ID,
        qos: QosClass.INTERACTIVE,
        json: { details: refusal },
        binary: null,
      });
      return;
    }
    await this.sendMessage(connection, {
      type: MuxFrameType.OPEN_ACK,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: {
        manifest: {
          rpc: FLOOR_RPC_MANIFEST,
          optionalRpc: {},
          stream: buildStreamManifest(
            hostStreamRpcRegistry,
            SERVES_EVERY_INSTALLED_MAJOR,
          ),
        },
        capabilities: [...this.openAckCapabilities],
      },
      binary: null,
    });
  }

  private async sendMessage(
    connection: RelayConnection,
    message: OutboundMessage,
  ): Promise<void> {
    const source = new OutboundChunkSource(
      message,
      () => {
        const seq = connection.outboundSeqByStream.get(message.streamId) ?? 0;
        connection.outboundSeqByStream.set(message.streamId, seq + 1);
        return seq;
      },
      false,
    );
    while (!source.done) {
      const muxBytes = encodeMuxFrame(source.nextFrame());
      const noise = connection.noise;
      if (noise === null) throw new Error("relay Noise session is not ready");
      connection.socket.fireMessage(await noise.encrypt(muxBytes, EMPTY_AD));
    }
  }
}
