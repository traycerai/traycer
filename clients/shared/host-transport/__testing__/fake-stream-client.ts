import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "../host-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamFrameEnvelope,
} from "../i-stream-session";

type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * One subscription on a drivable stand-in for a host stream, shared by every
 * suite that needs to put frames in front of a REAL stream client.
 *
 * It sits under the production client rather than beside it, so a frame a test
 * emits is parsed against the protocol schema before the code under test sees
 * it, and a frame that code sends is the envelope that would have gone on the
 * wire. Implemented in full against the transport interfaces rather than cast
 * into place: a fake that has to lie about its shape is a fake that can drift
 * from it.
 */
export class FakeStreamSession implements IStreamSession {
  readonly sentFrames: StreamFrameEnvelope[] = [];
  closed = false;
  private serverHandler: ServerFrameHandler | null = null;
  private statusHandler: StatusChangeHandler | null = null;
  private status: StreamStatus = "connecting";

  sendClientFrame(
    frame: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    if (this.closed || this.status !== "open") return;
    this.sentFrames.push(frame);
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverHandler = handler;
  }

  /**
   * Replays the CURRENT status to a late subscriber, which the real session
   * effectively does by having transitioned before the consumer mounted. A
   * fixture that only pushed transitions left a consumer that subscribes after
   * `open` waiting forever for a status the socket had already reached.
   */
  onStatusChange(handler: StatusChangeHandler): void {
    this.statusHandler = handler;
    if (this.status === "open") handler("open", null);
  }

  requestReconnect(): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {
    this.closed = true;
  }

  emitStatus(status: StreamStatus): void {
    this.status = status;
    this.statusHandler?.(status, null);
  }

  /** The terminal close a host's bearer-expiry disconnect produces. */
  emitFatal(reason: string): void {
    this.status = "closed";
    this.statusHandler?.("closed", {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason,
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
  }

  /**
   * One server frame. The binary payload is explicit and required: a text
   * frame passes `null`, and the screencast planes carry their JPEG in the
   * second argument exactly as the socket does.
   */
  emit(frame: StreamFrameEnvelope, binaryPayload: Uint8Array | null): void {
    this.serverHandler?.({ ...frame }, binaryPayload);
  }

  framesOfKind(kind: string): readonly StreamFrameEnvelope[] {
    return this.sentFrames.filter((frame) => frame.kind === kind);
  }
}

/**
 * A client that answers `subscribe` with a drivable session and declines every
 * other capability.
 */
export class FakeStreamClient implements IHostStreamClient<HostStreamRpcRegistry> {
  readonly instanceId = "fake-stream-client";
  readonly sessions: FakeStreamSession[] = [];
  readonly subscribes: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];
  private readonly autoOpen: boolean;
  private closed = false;

  /**
   * `autoOpen` decides whether a subscription is born connected. A suite that
   * drives the CONNECTION (an attach burst, a rotation, a terminal close)
   * passes `false` and opens it itself; a suite that only cares what travels
   * once the socket is up passes `true` and skips the ceremony. Explicit
   * because "already open" is a real difference in what `sendClientFrame`
   * does - it drops silently while the session is not open.
   */
  constructor(autoOpen: boolean) {
    this.autoOpen = autoOpen;
  }

  subscribe(method: string, params: unknown): FakeStreamSession {
    const session = new FakeStreamSession();
    this.sessions.push(session);
    this.subscribes.push({ method, params });
    if (this.autoOpen) session.emitStatus("open");
    return session;
  }

  subscribeWithParamsProvider(
    method: string,
    paramsProvider: () => unknown,
  ): FakeStreamSession {
    return this.subscribe(method, paramsProvider());
  }

  getMethodSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  getClosedReason(): string | null {
    return null;
  }

  onClosed(): () => void {
    return () => undefined;
  }

  /**
   * Models what `WsStreamClient` does with a rotated bearer: push a
   * `credentialUpdate` onto every open session, so an already-connected host
   * stops holding a stale request context.
   */
  notifyBearerRotated(): void {
    for (const session of this.sessions) {
      session.sendClientFrame(
        { kind: "credentialUpdate", hasBinaryPayload: false },
        null,
      );
    }
  }

  reconnectAll(): void {}

  isReady(): boolean {
    return true;
  }

  getMethodSupport(): "unknown" {
    return "unknown";
  }

  subscribeMethodSupport(): () => void {
    return () => undefined;
  }

  subscribeAvailabilityRecovered(): () => void {
    return () => undefined;
  }
}
