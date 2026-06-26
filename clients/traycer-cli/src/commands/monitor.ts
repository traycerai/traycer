import { formatAgentMessage } from "@traycer/protocol/agent/a2a-message-format";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  agentInboxSubscribeServerFrameSchema,
  type AgentInboxMessage,
  type AgentInboxNotice,
} from "@traycer/protocol/host/agent/inbox";
import { CredentialLeaseReleasedError } from "@traycer/protocol/auth/request-context";
import { MutableBearerLease } from "../../../shared/auth/bearer-source";
import {
  createBearerRevalidator,
  type RevalidateOutcome,
} from "../../../shared/auth/bearer-revalidator";
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
import { cliBearerStore, resolveHostAuth } from "../internal/host-auth";

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

  logger.info("Monitor resolving target", {
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
    throw new Error(
      "traycer monitor: epic id required — pass --epic-id or set TRAYCER_EPIC_ID.",
    );
  }
  const auth = await resolveHostAuth();
  if (auth === null) {
    logger.warn("Monitor cannot start without credentials", {
      environment: config.environment,
      agentId,
      epicId,
    });
    throw new Error(
      "traycer monitor: not signed in — run `traycer login` to authenticate.",
    );
  }
  logger.info("Monitor credentials resolved", {
    environment: config.environment,
    agentId,
    epicId,
  });

  const lease = new MutableBearerLease(auth.token, auth.userId);
  const revalidator = createBearerRevalidator({
    authnBaseUrl: auth.authnBaseUrl,
    lease,
    store: cliBearerStore,
    clearOnReject: false,
  });

  // The shared client reads `endpoint()` on every (re)connect, so a poller that
  // refreshes the cached endpoint is the CLI's equivalent of the renderer's
  // host directory — reconnects survive a host restart on a new port. Polls
  // are serialized (no out-of-order clobber) and a good endpoint is never
  // overwritten with `null` (a momentarily-absent pid file keeps the last-known
  // URL; dials simply retry until a fresh one appears).
  const endpointResolutionLogState: EndpointResolutionLogState = { value: null };
  let endpoint = await tryResolveStreamEndpoint(
    logger,
    endpointResolutionLogState,
  );
  logger.info("Monitor initial endpoint resolution completed", {
    environment: config.environment,
    hasEndpoint: endpoint !== null,
    agentId,
    epicId,
  });
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
      .finally(() => {
        pollInFlight = false;
      });
  }, ENDPOINT_POLL_MS);

  const client = new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    endpoint: () => endpoint,
    bearer: () => lease,
    // `auth: null` opts out of the WsStreamClient's built-in stream-auth
    // recovery: the monitor runs its OWN refresh-on-UNAUTHORIZED loop in
    // `runInboxSubscription` (revalidate, then re-subscribe on `rotated` /
    // back off and re-subscribe on `network-error`), so wiring the client
    // handler too would double up. Non-UNAUTHORIZED fatals stay terminal there.
    auth: null,
    webSocketFactory: createWhatwgStreamWebSocketFactory(),
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: PING_INTERVAL_MS,
    pongTimeoutMs: PONG_TIMEOUT_MS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
  });

  // Proactively refresh the bearer shortly before its ~4h TTL so a long-running
  // monitor never carries a dead token into a reconnect (or hands the host a
  // stale credential it would 401 on). The reactive refresh-on-`UNAUTHORIZED`
  // loop in `runInboxSubscription` stays as the safety net; this just rotates
  // ahead of expiry. The scheduler shares the same single-flight `revalidator`,
  // so a proactive and reactive refresh can't race into a double rotation.
  const refreshScheduler = createProactiveRefreshScheduler<NodeJS.Timeout>({
    getToken: () => readLeaseBearer(lease),
    revalidate: async () => {
      const outcome = await revalidator.revalidateCurrentContext();
      if (outcome === "rotated") {
        // Push the fresh bearer onto the open inbox stream so the host updates
        // its captured credential in place - no reconnect. The reactive
        // UNAUTHORIZED path already re-dials with the fresh token, so it needs
        // no push.
        client.notifyBearerRotated();
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
  refreshScheduler.start();

  diag(`inbox monitor starting — agent=${agentId} epic=${epicId}`);
  logger.info("Monitor subscription loop starting", {
    environment: config.environment,
    agentId,
    epicId,
  });
  try {
    await runInboxSubscription(client, revalidator, { agentId, epicId }, logger);
  } finally {
    refreshScheduler.stop();
    clearInterval(poll);
    logger.info("Monitor subscription loop stopped", {
      environment: config.environment,
      agentId,
      epicId,
    });
  }
}

/**
 * Reads the lease's current bearer, mapping the "no bearer" throw
 * (`CredentialLeaseReleasedError`, raised on an empty token) to `null` so the
 * refresh scheduler treats it as "signed out, nothing to schedule".
 */
function readLeaseBearer(lease: MutableBearerLease): string | null {
  try {
    return lease.getBearerToken();
  } catch (cause) {
    // Only the "no bearer / signed out" signal maps to null. Any other lease
    // failure is a real bug; rethrow it rather than silently disabling the
    // refresh scheduler and masking it as a benign signed-out state.
    if (cause instanceof CredentialLeaseReleasedError) {
      return null;
    }
    throw cause;
  }
}

type InboxTarget = { readonly agentId: string; readonly epicId: string };

type InboxRevalidator = {
  revalidateCurrentContext(): Promise<RevalidateOutcome>;
};

/**
 * Drives the inbox subscription until a terminal failure. Resolves never on a
 * healthy stream (the command runs forever); rejects on a non-recoverable close
 * so `traycer monitor` exits non-zero.
 *
 * Recovery on a host `UNAUTHORIZED` fatal switches on the refresh OUTCOME:
 *   - `rotated`       → re-subscribe immediately (bounded by the spin guard);
 *   - `network-error` → transient; keep the bearer and re-subscribe after a
 *                       delay (don't kill a long-running monitor on a flaky link);
 *   - `rejected`      → terminal (the host re-spawns monitor after re-auth).
 * Any non-`UNAUTHORIZED` fatal (e.g. `INCOMPATIBLE`) is terminal.
 */
function runInboxSubscription(
  client: WsStreamClient<HostStreamRpcRegistry>,
  revalidator: InboxRevalidator,
  target: InboxTarget,
  logger: ILogger,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    let session: IStreamSession | null = null;
    let authRefreshCount = 0;
    let healthTimer: NodeJS.Timeout | null = null;
    let retryTimer: NodeJS.Timeout | null = null;
    let settled = false;

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
      session?.close();
      reject(error);
    };

    // The subscription is demonstrably accepted — reset the auth-spin guard.
    const markHealthy = (): void => {
      authRefreshCount = 0;
    };

    const subscribe = (): void => {
      clearRetryTimer();
      session?.close();
      logger.info("Monitor subscribing to inbox stream", {
        environment: config.environment,
        method: SUBSCRIBE_METHOD,
        agentId: target.agentId,
        epicId: target.epicId,
      });
      const next = client.subscribe(SUBSCRIBE_METHOD, target);
      session = next;
      next.onServerFrame((envelope) => {
        markHealthy();
        handleServerFrame(envelope, target, logger);
      });
      next.onStatusChange((status, reason) => {
        void onStatusChange(status, reason);
      });
    };

    const onStatusChange = async (
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
    ): Promise<void> => {
      if (settled) {
        return;
      }
      diag(`stream ${status}`);
      clearHealthTimer();
      if (status === "open") {
        logger.info("Monitor stream opened", {
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
      if (reason.details.code !== "UNAUTHORIZED") {
        logger.warn("Monitor stream closed with non-auth fatal error", {
          environment: config.environment,
          code: reason.details.code,
          agentId: target.agentId,
          epicId: target.epicId,
        });
        fail(
          new Error(
            `traycer monitor: host closed the stream: ${reason.details.reason}`,
          ),
        );
        return;
      }
      // The revalidator never throws (it maps failures to an outcome), so this
      // await can't reject the swallowed handler promise into a hang.
      const outcome = await revalidator.revalidateCurrentContext();
      if (settled) {
        return;
      }
      logger.info("Monitor auth revalidation completed", {
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
              `traycer monitor: session rejected after ${authRefreshCount} refreshes — the agent/epic may be invalid or inaccessible (check --agent-id/--epic-id).`,
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
      fail(new Error("traycer monitor: session expired — re-authenticate."));
    };

    subscribe();
  });
}

function handleServerFrame(
  envelope: StreamFrameEnvelope,
  target: InboxTarget,
  logger: ILogger,
): void {
  const parsed = agentInboxSubscribeServerFrameSchema.safeParse(envelope);
  if (!parsed.success) {
    diag(`dropping unrecognized frame kind=${String(envelope.kind)}`);
    logger.warn("Monitor dropped unrecognized inbox frame", {
      environment: config.environment,
      frameKind: String(envelope.kind),
      issueCount: parsed.error.issues.length,
      agentId: target.agentId,
      epicId: target.epicId,
    });
    return;
  }
  if (parsed.data.kind === "message") {
    logger.info("Monitor received inbox message frame", {
      environment: config.environment,
      agentId: target.agentId,
      epicId: target.epicId,
      fromAgentId: parsed.data.item.fromAgentId,
      hasReply: parsed.data.item.reply !== null,
    });
    printInboxMessage(parsed.data.item);
    return;
  }
  if (parsed.data.kind === "notice") {
    logger.info("Monitor received inbox notice frame", {
      environment: config.environment,
      agentId: target.agentId,
      epicId: target.epicId,
      receiverAgentId: parsed.data.notice.receiverAgentId,
      reason: parsed.data.notice.reason,
      droppedReceiverCount: parsed.data.notice.droppedReceivers?.length ?? 0,
    });
    printInboxNotice(parsed.data.notice);
  }
}

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
      logger.warn("Monitor endpoint metadata advertised invalid websocket URL", {
        environment: config.environment,
        hostId: metadata.hostId,
      });
    });
    return null;
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

function printInboxMessage(item: AgentInboxMessage): void {
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
  process.stdout.write(`${output}\n`);
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
      return `${receiverLabel} was stopped by the user before it could reply`;
    case "errored":
      return detail !== undefined && detail.length > 0
        ? `${receiverLabel} ran into an error before replying: ${detail}`
        : `${receiverLabel} ran into an error before replying`;
    case "awaiting-input":
      return detail !== undefined && detail.length > 0
        ? `${receiverLabel} is blocked waiting on a human — it ${detail} — and will not reply until someone responds`
        : `${receiverLabel} is blocked waiting on a human and will not reply until someone responds`;
    case "receiver-cancelled":
      return `${receiverLabel} was stopped by the user — your message could not be delivered and this request is now closed`;
  }
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
  const lines = [
    "",
    `[traycer inbox] inactivity notice — ${inactivityHeadline(notice, receiverLabel)}${harnessSuffix} (responseId ${notice.responseId})`,
    `[traycer inbox] check what it is doing: traycer agent transcript --agent-id ${notice.receiverAgentId}`,
    `[traycer inbox] the request is still open; a follow-up on the same thread can be sent with: traycer agent send --to ${notice.receiverAgentId} --response-id ${notice.responseId} --message "<follow-up>"`,
    `[traycer inbox] based on your judgment decide how to proceed — read transcript, follow up, launch a new agent, etc.`,
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
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
        `[traycer inbox] inactivity notice — ${dropped.length} messages you sent could not be delivered; the user stopped the agents you were waiting on:`,
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
  process.stdout.write(`${lines.join("\n")}\n`);
}

function diag(message: string): void {
  process.stderr.write(`[traycer monitor] ${message}\n`);
}
