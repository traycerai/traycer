import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { HostCredentialState } from "@traycer/protocol/framework/stream-ws-protocol";
import { MutableBearerLease } from "../../../shared/auth/bearer-source";
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
  // The host asked, but minting failed (authn unreachable, mint rejected,
  // or another client superseded us).
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
  const innerMint = createCliHostCredentialMintFlow({
    authnBaseUrl: options.auth.authnBaseUrl,
    bearer: () => options.auth.token,
    diag: (message) => options.progress(message),
  });
  const lease = new MutableBearerLease(options.auth.token, options.auth.userId);

  const client = new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    endpoint: () => endpoint,
    bearer: () => lease,
    // Short-lived probe on a token minted or validated moments ago: an
    // UNAUTHORIZED here is a real answer, not an expiry to refresh past.
    auth: null,
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

  try {
    let sawSilentOpen = false;
    for (let lap = 1; lap <= MAX_SESSIONS; lap++) {
      const remainingMs = deadlineAt - Date.now();
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
            return { kind: "active", minted: mintInvoked };
          }
          // Non-active: the client is minting (first time) or re-delivering a
          // held credential. Wait for the mint to settle so the push happens
          // on the session we just held open, then close it and verify on the
          // next lap - stacking a second live session onto the handoff one
          // would route the verify ack ambiguously.
          if (mintSettled !== null) {
            const outcome = await settleMint(mintSettled, options.logger);
            mintSettled = null;
            if (outcome !== "provisioned") {
              session.close();
              return { kind: "mint-unavailable" };
            }
          }
          await sleep(PUSH_DRAIN_MS);
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
          return mintInvoked
            ? { kind: "not-adopted" }
            : { kind: "unreachable" };
        case "timeout":
          if (mintInvoked) {
            return { kind: "not-adopted" };
          }
          return sawSilentOpen
            ? { kind: "unsupported" }
            : { kind: "unreachable" };
      }
    }
    if (mintInvoked) {
      return { kind: "not-adopted" };
    }
    return sawSilentOpen ? { kind: "unsupported" } : { kind: "unreachable" };
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

async function settleMint(
  mint: Promise<HostCredentialMintOutcome>,
  logger: ILogger,
): Promise<"provisioned" | "unavailable"> {
  try {
    const outcome = await mint;
    return outcome.kind === "provisioned" ? "provisioned" : "unavailable";
  } catch (err) {
    logger.warn("Host credential provisioning mint flow threw", {
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return "unavailable";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
