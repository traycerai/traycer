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
 * raise its own email-OTP dialog. This module is where "one prompt per host"
 * actually lives; `buildHostStreamClient` hands every client the same flow from
 * here, so the guarantee holds no matter how many transports exist.
 *
 * The mechanism (which auth service, which dialog) is supplied at runtime by the
 * provisioning provider: this module deliberately owns no React state, so a
 * transport constructed outside a component tree still gets the same policy.
 */
export type HostCredentialMintRunner = (
  request: HostCredentialMintRequest,
) => Promise<HostCredentialMintOutcome>;

let runner: HostCredentialMintRunner | null = null;
const settledHostIds = new Set<string>();
/**
 * Bumped by every reset. An attempt that was already running when the identity
 * changed must not write its result into the new identity's state - otherwise a
 * decline made by the previous user lands in the memo moments after the sign-out
 * that was supposed to clear it, and the new user is never asked.
 */
let generation = 0;

/**
 * Installs (or clears) the runtime that actually mints. Called by the
 * provisioning provider on mount/unmount. With no runner installed - dev shells,
 * tests, the window before auth is wired - every request resolves `declined`,
 * which leaves hosts on the client-lease fallback rather than failing anything.
 */
export function setHostCredentialMintRunner(
  next: HostCredentialMintRunner | null,
): void {
  runner = next;
}

/**
 * Forgets which hosts have already been asked about. Must run on sign-out: the
 * memo below is keyed by hostId alone, so without this the next user to sign in
 * on this machine would silently never be offered provisioning for a host the
 * PREVIOUS user had declined.
 */
export function resetHostCredentialProvisioning(): void {
  generation += 1;
  attemptsByHostId.clear();
  settledHostIds.clear();
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
    // A second transport noticed the same host mid-prompt. Join the first
    // attempt instead of raising a second dialog. Note the `.then(claim)` here
    // rather than returning the stored promise directly: the gate has to run
    // once PER CALLER, and a shared promise's own `.then` would run only once.
    return existing.settled.then(existing.claim);
  }
  if (settledHostIds.has(hostId)) {
    return Promise.resolve({ kind: "declined" });
  }
  const current = runner;
  if (current === null) {
    return Promise.resolve({ kind: "declined" });
  }

  const startedAt = generation;
  const settled = current(request)
    .catch((): HostCredentialMintOutcome => ({ kind: "unavailable" }))
    .then((outcome): HostCredentialMintOutcome => {
      if (generation !== startedAt) {
        // A reset (sign-out, or a switch to another account) overtook this
        // attempt. Its state belongs to an identity that is gone: do not write
        // it back, and do not hand the credential to a transport that is now
        // serving someone else.
        return { kind: "unavailable" };
      }
      attemptsByHostId.delete(hostId);
      // Settled either way. A success needs no second mint, and a decline or a
      // failure must not re-prompt on the next reconnect - the recovery door for
      // both is the next app run, not a dialog loop.
      settledHostIds.add(hostId);
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
