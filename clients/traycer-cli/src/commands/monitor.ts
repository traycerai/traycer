import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { localTeamAdmissionCliError } from "../internal/local-open-auth";
import {
  hostDoorRefusalCliError,
  olderHostCliError,
  type HostDoorCredential,
} from "../internal/host-door-words";
import {
  hostVersionNeedsUpdate,
  MINIMUM_HOST_VERSION,
} from "@traycer-clients/shared/host-client/minimum-host-version";
import {
  createCliHostTokens,
  type SignInRevalidator,
} from "../internal/cli-host-tokens";
import { isCredentialRefusal } from "@traycer/protocol/host-transport/door-refusal";
import { formatAgentMessage } from "@traycer/protocol/agent/a2a-message-format";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  agentInboxSubscribeServerFrameSchema,
  agentInboxSubscribeServerFrameSchemaV10,
  agentInboxSubscribeServerFrameSchemaV11,
  agentInboxSubscribeServerFrameSchemaV12,
  type AgentInboxMessage,
  type AgentInboxNotice,
} from "@traycer/protocol/host/agent/inbox";
import type { RoleAwarenessEvent } from "@traycer/protocol/host/agent/roles";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  MutableBearerLease,
  readLeaseBearer,
  type BearerSourceProvider,
} from "../../../shared/auth/bearer-source";
import type { RevalidateOutcome } from "../../../shared/auth/bearer-revalidator";
import type { HostCredentialMintFlow } from "../../../shared/host-transport/host-credential-mint-flow";
import {
  createProactiveRefreshScheduler,
  DEFAULT_REFRESH_LEAD_MS,
  DEFAULT_REFRESH_MIN_DELAY_MS,
} from "../../../shared/auth/token-refresh-scheduler";
import { createWhatwgStreamWebSocketFactory } from "../../../shared/host-transport/whatwg-stream-ws-factory";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "../../../shared/host-transport/i-stream-session";
import type { HostTransportEndpoint } from "../../../shared/host-transport/ws-rpc-client";
import { WsStreamClient } from "../../../shared/host-transport/ws-stream-client";
import { DEFAULT_DIAL_TIMEOUT_MS } from "../../../shared/host-transport/transport-config";
import { config } from "../config";
import { createCliLogger, type ILogger } from "../logger";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
} from "../host/pid-metadata";
import { createCliHostCredentialMintFlow } from "../auth/host-credential-mint";
import { resolveHostAuth } from "../internal/host-auth";
import { callAgentHostRpc } from "../internal/host-rpc";
import {
  PROCESS_AGENT_ENVIRONMENT,
  readAgentSessionCapability,
  type AgentSessionCapability,
} from "../internal/agent-session-capability";
import {
  stdoutReaderClosed,
  writeStderr,
  writeStdout,
  writeStdoutForAck,
} from "../runner/std-write";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { CLI_CLIENT_IDENTITY } from "../cli-version";

/**
 * `traycer monitor` — long-running background command spawned inside a Claude
 * Code TUI session by the Traycer plugin. It subscribes to the host's
 * `agent.inbox.subscribe` stream for one agent id and prints every inbound
 * inter-agent message to stdout, where Claude Code's background-command surface
 * shows it to the agent.
 *
 * The transport is the shared `WsStreamClient` (the same client the Desktop
 * renderer uses for its streams): it owns dial / handshake / ping-pong /
 * reconnect-with-backoff. This command only layers on the inbox-frame printing
 * and the refresh-on-`UNAUTHORIZED` recovery.
 *
 * stdout carries inbox messages only; all connection/diagnostic noise goes to
 * stderr so it never pollutes the agent-facing stream.
 *
 * NOT read-only, despite "stream" (CLI-021). Three durable effects, all of them
 * required for the stream to be correct rather than incidental:
 *
 *  1. Delivery acknowledgement - a message confirmed onto stdout advances the
 *     agent's inbox server-side, so the at-least-once inbox stops redelivering
 *     it on reconnect. From the negotiated `@1.2` this CLI enqueues the
 *     `agent.inbox.ack` itself; below that there is no event id on the frame
 *     and the host retires the row on its own (see `handleServerFrame`).
 *  2. Credential maintenance - the store-backed revalidator rotates and
 *     PERSISTS this machine's credentials, proactively before expiry and
 *     reactively on `UNAUTHORIZED`. A rotation spends a single-use refresh
 *     token, which is why it goes through the locked store.
 *  3. Host-credential provisioning - a host reporting `missing` gets a
 *     delegated credential minted for it, so it keeps serving after this
 *     process exits.
 *
 * On the readonly agent surface this command is hidden but NOT refused; see
 * `MONITOR_SURFACE_NOTE` in `../agent-surface.ts` for that decision.
 */
const SUBSCRIBE_METHOD = "agent.inbox.subscribe" as const;
const OPEN_ACK_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Re-read the host pid metadata so reconnects pick up a restarted host's port. */
const ENDPOINT_POLL_MS = 2_000;
/**
 * Once a connection has stayed open this long without a fatal close, treat the
 * subscription as accepted and reset the auth-refresh spin counter. `open` alone
 * isn't proof — `WsStreamClient` emits it right after sending the subscribe
 * frame, before the host accepts it — so a host that rejects at the
 * subscribe stage must not be allowed to reset the counter every cycle.
 */
const HEALTHY_OPEN_MS = 10_000;
/** Backoff before re-subscribing after a transient (network-error) auth refresh. */
const AUTH_RETRY_DELAY_MS = 5_000;
/**
 * Consecutive bearer refreshes (each rotating to a genuinely new token) without
 * the subscription ever becoming healthy, before we give up — bounds a
 * refresh/reject spin when a freshly-refreshed bearer is still rejected
 * (cloud/host desync).
 */
const MAX_CONSECUTIVE_AUTH_REFRESHES = 3;

export type MonitorArgs = {
  readonly agentId: string | null;
  readonly epicId: string | null;
};

type EndpointResolutionLogState = {
  value: string | null;
};

export async function runMonitor(args: MonitorArgs): Promise<void> {
  const logger = createCliLogger(config.environment);
  const agentId = args.agentId ?? process.env.TRAYCER_AGENT_ID ?? null;
  const epicId = args.epicId ?? process.env.TRAYCER_EPIC_ID ?? null;

  logger.debug("Monitor resolving target", {
    environment: config.environment,
    agentIdPresent: agentId !== null && agentId.length > 0,
    epicIdPresent: epicId !== null && epicId.length > 0,
    agentIdFromArg: args.agentId !== null,
    epicIdFromArg: args.epicId !== null,
  });

  if (agentId === null || agentId.length === 0) {
    logger.warn("Monitor missing agent id", {
      environment: config.environment,
    });
    throw new Error(
      "traycer monitor: agent id required — pass --agent-id or set TRAYCER_AGENT_ID.",
    );
  }
  if (epicId === null || epicId.length === 0) {
    logger.warn("Monitor missing epic id", {
      environment: config.environment,
    });
    throw new Error("traycer monitor: epic id required — set TRAYCER_EPIC_ID.");
  }
  // The shared client reads `endpoint()` on every (re)connect, so a poller that
  // refreshes the cached endpoint is the CLI's equivalent of the renderer's
  // host directory — reconnects survive a host restart on a new port. Polls
  // are serialized (no out-of-order clobber) and a good endpoint is never
  // overwritten with `null` (a momentarily-absent pid file keeps the last-known
  // URL; dials simply retry until a fresh one appears).
  const endpointResolutionLogState: EndpointResolutionLogState = {
    value: null,
  };
  let endpoint = await tryResolveStreamEndpoint(
    logger,
    endpointResolutionLogState,
  );
  logger.debug("Monitor initial endpoint resolution completed", {
    environment: config.environment,
    hasEndpoint: endpoint !== null,
    agentId,
    epicId,
  });
  // After the floor, so a host below it is refused before any credential is
  // read.
  const capability = readAgentSessionCapability(PROCESS_AGENT_ENVIRONMENT);
  const credential =
    capability === null
      ? await signInMonitorCredential(logger, { agentId, epicId })
      : capabilityMonitorCredential(capability);
  let pollInFlight = false;
  const poll = setInterval(() => {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;
    void tryResolveStreamEndpoint(logger, endpointResolutionLogState)
      .then((next) => {
        if (next !== null && !sameEndpoint(endpoint, next)) {
          endpoint = next;
          logger.debug("Monitor endpoint refreshed", {
            environment: config.environment,
            hostId: next.hostId,
          });
        }
      })
      // A host restarted below the floor is never dialed: the monitor keeps
      // the endpoint it has. Logged where it is found.
      .catch(() => undefined)
      .finally(() => {
        pollInFlight = false;
      });
  }, ENDPOINT_POLL_MS);

  const client = new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    // The host this endpoint resolves to, or `null` while it has resolved none
    // yet - which simply declines the seed. Safe even where `endpoint` is
    // re-resolved later in the run: the seed is consulted only before this
    // client's first handshake, which is while this id is still the current
    // one, and the latch closes it for good after that.
    hostId: endpoint?.hostId ?? null,
    endpoint: () => endpoint,
    // `null` (the transport's wait) until the endpoint names a host.
    bearer: () =>
      endpoint === null ? null : credential.bearer(endpoint.hostId)(),
    userId: credential.userId,
    // `auth: null` opts out of the WsStreamClient's built-in stream-auth
    // recovery: the monitor runs its OWN recovery loop in
    // `runInboxSubscription` (a fresh token, then re-subscribe on `rotated` /
    // back off and re-subscribe on `network-error`), so wiring the client
    // handler too would double up. A refusal a fresh token cannot answer stays
    // terminal there.
    auth: null,
    clock: null,
    hostCredentialMint: credential.hostCredentialMint,
    // The monitor provisions opportunistically and never verifies adoption -
    // the next connection's ack settles it.
    onHostCredentialState: null,
    // The CLI has no selection authority to feed: it holds no lease
    // state and never fails a window over.
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: createWhatwgStreamWebSocketFactory(),
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: PING_INTERVAL_MS,
    pongTimeoutMs: PONG_TIMEOUT_MS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    clientIdentity: CLI_CLIENT_IDENTITY,
  });

  credential.startUpkeep(
    () => endpoint?.hostId ?? null,
    () => client.notifyBearerRotated(),
  );

  diag(`inbox monitor starting — agent=${agentId} epic=${epicId}`);
  logger.info("Monitor subscription loop starting", {
    environment: config.environment,
    agentId,
    epicId,
  });
  try {
    await runInboxSubscription(
      client,
      (details) =>
        endpoint === null
          ? Promise.resolve<RevalidateOutcome>("network-error")
          : credential.recover(endpoint.hostId, details),
      credential.signInRejected,
      credential.presented,
      { agentId, epicId },
      logger,
      stdoutReaderClosed(),
    );
    // Reached only when stdout's reader went away: there is nobody left to
    // print a message to, so stop holding the inbox open. Nothing was acked
    // for a message that did not confirm onto stdout, so the at-least-once
    // inbox redelivers it to the next monitor.
    client.close("stdout-reader-closed");
  } finally {
    credential.stopUpkeep();
    clearInterval(poll);
    logger.info("Monitor subscription loop stopped", {
      environment: config.environment,
      agentId,
      epicId,
    });
  }
}

/** What the monitor presents to its host, and the upkeep that keeps it good. */
interface MonitorCredential {
  readonly presented: HostDoorCredential;
  readonly userId: string;
  readonly bearer: (hostId: string) => BearerSourceProvider;
  readonly recover: (
    hostId: string,
    details: FatalErrorDetails,
  ) => Promise<RevalidateOutcome>;
  /** Whether this machine is signed out in fact; see `runInboxSubscription`. */
  readonly signInRejected: () => boolean;
  readonly hostCredentialMint: HostCredentialMintFlow | null;
  /** `onRenewed` pushes a renewed token onto the open stream. */
  readonly startUpkeep: (
    hostId: () => string | null,
    onRenewed: () => void,
  ) => void;
  readonly stopUpkeep: () => void;
}

/**
 * The stored sign-in, spent at authn alone: the host receives this CLI's
 * host-only token for it, never the sign-in.
 */
async function signInMonitorCredential(
  logger: ILogger,
  target: InboxTarget,
): Promise<MonitorCredential> {
  const auth = await resolveHostAuth();
  if (auth === null) {
    logger.warn("Monitor cannot start without credentials", {
      environment: config.environment,
      agentId: target.agentId,
      epicId: target.epicId,
    });
    throw new Error(
      "traycer monitor: not signed in — run `traycer login` to authenticate.",
    );
  }
  logger.debug("Monitor credentials resolved", {
    environment: config.environment,
    agentId: target.agentId,
    epicId: target.epicId,
  });
  const lease = new MutableBearerLease(auth.token, auth.userId);
  // Refreshes of the sign-in (when authn refuses it for a mint, and ahead of
  // its TTL) route through the locked `rotate` (§7) so a monitor refresh and a
  // concurrent desktop refresh can never double-spend the single-use refresh
  // token. One store for the monitor's lifetime - its background continuation
  // timer can land a `commit-failed` spend while the monitor keeps running -
  // disposed by `stopUpkeep`.
  const store = createCliCredentialsStore();
  // `signal: null`: the monitor's revalidator lives as long as the command
  // itself - there is no earlier deadline to cancel a rotation against.
  const revalidator: SignInRevalidator = createStoreBackedRevalidator({
    store,
    lease,
    signal: null,
  });
  // Whether authn refused the stored sign-in at its last answered refresh:
  // the only case in which this machine is signed out in fact.
  let signInRejected = false;
  const refreshSignIn = async (): Promise<RevalidateOutcome> => {
    const outcome = await revalidator.revalidateCurrentContext();
    if (outcome === "rejected") signInRejected = true;
    else if (outcome === "rotated") signInRejected = false;
    return outcome;
  };
  const hostTokens = createCliHostTokens({ lease, refresh: refreshSignIn });
  let refreshScheduler: { readonly stop: () => void } | null = null;
  return {
    presented: "host-token",
    userId: lease.identity.userId,
    bearer: (hostId) => hostTokens.streamBearer(hostId),
    recover: (hostId, details) =>
      hostTokens.streamRecovery(hostId).revalidateRefused(details),
    signInRejected: () => signInRejected,
    // Delegated host-credential provisioning. `monitor` is the CLI command
    // that most needs it: the host it watches should keep serving after this
    // process exits. Provisioning is silent, so this works the same whether
    // `monitor` is run from a terminal or as the background command it
    // usually is.
    hostCredentialMint: createCliHostCredentialMintFlow({
      authnBaseUrl: auth.authnBaseUrl,
      bearer: () => readLeaseBearer(lease),
      diag: (message) => diag(message),
      signal: null,
      unavailableNote:
        "continuing without a host credential — it will stop working when this connection ends.",
      onUnauthorized: null,
    }),
    // Proactively refresh the sign-in shortly before its ~4h TTL, and buy the
    // host-only token with it at once, so a long-running monitor never
    // carries a dead token into a reconnect. The reactive recovery in
    // `runInboxSubscription` stays as the safety net. The scheduler shares the
    // same single-flight `revalidator`, so a proactive and reactive refresh
    // can't race into a double rotation.
    startUpkeep: (hostId, onRenewed) => {
      const scheduler = createProactiveRefreshScheduler<NodeJS.Timeout>({
        getToken: () => readLeaseBearer(lease),
        revalidate: async () => {
          const outcome = await refreshSignIn();
          const current = hostId();
          if (outcome === "rotated" && current !== null) {
            await hostTokens.renewAfterSignInRefresh(current);
            // The host updates its captured credential in place - no
            // reconnect. The reactive path already re-dials with the fresh
            // token, so it needs no push.
            onRenewed();
          }
          return outcome;
        },
        now: () => Date.now(),
        setTimer: (handler, ms) => setTimeout(handler, ms),
        clearTimer: (handle) => clearTimeout(handle),
        leadMs: DEFAULT_REFRESH_LEAD_MS,
        minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
        onDiagnostic: (message) => diag(message),
      });
      scheduler.start();
      refreshScheduler = scheduler;
    },
    stopUpkeep: () => {
      refreshScheduler?.stop();
      store.dispose();
    },
  };
}

/**
 * The agent session capability: no sign-in is read and nothing is renewed,
 * minted or provisioned. The host's refusal of it ends the monitor.
 */
function capabilityMonitorCredential(
  capability: AgentSessionCapability,
): MonitorCredential {
  return {
    presented: "agent-capability",
    userId: capability.bearer.identity.userId,
    bearer: () => capability.streamBearer,
    recover: () => capability.streamRecovery(),
    signInRejected: () => false,
    hostCredentialMint: null,
    startUpkeep: () => undefined,
    stopUpkeep: () => undefined,
  };
}

type InboxTarget = { readonly agentId: string; readonly epicId: string };

/** A fresh host-only token after the host refused this one. */
type InboxRecovery = (details: FatalErrorDetails) => Promise<RevalidateOutcome>;

/**
 * Drives the inbox subscription until a terminal failure or until stdout's
 * reader goes away. Resolves only on `readerClosed` (an orphaned monitor whose
 * reader has closed the pipe; `traycer monitor` then exits 0); rejects on a
 * non-recoverable close so `traycer monitor` exits non-zero. A healthy stream
 * with a live reader runs forever.
 *
 * Recovery on a host's credential refusal switches on the fresh token's
 * OUTCOME:
 *   - `rotated`       → re-subscribe immediately (bounded by the spin guard);
 *   - `network-error` → transient; keep the bearer and re-subscribe after a
 *                       delay (don't kill a long-running monitor on a flaky link);
 *   - `rejected`      → terminal, with the door's line: sign-in advice only
 *                       when `signInRejected()` says this machine is signed
 *                       out in fact.
 * Every other fatal (e.g. `INCOMPATIBLE`) is terminal, with the door's line
 * when it is a door refusal.
 */
function runInboxSubscription(
  client: WsStreamClient<HostStreamRpcRegistry>,
  recover: InboxRecovery,
  signInRejected: () => boolean,
  presented: HostDoorCredential,
  target: InboxTarget,
  logger: ILogger,
  readerClosed: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let session: IStreamSession | null = null;
    let authRefreshCount = 0;
    let healthTimer: NodeJS.Timeout | null = null;
    let retryTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const acknowledgements = new InboxAcknowledgementQueue(target, logger);

    const clearHealthTimer = (): void => {
      if (healthTimer !== null) {
        clearTimeout(healthTimer);
        healthTimer = null;
      }
    };
    const clearRetryTimer = (): void => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      logger.error(
        "Monitor subscription failed",
        {
          environment: config.environment,
          agentId: target.agentId,
          epicId: target.epicId,
        },
        error,
      );
      clearHealthTimer();
      clearRetryTimer();
      acknowledgements.dispose();
      session?.close();
      readerClosed.removeEventListener("abort", stopForClosedReader);
      reject(error);
    };

    const stopForClosedReader = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      logger.info("Monitor stopping: stdout reader closed", {
        environment: config.environment,
        agentId: target.agentId,
        epicId: target.epicId,
      });
      clearHealthTimer();
      clearRetryTimer();
      acknowledgements.dispose();
      session?.close();
      resolve();
    };

    // The subscription is demonstrably accepted — reset the auth-spin guard.
    const markHealthy = (): void => {
      authRefreshCount = 0;
    };

    const subscribe = (): void => {
      clearRetryTimer();
      session?.close();
      logger.debug("Monitor subscribing to inbox stream", {
        environment: config.environment,
        method: SUBSCRIBE_METHOD,
        agentId: target.agentId,
        epicId: target.epicId,
      });
      const next = client.subscribe(SUBSCRIBE_METHOD, target);
      session = next;
      next.onServerFrame((envelope) => {
        markHealthy();
        void handleServerFrame(
          envelope,
          client,
          target,
          logger,
          acknowledgements,
        );
      });
      next.onStatusChange((status, reason, retryCause) => {
        void onStatusChange(status, reason, retryCause);
      });
    };

    const onStatusChange = async (
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
      retryCause: FatalErrorDetails | null,
    ): Promise<void> => {
      if (settled) {
        return;
      }
      const admissionError = retryCause
        ? localTeamAdmissionCliError(retryCause)
        : null;
      if (admissionError !== null) diag(admissionError.message);
      else diag(`stream ${status}`);
      clearHealthTimer();
      if (status === "open") {
        logger.debug("Monitor stream opened", {
          environment: config.environment,
          agentId: target.agentId,
          epicId: target.epicId,
        });
        // Sustained openness (past the subscribe-accept window) is health.
        healthTimer = setTimeout(markHealthy, HEALTHY_OPEN_MS);
        return;
      }
      if (
        status !== "closed" ||
        reason === null ||
        reason.kind !== "fatalError"
      ) {
        return;
      }
      const details = reason.details;
      const hostClosed = (): Error =>
        new Error(`traycer monitor: host closed the stream: ${details.reason}`);
      if (details.retryable === true || !isCredentialRefusal(details)) {
        logger.warn("Monitor stream closed with non-auth fatal error", {
          environment: config.environment,
          code: details.code,
          agentId: target.agentId,
          epicId: target.epicId,
        });
        fail(
          hostDoorRefusalCliError(details, false, presented, hostClosed) ??
            localTeamAdmissionCliError(details) ??
            hostClosed(),
        );
        return;
      }
      // The recovery never throws (it maps failures to an outcome), so this
      // await can't reject the swallowed handler promise into a hang.
      const outcome = await recover(details);
      if (settled) {
        return;
      }
      logger.debug("Monitor auth revalidation completed", {
        environment: config.environment,
        outcome,
        authRefreshCount,
        agentId: target.agentId,
        epicId: target.epicId,
      });
      if (outcome === "rotated") {
        authRefreshCount += 1;
        if (authRefreshCount > MAX_CONSECUTIVE_AUTH_REFRESHES) {
          // The bearer genuinely rotated on every attempt yet the host
          // still rejected the freshly-minted token. The `/stream` fatal
          // frame only carries `UNAUTHORIZED` / `INCOMPATIBLE` (see
          // `FatalErrorDetails` in ws-protocol), so it can't tell us
          // whether this is an auth failure or an authz one. A new token
          // being rejected points at authz, not a stale token — surface
          // that the agent/epic may be invalid or inaccessible instead of
          // blaming the bearer.
          fail(
            new Error(
              `traycer monitor: session rejected after ${authRefreshCount} refreshes — the agent/epic may be invalid or inaccessible (check --agent-id and TRAYCER_EPIC_ID).`,
            ),
          );
          return;
        }
        diag("bearer refreshed after auth rejection — re-subscribing");
        logger.info("Monitor bearer refreshed after auth rejection", {
          environment: config.environment,
          authRefreshCount,
          agentId: target.agentId,
          epicId: target.epicId,
        });
        subscribe();
        return;
      }
      if (outcome === "network-error") {
        diag(`auth refresh unavailable — retrying in ${AUTH_RETRY_DELAY_MS}ms`);
        logger.warn("Monitor auth refresh unavailable; retry scheduled", {
          environment: config.environment,
          retryDelayMs: AUTH_RETRY_DELAY_MS,
          agentId: target.agentId,
          epicId: target.epicId,
        });
        retryTimer = setTimeout(subscribe, AUTH_RETRY_DELAY_MS);
        return;
      }
      fail(
        hostDoorRefusalCliError(
          details,
          signInRejected(),
          presented,
          hostClosed,
        ) ?? hostClosed(),
      );
    };

    if (readerClosed.aborted) {
      stopForClosedReader();
      return;
    }
    readerClosed.addEventListener("abort", stopForClosedReader, {
      once: true,
    });
    subscribe();
  });
}

/**
 * Coalesces durable inbox acknowledgements into bounded unary RPCs. A replay
 * may deliver many frames concurrently; opening one authenticated RPC per
 * printed message otherwise creates a connection storm and turns a transient
 * hiccup into another replay. Failed batches remain pending and retry locally;
 * the inbox's at-least-once contract also redelivers them after reconnect.
 */
class InboxAcknowledgementQueue {
  private static readonly MAX_EVENT_IDS_PER_ACK = 500;
  private static readonly INITIAL_RETRY_DELAY_MS = 1_000;
  private static readonly MAX_RETRY_DELAY_MS = 60_000;
  private readonly pendingEventIds = new Set<string>();
  private flushing = false;
  private flushScheduled = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs = InboxAcknowledgementQueue.INITIAL_RETRY_DELAY_MS;
  private disposed = false;

  constructor(
    private readonly target: InboxTarget,
    private readonly logger: ILogger,
  ) {}

  enqueue(eventId: string): void {
    if (this.disposed) return;
    this.pendingEventIds.add(eventId);
    this.scheduleFlush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pendingEventIds.clear();
  }

  private scheduleFlush(): void {
    if (
      this.flushScheduled ||
      this.flushing ||
      this.pendingEventIds.size === 0 ||
      this.retryTimer !== null ||
      this.disposed
    ) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    try {
      while (this.pendingEventIds.size > 0 && !this.disposed) {
        const eventIds = Array.from(this.pendingEventIds).slice(
          0,
          InboxAcknowledgementQueue.MAX_EVENT_IDS_PER_ACK,
        );
        try {
          await callAgentHostRpc("agent.inbox.ack", {
            epicId: this.target.epicId,
            agentId: this.target.agentId,
            eventIds,
          });
          this.retryDelayMs = InboxAcknowledgementQueue.INITIAL_RETRY_DELAY_MS;
          for (const eventId of eventIds) this.pendingEventIds.delete(eventId);
        } catch (error) {
          this.logger.warn("Monitor failed to acknowledge inbox messages", {
            environment: config.environment,
            agentId: this.target.agentId,
            epicId: this.target.epicId,
            eventIds: eventIds.length,
            error: error instanceof Error ? error.message : String(error),
          });
          this.scheduleRetry();
          return;
        }
      }
    } finally {
      this.flushing = false;
      this.scheduleFlush();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.disposed) return;
    const delayMs = this.retryDelayMs;
    this.retryDelayMs = Math.min(
      delayMs * 2,
      InboxAcknowledgementQueue.MAX_RETRY_DELAY_MS,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scheduleFlush();
    }, delayMs);
  }
}

/**
 * A server frame normalized to the shape `handleServerFrame` acts on,
 * independent of which minor it was parsed against. `eventId` is `null` for
 * a "message" parsed against the `@1.0`/`@1.1` trees - those have no
 * `eventId` field at all, so there is nothing this monitor could ack; the
 * host applies its own compatibility ack for a connection at that minor
 * (see `agentInboxSubscribeServerFrameSchemaV12`'s doc comment).
 */
type NormalizedServerFrame =
  | {
      readonly kind: "message";
      readonly item: AgentInboxMessage;
      readonly eventId: string | null;
    }
  | { readonly kind: "notice"; readonly notice: AgentInboxNotice }
  | { readonly kind: "role-awareness"; readonly event: RoleAwarenessEvent }
  | { readonly kind: "pong" };

function noticeWithoutStopProvenance(
  notice: Omit<AgentInboxNotice, "stopInitiator">,
): AgentInboxNotice {
  return { ...notice, stopInitiator: null };
}

/**
 * Parses against the schema tree matching the NEGOTIATED minor, not always
 * the latest one this build knows. A new monitor talking to an old host
 * negotiates `@1.0`/`@1.1`; parsing its frames against the latest `@1.2`
 * schema would fail outright (`eventId` is required there) and silently
 * drop every message - the exact bug this guards against.
 */
function parseServerFrame(
  envelope: StreamFrameEnvelope,
  negotiated: SchemaVersion | null,
): NormalizedServerFrame | null {
  if (negotiated !== null && negotiated.major === 1 && negotiated.minor === 0) {
    const parsed = agentInboxSubscribeServerFrameSchemaV10.safeParse(envelope);
    if (!parsed.success) return null;
    if (parsed.data.kind === "message") {
      return { kind: "message", item: parsed.data.item, eventId: null };
    }
    if (parsed.data.kind === "notice") {
      return {
        kind: "notice",
        notice: noticeWithoutStopProvenance(parsed.data.notice),
      };
    }
    return { kind: "pong" };
  }
  if (negotiated !== null && negotiated.major === 1 && negotiated.minor === 1) {
    const parsed = agentInboxSubscribeServerFrameSchemaV11.safeParse(envelope);
    if (!parsed.success) return null;
    if (parsed.data.kind === "message") {
      return { kind: "message", item: parsed.data.item, eventId: null };
    }
    if (parsed.data.kind === "notice") {
      return {
        kind: "notice",
        notice: noticeWithoutStopProvenance(parsed.data.notice),
      };
    }
    if (parsed.data.kind === "role-awareness") {
      return { kind: "role-awareness", event: parsed.data.event };
    }
    return { kind: "pong" };
  }
  if (negotiated !== null && negotiated.major === 1 && negotiated.minor === 2) {
    const parsed = agentInboxSubscribeServerFrameSchemaV12.safeParse(envelope);
    if (!parsed.success) return null;
    if (parsed.data.kind === "message") {
      return {
        kind: "message",
        item: parsed.data.item,
        eventId: parsed.data.item.eventId,
      };
    }
    if (parsed.data.kind === "notice") {
      return {
        kind: "notice",
        notice: noticeWithoutStopProvenance(parsed.data.notice),
      };
    }
    if (parsed.data.kind === "role-awareness") {
      return { kind: "role-awareness", event: parsed.data.event };
    }
    return { kind: "pong" };
  }
  const parsed = agentInboxSubscribeServerFrameSchema.safeParse(envelope);
  if (!parsed.success) return null;
  if (parsed.data.kind === "message") {
    return {
      kind: "message",
      item: parsed.data.item,
      eventId: parsed.data.item.eventId,
    };
  }
  if (parsed.data.kind === "notice") {
    return { kind: "notice", notice: parsed.data.notice };
  }
  if (parsed.data.kind === "role-awareness") {
    return { kind: "role-awareness", event: parsed.data.event };
  }
  return { kind: "pong" };
}

async function handleServerFrame(
  envelope: StreamFrameEnvelope,
  client: WsStreamClient<HostStreamRpcRegistry>,
  target: InboxTarget,
  logger: ILogger,
  acknowledgements: InboxAcknowledgementQueue,
): Promise<void> {
  const negotiated = client.getMethodSchemaVersion(SUBSCRIBE_METHOD);
  const frame = parseServerFrame(envelope, negotiated);
  if (frame === null) {
    diag(`dropping unrecognized frame kind=${String(envelope.kind)}`);
    logger.warn("Monitor dropped unrecognized inbox frame", {
      environment: config.environment,
      frameKind: String(envelope.kind),
      negotiatedMinor: negotiated?.minor ?? null,
      agentId: target.agentId,
      epicId: target.epicId,
    });
    return;
  }
  if (frame.kind === "message") {
    logger.debug("Monitor received inbox message frame", {
      environment: config.environment,
      agentId: target.agentId,
      epicId: target.epicId,
      fromAgentId: frame.item.fromAgentId,
      hasReply: frame.item.reply.expectsReply,
    });
    const printed = printInboxMessage(frame.item);
    if (frame.eventId === null) {
      // Negotiated below @1.2 - no eventId to ack; the host retires this
      // row itself (server-side compatibility ack). Still await the print
      // so this frame's output has landed before the next one is handled.
      await printed.confirmation;
      return;
    }
    const eventId = frame.eventId;
    // The durable row must only be acknowledged once THIS write was
    // CONFIRMED to reach the OS - not merely handed to `process.stdout`
    // (asynchronous whenever stdout is a pipe - see `std-write.ts`), and not
    // merely "flushStdio resolved": that helper is deliberately
    // non-rejecting and can resolve after its own bounded timeout with the
    // write still incomplete or failed, which previously let an ack fire for
    // text that was never actually written. `writeStdoutForAck` reports
    // this exact write's own outcome instead.
    const delivered = await printed.confirmation;
    if (!delivered) {
      void printed.eventualOutcome.then((eventuallyDelivered) => {
        if (eventuallyDelivered) acknowledgements.enqueue(eventId);
      });
      logger.warn(
        "Monitor: stdout write for inbox message did not confirm before the timeout; waiting for its eventual outcome",
        {
          environment: config.environment,
          agentId: target.agentId,
          epicId: target.epicId,
          eventId,
        },
      );
      return;
    }
    acknowledgements.enqueue(eventId);
    return;
  }
  if (frame.kind === "notice") {
    logger.debug("Monitor received inbox notice frame", {
      environment: config.environment,
      agentId: target.agentId,
      epicId: target.epicId,
      receiverAgentId: frame.notice.receiverAgentId,
      reason: frame.notice.reason,
      droppedReceiverCount: frame.notice.droppedReceivers?.length ?? 0,
    });
    printInboxNotice(frame.notice);
    return;
  }
  if (frame.kind === "role-awareness") {
    logger.debug("Monitor received role awareness frame", {
      environment: config.environment,
      agentId: target.agentId,
      epicId: target.epicId,
      eventKind: frame.event.kind,
      claimAgentId: frame.event.claim.agentId,
    });
    printRoleAwareness(frame.event);
  }
}

/**
 * The host the pid file names, `null` while it names none usable; throws the
 * older-host error for a host below the minimum version.
 */
async function tryResolveStreamEndpoint(
  logger: ILogger,
  logState: EndpointResolutionLogState,
): Promise<HostTransportEndpoint | null> {
  const metadata = await readHostPidMetadata(config.environment);
  if (metadata === null) {
    logEndpointResolution(logState, "missing", () => {
      logger.debug("Monitor endpoint metadata missing", {
        environment: config.environment,
      });
    });
    return null;
  }
  if (!isValidLocalHostWebsocketUrl(metadata.websocketUrl)) {
    logEndpointResolution(logState, `invalid:${metadata.hostId}`, () => {
      logger.warn(
        "Monitor endpoint metadata advertised invalid websocket URL",
        {
          environment: config.environment,
          hostId: metadata.hostId,
        },
      );
    });
    return null;
  }
  // Before any dial, as the app does: a host older than the paired floor
  // cannot read this CLI's credential, and its refusal would read as one.
  if (hostVersionNeedsUpdate(metadata.version, MINIMUM_HOST_VERSION)) {
    logEndpointResolution(logState, `older:${metadata.hostId}`, () => {
      logger.warn("Monitor endpoint is a host below the floor", {
        environment: config.environment,
        hostId: metadata.hostId,
        hostVersion: metadata.version,
        minimumHostVersion: MINIMUM_HOST_VERSION,
      });
    });
    throw olderHostCliError();
  }
  // `WsStreamClient` maps the `/rpc` URL to `/stream` itself.
  logState.value = `ready:${metadata.hostId}:${metadata.websocketUrl}`;
  return { hostId: metadata.hostId, websocketUrl: metadata.websocketUrl };
}

function sameEndpoint(
  current: HostTransportEndpoint | null,
  next: HostTransportEndpoint,
): boolean {
  return (
    current !== null &&
    current.hostId === next.hostId &&
    current.websocketUrl === next.websocketUrl
  );
}

function logEndpointResolution(
  state: EndpointResolutionLogState,
  key: string,
  write: () => void,
): void {
  if (state.value === key) return;
  state.value = key;
  write();
}

/**
 * Returns both the bounded confirmation used for timely diagnostics and the
 * write's eventual outcome. A callback that succeeds after the bound still
 * permits the caller to acknowledge the durable row; an error never does.
 */
function printInboxMessage(item: AgentInboxMessage): {
  readonly confirmation: Promise<boolean>;
  readonly eventualOutcome: Promise<boolean>;
} {
  const output = formatAgentMessage({
    receiverChannel: "cli",
    sender: {
      agentId: item.fromAgentId,
      title: item.senderTitle,
      harnessId: item.senderHarnessId,
    },
    reply: item.reply,
    body: item.prompt,
  });
  return writeStdoutForAck(`${output}\n`);
}

/**
 * Reason-specific lead line for an inactivity notice. The wording tells
 * the sender how much to trust the signal - `quiet` is advisory (the
 * receiver may still be working), the others are definitive for this run.
 */
function inactivityHeadline(
  notice: AgentInboxNotice,
  receiverLabel: string,
): string {
  const detail = notice.detail?.trim();
  switch (notice.reason) {
    case "exited":
      return `${receiverLabel} exited without replying`;
    case "quiet":
      return `${receiverLabel} has been quiet for a while without replying — it may still be working`;
    case "turn-ended":
      return `${receiverLabel} finished its turn without replying`;
    case "user-stopped":
      return `${receiverLabel} was stopped before it could reply`;
    case "errored":
      return detail !== undefined && detail.length > 0
        ? `${receiverLabel} ran into an error before replying: ${detail}`
        : `${receiverLabel} ran into an error before replying`;
    case "awaiting-input":
      return detail !== undefined && detail.length > 0
        ? `${receiverLabel} is blocked waiting on a human — it ${detail} — and will not reply until someone responds`
        : `${receiverLabel} is blocked waiting on a human and will not reply until someone responds`;
    case "receiver-cancelled":
      return `${receiverLabel} was stopped by ${stopInitiatorLabel(notice)} — your message could not be delivered and this request is now closed`;
  }
}

function stopInitiatorLabel(notice: AgentInboxNotice): string {
  const initiator = notice.stopInitiator;
  if (initiator === null || initiator.type === "user") return "the user";
  const title = initiator.agentTitle?.trim();
  return title !== undefined && title.length > 0
    ? `agent ${title} (${initiator.agentId})`
    : `agent ${initiator.agentId}`;
}

function printInboxNotice(notice: AgentInboxNotice): void {
  const receiverLabel =
    notice.receiverTitle !== null
      ? `${notice.receiverTitle} (agent ${notice.receiverAgentId})`
      : `agent ${notice.receiverAgentId}`;
  const harnessSuffix =
    notice.receiverHarnessId !== null ? ` [${notice.receiverHarnessId}]` : "";
  if (notice.reason === "receiver-cancelled") {
    printReceiverCancelledNotice(notice, receiverLabel, harnessSuffix);
    return;
  }
  if (notice.reason === "awaiting-input") {
    const lines = [
      "",
      `[traycer inbox] inactivity notice — ${inactivityHeadline(notice, receiverLabel)}${harnessSuffix} (responseId ${notice.responseId})`,
      `[traycer inbox] Sending a follow-up now would queue behind the user's input and re-trigger this notice. Wait for the receiver's reply or the user's answer to wake you. If you are working for another agent, tell it you're blocked.`,
      `[traycer inbox] Omit --response-id for your own follow-ups; the displayed responseId is not an incoming reply ID from this receiver.`,
      `[traycer inbox] you may read its transcript: traycer agent transcript --agent-id ${notice.receiverAgentId}`,
      "",
    ];
    writeStdout(`${lines.join("\n")}\n`);
    return;
  }
  const lines = [
    "",
    `[traycer inbox] inactivity notice — ${inactivityHeadline(notice, receiverLabel)}${harnessSuffix} (responseId ${notice.responseId})`,
    `[traycer inbox] check what it is doing: traycer agent transcript --agent-id ${notice.receiverAgentId}`,
    `[traycer inbox] the request is still open; a follow-up can be sent with: traycer agent send --to ${notice.receiverAgentId} --expect-reply --message "<follow-up>"`,
    `[traycer inbox] omit --response-id for this follow-up. Repeated --expect-reply sends from you to the same recipient reuse its still-open thread; --response-id is for answering a request you received from that recipient.`,
    `[traycer inbox] based on your judgment decide how to proceed — read transcript, follow up, launch a new agent, etc.`,
    "",
  ];
  writeStdout(`${lines.join("\n")}\n`);
}

/**
 * Role awareness is ambient coordination state, not a message — a single
 * compact line informs the transcript without crowding it. Role and scope are
 * normalized non-empty text by schema, so both always render.
 */
function printRoleAwareness(event: RoleAwarenessEvent): void {
  const verb =
    event.kind === "role-claimed" ? "claimed role" : "relinquished role";
  writeStdout(
    `[traycer roles] agent ${event.claim.agentId} ${verb} "${event.claim.role}" (scope: ${event.claim.scope})\n`,
  );
}

/**
 * Renders a `receiver-cancelled` notice. Lists every dropped thread when the
 * sender lost more than one in the same stop; otherwise uses the
 * single-thread headline. The guidance is identical either way: do not
 * retry, wait on the user or escalate to the agent you work for.
 */
function printReceiverCancelledNotice(
  notice: AgentInboxNotice,
  receiverLabel: string,
  harnessSuffix: string,
): void {
  const dropped = notice.droppedReceivers ?? [
    { receiverAgentId: notice.receiverAgentId, responseId: notice.responseId },
  ];
  const plural = dropped.length > 1;
  const headlineLines = plural
    ? [
        `[traycer inbox] inactivity notice — ${dropped.length} messages you sent could not be delivered; ${stopInitiatorLabel(notice)} stopped the agents you were waiting on:`,
        ...dropped.map(
          (thread) =>
            `[traycer inbox]   · agent ${thread.receiverAgentId} (responseId ${thread.responseId})`,
        ),
      ]
    : [
        `[traycer inbox] inactivity notice — ${inactivityHeadline(notice, receiverLabel)}${harnessSuffix} (responseId ${notice.responseId})`,
      ];
  const lines = [
    "",
    ...headlineLines,
    `[traycer inbox] this is informational only — do NOT re-send ${plural ? "them" : "the message"} or launch ${plural ? "new agents" : "a new agent"} to take their place`,
    `[traycer inbox] if you are working on the user's behalf, wait for their next instruction; if you are working on behalf of another agent, let that agent know`,
    "",
  ];
  writeStdout(`${lines.join("\n")}\n`);
}

function diag(message: string): void {
  writeStderr(`[traycer monitor] ${message}\n`);
}
