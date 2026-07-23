import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/registry";
import { MutableBearerLease } from "../../../shared/auth/bearer-source";
import { createAuthAwareMessenger } from "../../../shared/host-transport/auth-aware-messenger";
import {
  createRetryingMessenger,
  DEFAULT_TRANSPORT_RETRY_POLICY,
  NO_RETRY_TRANSPORT_POLICY,
  type TransportRetryPolicy,
} from "../../../shared/host-transport/retrying-messenger";
import { DEFAULT_DIAL_TIMEOUT_MS } from "../../../shared/host-transport/transport-config";
import {
  HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
  HostRequestAuthority,
  HostTransportEndpoint,
} from "../../../shared/host-transport/host-messenger";
import { WsRpcClient } from "../../../shared/host-transport/ws-rpc-client";
import { createWhatwgWebSocketFactory } from "../../../shared/host-transport/whatwg-ws-factory";
import { config } from "../config";
import { createCliLogger, errorFromUnknown } from "../logger";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
} from "../host/pid-metadata";
import { isProcessAlive } from "../store/cli-lock";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import { resolveHostAuth, type HostAuth } from "./host-auth";
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";
import {
  compatRecoveryHint,
  effectiveUpgradeGuidance,
} from "../host/compat-recovery";

const FRAME_TIMEOUT_MS = 15_000;

/**
 * One-shot unary RPC to the host's `/rpc` WebSocket endpoint.
 *
 * The protocol (open → openAck → request → response, manifest negotiation,
 * frame parsing, timeouts) is the shared `WsRpcClient` that the Desktop renderer
 * also uses - the CLI no longer hand-rolls it. The bearer comes from the stored
 * credentials (`resolveHostAuth`), seeded by `traycer login`; on a host
 * `UNAUTHORIZED` the shared auth-aware wrapper refreshes the bearer via the
 * store-backed revalidator - the refresh spend runs inside the shared credentials
 * file lock (`store.rotate`, §7) - rotates the lease, and retries once before the
 * error surfaces.
 */
export async function callHostRpc<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const logger = createCliLogger(config.environment);
  logger.debug("Host RPC requested", {
    environment: config.environment,
    method,
    retryPolicy: "default",
  });
  const auth = await resolveHostAuth();
  if (auth === null) {
    logger.warn("Host RPC blocked by missing credentials", {
      environment: config.environment,
      method,
    });
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
      details: null,
      exitCode: 1,
    });
  }

  // Resolve the endpoint once (throws when the host isn't running). Endpoint
  // discovery belongs to the endpoint provider, not the auth revalidator; a
  // unary call is short-lived, so a same-call host-restart simply fails and
  // the caller re-runs. (The long-running monitor owns its own endpoint poller.)
  const endpoint = await resolveEndpoint();
  return requestAtEndpoint(
    method,
    params,
    endpoint,
    auth,
    DEFAULT_TRANSPORT_RETRY_POLICY,
  );
}

/**
 * Like {@link callHostRpc} but fails fast: a transient transport failure
 * surfaces on the first attempt with no retry. For best-effort, latency-bound
 * callers (IDE hook commands such as title/activity reporting) where blocking
 * the agent for a multi-attempt retry of a non-responsive host is worse than a
 * quick miss.
 */
export async function callHostRpcFastFail<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const logger = createCliLogger(config.environment);
  logger.debug("Host RPC requested", {
    environment: config.environment,
    method,
    retryPolicy: "fast-fail",
  });
  const auth = await resolveHostAuth();
  if (auth === null) {
    logger.warn("Host RPC fast-fail call blocked by missing credentials", {
      environment: config.environment,
      method,
    });
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
      details: null,
      exitCode: 1,
    });
  }

  const endpoint = await resolveEndpoint();
  return requestAtEndpoint(
    method,
    params,
    endpoint,
    auth,
    NO_RETRY_TRANSPORT_POLICY,
  );
}

/**
 * Like {@link callHostRpc} but targets an explicitly-resolved endpoint instead
 * of re-reading pid metadata. Doctor uses this so its TCP probe and its RPC
 * probe provably hit the *same* host URL - a fresh `resolveEndpoint()` could
 * otherwise race a host restart between the two probes and report on a URL it
 * never actually probed.
 */
export async function callHostRpcAtEndpoint<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  endpoint: HostTransportEndpoint,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const logger = createCliLogger(config.environment);
  logger.debug("Host RPC requested at explicit endpoint", {
    environment: config.environment,
    method,
    retryPolicy: "default",
    hostId: endpoint.hostId,
  });
  const auth = await resolveHostAuth();
  if (auth === null) {
    logger.warn(
      "Host RPC explicit-endpoint call blocked by missing credentials",
      {
        environment: config.environment,
        method,
        hostId: endpoint.hostId,
      },
    );
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
      details: null,
      exitCode: 1,
    });
  }
  return requestAtEndpoint(
    method,
    params,
    endpoint,
    auth,
    DEFAULT_TRANSPORT_RETRY_POLICY,
  );
}

async function requestAtEndpoint<Method extends keyof HostRpcRegistry & string>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  endpoint: HostTransportEndpoint,
  auth: HostAuth,
  retryPolicy: TransportRetryPolicy,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const logger = createCliLogger(config.environment);
  const lease = new MutableBearerLease(auth.token, auth.userId);
  // On a host UNAUTHORIZED the auth-aware messenger drives the refresh through
  // the locked `rotate` (§7): a short-lived store for this one call, disposed
  // once the request settles so a `commit-failed` continuation timer never
  // outlives the command.
  const store = createCliCredentialsStore();
  const revalidator = createStoreBackedRevalidator({ store, lease });

  const messenger = createRetryingMessenger<HostRpcRegistry>(
    createAuthAwareMessenger<HostRpcRegistry>(
      new WsRpcClient<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => randomUUID(),
        webSocketFactory: createWhatwgWebSocketFactory(),
        dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
        frameTimeoutMs: FRAME_TIMEOUT_MS,
      }),
      revalidator,
    ),
    retryPolicy,
  );

  const callLifetime = new AbortController();
  const authority: HostRequestAuthority = {
    endpoint,
    bearer: lease,
    abortSignal: callLifetime.signal,
  };
  try {
    const response = await messenger.request(method, params, authority);
    logger.debug("Host RPC completed", {
      environment: config.environment,
      method,
      retryPolicy: retryPolicyLabel(retryPolicy),
      hostId: endpoint.hostId,
    });
    return response;
  } catch (err) {
    const error = errorFromUnknown(err);
    logger.debug("Host RPC failed; propagating to command boundary", {
      environment: config.environment,
      method,
      retryPolicy: retryPolicyLabel(retryPolicy),
      hostId: endpoint.hostId,
      errorName: error.name,
    });
    throw err;
  } finally {
    callLifetime.abort("cli-call-settled");
    store.dispose();
  }
}

/**
 * Reads the `/rpc` WebSocket endpoint from the host pid metadata file. The
 * pid file advertises the unary endpoint URL verbatim. Exported so streaming
 * commands (`worktree delete`) that dial the shared `WsStreamClient` resolve
 * the endpoint through the same liveness-checked path as the unary calls -
 * an absent/dead pid surfaces as a clean `HOST_NOT_RUNNING` CliError, and the
 * stream client maps the `/rpc` URL to `/stream` itself.
 */
export async function resolveEndpoint(): Promise<HostTransportEndpoint> {
  const logger = createCliLogger(config.environment);
  const metadata = await readHostPidMetadata(config.environment);
  // Liveness check, not just presence: a stopped/crashed host can leave a
  // stale pid.json behind (the same reason `host status` checks
  // `isProcessAlive`). Catching a dead pid here is what lets `mapHostRpcError`
  // treat a transport `RPC_ERROR` as a genuine host error rather than
  // overloading it to mean "not running".
  if (metadata === null) {
    logger.warn("Host RPC endpoint resolution failed; metadata missing", {
      environment: config.environment,
    });
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
      message:
        "traycer: host not running - pid metadata is absent, malformed, advertises an invalid local WebSocket endpoint, or names a process that is no longer alive.",
      details: null,
      exitCode: 1,
    });
  }
  if (!isProcessAlive(metadata.pid)) {
    logger.warn("Host RPC endpoint resolution failed; process is not alive", {
      environment: config.environment,
      hostId: metadata.hostId,
      pid: metadata.pid,
    });
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
      message:
        "traycer: host not running - pid metadata is absent, malformed, advertises an invalid local WebSocket endpoint, or names a process that is no longer alive.",
      details: null,
      exitCode: 1,
    });
  }
  if (!isValidLocalHostWebsocketUrl(metadata.websocketUrl)) {
    logger.warn("Host RPC endpoint resolution failed; websocket URL invalid", {
      environment: config.environment,
      hostId: metadata.hostId,
    });
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
      message:
        "traycer: host not running - pid metadata is absent, malformed, advertises an invalid local WebSocket endpoint, or names a process that is no longer alive.",
      details: null,
      exitCode: 1,
    });
  }
  logger.debug("Host RPC endpoint resolved", {
    environment: config.environment,
    hostId: metadata.hostId,
    pid: metadata.pid,
  });
  return { hostId: metadata.hostId, websocketUrl: metadata.websocketUrl };
}

/**
 * Wraps a `callHostRpc` promise so a `HostRpcError` (the only error the
 * shared transport throws on a wire/host failure) becomes a `CliError` with
 * a stable code and no leaked stack. This is the single boundary the agent
 * commands route their RPC calls through, so every caller maps failures the
 * same way and the runner never blankets them as `E_UNEXPECTED`.
 *
 * Codes already raised as `CliError` inside `callHostRpc` itself (not signed
 * in, host-not-running) pass through untouched.
 */
export async function toAgentCliError<T>(call: Promise<T>): Promise<T> {
  return call.catch((err: unknown) => {
    throw hostRpcToCliError(err);
  });
}

// Prefix of the message the shared transport throws when the client is the
// newer side and its request cannot be projected onto the host's older minor
// request schema (`prepareRequestPayload` in `ws-rpc-client.ts`). This is a
// client-side failure raised during request preparation, before anything is
// sent to the host.
const REQUEST_PROJECTION_FAILURE_PREFIX =
  "Failed to project request params onto";

/**
 * True when `err` is the transport's client-side request-projection failure -
 * i.e. this CLI negotiated a newer canonical version for the method than the
 * host speaks, and the request carries a value the host's older minor request
 * schema cannot represent (e.g. a newer enum value that isn't strippable like an
 * additive field). The transport raises this as a `RPC_ERROR` locally during
 * request preparation, so it never reached the host.
 *
 * Best-effort hook commands use this to degrade a version-skew miss to a quiet
 * no-op instead of surfacing it: the call is meaningless against a host too old
 * to understand it. Matched narrowly (the specific code + preparation message)
 * so genuine host `RPC_ERROR`s and auth failures still surface.
 */
export function isRequestVersionProjectionError(err: unknown): boolean {
  return (
    err instanceof HostRpcError &&
    err.code === "RPC_ERROR" &&
    err.message.startsWith(REQUEST_PROJECTION_FAILURE_PREFIX)
  );
}

/**
 * Validate user-supplied request input against its protocol schema, turning a
 * schema failure into a clean `E_INVALID_ARGUMENT` instead of an uncaught
 * `ZodError` (which the runner would blanket as `E_UNEXPECTED` with the raw
 * stack trace leaked into the NDJSON envelope). Used by the agent commands for
 * the request they build from flags (e.g. `--harness`), so a bad value reports
 * the allowed options rather than dumping a Zod parse tree.
 */
export function parseUserInput<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  createCliLogger(config.environment).warn("CLI user input validation failed", {
    environment: config.environment,
    issueCount: parsed.error.issues.length,
  });
  const detail = parsed.error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: `traycer: ${detail}`,
    details: null,
    exitCode: 1,
  });
}

/**
 * Validate a host RESPONSE against its protocol schema. A failure here means
 * the host replied with a shape this CLI can't read - almost always a
 * host/CLI version skew - so it surfaces as a clean `E_HOST_INCOMPATIBLE`
 * with `details: null` instead of letting the raw `ZodError` (with its stack)
 * leak into the NDJSON envelope as the runner's blanket `E_UNEXPECTED`. Mirrors
 * `parseUserInput` on the request side.
 */
export function parseHostResponse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  createCliLogger(config.environment).warn(
    "Host RPC response validation failed",
    {
      environment: config.environment,
      issueCount: parsed.error.issues.length,
    },
  );
  throw cliError({
    code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
    message:
      "traycer: the host returned a response this CLI could not parse (possible host/CLI version mismatch) - try 'traycer host restart'.",
    details: null,
    exitCode: 1,
  });
}

function hostRpcToCliError(err: unknown): unknown {
  if (!(err instanceof HostRpcError)) return err;
  createCliLogger(config.environment).warn(
    "Mapping host RPC wire error to CLI error",
    {
      environment: config.environment,
      hostRpcCode: err.code,
    },
  );
  return mapHostRpcError(err);
}

/**
 * Maps a host wire error code to a stable CLI error code:
 *   - authorization failure → `FORBIDDEN`: the host signals "no access" with a
 *     `FORBIDDEN` wire code - a cloud 403 is mapped to `FORBIDDEN` in the host's
 *     `cloudErrorFromResponse`, and a viewer/no-role caller hits
 *     `EpicAccessForbiddenError`. `isAccessDenied` is a best-effort fallback for
 *     an access denial that still arrives bucketed as `RPC_ERROR`. We do NOT pass
 *     the host's raw text through here: it can embed an internal user UUID and
 *     the internal term "task" (epic), neither actionable for a CLI user.
 *   - `UNAUTHORIZED` → `AUTH_REJECTED`: bearer rejected even after the
 *     auth-aware wrapper's refresh-and-retry.
 *   - `E_HOST_UNSUPPORTED` → `HOST_UNSUPPORTED`: per-feature unsupported on
 *     this host, actionable by updating the host.
 *   - `INCOMPATIBLE` / `DOWNGRADE_UNSUPPORTED` → `HOST_INCOMPATIBLE`: host/CLI
 *     protocol skew, actionable via `host restart` / updating the CLI.
 *   - everything else, including `RPC_ERROR` → `UNEXPECTED`: `RPC_ERROR` is the
 *     host's catch-all for any resolver error (e.g. "agent not found"), so it
 *     must NOT be reported as "host not running" - the host answered. A
 *     genuinely unreachable/dead host is already caught upstream in
 *     `resolveEndpoint` (absent/dead pid → `HOST_NOT_RUNNING`). `details: null`
 *     keeps the raw stack out of the NDJSON envelope; the host's own message
 *     is preserved so the user still sees what went wrong.
 */
function mapHostRpcError(err: HostRpcError): CliError {
  if (err.code === "FORBIDDEN" || isAccessDenied(err)) {
    return cliError({
      code: CLI_ERROR_CODES.FORBIDDEN,
      message:
        "traycer: access denied for this epic - check --epic-id and that you're signed in to the account that owns it.",
      details: null,
      exitCode: 1,
    });
  }
  if (err.code === "E_HOST_UNSUPPORTED") {
    return cliError({
      code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
      message: `traycer: ${err.message}`,
      details: {
        hostShouldUpgrade: true,
        method: err.method,
      },
      exitCode: 1,
    });
  }
  if (err.code === "INCOMPATIBLE" || err.code === "DOWNGRADE_UNSUPPORTED") {
    // Append the recovery hint derived from the rejecting frame's
    // `upgradeGuidance` so the user is told which side is stale and how to
    // recover, instead of the bare protocol-skew message. The vector-aware
    // form (with the exact per-install-vector command) lives in `traycer
    // host doctor`; this boundary has no install vector in scope.
    //
    // Route through `effectiveUpgradeGuidance` so `DOWNGRADE_UNSUPPORTED`
    // (client-newer, `fatalDetails: null`) maps to "update the host" - the
    // SAME verdict `traycer host doctor` derives - instead of falling through
    // null guidance to an ineffective "restart" hint.
    return cliError({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message: `traycer: ${err.message} - ${compatRecoveryHint(effectiveUpgradeGuidance(err.code, err.fatalDetails?.upgradeGuidance ?? null))}.`,
      details: null,
      exitCode: 1,
    });
  }
  const code =
    err.code === "UNAUTHORIZED"
      ? CLI_ERROR_CODES.AUTH_REJECTED
      : CLI_ERROR_CODES.UNEXPECTED;
  return cliError({
    code,
    message: err.message,
    details: null,
    exitCode: 1,
  });
}

// Best-effort fallback: an `RPC_ERROR` whose message still indicates an access
// denial ("...does not have access to..." / "...does not have ... permission...").
// The primary path is the host's `FORBIDDEN` wire code (cloud 403 and
// viewer/no-role both map there); this only catches an access denial that some
// other code path bucketed as a generic `RPC_ERROR`, routing it to `FORBIDDEN`
// rather than `UNEXPECTED`.
function isAccessDenied(err: HostRpcError): boolean {
  return (
    err.code === "RPC_ERROR" &&
    /does not have (?:access|[\w ]*permission)/i.test(err.message)
  );
}

function retryPolicyLabel(
  policy: TransportRetryPolicy,
): "default" | "fast-fail" {
  return policy === NO_RETRY_TRANSPORT_POLICY ? "fast-fail" : "default";
}
