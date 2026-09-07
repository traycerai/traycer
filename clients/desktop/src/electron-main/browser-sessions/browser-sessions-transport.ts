import { randomUUID } from "node:crypto";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  fetchRegisteredHostsViaHttp,
  hostListItemToDirectoryEntry,
  isRemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import { createRemoteHostTransport } from "@traycer-clients/shared/host-transport/remote/index";
import {
  DEFAULT_DIAL_TIMEOUT_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_OPEN_ACK_TIMEOUT_MS,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
} from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgStreamWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { describeLogError, log } from "../app/logger";

const streamWebSocketFactory = createWhatwgStreamWebSocketFactory();

export interface BrowserSessionsHostTransport {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly close: () => void;
}

export interface BrowserSessionsHostDirectory {
  resolve(hostId: string): Promise<HostDirectoryEntry | null>;
  endpoint(hostId: string): HostTransportEndpoint | null;
  invalidate(hostId: string): void;
  reset(): void;
}

export interface BrowserSessionsHostDirectoryDeps {
  /** Read at call time, not at registration: the IPC layer is wired before the bridge's options are anything a directory read could use, and a value captured then would pin the process. */
  readonly authnBaseUrl: () => string;
  readonly relayBaseUrl: string;
  /** This machine's own host, or null while none is published. */
  readonly localHost: () => {
    readonly hostId: string;
    readonly websocketUrl: string;
    readonly version: string | null;
  } | null;
  readonly bearerToken: () => string | null;
  /** `fetchRegisteredHostsViaHttp` in production; a double in tests. */
  readonly listRegisteredHosts: typeof fetchRegisteredHostsViaHttp;
  readonly now: () => number;
}

/** An explicit `invalidate` is not a miss and is never throttled. */
const MISS_REFRESH_COOLDOWN_MS = 30_000;

export function createBrowserSessionsHostDirectory(
  deps: BrowserSessionsHostDirectoryDeps,
): BrowserSessionsHostDirectory {
  let cachedRemote = new Map<string, HostDirectoryEntry>();
  let inFlight: Promise<void> | null = null;
  let lastRefreshAt: number | null = null;
  let forced = false;

  const refresh = async (): Promise<void> => {
    const bearerToken = deps.bearerToken();
    if (bearerToken === null) return;
    const result = await deps.listRegisteredHosts(
      deps.authnBaseUrl(),
      bearerToken,
    );
    if (result.kind !== "ok") return;
    const next = new Map<string, HostDirectoryEntry>();
    for (const item of result.response.hosts) {
      next.set(
        item.hostId,
        hostListItemToDirectoryEntry(item, deps.relayBaseUrl, true),
      );
    }
    cachedRemote = next;
  };

  const refreshOnce = (): Promise<void> => {
    const running = inFlight;
    if (running !== null) return running;
    if (deps.bearerToken() === null) return Promise.resolve();
    const since = lastRefreshAt;
    if (
      !forced &&
      since !== null &&
      deps.now() - since < MISS_REFRESH_COOLDOWN_MS
    ) {
      return Promise.resolve();
    }
    // Consumed when the forced read STARTS, not when it succeeds: an
    // invalidation asks for one fresh read, and a failing registry must not
    // turn that request into a standing exemption from the floor.
    forced = false;
    const started = refresh()
      .catch((error: unknown) => {
        log.warn("[browser-sessions] host registry read failed", {
          error: describeLogError(error),
        });
      })
      .finally(() => {
        lastRefreshAt = deps.now();
        inFlight = null;
      });
    inFlight = started;
    return started;
  };

  const localEntryFor = (hostId: string): HostDirectoryEntry | null => {
    const local = deps.localHost();
    if (local === null || local.hostId !== hostId) return null;
    return {
      hostId,
      label: hostId,
      kind: "local",
      websocketUrl: local.websocketUrl,
      version: local.version,
      transportDialability: "dialable",
    };
  };

  return {
    invalidate: (hostId) => {
      cachedRemote.delete(hostId);
      forced = true;
    },
    reset: () => {
      cachedRemote = new Map();
      lastRefreshAt = null;
      forced = true;
    },
    endpoint: (hostId) => {
      const entry = localEntryFor(hostId) ?? cachedRemote.get(hostId) ?? null;
      if (entry === null) return null;
      return { hostId, websocketUrl: entry.websocketUrl };
    },
    resolve: async (hostId) => {
      const local = localEntryFor(hostId);
      if (local !== null) return local;
      const cached = cachedRemote.get(hostId);
      if (cached !== undefined) return cached;
      await refreshOnce();
      return cachedRemote.get(hostId) ?? null;
    },
  };
}

export interface BrowserSessionsTransportDeps {
  readonly authnBaseUrl: () => string;
  readonly bearer: BearerSourceProvider;
  /** Re-read on every (re)dial, so a host that moved is followed. */
  readonly endpoint: () => HostTransportEndpoint | null;
  readonly appVersion: string | null;
}

export function openBrowserSessionsTransport(
  target: HostDirectoryEntry,
  userId: string,
  deps: BrowserSessionsTransportDeps,
): BrowserSessionsHostTransport | null {
  const clientIdentity: FirstPartyClientIdentity = {
    kind: "desktop",
    compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
    appVersion: deps.appVersion,
  };
  if (target.kind === "remote") {
    if (!isRemoteHostDirectoryEntry(target) || target.websocketUrl === null) {
      return null;
    }
    const remote = createRemoteHostTransport<
      HostRpcRegistry,
      HostStreamRpcRegistry
    >({
      hostId: target.hostId,
      userId,
      relayAttachUrl: target.websocketUrl,
      authnBaseUrl: deps.authnBaseUrl(),
      hostPublicKey: target.publicKey,
      bearer: deps.bearer,
      auth: null,
      clock: null,
      rpcRegistry: hostRpcRegistry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: streamWebSocketFactory,
      requestId: () => randomUUID(),
      evidence: NO_TRANSPORT_EVIDENCE,
      clientIdentity,
      // The jar stream re-snapshots on replay, so the wake sweep may probe it.
      proactiveWakeEligible: true,
    });
    if (remote === null) return null;
    remote.session.start();
    return {
      wsStreamClient: remote.streamClient,
      close: () => {
        remote.session.close();
      },
    };
  }
  if (target.websocketUrl === null) return null;
  const client = new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    hostId: target.hostId,
    endpoint: deps.endpoint,
    bearer: deps.bearer,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: streamWebSocketFactory,
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: DEFAULT_OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
    pongTimeoutMs: DEFAULT_PONG_TIMEOUT_MS,
    initialBackoffMs: DEFAULT_INITIAL_BACKOFF_MS,
    maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
    clientIdentity,
  });
  return {
    wsStreamClient: client,
    close: () => {
      client.close("browser-sessions-stream-closed");
    },
  };
}
