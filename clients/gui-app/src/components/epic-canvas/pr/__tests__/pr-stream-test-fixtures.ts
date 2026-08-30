import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
/**
 * The one mock stream session + client the `pr.*` suites drive.
 *
 * The three PR suites (`pr-detail-body`, `pr-panel-actions`, `pr-panel-body`)
 * all fake the same single boundary - the host stream transport - and had one
 * verbatim copy of these classes each. The only real difference was the frame
 * type `emitFrame` accepts, which is a type parameter here, so a change to
 * `IStreamSession` or to the `WsStreamClient` constructor options is now one
 * edit rather than three.
 */
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

export class MockStreamSession<
  TFrame extends StreamFrameEnvelope,
> implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  closed: boolean = false;
  /** Every client frame the hook under test sent, in order. */
  sentClientFrames: StreamFrameEnvelope[] = [];

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    this.sentClientFrames.push(envelope);
  }

  /** Never negotiates: this fake exercises no version-dependent path. */
  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {
    // No-op for these tests; reconnect is owned by the real StreamSession.
  }

  close(): void {
    // Idempotent, because `IStreamSession.close()` is. Emitting a second
    // "closed" on a repeat call would let this fixture drive a lifecycle the
    // real transport cannot produce - and a hook that mishandled it would
    // fail here while working in the app, or pass here while broken in it.
    if (this.closed) return;
    this.closed = true;
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  emitFrame(frame: TFrame): void {
    if (this.serverFrameHandler !== null) {
      const handler = this.serverFrameHandler;
      const envelope = { ...frame } satisfies StreamFrameEnvelope;
      handler(envelope, null);
    }
  }

  emitStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler?.(status, reason);
  }
}

export class MockWsStreamClient<
  TFrame extends StreamFrameEnvelope,
> extends WsStreamClient<HostStreamRpcRegistry> {
  sessions: Map<string, MockStreamSession<TFrame>> = new Map();
  subscribeCallCount: number = 0;

  constructor() {
    super({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: {
        create: () => {
          throw new Error("MockWsStreamClient should not open a websocket");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribeCallCount += 1;
    const key = JSON.stringify({ method, params });

    if (!this.sessions.has(key)) {
      this.sessions.set(key, new MockStreamSession<TFrame>());
    }

    const session = this.sessions.get(key);
    if (session === undefined) {
      throw new Error("Session not found");
    }
    return session;
  }

  getSession(
    method: string,
    params: unknown,
  ): MockStreamSession<TFrame> | undefined {
    const key = JSON.stringify({ method, params });
    return this.sessions.get(key);
  }
}
