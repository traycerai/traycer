import {
  encodeManagedCliOpen,
  MANAGED_CLI_REFUSAL,
  MANAGED_CLI_WAITING,
  MANAGED_CLI_RPC_PATH,
  MANAGED_CLI_UNARY_METHODS,
} from "@traycer/protocol/host/managed-cli-auth";
import {
  isManagedCliAuth,
  managedSignInRefusal,
  managedHostStopped,
  managedWaiting,
  managedUnavailable,
  readManagedHostCredential,
} from "./managed-host-auth";
import {
  isRefusalOfAgentSessionCapability,
  markRefusalOfAgentSessionCapability,
  PROCESS_AGENT_ENVIRONMENT,
  readAgentCommandCredential,
  type AgentCommandCredential,
} from "./agent-session-capability";
import { localTeamAdmissionCliError } from "./local-open-auth";
import {
  requireCliHostSession,
  type CliHostRefusal,
  type CliRefusalEnding,
  type CliRefusalEvidence,
  type SignInRejection,
} from "./cli-host-tokens";
import {
  isReleasedSignInRefusal,
  processReleasedHosts,
  type ReleasedSignOn,
  type ReleasedUnaryCause,
} from "@traycer-clients/shared/host-transport/released-sign-on";
import {
  hostDoorRefusalCliError,
  refusalEndingCliError,
  signedOutCliError,
} from "./host-door-words";
import {
  hostRefusalOf,
  type DoorAdmissionRelease,
} from "@traycer-clients/shared/host-transport/host-door-state";
import { TEAM_TRANSFER_REFUSALS } from "@traycer-clients/shared/host-client/team-computer-refusals";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/registry";
import { getLatestContract } from "@traycer/protocol/framework/versioned-rpc";
import type { OpenFrameBearerSource } from "../../../shared/auth/bearer-source";
import type { RefusalAwareAuthRevalidator } from "../../../shared/auth/bearer-revalidator";
import { markRefusalAfterRejectedSignIn } from "./sign-in-rejection";
import {
  createAuthAwareMessenger,
  type AuthRecoveryScope,
} from "../../../shared/host-transport/auth-aware-messenger";
import {
  createRetryingMessenger,
  DEFAULT_TRANSPORT_RETRY_POLICY,
  finalRefusalOf,
  RetryEpisodeOutcomeUnknownError,
  NO_RETRY_TRANSPORT_POLICY,
  type TransportRetryPolicy,
} from "../../../shared/host-transport/retrying-messenger";
import { DEFAULT_DIAL_TIMEOUT_MS } from "../../../shared/host-transport/transport-config";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type RequiredHostMethodVersion,
  type RequestOfMethod,
  type ResponseOfMethod,
  HostRequestAuthority,
  HostRequestOptions,
  HostTransportEndpoint,
} from "../../../shared/host-transport/host-messenger";
import {
  HOST_POST_OPEN_ATTESTATION_WINDOW_MS,
  WsRpcClient,
} from "../../../shared/host-transport/ws-rpc-client";
import { createWhatwgWebSocketFactory } from "../../../shared/host-transport/whatwg-ws-factory";
import type { IWebSocketFactory } from "../../../shared/host-transport/ws-factory";
import {
  isProfileLifecycleRejection,
  isRemovedProfileRefusal,
} from "../../../shared/host-transport/profile-lifecycle-rejection";
import { config } from "../config";
import { createCliLogger, errorFromUnknown } from "../logger";
import {
  isValidLocalHostWebsocketUrl,
  publishedHostProcessGone,
  readHostPidMetadata,
} from "../host/pid-metadata";
import { resolveHostAuth, type HostAuth } from "./host-auth";
import { cliError, CLI_ERROR_CODES, CliError } from "../runner/errors";
import {
  clientCompatibilityRecoveryHint,
  compatRecoveryHint,
  effectiveUpgradeGuidance,
} from "../host/compat-recovery";
import { CLI_CLIENT_IDENTITY } from "../cli-version";

/**
 * How long a call waits for its response frame. Exported so a one-shot stream
 * read (`readBotSnapshot`) waits for its first answer exactly as long.
 */
export const FRAME_TIMEOUT_MS = 15_000;

/**
 * One-shot unary RPC to the host's `/rpc` WebSocket endpoint.
 *
 * The protocol (open → openAck → request → response, manifest negotiation,
 * frame parsing, timeouts) is the shared `WsRpcClient` that the Desktop renderer
 * also uses - the CLI no longer hand-rolls it. The host receives only this CLI's host-only token
 * for it (`cli-host-tokens.ts`), read from disk; the stored sign-in (`resolveHostAuth`) is spent at
 * authn alone. A host refusal the shared auth-aware wrapper reads by its reason: a credential
 * reason gets one fresh token and one more send, never a third.
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
  if (await isManagedCliAuth()) {
    return requestWithManagedHostAuth(
      method,
      params,
      await resolveManagedEndpoint(),
      PLAIN_DISPATCH,
    );
  }
  const auth = await resolveHostAuth("required");
  if (auth === null) {
    logger.warn("Host RPC blocked by missing credentials", {
      environment: config.environment,
      method,
    });
    throw signedOutCliError();
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
    PLAIN_DISPATCH,
  );
}

/**
 * Like {@link callHostRpc} but fails fast: a transient transport failure
 * surfaces on the first attempt with no retry. For best-effort, latency-bound
 * callers (IDE hook commands such as title/activity reporting) where blocking
 * the agent for a multi-attempt retry of a non-responsive host is worse than a
 * quick miss.
 *
 * Because it never redials, it also waives the host attestation window (see
 * `attestationWindowForPolicy`): a post-send miss surfaces at the 15s response
 * deadline instead of waiting out an attestation this caller could not act on.
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
  if (await isManagedCliAuth()) {
    return requestWithManagedHostAuth(
      method,
      params,
      await resolveManagedEndpoint(),
      FAIL_FAST_DISPATCH,
    );
  }
  const auth = await resolveHostAuth("required");
  if (auth === null) {
    logger.warn("Host RPC fast-fail call blocked by missing credentials", {
      environment: config.environment,
      method,
    });
    throw signedOutCliError();
  }

  const endpoint = await resolveEndpoint();
  return requestAtEndpoint(
    method,
    params,
    endpoint,
    auth,
    NO_RETRY_TRANSPORT_POLICY,
    PLAIN_DISPATCH,
  );
}

/**
 * What a call needs beyond a method and its params. Every field is stated by
 * the caller; {@link PLAIN_DISPATCH} is the ordinary unary call.
 */
export interface HostRpcDispatch {
  /**
   * How long to wait for the response frame, or null for the transport's
   * 15s default. Only a long-poll (`providers.awaitLogin`, silent until the
   * sign-in ends) needs more; dial and handshake keep their own deadlines.
   */
  readonly responseTimeoutMs: number | null;
  /**
   * A version this call's own handshake must clear, or nothing is sent. For a
   * request whose meaning rides on a field a later minor added: below that
   * minor the field is stripped and the host acts on what is left - a profile
   * `remove` riding `providers.setEnabled` becomes a provider enable. Refused
   * pre-send as `DOWNGRADE_UNSUPPORTED`, which the CLI reports as "update the
   * host".
   */
  readonly requiredHostMethodVersion: RequiredHostMethodVersion | null;
  /** Aborts the call (Ctrl+C during a long-poll), or null to let it run. */
  readonly signal: AbortSignal | null;
  /**
   * One attempt, with no transport retry, for a best-effort call made while
   * the user is waiting to leave (a release after Ctrl+C): the retrying
   * policy can spend a dial timeout per attempt against a wedged host. The
   * single re-authentication on UNAUTHORIZED still happens, within
   * `reauthenticate`.
   */
  readonly failFast: boolean;
  /**
   * Which host UNAUTHORIZED refreshes the sign-in and sends the request once
   * more. `"before-request"` limits it to the host's refusal of the open
   * frame, for a create that must read a refusal as proof that nothing was
   * created: an answer to the second send carries no trace of a first that
   * may have reached the host before its session went fatal.
   */
  readonly reauthenticate: AuthRecoveryScope;
  /**
   * The key a host that negotiated it deduplicates this call by, or null.
   * Without one the retrying messenger may not replay a mutation after a
   * failure that followed the send, so a keyed create is the only one a
   * transport retry can finish. Byte-identical params under one key replay;
   * different params under it are refused.
   */
  readonly idempotencyKey: string | null;
}

export const PLAIN_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: null,
  signal: null,
  failFast: false,
  reauthenticate: "always",
  idempotencyKey: null,
};

/**
 * Like {@link callHostRpc}, for the calls that need one of the
 * {@link HostRpcDispatch} controls. Same credentials and endpoint discovery,
 * and the same retry policy unless the dispatch asks to fail fast.
 */
export async function callHostRpcWithDispatch<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  dispatch: HostRpcDispatch,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const logger = createCliLogger(config.environment);
  logger.debug("Host RPC requested", {
    environment: config.environment,
    method,
    retryPolicy: dispatch.failFast ? "fast-fail" : "default",
  });
  if (await isManagedCliAuth()) {
    return requestWithManagedHostAuth(
      method,
      params,
      await resolveManagedEndpoint(),
      dispatch,
    );
  }
  const auth = await resolveHostAuth("required");
  if (auth === null) {
    logger.warn("Host RPC blocked by missing credentials", {
      environment: config.environment,
      method,
    });
    throw signedOutCliError();
  }
  const endpoint = await resolveEndpoint();
  return callHostRpcAtResolvedEndpoint(
    method,
    params,
    endpoint,
    auth,
    dispatch,
  );
}

const FAIL_FAST_DISPATCH: HostRpcDispatch = {
  ...PLAIN_DISPATCH,
  failFast: true,
};

/**
 * With a capability in the agent's environment the call presents it, reads neither
 * the stored sign-in nor a host-only token, and recovers nothing; in a host session
 * without one nothing is presented. Which methods it may call is the host's list.
 */
export async function callAgentHostRpcWithDispatch<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  dispatch: HostRpcDispatch,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  return callHostRpcWithAgentCredential(
    method,
    params,
    readAgentCommandCredential(PROCESS_AGENT_ENVIRONMENT),
    dispatch,
  );
}

/** Uses the credential captured by a monitor for all of its acknowledgements. */
export async function callHostRpcWithAgentCredential<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  credential: AgentCommandCredential,
  dispatch: HostRpcDispatch,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  if (credential.kind === "outside-agent-session")
    return callHostRpcWithDispatch(method, params, dispatch);
  if (credential.kind === "none") {
    if (await isManagedCliAuth()) throw managedSignInRefusal();
    createCliLogger(config.environment).warn(
      "Host RPC blocked: the agent session carries no capability",
      { environment: config.environment, method },
    );
    throw signedOutCliError();
  }
  const endpoint = await resolveEndpoint();
  const capability = credential.capability;
  createCliLogger(config.environment).debug(
    "Host RPC requested with the agent session capability",
    {
      environment: config.environment,
      method,
      retryPolicy: dispatch.failFast ? "fast-fail" : "default",
    },
  );
  try {
    return await requestWithHostToken(
      method,
      params,
      endpoint,
      capability.bearer,
      capability.recovery,
      null,
      dispatch.failFast
        ? NO_RETRY_TRANSPORT_POLICY
        : DEFAULT_TRANSPORT_RETRY_POLICY,
      dispatch,
    );
  } catch (err) {
    const refusal = finalRefusalOf(err);
    if (refusal instanceof HostRpcError) {
      markRefusalOfAgentSessionCapability(refusal);
    }
    throw err;
  }
}

export function callAgentHostRpc<Method extends keyof HostRpcRegistry & string>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  return callAgentHostRpcWithDispatch(method, params, PLAIN_DISPATCH);
}

export function callAgentHostRpcFastFail<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  return callAgentHostRpcWithDispatch(method, params, FAIL_FAST_DISPATCH);
}

/**
 * Like {@link callHostRpcWithDispatch}, on a sign-in and endpoint the caller
 * already resolved. For a command that preflights both before it records
 * anything (`task create` writes its key record between the two), so nothing
 * is re-read after that point: a host restarted in between fails this call
 * instead of receiving it.
 */
export async function callHostRpcAtResolvedEndpoint<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  endpoint: HostTransportEndpoint,
  auth: HostAuth,
  dispatch: HostRpcDispatch,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  return requestAtEndpoint(
    method,
    params,
    endpoint,
    auth,
    dispatch.failFast
      ? NO_RETRY_TRANSPORT_POLICY
      : DEFAULT_TRANSPORT_RETRY_POLICY,
    dispatch,
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
  if (await isManagedCliAuth()) {
    return requestWithManagedHostAuth(method, params, endpoint, PLAIN_DISPATCH);
  }
  const auth = await resolveHostAuth("required");
  if (auth === null) {
    logger.warn(
      "Host RPC explicit-endpoint call blocked by missing credentials",
      {
        environment: config.environment,
        method,
        hostId: endpoint.hostId,
      },
    );
    throw signedOutCliError();
  }
  // The same check as `resolveEndpoint`: no token or sign-in goes to a URL
  // that is not this machine's host, nor to none.
  if (
    endpoint.websocketUrl === null ||
    !isValidLocalHostWebsocketUrl(endpoint.websocketUrl)
  ) {
    logger.warn(
      "Host RPC explicit-endpoint call blocked; websocket URL invalid",
      {
        environment: config.environment,
        method,
        hostId: endpoint.hostId,
      },
    );
    throw hostNotRunningCliError();
  }
  return requestAtEndpoint(
    method,
    params,
    endpoint,
    auth,
    DEFAULT_TRANSPORT_RETRY_POLICY,
    PLAIN_DISPATCH,
  );
}

/**
 * The errors that left `requestAtEndpoint` while no request frame of the call
 * had been written: an open frame at most. Only errors go in. The mark is
 * positive evidence on the marked exits alone. An error that left elsewhere,
 * such as a session that could not be acquired before the call's observer
 * existed, or a pre-send abort, is not marked. An unmarked error is an unknown
 * predicate result, not an outcome of the caller's: `hostRpcWroteNoRequest`
 * returning false says nothing either way about whether a request was
 * written. A caller may attest no dispatch by another route, as task create's
 * own classifier does for a `HostRequestAbortedError` that never dispatched.
 */
const wroteNoRequest = new WeakSet<object>();

/**
 * Whether `error` left a CLI call that wrote no request frame: the host had
 * nothing to carry out, whatever it did with the open.
 */
export function hostRpcWroteNoRequest(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && wroteNoRequest.has(error)
  );
}

function markWroteNoRequest<Failure>(error: Failure): Failure {
  if (typeof error === "object" && error !== null) wroteNoRequest.add(error);
  return error;
}

/**
 * How the gate ended a call, as strings only: the rejection object and every
 * sign-in key stay with the gate. `failure` is the host refusal's kind, and
 * `null` for a rejected sign-in.
 */
interface GateEnding {
  readonly kind: "sign-in-rejected" | "refusal";
  readonly failure: CliHostRefusal["kind"] | null;
}

/** The errors `blockedCallCliError` made, and how the gate ended each. */
const gateEndings = new WeakMap<object, GateEnding>();

/**
 * How the gate ended the call that threw `error`, or `null` when `error` is
 * not one the gate's ending made. The CliError a gate ending throws carries
 * only its words; this is the typed ending behind them.
 */
export function hostRpcGateEndingOf(error: unknown): GateEnding | null {
  return typeof error === "object" && error !== null
    ? (gateEndings.get(error) ?? null)
    : null;
}

/** A call the gate's ending stops, logged once. */
function blockedCallCliError(
  method: string,
  endpoint: HostTransportEndpoint,
  ending: CliRefusalEnding,
): CliError {
  createCliLogger(config.environment).warn(
    "Host RPC blocked: no host-only token",
    {
      environment: config.environment,
      method,
      hostId: endpoint.hostId,
      mintOutcome:
        ending.kind === "sign-in-rejected" ? ending.kind : ending.failure.kind,
    },
  );
  const error = refusalEndingCliError(ending);
  gateEndings.set(
    error,
    ending.kind === "sign-in-rejected"
      ? { kind: "sign-in-rejected", failure: null }
      : { kind: "refusal", failure: ending.failure.kind },
  );
  return error;
}

const CALLER_GAVE_UP: unique symbol = Symbol("caller-gave-up");
const BUDGET_SPENT: unique symbol = Symbol("budget-spent");

/**
 * The one wait on the gate's verdict in this file. `work`'s answer, unless
 * the caller's `signal` aborts (`aborted`) or `budgetMs` passes (`spent`)
 * first. A verdict already settled always wins: `work` is raced as it is, so
 * its answer is queued before a later abort's. Its timer and listener end
 * whichever comes first, and an answer arriving later replaces nothing.
 */
async function verdictBeforeCaller<V>(
  work: Promise<V>,
  signal: AbortSignal | null,
  budgetMs: number | null,
): Promise<
  | { readonly kind: "answer"; readonly value: V }
  | { readonly kind: "aborted" }
  | { readonly kind: "spent" }
> {
  let stop = (): void => undefined;
  const ended = new Promise<typeof CALLER_GAVE_UP | typeof BUDGET_SPENT>(
    (resolve) => {
      const onAbort = (): void => resolve(CALLER_GAVE_UP);
      const timer =
        budgetMs === null
          ? null
          : setTimeout(() => resolve(BUDGET_SPENT), budgetMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      stop = () => {
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted === true) onAbort();
    },
  );
  try {
    const first = await Promise.race([work, ended]);
    if (first === CALLER_GAVE_UP) return { kind: "aborted" };
    if (first === BUDGET_SPENT) return { kind: "spent" };
    return { kind: "answer", value: first };
  } finally {
    stop();
  }
}

async function requestAtEndpoint<Method extends keyof HostRpcRegistry & string>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  endpoint: HostTransportEndpoint,
  auth: HostAuth,
  retryPolicy: TransportRetryPolicy,
  dispatch: HostRpcDispatch,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const session = await requireCliHostSession(
    auth,
    endpoint.hostId,
    dispatch.signal,
  );
  // A refusal that may end the command is kept as evidence only: unless the
  // call was answered anyway, the gate decides what ends it.
  const ended: { refusal: CliRefusalEvidence | null } = { refusal: null };
  // Whether a frame carrying a request (not the open or a fatalError) went out
  // on any socket of this call. Only this boolean survives, never the frame.
  let requestWritten = false;
  const noteFrameSent = (data: unknown): void => {
    try {
      if (typeof data === "string") {
        const frame: unknown = JSON.parse(data);
        if (
          typeof frame === "object" &&
          frame !== null &&
          !Array.isArray(frame) &&
          "kind" in frame &&
          (frame.kind === "open" || frame.kind === "fatalError")
        )
          return;
      }
    } catch {
      // Not read: written, as is any frame this does not recognise as the open.
    }
    requestWritten = true;
  };
  const stopRefusals = session.tokens.onRefusalEndingCommand((evidence) => {
    if (evidence.hostId === endpoint.hostId) ended.refusal ??= evidence;
  });
  try {
    // With no usable token held, the call waits for the mint first, within
    // its own response budget: a held token past its end is refused by a
    // host that can reach authn. A refusal that mint met and the gate says
    // ends the command ends it here, before any request is written. A call
    // that would spend its budget waiting goes with what is held, as it
    // always did; a best-effort call made while the person waits to leave
    // (`failFast`) goes at once, the mint running beside it.
    // One race covers the mint and the gate's verdict on it; the clock is
    // read first after it, and past the budget the call goes with what is
    // held.
    const minted = session.tokens.mintBeforeWork(endpoint.hostId);
    const budgetMs = dispatch.responseTimeoutMs ?? FRAME_TIMEOUT_MS;
    const budgetEndsAt = Date.now() + budgetMs;
    // Never rejects: a verdict that fails is no verdict. An aborted caller
    // enters no gate, even on a mint failure its abort caused.
    const verdict = async (): Promise<CliRefusalEnding | null> => {
      try {
        const answer = await minted;
        if (answer === null || answer.kind !== "failed") return null;
        if (dispatch.signal?.aborted === true) return null;
        return await session.tokens.refusalEndingCommandNow(endpoint.hostId);
      } catch {
        return null;
      }
    };
    // A caller that gives up meanwhile goes to the request, which ends at
    // once with its own abort.
    const judged = dispatch.failFast
      ? null
      : await verdictBeforeCaller(verdict(), dispatch.signal, budgetMs);
    const ending = judged?.kind === "answer" ? judged.value : null;
    if (ending !== null && Date.now() < budgetEndsAt)
      throw markWroteNoRequest(blockedCallCliError(method, endpoint, ending));
    // That mint is the one the call's first open would have started.
    let firstOpen = true;
    try {
      return await requestWithHostToken(
        method,
        params,
        endpoint,
        session.bearer,
        session.tokens.unaryRecovery(endpoint.hostId),
        {
          releasedSignOn: session.releasedSignOn,
          // Every later open with no usable token starts the mint through the
          // one starter, as every bearer read did before.
          hostBearerFor: (waitForMint) => {
            if (!firstOpen) void session.tokens.mintBeforeWork(endpoint.hostId);
            firstOpen = false;
            return session.tokens.hostBearerFor(endpoint.hostId, waitForMint);
          },
          runningMint: () => session.tokens.runningMint(endpoint.hostId),
          // The unary door names no process: the one current as the fence lets
          // the admission through.
          admitted: () =>
            session.tokens.admitted(
              processReleasedHosts.currentInstance(endpoint.hostId),
            ),
          noteFrameSent,
        },
        retryPolicy,
        dispatch,
      );
    } catch (err) {
      // A caller that has given up gets its own ending at once: no verdict
      // read starts after its deadline, and one under way replaces nothing.
      if (dispatch.signal?.aborted === true) throw err;
      // A request frame of this call was written: the host may have carried
      // it out. The call's error leaves as the client's own object, with only
      // the gate's sign-in judgement added to it; the gate's refusal ends a
      // call only when nothing was written.
      // The one judgement for this exit, and the exit in the same turn as it.
      // With no refusal reported, the gate's verdict on the stored sign-in
      // rides on the refusal thrown now, to its synchronous mapping.
      if (ended.refusal === null || requestWritten) {
        const refusal = finalRefusalOf(err);
        if (refusal instanceof HostRpcError) {
          const judged = await verdictBeforeCaller(
            session.tokens.signInRejectionNow(null),
            dispatch.signal,
            null,
          );
          if (judged.kind === "answer" && judged.value !== null) {
            markRefusalAfterRejectedSignIn(refusal);
            rejectionOfRefusal.set(refusal, judged.value);
          }
        }
        throw requestWritten ? err : markWroteNoRequest(err);
      }
      const judged = await verdictBeforeCaller(
        session.tokens.refusalEndingCommandNow(endpoint.hostId),
        dispatch.signal,
        null,
      );
      if (judged.kind !== "answer" || judged.value === null)
        throw markWroteNoRequest(err);
      throw markWroteNoRequest(
        blockedCallCliError(method, endpoint, judged.value),
      );
    }
  } finally {
    stopRefusals();
    session.dispose();
  }
}

/**
 * The gate's judgement for a refusal the call threw in the same turn: only a
 * refusal judged so is worded as a rejected sign-in.
 */
const rejectionOfRefusal = new WeakMap<HostRpcError, SignInRejection>();

/** This machine's host, reached with this CLI's host-only token. */
interface LocalHostDoor {
  readonly releasedSignOn: ReleasedSignOn;
  /** `CliHostTokens.hostBearerFor` of the host. */
  readonly hostBearerFor: (
    waitForMint: boolean,
  ) => Promise<OpenFrameBearerSource | null>;
  /** `CliHostTokens.runningMint` of the host. */
  readonly runningMint: () => Promise<OpenFrameBearerSource | null> | null;
  /** The host admitted a call; the release is called when that connection leaves. */
  readonly admitted: () => DoorAdmissionRelease;
  /** Called with every frame this call's sockets send, before it goes out. */
  readonly noteFrameSent: (data: unknown) => void;
}

/**
 * The factory a local call dials through: each socket reports every frame it
 * sends to the door before sending it, and sends it as it would have.
 */
function recordingSocketFactory(localDoor: LocalHostDoor): IWebSocketFactory {
  const inner = createWhatwgWebSocketFactory();
  return {
    create: (url, priority) => {
      const socket = inner.create(url, priority);
      const send = socket.send.bind(socket);
      socket.send = (data: string): void => {
        try {
          localDoor.noteFrameSent(data);
        } catch {
          // The recorder never throws; the frame goes out either way.
        }
        send(data);
      };
      return socket;
    },
  };
}

const managedMethods = new Set<string>(MANAGED_CLI_UNARY_METHODS);

async function requestWithManagedHostAuth<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  endpoint: HostTransportEndpoint,
  dispatch: HostRpcDispatch,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  if (!managedMethods.has(method)) throw managedSignInRefusal();
  if (endpoint.websocketUrl === null) throw managedHostStopped();
  const stored = await readManagedHostCredential(endpoint, dispatch.signal);
  const url = new URL(endpoint.websocketUrl);
  url.pathname = MANAGED_CLI_RPC_PATH;
  const credential =
    method === "worktree.listBindingsForEpic" && stored.identity.kind === "team"
      ? readAgentCommandCredential(PROCESS_AGENT_ENVIRONMENT)
      : null;
  const open = encodeManagedCliOpen({
    token: stored.token,
    taskCapability:
      credential?.kind === "capability"
        ? credential.capability.bearer.getBearerToken()
        : null,
  });
  try {
    return await requestWithHostToken(
      method,
      params,
      { ...endpoint, websocketUrl: url.href },
      {
        identity: { userId: "managed-cli" },
        getBearerToken: () => open,
      },
      {
        revalidateExpectedBearer: async () => "rejected",
        revalidateRefusedBearer: async () => "rejected",
      },
      null,
      NO_RETRY_TRANSPORT_POLICY,
      { ...dispatch, reauthenticate: "before-request" },
    );
  } catch (error) {
    const refusal = finalRefusalOf(error);
    if (refusal instanceof HostRpcError) {
      if (refusal.fatalDetails?.reason === MANAGED_CLI_REFUSAL)
        throw managedSignInRefusal();
      if (refusal.fatalDetails?.reason === MANAGED_CLI_WAITING)
        throw managedWaiting();
      if (refusal.fatalDetails?.retryable === true)
        throw managedUnavailable(true);
    }
    if (refusal instanceof HostTransportFailureError)
      throw managedUnavailable(true);
    if (refusal instanceof HostRpcError && refusal.code === "UNAUTHORIZED")
      throw managedUnavailable(false);
    throw error;
  }
}

async function requestWithHostToken<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  endpoint: HostTransportEndpoint,
  bearer: OpenFrameBearerSource,
  recovery: RefusalAwareAuthRevalidator,
  localDoor: LocalHostDoor | null,
  retryPolicy: TransportRetryPolicy,
  dispatch: HostRpcDispatch,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const logger = createCliLogger(config.environment);
  const client = new WsRpcClient<HostRpcRegistry>({
    ...(localDoor === null
      ? {}
      : {
          // Never waits for a mint authn has not answered, unless a current
          // host named its reason for the probe.
          hostBearerFor: (
            _hostId: string,
            _signIn: OpenFrameBearerSource,
            waitForMint: boolean,
          ) => localDoor.hostBearerFor(waitForMint),
          runningHostMintFor: () => localDoor.runningMint(),
          doorFor: () => ({
            refused: () => undefined,
            admitted: localDoor.admitted,
          }),
          // The CLI holds no row. Eligibility is this process's mint record and
          // held token, read synchronously as they stand at the ask.
          releasedSignOnFor: (
            authority: HostRequestAuthority,
            cause: ReleasedUnaryCause,
          ) => {
            const releasedSignOn = localDoor.releasedSignOn;
            const hostId = authority.endpoint.hostId;
            const signIn = releasedSignOn.signIn();
            const eligible =
              cause === "refused" ||
              (cause === "owner-sign-in"
                ? releasedSignOn.ownerSignInEligible(hostId)
                : releasedSignOn.hostTokenUnobtainable(hostId));
            return signIn !== null && eligible
              ? { bearer: signIn, recovery: releasedSignOn.recovery }
              : null;
          },
          heldTokenRefusedFor: (_authority, presented, instance) =>
            localDoor.releasedSignOn.heldTokenRefused(instance, presented),
          forgetHeldRefusalFor: (authority) =>
            localDoor.releasedSignOn.forgetHeldRefusal(
              authority.endpoint.hostId,
            ),
          releasedHosts: localDoor.releasedSignOn.hosts,
          surfacesNotProvisioned: true,
        }),
    registry: hostRpcRegistry,
    requestId: () => randomUUID(),
    webSocketFactory:
      localDoor === null
        ? createWhatwgWebSocketFactory()
        : recordingSocketFactory(localDoor),
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    frameTimeoutMs: FRAME_TIMEOUT_MS,
    hostAttestationWindowMs: attestationWindowForPolicy(retryPolicy),
    // The CLI has no selection authority to feed: there is no window, no
    // kernel, and nothing that could act on a failover verdict.
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: CLI_CLIENT_IDENTITY,
  });
  const messenger = createRetryingMessenger<HostRpcRegistry>(
    createAuthAwareMessenger<HostRpcRegistry>(
      client,
      recovery,
      dispatch.reauthenticate,
    ),
    retryPolicy,
  );

  const callLifetime = new AbortController();
  const abortWithCaller = (): void => callLifetime.abort("cli-call-aborted");
  if (dispatch.signal !== null) {
    if (dispatch.signal.aborted) abortWithCaller();
    else dispatch.signal.addEventListener("abort", abortWithCaller);
  }
  const authority: HostRequestAuthority = {
    endpoint,
    bearer,
    abortSignal: callLifetime.signal,
  };
  const options: HostRequestOptions = {
    idempotencyKey: dispatch.idempotencyKey,
    authority,
    // A caller's FIRST attempt. The replay requirement is raised by the
    // `createRetryingMessenger` wrapper above, per failure, not here.
    replayMustBeKeyed: false,
    // Null for every call but the ones that name a floor: those dispatch
    // whatever the handshake negotiates, as the CLI always has.
    requiredHostMethodVersion: dispatch.requiredHostMethodVersion,
  };
  try {
    const response =
      dispatch.responseTimeoutMs === null
        ? await messenger.request(method, params, options)
        : await messenger.requestWithResponseTimeout(
            method,
            params,
            dispatch.responseTimeoutMs,
            options,
          );
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
    dispatch.signal?.removeEventListener("abort", abortWithCaller);
    callLifetime.abort("cli-call-settled");
    client.releaseIdleLocalSessions();
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
  // Identity check, not just presence: a stopped/crashed host can leave a
  // stale pid.json behind, and the pid it names can since have been handed to
  // an unrelated process (the same reason `host status` reads
  // `publishedHostProcessGone`). Catching that record here is what lets
  // `mapHostRpcError` treat a transport `RPC_ERROR` as a genuine host error
  // rather than overloading it to mean "not running".
  if (metadata === null) {
    logger.warn("Host RPC endpoint resolution failed; metadata missing", {
      environment: config.environment,
    });
    throw hostNotRunningCliError();
  }
  if (publishedHostProcessGone(metadata)) {
    logger.warn(
      "Host RPC endpoint resolution failed; the published process is gone (exited, or a recycled pid)",
      {
        environment: config.environment,
        hostId: metadata.hostId,
        pid: metadata.pid,
      },
    );
    throw hostNotRunningCliError();
  }
  if (!isValidLocalHostWebsocketUrl(metadata.websocketUrl)) {
    logger.warn("Host RPC endpoint resolution failed; websocket URL invalid", {
      environment: config.environment,
      hostId: metadata.hostId,
    });
    throw hostNotRunningCliError();
  }
  logger.debug("Host RPC endpoint resolved", {
    environment: config.environment,
    hostId: metadata.hostId,
    pid: metadata.pid,
  });
  return { hostId: metadata.hostId, websocketUrl: metadata.websocketUrl };
}

async function resolveManagedEndpoint(): Promise<HostTransportEndpoint> {
  try {
    return await resolveEndpoint();
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === CLI_ERROR_CODES.HOST_NOT_RUNNING
    )
      throw managedHostStopped();
    throw error;
  }
}

function hostNotRunningCliError(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
    message: "The host is not running. Run `traycer host ensure`.",
    details: null,
    exitCode: 1,
  });
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
 * additive field). Both transports raise this as `DOWNGRADE_UNSUPPORTED`
 * locally during request preparation (`ws-rpc-client.ts` and the remote
 * `rpc-codec.ts`), so the attempt that failed never reached the host. A
 * refusal that ended a retry episode is matched too: its final attempt failed
 * preparation, while an earlier attempt's outcome stays unknown.
 *
 * Best-effort hook commands use this to degrade a version-skew miss to a quiet
 * no-op instead of surfacing it: the call is meaningless against a host too old
 * to understand it. Matched narrowly (the specific code + preparation message)
 * so other downgrade refusals, genuine host errors and auth failures still
 * surface.
 */
export function isRequestVersionProjectionError(err: unknown): boolean {
  const refusal = finalRefusalOf(err);
  return (
    refusal instanceof HostRpcError &&
    refusal.code === "DOWNGRADE_UNSUPPORTED" &&
    refusal.message.startsWith(REQUEST_PROJECTION_FAILURE_PREFIX)
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

/**
 * Validate a host response against the CANONICAL (latest installed) response
 * schema for `method`, resolved from the same `hostRpcRegistry` the transport
 * negotiates against. Prefer this over {@link parseHostResponse} everywhere the
 * payload is just "the response to the call we made".
 *
 * Why this exists rather than each call site naming a schema: the transport
 * hands back a payload already at the client's canonical version - either the
 * host spoke it directly (returned unvalidated, so this parse IS the validation
 * boundary) or `upgradeResponseAlongChain` bridged an older host's reply up to
 * it. A call site that names an older `...SchemaVNN` therefore validates the
 * wrong contract AND, because Zod strips unknown keys, silently discards every
 * field added since - turning a host fact the CLI was told into one it never
 * saw. That skew is invisible to the type checker, because `parseHostResponse`
 * takes `value: unknown` and returns whatever the schema it was handed infers.
 *
 * Naming the METHOD alongside the schema is what closes that hole. The schema
 * parameter is typed as the method's canonical `ResponseOfMethod` - the same
 * type `callHostRpc` already promises for the value being parsed - so handing
 * it a stale `...SchemaVNN` is a compile error at the call site instead of a
 * silent field drop at runtime. When a protocol minor lands, every CLI call
 * site on that method stops compiling until someone decides what the new field
 * means here, which is the loud, reviewable moment the old signature never had.
 * `assertCanonicalResponseSchema` covers the residue the types cannot see.
 *
 * {@link parseHostResponse} stays for the callers that genuinely mean a
 * specific historical version - the streaming frame bridge in `monitor.ts`
 * decodes v1.0/v1.1/v1.2 envelopes on purpose.
 */
export function parseCanonicalHostResponse<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  schema: ZodType<ResponseOfMethod<HostRpcRegistry, Method>>,
  value: unknown,
): ResponseOfMethod<HostRpcRegistry, Method> {
  assertCanonicalResponseSchema(method, schema);
  return parseHostResponse(schema, value);
}

/**
 * The canonical (latest installed) response schema the registry declares for
 * `method` - the contract the transport negotiates and therefore the only one a
 * plain response parse may use. Exported so a test can assert the pairing for
 * every method without re-deriving the traversal.
 */
export function canonicalResponseSchemaFor(
  method: keyof HostRpcRegistry & string,
): ZodType<unknown> {
  return getLatestContract(hostRpcRegistry[method], undefined).responseSchema;
}

/**
 * Backstop for the drift the signature alone cannot catch. The
 * `ZodType<ResponseOfMethod<...>>` parameter rejects a stale schema whenever the
 * versions differ by a REQUIRED field - which is what an additive protocol minor
 * normally adds, since its upgrade path has to supply a value for older hosts.
 * It does not reject a schema that merely differs by an optional field, and it
 * cannot see a base-name alias that tracks the latest line today but is free to
 * stop doing so (`agentGetProviderProfileRateLimitsResponseSchema` is exactly
 * that shape).
 *
 * So compare identity against the registry as well. This is an O(1) property
 * walk against a call that just crossed a WebSocket, and it fails as a plain
 * `Error`, not a `CliError`: reaching it means the CLI was built with a
 * mismatched pairing, which is a bug in this repo rather than anything the user
 * or the host did.
 */
function assertCanonicalResponseSchema(
  method: keyof HostRpcRegistry & string,
  schema: ZodType<unknown>,
): void {
  if (canonicalResponseSchemaFor(method) === schema) return;
  throw new Error(
    `traycer: internal error - '${method}' is parsed with a non-canonical response schema. Parse the latest contract in the versioned-RPC registry; an older '...SchemaVNN' silently strips every field added since.`,
  );
}

/**
 * Appended to the mapped message when a refusal ended a retry episode whose
 * earlier attempt may have reached the host: the refusal's own guidance stays
 * true about the retry, and this says what may have happened to the request.
 */
const EARLIER_ATTEMPT_MAY_HAVE_RUN =
  "An earlier attempt may have gone through. Check before repeating it.";

/**
 * The mapping {@link toAgentCliError} applies, for a caller that has to read
 * the raw transport error itself before it is mapped (`task create` decides
 * from it whether its request frame was ever written).
 */
export function hostRpcToCliError(err: unknown): unknown {
  // Classified by the refusal that ended a retry episode, not by its
  // unknown-outcome wrapper: what the final refusal says stays true about the
  // retry whatever an earlier attempt did. The outcome stays unknown, and the
  // message says so.
  const refusal = finalRefusalOf(err);
  if (!(refusal instanceof HostRpcError)) return err;
  createCliLogger(config.environment).warn(
    "Mapping host RPC wire error to CLI error",
    {
      environment: config.environment,
      hostRpcCode: refusal.code,
    },
  );
  const mapped = mapHostRpcError(refusal);
  if (!(err instanceof RetryEpisodeOutcomeUnknownError)) return mapped;
  return cliError({
    code: mapped.code,
    message: `${mapped.message} ${EARLIER_ATTEMPT_MAY_HAVE_RUN}`,
    details: mapped.details,
    exitCode: mapped.exitCode,
  });
}

/**
 * A released host's refusal of this person's sign-in, in its own words, as
 * the released CLI printed every host refusal.
 */
export function releasedSignInRefusalCliError(reason: string): CliError {
  return cliError({
    code: CLI_ERROR_CODES.AUTH_REJECTED,
    message: reason,
    details: null,
    exitCode: 1,
  });
}

/**
 * Maps a host wire error code to a stable CLI error code:
 *   - a released host's refusal of this person's sign-in → `AUTH_REJECTED`
 *     with the host's own sentence, unless the sign-in itself was rejected.
 *   - a refusal by the host's door, after the call's one fresh token → the
 *     door's own line (`hostDoorRefusalCliError`), decided by its reason
 *     ahead of every code below: sign-in advice only for a machine signed out
 *     in fact, the older-host line for a reasonless refusal of the token, and
 *     otherwise the generic arm at the end.
 *   - authorization failure → `FORBIDDEN`: the host signals "no access" with a
 *     `FORBIDDEN` wire code - a cloud 403 is mapped to `FORBIDDEN` in the host's
 *     `cloudErrorFromResponse`, and a viewer/no-role caller hits
 *     `EpicAccessForbiddenError`. `isAccessDenied` is a best-effort fallback for
 *     an access denial that still arrives bucketed as `RPC_ERROR`. We do NOT pass
 *     the host's raw text through here: it can embed an internal user UUID and
 *     the internal term "task" (epic), neither actionable for a CLI user.
 *   - `UNAUTHORIZED` that is not the door's → `AUTH_REJECTED`, with the
 *     host's own line.
 *   - `WORKTREE_MISSING` / `WORKSPACE_BINDING_REQUIRED` / `E_HOST_STORAGE_FULL`
 *     → the CLI code of the same name: the person's own folder, workspace
 *     choice or disk stops the request, and the host's message names the fix.
 *   - `PROVIDER_DISABLED` → `PROVIDER_DISABLED`: the person turned that
 *     provider off in Settings → Providers; the host's message names it and the
 *     setting, and is passed through unchanged.
 *   - `E_INVALID_ARGUMENT` / `MESSAGE_TOO_LARGE`, and an `RPC_ERROR` carrying one
 *     of the host's four profile-selection messages → `INVALID_ARGUMENT`: the
 *     caller's own input.
 *   - `E_HOST_UNSUPPORTED` → `HOST_UNSUPPORTED`: per-feature unsupported on
 *     this host, actionable by updating the host.
 *   - `INCOMPATIBLE` / `DOWNGRADE_UNSUPPORTED` → `HOST_INCOMPATIBLE`: host/CLI
 *     protocol skew, actionable via `host restart` / updating the CLI.
 *   - a transport failure the transport could not prove was pre-dispatch →
 *     `HOST_REQUEST_OUTCOME_UNKNOWN`: the request frame went out and no answer
 *     came back, so the host may have carried the call out and re-running the
 *     command can repeat it.
 *   - every other `HostTransportFailureError` → `HOST_UNREACHABLE`: the
 *     connection failed before the request went out, or the failure is
 *     replayable, so nothing below applies and a retry is safe.
 *   - the exact `RPC_ERROR` shutdown refusal → `HOST_BUSY`: the host is
 *     stopping and refused this request; its message is preserved.
 *   - everything else, including `RPC_ERROR` → `UNEXPECTED`: `RPC_ERROR` is the
 *     host's catch-all for any resolver error (e.g. "agent not found"), so it
 *     must NOT be reported as "host not running" - the host answered. A
 *     genuinely unreachable/dead host is already caught upstream in
 *     `resolveEndpoint` (absent/dead pid → `HOST_NOT_RUNNING`). `details: null`
 *     keeps the raw stack out of the NDJSON envelope; the host's own message
 *     is preserved so the user still sees what went wrong.
 */
function mapHostRpcError(err: HostRpcError): CliError {
  const rejection = rejectionOfRefusal.get(err) ?? null;
  // A released host refused this person's sign-in: its own sentence, as the
  // released CLI printed it. Only a dead sign-in says more.
  if (rejection === null && isReleasedSignInRefusal(err))
    return releasedSignInRefusalCliError(err.message);
  // A capability cannot be repaired by the stored sign-in or a host-token mint.
  const doorRefusal = isRefusalOfAgentSessionCapability(err)
    ? null
    : hostRefusalOf(err);
  const doorError =
    doorRefusal === null
      ? null
      : hostDoorRefusalCliError(doorRefusal, rejection, () =>
          unexpectedHostCliError(err),
        );
  if (doorError !== null) return doorError;
  const admissionError =
    err.fatalDetails === null
      ? null
      : localTeamAdmissionCliError(err.fatalDetails);
  if (admissionError !== null) return admissionError;
  // Ahead of the unreachable arm below, and the two must never share a code:
  // this is the failure the transport could not prove was pre-dispatch, so
  // the host may have run the call and answered into a connection that was
  // already gone. Reported as "unreachable" it reads as "nothing happened",
  // and a caller that re-runs on that reading repeats whatever the first send
  // did - an `agent.sendMessage` whose message was delivered exited
  // `E_HOST_UNREACHABLE`, and the callers that retried on it delivered the
  // same message twice.
  //
  // The message keeps the transport's own text (it carries no host text) and
  // adds what the caller has to do about it.
  if (mayHaveReachedHost(err)) {
    return cliError({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: `traycer: ${err.message} - the request was sent and the host may have carried it out; check before sending it again.`,
      details: null,
      exitCode: 1,
    });
  }
  // Then by class rather than by code: the transport raises its own
  // failures as `RPC_ERROR` too, so the code cannot tell "the host answered
  // with an error" from "nothing answered". The class can. A connection that
  // errored, closed early or timed out is a state of the machine the command
  // has already reported to the user, not a defect in the CLI, which is what
  // `UNEXPECTED` tells the error reporter. The message is the transport's own
  // and carries no host text.
  if (err instanceof HostTransportFailureError) {
    return cliError({
      code: CLI_ERROR_CODES.HOST_UNREACHABLE,
      message: err.message,
      details: null,
      exitCode: 1,
    });
  }
  if (err.code === "FORBIDDEN" || isAccessDenied(err)) {
    return cliError({
      code: CLI_ERROR_CODES.FORBIDDEN,
      message:
        "traycer: access denied for this epic - check TRAYCER_EPIC_ID and that you're signed in to the account that owns it.",
      details: null,
      exitCode: 1,
    });
  }
  if (err.code === "E_AGENT_NOT_FOUND") {
    return cliError({
      code: CLI_ERROR_CODES.AGENT_NOT_FOUND,
      message: `traycer: ${err.message} Check --agent-id (or $TRAYCER_AGENT_ID).`,
      details: null,
      exitCode: 1,
    });
  }
  const teamRefusal = TEAM_TRANSFER_REFUSALS.find(
    ({ code }) => code === err.code,
  );
  if (teamRefusal !== undefined) {
    return cliError({
      code: teamRefusal.code,
      message: teamRefusal.message,
      details: null,
      exitCode: 1,
    });
  }
  // The host's own egress budget refusing a cloud request is retryable like a
  // cloud that gave no verdict, and the person's next step is the same.
  if (
    err.code === "E_CLOUD_UNREACHABLE" ||
    err.code === "E_CLOUD_REQUEST_REFUSED"
  ) {
    return cliError({
      code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message: `traycer: ${err.message}`,
      details: null,
      exitCode: 1,
    });
  }
  if (err.code === "E_AGENT_NOT_LOCAL") {
    return cliError({
      code: CLI_ERROR_CODES.AGENT_NOT_LOCAL,
      message: `traycer: ${err.message}`,
      details: null,
      exitCode: 1,
    });
  }
  if (err.code === "E_ROLE_FORBIDDEN") {
    return cliError({
      code: CLI_ERROR_CODES.ROLE_FORBIDDEN,
      message: `traycer: ${err.message}`,
      details: null,
      exitCode: 1,
    });
  }
  // The host answers these three with a typed code for a state of the
  // person's own machine or workspace, and the message already names the
  // remedy (restore or re-bind the folder, choose a workspace, free disk
  // space on the host). Left to the fall-through below they became
  // `UNEXPECTED` and were captured as CLI defects.
  if (err.code === "WORKTREE_MISSING") {
    return cliError({
      code: CLI_ERROR_CODES.WORKTREE_MISSING,
      message: `traycer: ${err.message}`,
      details: null,
      exitCode: 1,
    });
  }
  if (err.code === "WORKSPACE_BINDING_REQUIRED") {
    return cliError({
      code: CLI_ERROR_CODES.WORKSPACE_BINDING_REQUIRED,
      message: `traycer: ${err.message}`,
      details: null,
      exitCode: 1,
    });
  }
  if (err.code === "E_HOST_STORAGE_FULL") {
    return cliError({
      code: CLI_ERROR_CODES.HOST_STORAGE_FULL,
      message: `traycer: ${err.message}`,
      details: null,
      exitCode: 1,
    });
  }
  // A provider the person disabled in Settings → Providers is their own
  // setting, not a CLI defect. The host's message ("<Provider> is disabled.
  // Enable it in Settings → Providers.") already names the remedy and is kept
  // as the fall-through printed it.
  if (err.code === "PROVIDER_DISABLED") {
    return cliError({
      code: CLI_ERROR_CODES.PROVIDER_DISABLED,
      message: err.message,
      details: null,
      exitCode: 1,
    });
  }
  // A request that names a managed profile the host cannot use (removed, not
  // registered, still being set up, wrong provider) is the person's own
  // selection and expected. The host sends it as `RPC_ERROR` with a fixed
  // message, so it is recognized by message; if the host later sends the same
  // refusal as `E_INVALID_ARGUMENT`, the output below does not change. An
  // account a person removed is refused with the unknown-id sentence under
  // `removed-by-person`, and prints exactly what an unknown id prints.
  if (
    err.code === "E_INVALID_ARGUMENT" ||
    err.code === "MESSAGE_TOO_LARGE" ||
    isProfileLifecycleRejection(err.code, err.message) ||
    isRemovedProfileRefusal(err.code, err.message)
  ) {
    return cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `traycer: ${err.message}`,
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
    //
    // An EPOCH rejection wins over both: the host named the generation it
    // needs and the build that provides it, which is strictly more than the
    // two guidance booleans can express. `exitCode: 1` and no retry are
    // unchanged and are the point - the same binary against the same host
    // reaches the same verdict, so a reconnect is a loop.
    const epochHint = clientCompatibilityRecoveryHint(
      err.fatalDetails?.clientCompatibilityRequirement ?? null,
    );
    return cliError({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message: `traycer: ${err.message} - ${epochHint ?? compatRecoveryHint(effectiveUpgradeGuidance(err.code, err.fatalDetails?.upgradeGuidance ?? null))}.`,
      details: null,
      exitCode: 1,
    });
  }
  if (isHostShuttingDown(err)) {
    return cliError({
      code: CLI_ERROR_CODES.HOST_BUSY,
      message: err.message,
      details: null,
      exitCode: 1,
    });
  }
  return unexpectedHostCliError(err);
}

/** The host's own line, for an error no arm above names. */
function unexpectedHostCliError(err: HostRpcError): CliError {
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

// The host's admission latch refuses work during shutdown with this fixed
// message under its generic wire code. Match both exactly so other resolver
// failures remain unexpected; classification does not retry the request.
function isHostShuttingDown(err: HostRpcError): boolean {
  return (
    err.code === "RPC_ERROR" &&
    err.message === "EntityMemoryManager is shutting down"
  );
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

/**
 * True when the request frame may already have reached the host and its
 * outcome is therefore unknown.
 *
 * Read off the CLASS and the FLAG the transport sets, never off the message
 * text, because the same sentence describes both outcomes: a frame timeout
 * before the request went out and one after it read identically, and the
 * transport is the only layer that knows which happened. `ws-rpc-client.ts`'s
 * `transientFailure` builds a plain {@link HostTransportFailureError} for
 * exactly `requestSent && !requestReplaySafe` and a
 * {@link RetryableTransportError} for every failure that is provably
 * pre-dispatch or safe to replay, and `createRetryingMessenger` ends an
 * episode whose earlier attempt was sent and lost with a plain one too
 * (`RetryEpisodeOutcomeUnknownError`).
 *
 * The three arms, in the order they are decided:
 *   - a `RetryableTransportError` is safe to send again - either nothing was
 *     dispatched or the host is deduplicating a negotiated key - so it keeps
 *     the unreachable code, whose whole meaning is "try again";
 *   - a `HostRequestAbortedError` carries the answer on its own
 *     `mayHaveDispatched` flag: an abort stops the caller waiting, it does not
 *     recall a request the host may already be running;
 *   - every other `HostTransportFailureError` is the ambiguous post-send case.
 */
function mayHaveReachedHost(err: HostRpcError): boolean {
  if (!(err instanceof HostTransportFailureError)) return false;
  if (err instanceof RetryableTransportError) return false;
  if (err instanceof HostRequestAbortedError) return err.mayHaveDispatched;
  return true;
}

function retryPolicyLabel(
  policy: TransportRetryPolicy,
): "default" | "fast-fail" {
  return policy === NO_RETRY_TRANSPORT_POLICY ? "fast-fail" : "default";
}

/**
 * The attestation window a call gets is a function of what it could do with an
 * attestation.
 *
 * A retrying call gets the production window: the CLI's 15s response deadline
 * is half the host's 30s post-`openAck` deadline - and a stalled host fires that
 * timer later still - so without the window every stalled host would surface an
 * ambiguous, non-retryable timeout long before it could attest that it never
 * dispatched the request, and the retry wrapper would never get its one safe
 * reason to redial a non-idempotent method.
 *
 * A `maxRetries: 0` policy has no such reason to wait. Its retry wrapper goes
 * straight to the final attempt and propagates even a valid
 * `RetryableTransportError` without redialing, so holding the socket open for an
 * attestation would only delay a failure that is already decided - exactly what
 * `callHostRpcFastFail`'s latency-bound IDE-hook callers must not pay. Keyed off
 * `maxRetries` rather than policy identity so any future no-retry policy
 * inherits the same wiring.
 */
function attestationWindowForPolicy(policy: TransportRetryPolicy): number {
  return policy.maxRetries === 0 ? 0 : HOST_POST_OPEN_ATTESTATION_WINDOW_MS;
}
