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

/**
 * The one place main answers "which host is this id, and how do I dial it".
 *
 * The renderer passes an ID and nothing else. The directory row
 * carries the host's static Noise key, so accepting a renderer-supplied row
 * would let a compromised renderer point main's jar stream at a host it
 * controls - which is the whole ticket.
 */
export interface BrowserSessionsHostDirectory {
  resolve(hostId: string): Promise<HostDirectoryEntry | null>;
  /**
   * The address to dial RIGHT NOW, re-read on every (re)dial.
   *
   * A local host that respawns on a new port while a stream is warm is
   * ordinary - a `traycer host restart`, an update install - and a transport
   * holding the address it was built with would retry a dead port until the
   * renderer happened to re-open the stream. `null` while no address is known,
   * which the transport treats as "not dialable yet" and retries.
   */
  endpoint(hostId: string): HostTransportEndpoint | null;
  /**
   * Forgets what was cached for one host, so the next `resolve` re-reads the
   * registry.
   *
   * The cached row is not just an address: it carries the host's static Noise
   * key and its relay attach url, and both are frozen into a remote transport
   * when it is built. A rotated key or a deregistered host therefore strands
   * the stream for as long as the row survives, and nothing about a failed
   * dial would evict it - which is why the stream calls this on the way to a
   * restart rather than waiting for a miss.
   */
  invalidate(hostId: string): void;
  /**
   * Drops the whole cached registry, and the cooldown that guards refetching
   * it, because the identity it was read for has changed.
   *
   * The rows are per ACCOUNT - `listRegisteredHosts` answers for the bearer it
   * was given - but the cache is keyed by host id alone, so a sign-out or an
   * account switch would otherwise let the next account dial the previous
   * account's row for the same id. The cooldown goes with it: a fresh identity
   * is exactly the moment one read is owed rather than deferred.
   */
  reset(): void;
}

export interface BrowserSessionsHostDirectoryDeps {
  /**
   * Read at call time, not at registration: the IPC layer is wired before the
   * bridge's options are anything a directory read could use, and a value
   * captured then would pin the process to whatever was configured first.
   */
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

/**
 * The floor between two registry reads a MISS provokes.
 *
 * A miss is renderer-triggered (it names the host id), so an unknown id is a
 * request this process makes to authn on someone else's say-so. One read per
 * window of unknown ids is enough to learn about a host that appeared; a
 * renderer looping ids gets the cached "no" instead of an amplifier. An
 * explicit `invalidate` is not a miss and is never throttled.
 */
const MISS_REFRESH_COOLDOWN_MS = 30_000;

/**
 * Resolves a host id against this machine's own published host first, then the
 * account's registry.
 *
 * The registry answer is CACHED and refetched on a miss (rate-limited) or when
 * a caller invalidates a row: a stream opens rarely, and the renderer's own
 * directory poll remains the app's cadence. No timer of its own, deliberately.
 */
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
      // `planAllowsRemote: true` - main holds no plan state, and the fetcher's
      // own contract says a not-yet-known plan reads as allowed: a wasted dial
      // meets the relay's 403, while refusing here would silently strand the
      // jar plane for a paying account.
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
        // Stamped on every completed ATTEMPT, not on success. The floor
        // exists because a miss is renderer-triggered, and an unhealthy authn
        // is exactly when a loop of unknown ids would otherwise become one
        // request each - the failure a rate limit is most needed for.
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

/**
 * One `browser.sessions` transport, owned by main.
 *
 * `auth: null` and `hostCredentialMint: null` are the two deliberate
 * differences from the renderer's durable transport, and both are for the same
 * reason: those recoveries are app-wide single-flight machinery that lives in
 * the renderer, and a second implementation here would double-spend a
 * single-use refresh token or race a concurrent mint. What main loses is
 * self-healing on an `UNAUTHORIZED`: the stream goes terminal, the renderer
 * sees `failed`, and its own `retry()` re-opens on the bearer the renderer has
 * meanwhile rotated into this process. Since the bearer is read LIVE off the
 * desktop auth session, that retry dials with the fresh credential.
 */
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
