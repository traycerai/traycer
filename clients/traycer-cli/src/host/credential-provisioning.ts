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
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
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
import { CLI_CLIENT_IDENTITY } from "../cli-version";

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
// lands on a live socket.
//
// The credential STATE rides the handshake and is observed before this
// method's version is even checked, so a host this build cannot subscribe to
// still reports whether it holds a credential. The HANDOVER does not: pushing
// a provision frame needs a live session, and this method's compatibility is
// what grants one. A mismatch is therefore reported as `unsupported` - we
// reached the host and learned its state, but this CLI build cannot carry the
// credential to it - rather than as an unreachable host. The signal for that
// is a WITHHELD mint: a non-active state after which the client never invoked
// the mint hook, which happens exactly when the client decided it cannot
// deliver (version mismatch tore the session down first, or the host's id
// predates the UUID format authn requires). Both are deterministic for this
// client, so a withheld mint also ends the laps - re-dialing cannot change
// the answer.
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
  // The host was reached but this client cannot credential it: it never
  // reported a credential state (an older host without the provision
  // capability), the probe's method failed version negotiation (the state
  // rides the handshake, but the handover needs a live session), or the
  // host's id predates the UUID format authn requires - no client can mint
  // for that last one.
  | { readonly kind: "unsupported" }
  // The host asked, this run did not hand it a credential - authn
  // unreachable, mint rejected, another client superseded us, or the mint
  // simply never settled inside the budget - AND no later ack reported
  // `active`. A supersede alone does not land here: the winner's credential
  // usually verifies on the next lap and reports `active`.
  | { readonly kind: "mint-unavailable" }
  // A credential definitively WAS minted (and pushed, or held for delivery),
  // but no subsequent ack reported `active` inside the deadline. Never
  // claimed for a mint whose outcome is unknown - that is `mint-unavailable`.
  | { readonly kind: "not-adopted" }
  // The stored sign-in is dead: the host rejected the bearer and refreshing
  // it was terminally rejected too (revoked or expired refresh family).
  // Distinct from every kind above because it is the one outcome that does
  // NOT self-heal - no later client can mint on a dead credential either, so
  // the human line has to say `traycer login` rather than "a client will
  // sort this out". Also produced by the CALLER when the stored sign-in
  // disappeared between its pre-flight and this probe (a concurrent sign-out
  // or an unreadable credentials file) - same remedy, same line.
  | { readonly kind: "unauthorized" }
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
// The ack's credential state is reported BEFORE the transport reaches `open`:
// `handleOpenAckFrame` reports the state first (ahead of even the version
// check) and only then completes the subscribe and transitions. So by the
// time the status listener sees `open`, a state-carrying ack has already
// settled the lap, and this grace only ever runs out on an ack that
// genuinely carried no state - an older host without the provision
// capability. It stays a timer (not an instant call) as a belt against the
// ordering changing again.
const SILENT_ACK_GRACE_MS = 100;
// Verification laps run until the DEADLINE, not to a lap count. A fixed cap
// bounded the wrong axis: four laps of a fast-acking host is a few seconds,
// so a host that needed longer than that to persist and advertise its
// credential got `not-adopted` - "did not adopt it in time" - with most of
// the 30s budget still unspent, and a supersede whose winner was still
// handing off got `mint-unavailable` the same way. Both reports blame a host
// for missing a deadline we never actually gave it.
//
// What the cap was really protecting is reconnect CHURN, which this paces
// directly: each lap waits before re-dialing, doubling to a ceiling. That
// bounds dial rate without capping how long we are willing to keep watching,
// and the deadline (checked every lap, and passed to each ack wait) remains
// the single stop condition.
const VERIFY_BACKOFF_INITIAL_MS = 250;
const VERIFY_BACKOFF_MAX_MS = 2_000;
// ...with one exception, because the deadline is only the right bound for a
// question whose answer can still CHANGE. Waiting for a host to adopt a
// credential is such a question. A connection that opens without the ack
// ever carrying a credential state is not: that is a property of the host's
// build, and re-dialing cannot alter it - the same reasoning that already
// ends the laps on a withheld mint. A single silent open is not conclusive
// (a state-carrying ack can lose the race with the grace timer), so this
// takes consecutive ones - reset by any ack that does carry a state - and
// then stops rather than spending the rest of the budget re-confirming a
// constant. Without it, `host install` against an older host would sit for
// the full deadline before printing that it cannot be credentialed.
const SILENT_OPEN_CONFIRMATIONS = 3;

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
  // Cancels the probe's own remote work - the mint's HTTP request and the
  // locked credential rotation - when the budget runs out. Bounding the
  // AWAITS alone is not enough: the CLI exits by draining the event loop
  // (`runner/exit.ts` sets `process.exitCode`), so an abandoned fetch or a
  // lock poll left running keeps `host install` visibly sitting at the
  // prompt for up to tens of seconds after it printed its result. Abort maps
  // to TRANSIENT outcomes everywhere it lands (lock wait -> `lock-busy`,
  // refresh fetch -> `refresh-network`, mint fetch -> `network-error`), so
  // cancelling can never fabricate a "rejected"/unauthorized report.
  const probeAbort = new AbortController();

  // Everything acquirable is declared here and ACQUIRED INSIDE the `try`, so
  // no setup failure can escape this module. The caller runs after the bytes
  // are swapped and the service started, so a throw out of a best-effort
  // probe would report a completed install as a failed one - and a throw
  // between two acquisitions would leak the earlier one. `finally` releases
  // whatever was actually obtained.
  let poll: NodeJS.Timeout | null = null;
  let store: CredentialsMutationStore | null = null;
  let client: WsStreamClient<HostStreamRpcRegistry> | null = null;
  // The most recent revalidation, awaited (bounded) before returning so a
  // refresh this probe started does not outlive the call.
  let inFlightRevalidation: Promise<RevalidateOutcome> | null = null;
  // Set when a revalidation came back terminally `rejected`.
  let credentialRejected = false;

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
  // Routes each session's ack observation to the attempt currently waiting on
  // it; the client-level observer outlives individual sessions.
  let observeState: ((state: HostCredentialState) => void) | null = null;
  let mintInvoked = false;
  let mintSettled: Promise<HostCredentialMintOutcome> | null = null;
  // Our mint definitively returned a credential / definitively did not
  // (rejected, superseded, network). A mint abandoned at the deadline is
  // NEITHER until its promise actually settles - `recordMintOutcome` below
  // keeps listening so `minted` and the mint-unavailable report track what
  // actually happened rather than what the deadline happened to see.
  let mintProvisioned = false;
  let mintUnavailable = false;
  // A non-active state after which the client never invoked the mint hook:
  // it decided it cannot deliver (version-incompatible ack, or a non-UUID
  // host id). Deterministic per client - ends the laps.
  let mintWithheld = false;
  // Authn answered the mint with 401/403. Unlike every other mint failure
  // this one is NOT client-local - the same stored bearer fails for every
  // client - so it is confirmed via a rotation below before the probe
  // decides between "a later client will heal this" and "sign in again".
  let mintUnauthorized = false;
  // The mint-401 confirmation ROTATES a single-use refresh family, so it may
  // run at most once per probe. `mintUnauthorized` never clears (the 401 is
  // a fact about this run), so without this the confirm branch would re-fire
  // on every later non-active lap, spending a fresh refresh family each time
  // and racing whatever other signed-in client holds the same one. One
  // rotation is all the branch ever needed: it asks a single question - is
  // this sign-in dead? - and that answer does not change lap to lap.
  let mintUnauthorizedConfirmed = false;
  // The host demonstrably ANSWERED us, even though no ack ever carried a
  // credential state: a reconnect revalidation only fires because the host
  // rejected our bearer, which is itself proof it was listening. Tracked
  // because the terminal fallback is `unreachable`, whose copy says the host
  // never came up - false on its face once the host has spoken to us.
  let hostAnswered = false;
  // CONSECUTIVE silent opens - reset by any ack that carries a state, so an
  // occasional ack losing the race with the grace timer cannot accumulate
  // into a false "this host has no credential capability" verdict.
  let consecutiveSilentOpens = 0;
  const lease = new MutableBearerLease(options.auth.token, options.auth.userId);
  const remaining = (): number => Math.max(0, deadlineAt - Date.now());

  try {
    await refreshEndpoint();
    poll = setInterval(() => {
      void refreshEndpoint();
    }, ENDPOINT_POLL_MS);

    const innerMint = createCliHostCredentialMintFlow({
      authnBaseUrl: options.auth.authnBaseUrl,
      // The LIVE lease, not the token this call was handed: a revalidation
      // below can rotate the bearer mid-probe, and minting on the snapshot
      // would spend a token authn has already retired.
      bearer: () => readLeaseBearer(lease),
      diag: (message) => options.progress(message),
      signal: probeAbort.signal,
      // The install's consequence, not the connection-lease one: this probe
      // closes its connection on purpose, and the install already succeeded.
      unavailableNote: "continuing - the host stays unprovisioned for now.",
      onUnauthorized: () => {
        mintUnauthorized = true;
      },
    });
    // The stored access token has a ~4h TTL, so an ordinary "already signed
    // in" install routinely starts this probe on an EXPIRED bearer - the
    // common case, not an edge one. `auth: null` (correct only for a client
    // that has no revalidator) would make that first UNAUTHORIZED terminal,
    // and the host would never be minted for at all. Route reconnect recovery
    // through the same locked, single-flight `rotate` the monitor uses, so a
    // probe refresh and a concurrent desktop refresh cannot double-spend the
    // refresh token.
    store = createCliCredentialsStore();
    // Named narrowing, as `monitor` does: the factory's return intersects
    // `AuthRevalidator`, whose `revalidateCurrentContext` is declared
    // `Promise<unknown>` for the unary path that ignores it, and the call
    // otherwise resolves to that looser overload.
    const revalidator: ProbeRevalidator = createStoreBackedRevalidator({
      store,
      lease,
      signal: probeAbort.signal,
    });
    const streamAuth: StreamAuthRevalidator = {
      revalidateForReconnect: () => {
        // Reaching this callback at all means the host answered and rejected
        // the bearer we presented - it was up and talking, whatever happens
        // to the refresh below. Recorded before the early return so even a
        // rotation the deadline cannot cover still counts as contact.
        hostAnswered = true;
        // Never START a rotation the deadline cannot cover. The CLI sets
        // `process.exitCode` rather than calling `process.exit` (see
        // `runner/exit.ts`), so the process waits for the event loop to
        // drain: a refresh begun as the budget ran out would keep
        // `host install` alive past its advertised bound, and disposing the
        // store does not cancel one already in flight.
        if (remaining() <= 0) {
          return Promise.resolve<RevalidateOutcome>("rejected");
        }
        const settled = revalidator.revalidateCurrentContext();
        inFlightRevalidation = settled;
        // A terminal rejection means the stored sign-in is dead, which the
        // fatal close alone cannot tell us apart from an unreachable host.
        void settled.then((outcome) => {
          if (outcome === "rejected") {
            credentialRejected = true;
          }
        });
        return settled;
      },
    };

    const activeClient = new WsStreamClient<HostStreamRpcRegistry>({
      registry: hostStreamRpcRegistry,
      endpoint: () => endpoint,
      bearer: () => lease,
      auth: streamAuth,
      // No tracker wired yet on the CLI side: this is a short-lived
      // provisioning probe, not a long-lived session a user could rescue by
      // fixing their clock mid-run, and nothing here yet feeds server-time
      // samples. `null` keeps the pre-existing behaviour exactly.
      clock: null,
      hostCredentialMint: (request) => {
        mintInvoked = true;
        const settled = innerMint(request);
        mintSettled = settled;
        return settled;
      },
      onHostCredentialState: (hostId, state) => {
        options.logger.debug(
          "Host credential provisioning observed ack state",
          { environment: options.environment, hostId, state },
        );
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
      clientIdentity: CLI_CLIENT_IDENTITY,
    });
    client = activeClient;

    let sawSilentOpen = false;
    // Records what OUR mint actually returned, whenever that happens - at the
    // bounded wait below, or after the deadline abandoned it. `unavailable`
    // covers the 409 supersede too (another client won the race and ITS
    // credential is on the way), so adoption is still verified before
    // anything is called a failure; only an unverified run reports it.
    const recordMintOutcome = (
      mint: Promise<HostCredentialMintOutcome>,
    ): void =>
      void mint.then(
        (outcome) => {
          if (outcome.kind === "provisioned") {
            mintProvisioned = true;
          } else {
            mintUnavailable = true;
          }
        },
        (err: unknown) => {
          options.logger.warn("Host credential provisioning mint flow threw", {
            errorName: errorFromUnknown(err).name,
            errorMessage: errorFromUnknown(err).message,
          });
          mintUnavailable = true;
        },
      );
    // One place decides every non-`active` exit, so the loop end, the bound,
    // and a fatal close can never drift apart on what they report.
    const settledOutcome = (): HostCredentialProvisionOutcome => {
      // First: a dead sign-in explains every other symptom below it (the
      // stream never opens, nothing is ever minted) and is the only one that
      // does not self-heal, so it must not be reported as "unreachable".
      if (credentialRejected) {
        return { kind: "unauthorized" };
      }
      if (mintUnavailable) {
        return { kind: "mint-unavailable" };
      }
      // `not-adopted` claims a credential existed and was pushed (or held for
      // delivery), so it needs the mint to have definitively PROVISIONED. A
      // mint still pending at the deadline proved neither - "the handoff did
      // not complete" is all that is known, which is `mint-unavailable`'s
      // line, not an adoption failure the host can be blamed for.
      if (mintProvisioned) {
        return { kind: "not-adopted" };
      }
      if (mintInvoked) {
        return { kind: "mint-unavailable" };
      }
      // Both mean the host WAS reached and cannot be credentialed by this
      // client: it opened without ever reporting a state, or it reported a
      // non-active state whose mint the client withheld (version mismatch or
      // a non-UUID host id).
      if (mintWithheld || sawSilentOpen) {
        return { kind: "unsupported" };
      }
      // The host spoke to us but never got as far as reporting a credential
      // state - the shape of an expired stored bearer whose refresh could
      // not complete (authn unreachable), where the host answers
      // UNAUTHORIZED, the revalidation returns a transient failure, and the
      // stream just reconnects until the budget runs out. `unreachable`
      // would say "the host did not come up in time" about a host that
      // answered every single dial; what actually failed is the handoff, and
      // that is `mint-unavailable`'s line - self-heal included, since a
      // later client with a live token mints for it normally.
      if (hostAnswered) {
        return { kind: "mint-unavailable" };
      }
      return { kind: "unreachable" };
    };
    // True when NOTHING observed this run accounts for how it ended - no
    // dead sign-in, no mint history, no capability gap. Deliberately does
    // not consult `hostAnswered`: this asks "is the outcome unexplained?",
    // and contact alone explains nothing. It is exactly the condition under
    // which `settledOutcome` would have reported `unreachable` before the
    // `hostAnswered` fallback existed, which is what the fatal-close arm
    // needs to decide whether the close code is the most informative thing
    // this probe can report.
    const nothingExplainsTheClose = (): boolean =>
      !credentialRejected &&
      !mintUnavailable &&
      !mintProvisioned &&
      !mintInvoked &&
      !mintWithheld &&
      !sawSilentOpen;
    let verifyBackoffMs = VERIFY_BACKOFF_INITIAL_MS;
    for (;;) {
      const remainingMs = remaining();
      if (remainingMs <= 0) {
        break;
      }
      const { observation, session } = await observeNextAck(
        activeClient,
        (resolver) => {
          observeState = resolver;
        },
        remainingMs,
      );
      observeState = null;
      switch (observation.kind) {
        case "state": {
          // This ack carried a state, so any silent-open streak was a race
          // with the grace timer, not a capability gap - start it over.
          consecutiveSilentOpens = 0;
          if (observation.state === "active") {
            session.close();
            // `minted` claims THIS run provisioned it, so only a mint that
            // definitively returned a credential counts - under a supersede
            // the host goes active on the winner's credential, and announcing
            // it as ours would be a lie the human line then prints. A mint
            // that outlived its bounded wait still counts once it lands:
            // `recordMintOutcome` kept listening, and a held credential the
            // client flushed on a later ack is ours.
            return {
              kind: "active",
              minted: mintProvisioned,
            };
          }
          // Non-active with the mint hook never invoked: the client decided
          // it cannot deliver - the ack failed this method's version check
          // (the session is already torn down by the time this continuation
          // runs; the fatal close raced this state observation and lost), or
          // the host's id predates the UUID format. Both are deterministic
          // for this client, so further laps cannot change the answer - stop
          // burning the budget on them. (On a lap AFTER a mint,
          // `mintInvoked` is true and a quiet ack is the normal
          // re-verification path, not a withheld mint.)
          if (!mintInvoked) {
            mintWithheld = true;
            session.close();
            break;
          }
          // Non-active: the client is minting (first time) or re-delivering a
          // held credential. Wait for the mint to settle so the push happens
          // on the session we just held open, then close it and verify on the
          // next lap - stacking a second live session onto the handoff one
          // would route the verify ack ambiguously.
          if (mintSettled !== null) {
            // Annotated: `mintSettled` is only ever assigned inside the
            // `hostCredentialMint` callback, so TS's linear flow analysis
            // narrows the declared `| null` down to `null` here and the
            // non-null branch to `never`.
            const pendingMint: Promise<HostCredentialMintOutcome> = mintSettled;
            mintSettled = null;
            recordMintOutcome(pendingMint);
            const mintBoundMs = remaining();
            if (mintBoundMs > 0) {
              // Fall through to the verification lap either way once the
              // mint settles or the bound fires. A supersede reads as
              // `unavailable` (via `recordMintOutcome`), and the winner's
              // credential is exactly what the next ack will report as
              // `active`. A `deadline` here deliberately records NOTHING -
              // the mint's own settlement does, whenever it lands - so a
              // tight bound can neither manufacture a `mint-unavailable`
              // report nor suppress a truthful `minted`.
              await settleMint(pendingMint, options.logger, mintBoundMs);
            }
          }
          // A 401 from AUTHN on the mint (fired synchronously before the
          // flow resolved, so the flag is settled here whenever the mint is)
          // reaches this probe as a plain `unavailable` - but it is the one
          // mint failure that is not client-local: the host still accepted
          // the very same bearer to open this stream, which is the shape of
          // a token authn has revoked out from under an unexpired JWS. The
          // stream's own revalidator never fires in that shape (the host
          // keeps saying yes), so confirm here with one rotation: a terminal
          // rejection means the sign-in is dead and every client's mint
          // would 401 the same way - report `unauthorized`, because the
          // self-heal promise would be false - while a successful rotation
          // means a later client CAN mint, and `mint-unavailable` stands.
          if (
            mintUnauthorized &&
            !mintUnauthorizedConfirmed &&
            !credentialRejected &&
            remaining() > 0
          ) {
            // Latched BEFORE awaiting: the rotation is the side effect being
            // guarded, so a second lap must not slip past this branch while
            // the first is still settling.
            mintUnauthorizedConfirmed = true;
            const confirm = revalidator.revalidateCurrentContext();
            inFlightRevalidation = confirm;
            const confirmBound = cancelableDelay(remaining());
            try {
              const outcome = await Promise.race([
                confirm,
                confirmBound.promise.then(
                  (): RevalidateOutcome => "network-error",
                ),
              ]);
              if (outcome === "rejected") {
                credentialRejected = true;
              }
            } finally {
              confirmBound.cancel();
            }
          }
          await sleep(Math.min(PUSH_DRAIN_MS, remaining()));
          session.close();
          break;
        }
        case "opened-silent":
          // Keep looping rather than returning: an ack that races the grace
          // window resolves on the next lap. A genuinely older host instead
          // keeps opening silently, and `SILENT_OPEN_CONFIRMATIONS` decides
          // when that has been established (checked below, with the other
          // determinism exit).
          sawSilentOpen = true;
          consecutiveSilentOpens += 1;
          break;
        case "fatal": {
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
          // A version mismatch on the probe's own transport method is NOT an
          // unreachable host - we reached it, and it may well advertise the
          // credential capability. Retrying cannot help (the mismatch is a
          // property of this CLI build against this host), so report it as
          // the capability gap it is and let the self-heal cover it. (This
          // arm only fires for an ack that carried NO state - a state-carrying
          // incompatible ack settles the lap as `state` first, and lands in
          // `unsupported` through the withheld-mint path instead.)
          const reason = observation.reason;
          if (reason !== null && reason.kind === "fatalError") {
            if (reason.details.code === "INCOMPATIBLE") {
              return { kind: "unsupported" };
            }
            // Any other terminal fatal still PROVES the host answered - a
            // frame carried it. When nothing above explains the close (no
            // rejected sign-in, no mint history), "the host did not come up"
            // would be false on its face; report the close for what it is.
            //
            // Asked directly rather than by testing `settledOutcome()` for
            // `unreachable`: the `hostAnswered` fallback also resolves an
            // otherwise-unexplained probe, so keying off the returned kind
            // would swallow this close code the moment a reconnect
            // revalidation had fired. The close code is strictly the more
            // diagnostic of the two, and both say "reached, not credentialed".
            if (nothingExplainsTheClose()) {
              return {
                kind: "error",
                message: `the host closed the stream (${reason.details.code})`,
              };
            }
            return settledOutcome();
          }
          return settledOutcome();
        }
        case "timeout":
          return settledOutcome();
      }
      // Both exits here are the same idea: the answer is a constant for this
      // client, so the remaining laps would spend the budget re-measuring it.
      // A withheld mint is deterministic on the first observation (the
      // version mismatch and the id format do not change between dials); a
      // silent open needs a few consecutive ones to rule out an ack that
      // simply lost the race with the grace timer.
      if (mintWithheld || consecutiveSilentOpens >= SILENT_OPEN_CONFIRMATIONS) {
        break;
      }
      // Pace the re-dial. Without this the loop is bounded only by the
      // deadline, so a host that opens silently (no state, ~100ms grace per
      // lap) would be re-dialed hundreds of times across the budget. The
      // wait is clamped to the remaining budget so pacing can never push the
      // probe past its own deadline, and `sleep(0)` simply falls through to
      // the `remainingMs <= 0` break at the top.
      await sleep(Math.min(verifyBackoffMs, remaining()));
      verifyBackoffMs = Math.min(verifyBackoffMs * 2, VERIFY_BACKOFF_MAX_MS);
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
    // Null-checked because setup now happens inside the `try`: a throw part
    // way through it must still release whatever was already acquired.
    if (poll !== null) {
      clearInterval(poll);
    }
    if (inFlightRevalidation !== null) {
      // Annotated for the same reason as `pendingMint`: assigned only inside
      // a callback, so TS's linear flow narrows this branch to `never`.
      const pendingRevalidation: Promise<RevalidateOutcome> =
        inFlightRevalidation;
      // A revalidation only ever STARTS with budget left, so the remainder is
      // the most a started rotation gets to land cleanly (a landed rotation
      // leaves the credentials file consistent; an interrupted one leaves its
      // spent-base marker armed for the next process to resolve). Whatever is
      // still pending when the bound fires is cancelled just below.
      // A CANCELABLE deadline, not `sleep()`: an uncleared `setTimeout` keeps
      // the Node event loop alive, and the CLI exits by draining it rather
      // than calling `process.exit`. A plain race would therefore hold
      // `host install` open for the whole remaining budget every time the
      // revalidation won - the exact hang this block exists to prevent.
      const deadline = cancelableDelay(remaining());
      try {
        await Promise.race([
          pendingRevalidation.catch(() => undefined),
          deadline.promise,
        ]);
      } finally {
        deadline.cancel();
      }
    }
    if (client !== null) {
      client.close("host-install-credential-provisioning-settled");
    }
    // Waiting is over; now cancel the WORK. Anything still in flight - a
    // rotation the bounded wait above gave up on, a mint the deadline
    // abandoned - has no session left to deliver to, and left running it
    // keeps the drain-to-exit CLI sitting at the prompt for up to its own
    // HTTP timeout. Abort maps to transient outcomes everywhere (see the
    // controller's declaration), so this cannot rewrite what the probe
    // already decided to report.
    probeAbort.abort();
    // Stops any `commit-failed` continuation timer a revalidation armed;
    // without it the process keeps a timer alive past the probe.
    if (store !== null) {
      store.dispose();
    }
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
          // A state-carrying ack settles this promise BEFORE `open` fires
          // (`handleOpenAckFrame` reports the credential state first, ahead
          // of the version check), so arming the grace here only matters for
          // an ack that carried no state - it resolves `opened-silent` once
          // the grace passes without one.
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
 * `host install` well past the deadline this module advertises.
 *
 * Purely a pacing bound: outcome recording is `recordMintOutcome`'s job
 * (attached to the same promise before this is called), so a deadline here
 * abandons the WAIT, never the bookkeeping - and the abandoned request itself
 * is cancelled by the probe's abort on the way out.
 */
async function settleMint(
  mint: Promise<HostCredentialMintOutcome>,
  logger: ILogger,
  boundMs: number,
): Promise<void> {
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
        (): "settled" => "settled",
        (): "settled" => "settled",
      ),
      bound,
    ]);
    if (settled === "deadline") {
      logger.warn(
        "Host credential provisioning mint did not settle within the deadline",
        { boundMs },
      );
    }
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A delay whose timer can be cleared when it loses a race.
 *
 * `sleep()` is fine where the wait is always awaited to completion (the push
 * drain), but a losing arm of a `Promise.race` leaves its `setTimeout`
 * pending, and a pending timer keeps the Node event loop alive. The CLI sets
 * `process.exitCode` rather than calling `process.exit` (`runner/exit.ts`), so
 * that leak becomes a visible hang: the command sits there until the timer
 * fires.
 */
function cancelableDelay(ms: number): {
  readonly promise: Promise<void>;
  readonly cancel: () => void;
} {
  let handle: NodeJS.Timeout | null = null;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: (): void => {
      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
    },
  };
}
