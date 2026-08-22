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
}

/**
 * How long a freshly minted credential is treated as still on its way to the
 * host before another mint is allowed.
 *
 * A ceiling, not a schedule. The claim normally ends the moment a host reports
 * `active`; this only bounds the case where that report never comes - the
 * transport carrying the credential died between the mint and the frame, say -
 * so a host cannot be stranded on the client lease indefinitely by a claim
 * nobody will ever clear.
 */
const PENDING_ADOPTION_TTL_MS = 60_000;

/**
 * Hosts whose freshly minted credential has not yet been seen adopted, by the
 * wall-clock instant the mint settled.
 *
 * The window this closes is real and narrow: `attemptsByHostId` is cleared when
 * the mint SETTLES, but the host is only provisioned once a transport actually
 * carries the frame to it and it adopts. In between, the app looks to any
 * newly-constructed transport exactly as it does before a first mint - and a
 * per-`WsStreamClient` "already attempted" set cannot help, because a new
 * client starts with an empty one. Two mints then race, and superseding mints
 * can revoke one another, which can leave the host holding neither.
 *
 * Deliberately app-wide, like `attemptsByHostId` beside it and for the same
 * reason: the renderer holds several transports against one host, so any bound
 * kept per transport is not a bound at all.
 */
/**
 * Per host: when the claim was taken, and the mint-flow generation it was taken
 * under.
 *
 * The GENERATION half exists because `active` arrives on a callback that
 * nothing else orders. A delayed `active` from a transport belonging to the
 * previous account - or reporting a credential from before a burn - can land
 * after a NEW account's mint has settled, and a release keyed on `hostId`
 * alone would free that new claim before its credential was ever adopted,
 * reopening the double-mint this map exists to close. Correlating on the
 * generation makes a stale report about an older epoch simply not match.
 */
const awaitingAdoptionByHostId = new Map<
  string,
  { readonly mintedAt: number; readonly generation: number }
>();

/**
 * Reports what a host says about its credential, so the app-wide flow can tell
 * a delivered mint from one still in flight.
 *
 * `active` is the only positive proof that a minted credential arrived, and it
 * is the only thing that ends a claim early. Any other state means the host is
 * still asking - which does NOT release the claim, because the ask may simply
 * predate the credential now on its way.
 */
export function noteHostCredentialState(
  hostId: string,
  state: "missing" | "active" | "needs-reauth",
): void {
  if (state !== "active") {
    return;
  }
  const claim = awaitingAdoptionByHostId.get(hostId);
  if (claim === undefined) {
    return;
  }
  if (claim.generation !== generation) {
    // An `active` from before the last reset. It is evidence about a
    // credential minted for an identity that is gone, so it says nothing about
    // whether THIS claim's credential has landed.
    return;
  }
  awaitingAdoptionByHostId.delete(hostId);
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
      return { kind: "unavailable" };
    }
    claimed = true;
    return outcome;
  };

  attemptsByHostId.set(hostId, { settled, claim });
  return settled.then(claim);
};
