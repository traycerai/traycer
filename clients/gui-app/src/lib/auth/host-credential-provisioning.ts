import type {
  HostCredentialMintFlow,
  HostCredentialMintOutcome,
  HostCredentialMintRequest,
} from "@traycer-clients/shared/host-transport/host-credential-mint-flow";

/**
 * App-wide policy for delegated host-credential provisioning.
 *
 * `WsStreamClient` de-duplicates only within one instance, and the renderer
 * routinely holds SEVERAL clients against the same host at once - the app-wide
 * stream provider, a durable per-tab chat transport, a one-shot worktree stream.
 * Each would independently notice a `missing` host credential and each would
 * mint. `buildHostStreamClient` hands every client the same flow from here, so
 * "one mint in flight per host" holds no matter how many transports exist.
 *
 * That guarantee is about CORRECTNESS, not about interruption: the server
 * supersedes older credentials for a host on every mint, so simultaneous mints
 * would revoke one another and resolve as 409s - leaving the host with nothing.
 * (Provisioning itself is silent; there is no dialog to de-duplicate any more.)
 *
 * The mechanism (which auth service) is supplied at runtime by the provisioning
 * provider: this module deliberately owns no React state, so a transport
 * constructed outside a component tree still gets the same policy.
 */
export type HostCredentialMintRunner = (
  request: HostCredentialMintRequest,
) => Promise<HostCredentialMintOutcome>;

let runner: HostCredentialMintRunner | null = null;
/**
 * Bumped by every reset. An attempt that was already running when the identity
 * changed must not hand its credential to a transport that is now serving
 * someone else - the mint was authorized by the previous user's bearer.
 */
let generation = 0;

/**
 * Installs (or clears) the runtime that actually mints. Called by the
 * provisioning provider on mount/unmount. With no runner installed - dev shells,
 * tests, the window before auth is wired - every request resolves `unavailable`,
 * which leaves hosts on the client-lease fallback rather than failing anything.
 */
export function setHostCredentialMintRunner(
  next: HostCredentialMintRunner | null,
): void {
  runner = next;
}

/**
 * Abandons in-flight attempts. Must run on sign-out: a mint authorized by the
 * departing user's bearer must never be handed to a transport now serving the
 * next one.
 *
 * Note what is deliberately NOT here any more: a memo of hosts already asked
 * about. That existed so a decline could not re-raise a dialog on every
 * reconnect. With provisioning silent there is nothing to decline, and a failed
 * attempt SHOULD be retryable by a later transport - a transient network error
 * on first connect should not strand a host on the client lease for the rest of
 * the app run.
 */
export function resetHostCredentialProvisioning(): void {
  generation += 1;
  attemptsByHostId.clear();
  awaitingAdoptionByHostId.clear();
  mintBackoffByHostId.clear();
}

/**
 * Escalating floor between COMPLETED mints for one host.
 *
 * The re-arm edge (`ws-stream-client` clears its per-host attempt marker on
 * every transition back into `missing`/`needs-reauth`) deliberately makes the
 * silent mint repeatable - a burn must be repairable more than once per app
 * run. But repeatable with only the 60s adoption TTL as a floor means a cloud
 * that persistently refuses delegated credentials (a server-side bug, a
 * revoked account in a half-signed-out app) settles into mint -> adopt ->
 * refuse -> burn -> re-arm -> mint, ~1440 credentials per host per day, each
 * lap revoking its predecessor. Each lap doubles the wait instead: 1m, 2m,
 * 4m, ... capped at an hour, and a quiet stretch twice the current wait
 * resets the ladder so a genuinely recovered cloud gets prompt service.
 */
const MINT_BACKOFF_BASE_MS = 60_000;
const MINT_BACKOFF_MAX_MS = 3_600_000;

const mintBackoffByHostId = new Map<
  string,
  {
    readonly completedMints: number;
    readonly lastMintedAt: number;
    readonly generation: number;
  }
>();

function mintBackoffWaitMs(completedMints: number): number {
  if (completedMints <= 1) return 0;
  return Math.min(
    MINT_BACKOFF_MAX_MS,
    MINT_BACKOFF_BASE_MS * 2 ** (completedMints - 2),
  );
}

/** Whether a fresh mint for `hostId` must wait out the escalation ladder. */
function mintInBackoff(hostId: string): boolean {
  const entry = mintBackoffByHostId.get(hostId);
  if (entry === undefined) {
    return false;
  }
  if (entry.generation !== generation) {
    mintBackoffByHostId.delete(hostId);
    return false;
  }
  const waitMs = mintBackoffWaitMs(entry.completedMints);
  const elapsed = Date.now() - entry.lastMintedAt;
  if (elapsed >= Math.max(waitMs, MINT_BACKOFF_BASE_MS) * 2) {
    // Quiet long enough: the flapping stopped. Forget the ladder entirely so
    // the next genuine loss is served promptly.
    mintBackoffByHostId.delete(hostId);
    return false;
  }
  return elapsed < waitMs;
}

function recordCompletedMint(hostId: string): void {
  const entry = mintBackoffByHostId.get(hostId);
  const completedMints =
    entry !== undefined && entry.generation === generation
      ? entry.completedMints + 1
      : 1;
  mintBackoffByHostId.set(hostId, {
    completedMints,
    lastMintedAt: Date.now(),
    generation,
  });
}

/**
 * How long a freshly minted credential is treated as still on its way to the
 * host before another mint is allowed.
 *
 * This is now the ONLY thing that ends a claim - see
 * {@link noteHostCredentialState} for why no report is trusted to end one
 * early. So it is a real schedule rather than a backstop, and its size is the
 * trade: long enough to cover mint-to-adoption on a slow link, short enough
 * that a host whose delivery genuinely died is asking again within a minute.
 */
const PENDING_ADOPTION_TTL_MS = 60_000;

/**
 * Per host: when the claim was taken, and the mint-flow generation it was
 * taken under.
 *
 * The window this closes is real and narrow: `attemptsByHostId` is cleared
 * when the mint SETTLES, but the host is only provisioned once a transport
 * actually carries the frame to it and it adopts. In between, the app looks to
 * any newly-constructed transport exactly as it does before a first mint - and
 * a per-`WsStreamClient` "already attempted" set cannot help, because a new
 * client starts with an empty one. Two mints then race, and superseding mints
 * can revoke one another, which can leave the host holding neither.
 *
 * Deliberately app-wide, like `attemptsByHostId` beside it and for the same
 * reason: the renderer holds several transports against one host, so any bound
 * kept per transport is not a bound at all.
 *
 * The GENERATION half covers a claim outliving the account it was taken for:
 * it is only ever honoured within its own epoch.
 */
const awaitingAdoptionByHostId = new Map<
  string,
  { readonly mintedAt: number; readonly generation: number }
>();

/**
 * Reports what a host says about its credential.
 *
 * DELIBERATELY INERT for claim release, and that is the fix rather than an
 * omission. `active` looked like positive proof a minted credential had
 * landed, so it released the claim early - but the report carries no
 * provenance: not which credential it is about, not which transport observed
 * it, not when it was produced. Sockets report their `openAck` state
 * independently with no cross-socket ordering, so a delayed `active(A)` -
 * observed before A was burned, delivered after B was minted - released B's
 * claim, and a third socket's already-formed `needs-reauth` then minted C and
 * superseded B. No account switch is involved, so the generation guard cannot
 * see it either.
 *
 * With nothing on the report to correlate against, the honest move is not to
 * trust it: the claim's TTL owns expiry on its own. The cost is bounded -
 * after an adopt-then-burn inside one TTL window, a legitimate re-mint waits
 * out the remainder - and it is paid in a delay rather than in two credentials
 * revoking each other.
 *
 * Kept as a function, and still called, so the transport keeps one place to
 * report into if a future frame ever carries the credential's identity.
 */
export function noteHostCredentialState(
  _hostId: string,
  _state: "missing" | "active" | "needs-reauth",
): void {
  // Intentionally empty. See above.
}

/**
 * Whether a mint for `hostId` is still awaiting adoption, expiring the claim
 * if it has outlived {@link PENDING_ADOPTION_TTL_MS} or belongs to a
 * superseded generation.
 */
function mintAwaitingAdoption(hostId: string): boolean {
  const claim = awaitingAdoptionByHostId.get(hostId);
  if (claim === undefined) {
    return false;
  }
  if (
    claim.generation !== generation ||
    Date.now() - claim.mintedAt >= PENDING_ADOPTION_TTL_MS
  ) {
    awaitingAdoptionByHostId.delete(hostId);
    return false;
  }
  return true;
}

/**
 * A running attempt, plus the per-caller gate that decides which single caller
 * is handed the credential itself.
 */
interface HostCredentialAttempt {
  /** Resolves once, for everyone; carries the real outcome. */
  readonly settled: Promise<HostCredentialMintOutcome>;
  /** Applied per caller - so it must be `.then`-ed by each of them separately. */
  readonly claim: (
    outcome: HostCredentialMintOutcome,
  ) => HostCredentialMintOutcome;
}

const attemptsByHostId = new Map<string, HostCredentialAttempt>();

export const appHostCredentialMintFlow: HostCredentialMintFlow = (request) => {
  const hostId = request.hostId;
  if (mintAwaitingAdoption(hostId)) {
    // A credential was minted for this host moments ago and has not been seen
    // adopted yet. The ask that brought us here is stale by construction - the
    // host formed it before the credential now in flight reached it - and
    // minting a second one would supersede the first, with each able to revoke
    // the other. Wait for the delivery already under way.
    //
    // NOT `unavailable`: the caller must not count this as its one attempt.
    // See the outcome's own doc - answering `unavailable` here can strand a
    // host whose only surviving transport asked during the claim window.
    return Promise.resolve({ kind: "pending-elsewhere" });
  }
  const existing = attemptsByHostId.get(hostId);
  if (existing !== undefined) {
    // A second transport noticed the same host mid-mint. Join the first attempt
    // instead of racing it. Note the `.then(claim)` here rather than returning
    // the stored promise directly: the claim has to run once PER CALLER, and a
    // shared promise's own `.then` would run only once.
    return existing.settled.then(existing.claim);
  }
  if (mintInBackoff(hostId)) {
    // The escalation ladder says this host has been minting too often to be
    // healthy. `pending-elsewhere`, not `unavailable`, for the same reason as
    // the adoption claim above: the caller keeps its attempt, and the next
    // credential-state edge after the window re-asks.
    return Promise.resolve({ kind: "pending-elsewhere" });
  }
  const current = runner;
  if (current === null) {
    return Promise.resolve({ kind: "unavailable" });
  }

  const startedAt = generation;
  // Registered in `attemptsByHostId` BELOW, synchronously, so a second local
  // transport joins this attempt rather than starting its own.
  const settled = current(request)
    .catch((): HostCredentialMintOutcome => ({ kind: "unavailable" }))
    .then((outcome): HostCredentialMintOutcome => {
      if (generation !== startedAt) {
        // A reset (sign-out, or a switch to another account) overtook this
        // attempt. The credential was minted under an identity that is gone, so
        // do not hand it to a transport that is now serving someone else. The
        // host would reject it anyway - it asserts the access token's `id`
        // matches its own owner-gated identity - but dropping it here keeps a
        // dead 30-day refresh JWE from travelling at all.
        return { kind: "unavailable" };
      }
      attemptsByHostId.delete(hostId);
      if (outcome.kind === "provisioned") {
        // The attempt is over but the DELIVERY is not: the credential still
        // has to ride a live socket to the host and be adopted. Hold the claim
        // across that gap - it is exactly the window a second transport would
        // otherwise mint into.
        awaitingAdoptionByHostId.set(hostId, {
          mintedAt: Date.now(),
          generation: startedAt,
        });
        recordCompletedMint(hostId);
      }
      return outcome;
    });

  // Every joiner learns the attempt finished, but only ONE is given the
  // credential itself. A second holder buys no extra delivery chance - the
  // transport that receives it already holds it until one of its sessions can
  // carry it - so fanning it out would only copy a 30-day refresh JWE into more
  // objects and make the frame's "sent at most once" claim false.
  let claimed = false;
  const claim = (
    outcome: HostCredentialMintOutcome,
  ): HostCredentialMintOutcome => {
    if (outcome.kind !== "provisioned") {
      return outcome;
    }
    if (claimed) {
      // A joiner that did not win the credential. `pending-elsewhere`, NOT
      // `unavailable`: a credential for this host was successfully minted and
      // is on its way, so nothing this caller asked for failed and it must not
      // count the ask as its one attempt.
      //
      // This is the same liveness hole the claim window has, one step earlier.
      // The winner can close before delivering - the transport drops an
      // undeliverable credential outright - leaving a joiner that was told
      // `unavailable` as the only survivor, permanently unable to ask again
      // because its own state never transitions.
      return { kind: "pending-elsewhere" };
    }
    claimed = true;
    return outcome;
  };

  attemptsByHostId.set(hostId, { settled, claim });
  return settled.then(claim);
};
