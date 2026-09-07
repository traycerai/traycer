import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type {
  SchemaVersion,
  VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "../host-stream-client";
import type { IStreamSession } from "../i-stream-session";
import type { ParamsOf, StreamMethodSupport } from "../ws-stream-client";
import {
  PLAN_RESTRICTED_FATAL_CODE,
  planRestrictedClosedReason,
} from "./config";
import type { IRemoteSession } from "./remote-session";

let nextRemoteStreamClientId = 0;

/**
 * `IHostStreamClient` over the persistent remote session - the streaming sibling of `WsStreamClient`.
 * Because the typed wrappers depend only on `IStreamClient` (transport-seam spike extraction), this is a drop-in for the local client: `TerminalStreamClient`, `ChatStreamClient`, … run unchanged over the mux.
 */
export class RemoteStreamClient<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> implements IHostStreamClient<StreamRegistry> {
  private readonly session: IRemoteSession<RpcRegistry, StreamRegistry>;
  private readonly planRestrictedReprobeAt: () => number | null;
  readonly instanceId = `remote-stream-client-${nextRemoteStreamClientId++}`;

  constructor(
    session: IRemoteSession<RpcRegistry, StreamRegistry>,
    planRestrictedReprobeAt: () => number | null,
  ) {
    this.session = session;
    this.planRestrictedReprobeAt = planRestrictedReprobeAt;
  }

  subscribe<Method extends keyof StreamRegistry & string>(
    method: Method,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProvider(method, () => params);
  }

  subscribeAtVersion<Method extends keyof StreamRegistry & string>(
    method: Method,
    schemaVersion: SchemaVersion,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.session.subscribeAtVersion(method, schemaVersion, params);
  }

  subscribeWithParamsProvider<Method extends keyof StreamRegistry & string>(
    method: Method,
    paramsProvider: () => ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.session.subscribeWithParamsProvider(method, paramsProvider);
  }

  /** Pushes a rotated bearer in place (no reconnect) if the host supports it. */
  notifyBearerRotated(): void {
    this.session.notifyBearerRotated();
  }

  isClosed(): boolean {
    return this.session.isClosed();
  }

  getClosedReason(): string | null {
    if (this.session.terminalFatal()?.code !== PLAN_RESTRICTED_FATAL_CODE) {
      return null;
    }
    const reprobeAt = this.planRestrictedReprobeAt();
    return reprobeAt === null ? null : planRestrictedClosedReason(reprobeAt);
  }

  /**
   * This is what lets the owner-side liveness guard rebuild the transport instead of serving a permanently-dead client (`start()` no-ops once the session is closed).
   */
  onClosed(listener: () => void): () => void {
    return this.session.onClosed(listener);
  }

  close(_reason: string): void {
    this.session.close();
  }

  /**
   * Reconnects this client's session and no other (see {@link IRemoteSession.wake} / {@link IRemoteSession.forceReconnect}).
   * There is no endpoint to re-resolve - a remote session's attach address is the relay's fixed WS URL, never a per-host one that moves on respawn - but `probeFirst` still names two genuinely different demands.
   */
  reconnectAll(reason: string, options: ReconnectAllOptions): void {
    if (options.probeFirst) {
      this.session.wake(reason, options.wakeProbe);
    } else {
      this.session.forceReconnect(reason);
    }
  }

  /**
   * Exact by construction: one client, one shared session, no lookup by host.
   * A ready one-shot session or a lingering keep-warm one for the same host cannot answer here, which is the whole reason a surface speaking for one connection must ask its client rather than scan the cache.
   */
  isReady(): boolean {
    return this.session.isReady();
  }

  /**
   * This is what un-strands errored host-scoped queries for a tab bound to a non-active remote host, whose only recovery evidence is its own transport (the registry-liveness + relay-resume path only covers the active host).
   */
  subscribeAvailabilityRecovered(listener: () => void): () => void {
    return this.session.subscribeAvailabilityRecovered(listener);
  }

  getMethodSupport<Method extends keyof StreamRegistry & string>(
    _method: Method,
  ): StreamMethodSupport {
    return "unknown";
  }

  /** No-op: {@link getMethodSupport} never changes, so nothing to notify. */
  subscribeMethodSupport(_listener: () => void): () => void {
    return () => {};
  }

  /**
   * Always `null` (see {@link IHostStreamClient.getMethodSchemaVersion}): the mux session has no learned-schema-version cache to report, mirroring {@link getMethodSupport}'s degrade-quietly treatment for remote hosts.
   */
  getMethodSchemaVersion<Method extends keyof StreamRegistry & string>(
    _method: Method,
  ): SchemaVersion | null {
    return null;
  }
}
