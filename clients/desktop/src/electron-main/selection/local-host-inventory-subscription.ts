/**
 * Main's subscription to THIS machine's host for the account's registry.
 *
 * ## What it replaces, and what it does not
 *
 * `registerRegisteredHostsBroadcast` polls `GET /api/v3/hosts` once a minute
 * for the whole app. The local host reads the same endpoint on the same
 * cadence for its own reasons (`host-inventory.ts`), with a device-bound
 * credential it holds anyway. So a desktop with its host running makes two
 * reads a minute of one Redis lease, and one of them can be had for free.
 *
 * This subscribes to the host's answer and feeds it to the fleet source
 * through the same adoption path a fetch takes. It does NOT delete the poll:
 * the poll is the fallback, and it is the whole reason this is safe to add.
 *
 * ## The fallback is the design, not the error path
 *
 * Every way this can fail ends in the poll running exactly as it does today:
 *
 *  - a host that predates the method never advertises it, support reads
 *    `unsupported`, and no session is opened at all;
 *  - a host that is not running, or has no published endpoint, means nothing
 *    to dial;
 *  - a session that drops, stalls past its heartbeat, or is closed by a host
 *    restart reports a non-`open` status;
 *  - a snapshot the host marks STALE means the host's own read failed and it
 *    is serving last-known rows. The rows are still adopted - they are the
 *    freshest anyone has - but the push stops counting as coverage, because
 *    the host reads with a device credential and this process reads with the
 *    user's bearer: a host whose credential needs re-auth is stale in a way
 *    the poll is not.
 *
 * In each case `onPushActiveChanged(false)` fires and the poll resumes on its
 * next tick; a later healthy snapshot arms it again. Nothing here retries on
 * its own beyond the transport's own reconnect ladder - the poll is the retry.
 *
 * ## One stated limit: a TERMINAL close is not re-opened
 *
 * An ordinary drop is the client's business - it re-dials, re-reading the
 * endpoint each time, so the common case of the host restarting on a new port
 * heals without this module hearing about it. A session that goes terminally
 * `closed` (an UNAUTHORIZED, an incompatible method) is NOT re-opened here,
 * and deliberately: those are the closes that would re-fail immediately, and a
 * re-open loop against a host refusing us is worse than the thing it would be
 * trying to restore. The push stays down until this machine publishes a
 * different host id or the app restarts, and the poll - which reads with the
 * renderer's own bearer, not this stream's - carries the registry meanwhile.
 * That is the status quo, which is the worst this module is allowed to cost.
 */
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/index";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { HostInventoryStreamClient } from "@traycer-clients/shared/host-transport/host-inventory-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/host-messenger";
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

const streamWebSocketFactory = createWhatwgStreamWebSocketFactory();

const INVENTORY_METHOD = "host.hostInventory.subscribe";

export interface LocalHostEndpoint {
  readonly hostId: string;
  readonly websocketUrl: string;
}

export interface LocalHostInventorySubscriptionDeps {
  /** This machine's published host, re-read per dial so a moved host is followed. */
  readonly localHost: () => LocalHostEndpoint | null;
  /** Fires when the published host changes (pid.json moved, host restarted). */
  readonly onLocalHostChanged: (listener: () => void) => () => void;
  /**
   * Opens a stream client for this machine's host.
   *
   * A port rather than a `new WsStreamClient(...)` inside `attach`, and not
   * for symmetry: everything this module actually decides - when to open, when
   * to stand the poll back up, what a stale snapshot means - is reachable only
   * through a client, and a module that builds its own can be exercised only
   * against a real socket. {@link createLocalHostInventoryStreamClient} is the
   * production one, and the composition passes it explicitly.
   */
  readonly openStreamClient: (
    endpoint: LocalHostEndpoint,
  ) => IHostStreamClient<HostStreamRpcRegistry>;
  /**
   * One pushed registry answer, with the host's own clock at the read that
   * produced it.
   *
   * The read time travels with the rows because the consumer orders adoption
   * on it: a snapshot handed over when this subscription opens can carry rows
   * the host read up to a full interval ago, so it arrives newest and was
   * observed oldest. The host runs on THIS machine, so its `fetchedAtMs` and
   * the consumer's own clock are the same clock.
   */
  readonly onRows: (read: {
    readonly response: HostListResponse;
    readonly readAtMs: number;
  }) => void;
  /**
   * Whether the push is currently covering the registry. `false` is a
   * statement that the poll must keep running, and it is made whenever this
   * module is not certain of the opposite.
   */
  readonly onPushActiveChanged: (active: boolean) => void;
  readonly log: AuthorityLog;
}

export interface LocalHostInventorySubscription {
  dispose(): void;
}

export function startLocalHostInventorySubscription(
  deps: LocalHostInventorySubscriptionDeps,
): LocalHostInventorySubscription {
  let client: IHostStreamClient<HostStreamRpcRegistry> | null = null;
  let stream: HostInventoryStreamClient | null = null;
  let unsubscribeSupport: (() => void) | null = null;
  let attachedHostId: string | null = null;
  let pushActive = false;
  let disposed = false;

  const setPushActive = (active: boolean): void => {
    if (pushActive === active) return;
    pushActive = active;
    deps.onPushActiveChanged(active);
  };

  const teardown = (reason: string): void => {
    stream?.close();
    stream = null;
    unsubscribeSupport?.();
    unsubscribeSupport = null;
    client?.close(reason);
    client = null;
    attachedHostId = null;
    setPushActive(false);
  };

  /**
   * Opens the session when the host says it serves the method.
   *
   * `unknown` subscribes: it is the answer before a handshake, and the
   * subscribe IS the probe - withholding it there would mean never opening on
   * a cold client, which is every client at startup. Only an explicit
   * `unsupported` declines, and the support subscription below re-runs this if
   * that answer ever changes (an upgraded host, a fresh handshake).
   */
  const openStreamIfSupported = (): void => {
    if (disposed || client === null || stream !== null) return;
    if (client.getMethodSupport(INVENTORY_METHOD) === "unsupported") {
      deps.log.debug("[local-inventory] host does not serve the method", {});
      setPushActive(false);
      return;
    }
    stream = new HostInventoryStreamClient({
      wsStreamClient: client,
      callbacks: {
        onSnapshot: (snapshot) => {
          if (disposed) return;
          // Adopted whatever its staleness: rows the host could not refresh
          // are still rows, and dropping them would leave this process on
          // something older. Coverage is the separate question.
          deps.onRows({
            response: { hosts: [...snapshot.hosts] },
            readAtMs: snapshot.fetchedAtMs,
          });
          setPushActive(!snapshot.stale);
        },
        onConnectionStatus: (status) => {
          if (disposed) return;
          // Only `open` arms it, and `open` alone does not: a stream that is
          // connected but has said nothing yet is not covering anything. The
          // first snapshot arms it (the host sends one on subscribe), and any
          // other status disarms it immediately.
          if (status !== "open") setPushActive(false);
        },
      },
    });
  };

  const attach = (): void => {
    if (disposed) return;
    const endpoint = deps.localHost();
    if (endpoint === null) {
      // No published host: nothing to dial, and the poll is the only reader.
      if (client !== null) teardown("local-inventory-host-gone");
      setPushActive(false);
      return;
    }
    if (client !== null && attachedHostId === endpoint.hostId) return;
    // A different host id is a different machine identity, not a reconnect:
    // the memoized method support, the negotiated versions and the rows are
    // all keyed to the old one.
    if (client !== null) teardown("local-inventory-host-changed");
    attachedHostId = endpoint.hostId;
    client = deps.openStreamClient(endpoint);
    unsubscribeSupport = client.subscribeMethodSupport(() => {
      if (disposed) return;
      if (stream === null) {
        openStreamIfSupported();
        return;
      }
      if (client?.getMethodSupport(INVENTORY_METHOD) === "unsupported") {
        stream.close();
        stream = null;
        setPushActive(false);
      }
    });
    openStreamIfSupported();
  };

  const unsubscribeHostChange = deps.onLocalHostChanged(() => {
    attach();
  });
  attach();

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeHostChange();
      teardown("local-inventory-disposed");
    },
  };
}

/**
 * The production client: a plain local WebSocket to this machine's host.
 *
 * `auth` and `hostCredentialMint` are null for the reason
 * `browser-sessions-transport.ts` states about its own local client - the
 * credential recoveries are app-wide single-flight machinery owned by the
 * renderer, and a second implementation in main would double-spend a
 * single-use refresh token. What that costs here is self-healing on an
 * UNAUTHORIZED, and what an unhealed stream costs is the poll, which is where
 * this read was going to be made anyway.
 *
 * The endpoint is re-read per dial rather than captured, so a host that moved
 * between reconnect attempts is followed to its new port.
 */
export function createLocalHostInventoryStreamClient(deps: {
  readonly localHost: () => LocalHostEndpoint | null;
  readonly bearer: BearerSourceProvider;
  readonly appVersion: string | null;
}): (endpoint: LocalHostEndpoint) => IHostStreamClient<HostStreamRpcRegistry> {
  return (endpoint) =>
    new WsStreamClient<HostStreamRpcRegistry>({
      registry: hostStreamRpcRegistry,
      hostId: endpoint.hostId,
      endpoint: (): HostTransportEndpoint | null => {
        const current = deps.localHost();
        if (current === null) return null;
        return { hostId: current.hostId, websocketUrl: current.websocketUrl };
      },
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
      clientIdentity: {
        kind: "desktop",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: deps.appVersion,
      } satisfies FirstPartyClientIdentity,
    });
}
