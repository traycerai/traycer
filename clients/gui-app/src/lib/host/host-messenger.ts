import { v4 as uuidv4 } from "uuid";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  HostRpcError,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  createRemoteHostTransport,
  type RemoteHostTransport,
} from "@traycer-clients/shared/host-transport/remote/index";
import { DEFAULT_DIAL_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgStreamWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import {
  WsRpcClient,
  type RequestIdProvider,
} from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";

const DEFAULT_HOST_RPC_FRAME_TIMEOUT_MS = 30_000;
const TRANSPORT_KEY_SEPARATOR = "\u0000";

const browserWebSocketFactory = createWhatwgWebSocketFactory();
const browserStreamWebSocketFactory = createWhatwgStreamWebSocketFactory();

export interface BuiltHostMessenger<Registry extends VersionedRpcRegistry> {
  readonly messenger: IHostMessenger<Registry>;
  readonly remoteTransport: RemoteHostTransport<
    Registry,
    HostStreamRpcRegistry
  > | null;
}

export interface BuildRawHostMessengerForTargetParams<
  Registry extends VersionedRpcRegistry,
> {
  readonly target: HostDirectoryEntry;
  readonly endpoint: () => HostDirectoryEntry | null;
  readonly registry: Registry;
  readonly bearer: BearerSourceProvider;
  readonly authnBaseUrl: string;
  readonly requestId: RequestIdProvider;
}

export function buildRawHostMessengerForTarget<
  Registry extends VersionedRpcRegistry,
>(
  params: BuildRawHostMessengerForTargetParams<Registry>,
): BuiltHostMessenger<Registry> | null {
  if (
    params.target.kind === "remote" &&
    isRemoteHostDirectoryEntry(params.target) &&
    params.target.websocketUrl !== null
  ) {
    const remoteTransport = createRemoteHostTransport<
      Registry,
      HostStreamRpcRegistry
    >({
      hostId: params.target.hostId,
      relayAttachUrl: params.target.websocketUrl,
      authnBaseUrl: params.authnBaseUrl,
      hostPublicKey: params.target.publicKey,
      bearer: params.bearer,
      rpcRegistry: params.registry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: browserStreamWebSocketFactory,
      requestId: params.requestId,
    });
    if (remoteTransport === null) return null;
    return {
      messenger: remoteTransport.messenger,
      remoteTransport,
    };
  }

  return {
    messenger: new WsRpcClient<Registry>({
      registry: params.registry,
      endpoint: params.endpoint,
      bearer: params.bearer,
      requestId: params.requestId,
      webSocketFactory: browserWebSocketFactory,
      dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
      frameTimeoutMs: DEFAULT_HOST_RPC_FRAME_TIMEOUT_MS,
    }),
    remoteTransport: null,
  };
}

export interface RuntimeHostMessengerBinding<
  Registry extends VersionedRpcRegistry,
> {
  readonly messenger: IHostMessenger<Registry>;
  readonly reset: () => void;
  readonly dispose: () => void;
}

export interface BuildRuntimeHostMessengerParams<
  Registry extends VersionedRpcRegistry,
> {
  readonly registry: Registry;
  readonly endpoint: () => HostDirectoryEntry | null;
  readonly bearer: BearerSourceProvider;
  readonly authnBaseUrl: string;
  readonly requestId: RequestIdProvider;
}

export function buildRuntimeHostMessenger<
  Registry extends VersionedRpcRegistry,
>(
  params: BuildRuntimeHostMessengerParams<Registry>,
): RuntimeHostMessengerBinding<Registry> {
  const messenger = new RuntimeHostMessenger(params);
  return {
    messenger,
    reset: () => messenger.reset(),
    dispose: () => messenger.dispose(),
  };
}

class RuntimeHostMessenger<
  Registry extends VersionedRpcRegistry,
> implements IHostMessenger<Registry> {
  private readonly registry: Registry;
  private readonly endpoint: () => HostDirectoryEntry | null;
  private readonly bearer: BearerSourceProvider;
  private readonly authnBaseUrl: string;
  private readonly requestId: RequestIdProvider;
  private readonly localMessenger: IHostMessenger<Registry>;
  private remoteBinding: RemoteBinding<Registry> | null = null;

  constructor(params: BuildRuntimeHostMessengerParams<Registry>) {
    this.registry = params.registry;
    this.endpoint = params.endpoint;
    this.bearer = params.bearer;
    this.authnBaseUrl = params.authnBaseUrl;
    this.requestId = params.requestId;
    this.localMessenger = new WsRpcClient<Registry>({
      registry: params.registry,
      endpoint: params.endpoint,
      bearer: params.bearer,
      requestId: params.requestId,
      webSocketFactory: browserWebSocketFactory,
      dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
      frameTimeoutMs: DEFAULT_HOST_RPC_FRAME_TIMEOUT_MS,
    });
  }

  request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const target = this.endpoint();
    if (target === null || target.kind !== "remote") {
      this.closeRemoteTransport();
      return this.localMessenger.request(method, params);
    }

    const remoteMessenger = this.remoteMessengerFor(target);
    if (remoteMessenger === null) {
      return Promise.reject(
        new HostRpcError({
          code: "RPC_ERROR",
          message: `Remote host '${target.hostId}' does not expose a valid remote transport`,
          requestId: this.requestId(),
          method,
          fatalDetails: null,
        }),
      );
    }
    return remoteMessenger.request(method, params);
  }

  dispose(): void {
    this.closeRemoteTransport();
  }

  reset(): void {
    this.closeRemoteTransport();
  }

  private remoteMessengerFor(
    target: HostDirectoryEntry,
  ): IHostMessenger<Registry> | null {
    const nextKey = remoteTransportKey(target);
    if (nextKey === null) {
      return null;
    }
    if (this.remoteBinding !== null && this.remoteBinding.key === nextKey) {
      return this.remoteBinding.transport.messenger;
    }

    this.closeRemoteTransport();
    const built = buildRawHostMessengerForTarget({
      target,
      endpoint: this.endpoint,
      registry: this.registry,
      bearer: this.bearer,
      authnBaseUrl: this.authnBaseUrl,
      requestId: this.requestId,
    });
    if (built === null || built.remoteTransport === null) {
      return null;
    }
    built.remoteTransport.session.start();
    this.remoteBinding = {
      key: nextKey,
      transport: built.remoteTransport,
    };
    return built.messenger;
  }

  private closeRemoteTransport(): void {
    if (this.remoteBinding === null) {
      return;
    }
    this.remoteBinding.transport.session.close();
    this.remoteBinding = null;
  }
}

interface RemoteBinding<Registry extends VersionedRpcRegistry> {
  readonly key: string;
  readonly transport: RemoteHostTransport<Registry, HostStreamRpcRegistry>;
}

function remoteTransportKey(entry: HostDirectoryEntry): string | null {
  if (
    entry.kind !== "remote" ||
    !isRemoteHostDirectoryEntry(entry) ||
    entry.websocketUrl === null
  ) {
    return null;
  }
  return [
    entry.hostId,
    entry.websocketUrl,
    entry.version ?? "",
    entry.status,
    entry.publicKey,
  ].join(TRANSPORT_KEY_SEPARATOR);
}

export const defaultHostRpcRequestId: RequestIdProvider = () => uuidv4();
