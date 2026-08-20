import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { HostCredentialState } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  MutableBearerLease,
  readLeaseBearer,
} from "../../../shared/auth/bearer-source";
import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "../../../shared/auth/bearer-revalidator";
import type { HostCredentialMintOutcome } from "../../../shared/host-transport/host-credential-mint-flow";
import { createWhatwgStreamWebSocketFactory } from "../../../shared/host-transport/whatwg-stream-ws-factory";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
} from "../../../shared/host-transport/i-stream-session";
import type { HostTransportEndpoint } from "../../../shared/host-transport/ws-rpc-client";
import { WsStreamClient } from "../../../shared/host-transport/ws-stream-client";
import { DEFAULT_DIAL_TIMEOUT_MS } from "../../../shared/host-transport/transport-config";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { createCliHostCredentialMintFlow } from "../auth/host-credential-mint";
import type { HostAuth } from "../internal/host-auth";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import { errorFromUnknown, type ILogger } from "../logger";
import type { Environment } from "../runner/environment";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
} from "./pid-metadata";

// Post-install host-credential provisioning: the short-lived stream
// connection that leaves a freshly-installed host holding its own
// `aud: "host"` credential instead of waiting for the first client with a
// mint flow (the GUI, `monitor`) to happen to connect.
//
// Why a stream connection and not an RPC: the delegated-credential handoff is
// a stream-protocol capability. The host reports `hostCredentialState` on
// every `openAck`, the client mints off its own bearer and pushes the
// credential as a `hostCredentialProvision` control frame - and that frame
// deliberately has NO receipt. Adoption is only observable as the NEXT
// connection's ack reporting `active` (see stream-ws-protocol.ts), so this
// module verifies by reconnecting rather than trusting the push.
//
// The probe subscribes to `host.notifications.subscribe` purely as transport:
// it is host-scoped (no ids to invent), read-only, and stays quietly open,
// which keeps the session alive across the mint's HTTP round trip so the push
// lands on a live socket. The credential machinery itself rides the handshake,
// not the method.
//
// Every outcome here is advisory: `host install` already succeeded, and an
// unprovisioned host self-heals when any minting client connects later - so
// callers render failures as warnings, never as a failed install.

export type HostCredentialProvisionOutcome =
  // Verified: an `openAck` reported `active`. `minted` says whether this run
  // provisioned it or the host already held one (a re-install keeps the
  // host's own credential store).
  | { readonly kind: "active"; readonly minted: boolean }
  // No `openAck` arrived inside the deadline - the host never came up (or
  // never became reachable) while we watched.
  | { readonly kind: "unreachable" }
  // The connection opened but the host never reported a credential state:
  // an older host without the provision capability.
  | { readonly kind: "unsupported" }
  // The host asked, this run did not hand it a credential (authn unreachable,
  // mint rejected, or another client superseded us), AND no later ack
  // reported `active`. A supersede alone does not land here - the winner's
  // credential usually verifies on the next lap and reports `active`.
  | { readonly kind: "mint-unavailable" }
  // A credential was minted and pushed, but no subsequent ack reported
  // `active` inside the deadline.
  | { readonly kind: "not-adopted" }
  // Unexpected throw; the message is diagnostic only.
  | { readonly kind: "error"; readonly message: string };

export interface ProvisionHostCredentialOptions {
  readonly environment: Environment;
  readonly auth: HostAuth;
  // Overall budget covering host boot, mint, and verification together.
  readonly deadlineMs: number;
  // Human-facing phase lines; the caller routes them to its progress channel.
  readonly progress: (message: string) => void;
  readonly logger: ILogger;
}

const ENDPOINT_POLL_MS = 300;
const OPEN_ACK_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
// Fast reconnect cadence: the usual dial failure here is "host still
// booting", where waiting long between attempts only stretches the install.
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;
// How long a session is held open after the mint settles so the provision
// frame flushes before the verify reconnect. Not correctness-bearing - the
// verify ack is the real signal - just avoids closing under the write.
const PUSH_DRAIN_MS = 750;
// The ack's credential state is reported AFTER the transport reaches `open`,
// not before: `handleOpenAckFrame` transitions the connection first and calls
// `onHostCredentialAck` last, so status-open with no state seen yet is the
// normal ordering, not evidence the host reported none. This grace is what
// makes the distinction - reaching it means no state followed the open.
const SILENT_ACK_GRACE_MS = 100;
// Sessions are deadline-bounded anyway; the cap is a backstop against a
// pathological host that acks `missing` forever.
const MAX_SESSIONS = 4;

type ProbeRevalidator = {
  revalidateCurrentContext(): Promise<RevalidateOutcome>;
};

type AckObservation =
  | { readonly kind: "state"; readonly state: HostCredentialState }
  | { readonly kind: "opened-silent" }
  | { readonly kind: "fatal"; readonly reason: StreamCloseReason | null }
  | { readonly kind: "timeout" };

export async function provisionInstalledHostCredential(
  options: ProvisionHostCredentialOptions,
): Promise<HostCredentialProvisionOutcome> {
  const deadlineAt = Date.now() + options.deadlineMs;

  // The endpoint provider is synchronous, so a poller keeps a mutable slot
  // fresh (the monitor's pattern): the freshly-started host writes its pid
  // metadata some time after the service start, and dials retry through
  // `null` until it appears. A good endpoint is never overwritten with null -
  // a momentarily-absent pid file keeps the last-known URL.
  let endpoint: HostTransportEndpoint | null = null;
  let pollInFlight = false;
  const refreshEndpoint = async (): Promise<void> => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const metadata = await readHostPidMetadata(options.environment);
      if (
        metadata !== null &&
        isValidLocalHostWebsocketUrl(metadata.websocketUrl)
      ) {
        endpoint = {
          hostId: metadata.hostId,
          websocketUrl: metadata.websocketUrl,
        };
      }
    } catch (err) {
      options.logger.warn("Host credential provisioning endpoint poll failed", {
        environment: options.environment,
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      });
    } finally {
      pollInFlight = false;
    }
  };
  await refreshEndpoint();
  const poll = setInterval(() => {
    void refreshEndpoint();
  }, ENDPOINT_POLL_MS);

  // Routes each session's ack observation to the attempt currently waiting on
  // it; the client-level observer outlives individual sessions.
  let observeState: ((state: HostCredentialState) => void) | null = null;
  let mintInvoked = false;
  let mintSettled: Promise<HostCredentialMintOutcome> | null = null;
  const lease = new MutableBearerLease(options.auth.token, options.auth.userId);
  const innerMint = createCliHostCredentialMintFlow({
    authnBaseUrl: options.auth.authnBaseUrl,
    // The LIVE lease, not the token this call was handed: a revalidation
    // below can rotate the bearer mid-probe, and minting on the snapshot
    // would spend a token authn has already retired.
    bearer: () => readLeaseBearer(lease),
    diag: (message) => options.progress(message),
  });
  // The stored access token has a ~4h TTL, so an ordinary "already signed in"
  // install routinely starts this probe on an EXPIRED bearer - the common
  // case, not an edge one. `auth: null` (correct only for a client that has
  // no revalidator) would make that first UNAUTHORIZED terminal, and the host
  // would never be minted for at all. Route reconnect recovery through the
  // same locked, single-flight `rotate` the monitor uses, so a probe refresh
  // and a concurrent desktop refresh cannot double-spend the refresh token.
  const store = createCliCredentialsStore();
  // Named narrowing, as `monitor` does: the factory's return intersects
  // `AuthRevalidator`, whose `revalidateCurrentContext` is declared
  // `Promise<unknown>` for the unary path that ignores it, and the call
  // otherwise resolves to that looser overload.
  const revalidator: ProbeRevalidator = createStoreBackedRevalidator({
    store,
    lease,
  });
  const streamAuth: StreamAuthRevalidator = {
    revalidateForReconnect: () => revalidator.revalidateCurrentContext(),
  };

  const client = new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    endpoint: () => endpoint,
    bearer: () => lease,
    auth: streamAuth,
    hostCredentialMint: (request) => {
      mintInvoked = true;
      const settled = innerMint(request);
      mintSettled = settled;
      return settled;
    },
    onHostCredentialState: (hostId, state) => {
      options.logger.debug("Host credential provisioning observed ack state", {
        environment: options.environment,
        hostId,
        state,
      });
      if (observeState !== null) {
        observeState(state);
      }
    },
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: createWhatwgStreamWebSocketFactory(),
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: PING_INTERVAL_MS,
    pongTimeoutMs: PONG_TIMEOUT_MS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
  });

  const remaining = (): number => Math.max(0, deadlineAt - Date.now());

  try {
    let sawSilentOpen = false;
    // A mint that resolved without handing us a credential. NOT terminal on
    // its own: the same `unavailable` covers the 409 supersede, where another
    // client won the race and ITS credential is already on the way to the
    // host - so adoption still has to be verified before anything is called a
    // failure. Only an unverified run reports it.
    let mintUnavailable = false;
    // One place decides every non-`active` exit, so the loop end, the bound,
    // and a fatal close can never drift apart on what they report.
    const settledOutcome = (): HostCredentialProvisionOutcome => {
      if (mintUnavailable) {
        return { kind: "mint-unavailable" };
      }
      if (mintInvoked) {
        return { kind: "not-adopted" };
      }
      return sawSilentOpen ? { kind: "unsupported" } : { kind: "unreachable" };
    };
    for (let lap = 1; lap <= MAX_SESSIONS; lap++) {
      const remainingMs = remaining();
      if (remainingMs <= 0) {
        break;
      }
      const { observation, session } = await observeNextAck(
        client,
        (resolver) => {
          observeState = resolver;
        },
        remainingMs,
      );
      observeState = null;
      switch (observation.kind) {
        case "state": {
          if (observation.state === "active") {
            session.close();
            // `minted` claims THIS run provisioned it, so a mint that never
            // handed over a credential does not count - under a supersede the
            // host goes active on the winner's credential, and announcing it
            // as ours would be a lie the human line then prints.
            return {
              kind: "active",
              minted: mintInvoked && !mintUnavailable,
            };
          }
          // Non-active: the client is minting (first time) or re-delivering a
          // held credential. Wait for the mint to settle so the push happens
          // on the session we just held open, then close it and verify on the
          // next lap - stacking a second live session onto the handoff one
          // would route the verify ack ambiguously.
          if (mintSettled !== null) {
            const outcome = await settleMint(
              mintSettled,
              options.logger,
              remaining(),
            );
            mintSettled = null;
            // Fall through to the verification lap either way. A supersede
            // reads as `unavailable` here, and the winner's credential is
            // exactly what the next ack will report as `active`.
            mintUnavailable = outcome !== "provisioned";
          }
          await sleep(Math.min(PUSH_DRAIN_MS, remaining()));
          session.close();
          break;
        }
        case "opened-silent":
          // Keep looping rather than returning: an ack that races the grace
          // window resolves on the next lap; a genuinely older host keeps
          // opening silently until the deadline reports it.
          sawSilentOpen = true;
          break;
        case "fatal":
          options.logger.warn(
            "Host credential provisioning stream closed fatally",
            {
              environment: options.environment,
              reason:
                observation.reason !== null
                  ? JSON.stringify(observation.reason)
                  : null,
            },
          );
          return settledOutcome();
        case "timeout":
          return settledOutcome();
      }
    }
    return settledOutcome();
  } catch (err) {
    const error = errorFromUnknown(err);
    options.logger.warn("Host credential provisioning failed unexpectedly", {
      environment: options.environment,
      errorName: error.name,
      errorMessage: error.message,
    });
    return { kind: "error", message: error.message };
  } finally {
    clearInterval(poll);
    client.close("host-install-credential-provisioning-settled");
    // Stops any `commit-failed` continuation timer a revalidation armed;
    // without it the process keeps a timer alive past the probe.
    store.dispose();
  }
}

/**
 * Opens one probe session and resolves on the first credential-state ack, a
 * silent open (state never reported), a fatal close, or the bound. The session
 * is closed here on every path EXCEPT `state`: a non-active state needs the
 * session alive for the mint handoff, so it is returned for the caller's lap
 * to close once the handoff has drained.
 */
function observeNextAck(
  client: WsStreamClient<HostStreamRpcRegistry>,
  bindObserver: (resolver: (state: HostCredentialState) => void) => void,
  timeoutMs: number,
): Promise<{
  readonly observation: AckObservation;
  readonly session: IStreamSession;
}> {
  return new Promise<{
    readonly observation: AckObservation;
    readonly session: IStreamSession;
  }>((resolve) => {
    let settled = false;
    let silentTimer: NodeJS.Timeout | null = null;
    const session = client.subscribe("host.notifications.subscribe", {
      filter: "unread",
      initialLimit: 1,
    });
    const finish = (
      observation: AckObservation,
      closeSession: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      if (silentTimer !== null) clearTimeout(silentTimer);
      clearTimeout(bound);
      if (closeSession) session.close();
      resolve({ observation, session });
    };
    const bound = setTimeout(() => {
      finish({ kind: "timeout" }, true);
    }, timeoutMs);
    bindObserver((state) => {
      // Leave the session open: a non-active state is followed by the mint
      // handoff on this very session.
      finish({ kind: "state", state }, false);
    });
    session.onStatusChange(
      (status: StreamConnectionStatus, reason: StreamCloseReason | null) => {
        if (status === "open") {
          // The state callback fires just AFTER this status change (same tick,
          // end of `handleOpenAckFrame`), so arriving here proves nothing yet -
          // only surviving the grace without a state does.
          if (silentTimer === null && !settled) {
            silentTimer = setTimeout(() => {
              finish({ kind: "opened-silent" }, true);
            }, SILENT_ACK_GRACE_MS);
          }
          return;
        }
        if (
          status === "closed" &&
          reason !== null &&
          reason.kind === "fatalError"
        ) {
          finish({ kind: "fatal", reason }, true);
        }
        // `connecting` / `reconnecting` / a non-fatal close: the client keeps
        // retrying through the deadline - the host is likely still booting.
      },
    );
  });
}

/**
 * Awaits the mint, but never past `boundMs`.
 *
 * The overall deadline has to bind this too: a host that acks `missing` near
 * the end of the budget would otherwise let the mint's own HTTP timeout run
 * `host install` well past the deadline this module advertises. Abandoning a
 * mint costs nothing - it completes server-side regardless, and its credential
 * simply becomes the one a later client verifies.
 *
 * Both the rejection and the bound resolve to `unavailable`; the caller treats
 * that as "not provisioned BY US", never as proof the host has no credential.
 */
async function settleMint(
  mint: Promise<HostCredentialMintOutcome>,
  logger: ILogger,
  boundMs: number,
): Promise<"provisioned" | "unavailable"> {
  let timer: NodeJS.Timeout | null = null;
  const bound = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), boundMs);
  });
  try {
    // Handling the rejection inside the race (rather than around it) is what
    // keeps an abandoned mint's later failure from surfacing as an unhandled
    // rejection once we have stopped waiting on it.
    const settled = await Promise.race([
      mint.then(
        (outcome): "provisioned" | "unavailable" =>
          outcome.kind === "provisioned" ? "provisioned" : "unavailable",
        (err: unknown): "unavailable" => {
          logger.warn("Host credential provisioning mint flow threw", {
            errorName: errorFromUnknown(err).name,
            errorMessage: errorFromUnknown(err).message,
          });
          return "unavailable";
        },
      ),
      bound,
    ]);
    if (settled === "deadline") {
      logger.warn(
        "Host credential provisioning mint did not settle within the deadline",
        { boundMs },
      );
      return "unavailable";
    }
    return settled;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
