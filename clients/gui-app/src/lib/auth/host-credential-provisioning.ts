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
