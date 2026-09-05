/**
 * A real `IStreamClient` that records instead of dialling.
 *
 * Not a mock of the proxy - a stand-in for the SOCKET, which is the only thing
 * a suite cannot have. Every session it hands back is a genuine `IStreamSession`
 * with working handler registration, so the proxy host under test wires and
 * drives production objects; what is faked is the wire beneath them.
 *
 * The recorded lists are what the leak pin reads: `openCount` alone cannot tell
 * "three sessions, three closes" from "three sessions, one closed three times",
 * and those are different bugs.
 */
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ParamsOf } from "@traycer-clients/shared/host-transport/ws-stream-client";

export interface RecordedSession {
  readonly method: string;
  /** `null` for the plain `subscribe` form, which freezes its params. */
  readonly paramsProvider: (() => unknown) | null;
  readonly initialParams: unknown;
  /** Frames the proxy host sent on this session. */
  readonly sent: Array<{
    readonly envelope: StreamFrameEnvelope;
    readonly binaryPayload: Uint8Array | null;
  }>;
  reconnectCount(): number;
  closeCount(): number;
  /** Drives a server frame into whatever handler the host installed. */
  emitFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void;
  /** Drives a status transition, reading the version the test set. */
  emitStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void;
  setNegotiatedVersion(version: SchemaVersion | null): void;
  /** Re-reads the provider, as a wire re-subscribe would. */
  readParams(): unknown;
}

export interface RecordingStreamClient {
  readonly client: IStreamClient<HostStreamRpcRegistry>;
  opened(): readonly RecordedSession[];
  /** Total `close()` calls across every session it handed out. */
  closedCount(): number;
  methodVersion(method: string): SchemaVersion | null;
  setMethodVersion(method: string, version: SchemaVersion | null): void;
}

export function createRecordingStreamClient(): RecordingStreamClient {
  const sessions: RecordedSession[] = [];
  const methodVersions = new Map<string, SchemaVersion | null>();

  function build(
    method: string,
    paramsProvider: (() => unknown) | null,
    initialParams: unknown,
  ): { readonly session: IStreamSession; readonly recorded: RecordedSession } {
    let frameHandler: ServerFrameHandler | null = null;
    let statusHandler: StatusChangeHandler | null = null;
    let negotiated: SchemaVersion | null = null;
    let reconnects = 0;
    let closes = 0;
    const sent: RecordedSession["sent"] = [];

    const session: IStreamSession = {
      sendClientFrame(envelope, binaryPayload): void {
        sent.push({ envelope, binaryPayload });
      },
      onServerFrame(handler): void {
        frameHandler = handler;
      },
      onStatusChange(handler): void {
        statusHandler = handler;
      },
      requestReconnect(): void {
        reconnects += 1;
      },
      getNegotiatedSchemaVersion: () => negotiated,
      close(): void {
        closes += 1;
      },
    };

    const recorded: RecordedSession = {
      method,
      paramsProvider,
      initialParams,
      sent,
      reconnectCount: () => reconnects,
      closeCount: () => closes,
      emitFrame: (envelope, binaryPayload) => {
        frameHandler?.(envelope, binaryPayload);
      },
      emitStatus: (status, reason) => {
        statusHandler?.(status, reason);
      },
      setNegotiatedVersion: (version) => {
        negotiated = version;
      },
      readParams: () =>
        paramsProvider === null ? initialParams : paramsProvider(),
    };
    return { session, recorded };
  }

  const client: IStreamClient<HostStreamRpcRegistry> = {
    subscribe<Method extends keyof HostStreamRpcRegistry & string>(
      method: Method,
      params: ParamsOf<HostStreamRpcRegistry, Method>,
    ): IStreamSession {
      const built = build(method, null, params);
      sessions.push(built.recorded);
      return built.session;
    },
    subscribeWithParamsProvider<
      Method extends keyof HostStreamRpcRegistry & string,
    >(
      method: Method,
      paramsProvider: () => ParamsOf<HostStreamRpcRegistry, Method>,
    ): IStreamSession {
      const built = build(method, paramsProvider, paramsProvider());
      sessions.push(built.recorded);
      return built.session;
    },
    getMethodSchemaVersion<Method extends keyof HostStreamRpcRegistry & string>(
      method: Method,
    ): SchemaVersion | null {
      return methodVersions.get(method) ?? null;
    },
  };

  return {
    client,
    opened: () => sessions,
    closedCount: () =>
      sessions.reduce((total, session) => total + session.closeCount(), 0),
    methodVersion: (method) => methodVersions.get(method) ?? null,
    setMethodVersion: (method, version) => {
      methodVersions.set(method, version);
    },
  };
}
