import type { HostCredentialState } from "@traycer/protocol/framework/stream-ws-protocol";
import type {
  HostCredentialMintFlow,
  HostCredentialMintOutcome,
  HostCredentialMintRequest,
} from "@traycer-clients/shared/host-transport/host-credential-mint-flow";

/** App-wide policy for delegated host-credential provisioning. */
export type HostCredentialMintRunner = (
  request: HostCredentialMintRequest,
) => Promise<HostCredentialMintOutcome>;

let runner: HostCredentialMintRunner | null = null;
/**
 * Bumped by every reset.
 * An attempt that was already running when the identity changed must not hand its credential to a transport that is now serving someone else - the mint was authorized by the previous user's bearer.
 */
let generation = 0;

/**
 * Installs (or clears) the runtime that actually mints.
 * Called by the provisioning provider on mount/unmount.
 */
export function setHostCredentialMintRunner(
  next: HostCredentialMintRunner | null,
): void {
  runner = next;
}

/**
 * Abandons in-flight attempts.
 * Must run on sign-out: a mint authorized by the departing user's bearer must never be handed to a transport now serving the next one.
 */
export function resetHostCredentialProvisioning(): void {
  generation += 1;
  attemptsByHostId.clear();
  awaitingAdoptionByHostId.clear();
  mintBackoffByHostId.clear();
}

/** Escalating floor between COMPLETED mints for one host. */
const MINT_BACKOFF_BASE_MS = 60_000;
const MINT_BACKOFF_MAX_MS = 3_600_000;
const MINT_BACKOFF_QUIET_DECAY_MS = 1_800_000;

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
    MINT_BACKOFF_BASE_MS * 2 ** (completedMints - 1),
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
  let effective = entry;
  const quietElapsed = Date.now() - entry.lastMintedAt;
  if (quietElapsed >= MINT_BACKOFF_QUIET_DECAY_MS) {
    // Quiet stretch: decay one rung per full quiet window rather than forgetting outright, so a slow flap cannot farm the reset.
    // The remaining rung is then re-checked below - at the high rungs a single quiet window is shorter than the wait itself, and decaying must not double as admission.
    const decayedRungs = Math.floor(quietElapsed / MINT_BACKOFF_QUIET_DECAY_MS);
    const completedMints = entry.completedMints - decayedRungs;
    if (completedMints <= 0) {
      mintBackoffByHostId.delete(hostId);
      return false;
    }
    effective = {
      completedMints,
      lastMintedAt:
        entry.lastMintedAt + decayedRungs * MINT_BACKOFF_QUIET_DECAY_MS,
      generation: entry.generation,
    };
    mintBackoffByHostId.set(hostId, effective);
  }
  return (
    Date.now() - effective.lastMintedAt <
    mintBackoffWaitMs(effective.completedMints)
  );
}

/** What is LEFT of this host's escalation rung, for the caller's retry timer. */
function remainingBackoffMs(hostId: string): number {
  const entry = mintBackoffByHostId.get(hostId);
  if (entry === undefined) {
    return 0;
  }
  return Math.max(
    0,
    entry.lastMintedAt + mintBackoffWaitMs(entry.completedMints) - Date.now(),
  );
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
 * How long a freshly minted credential is treated as still on its way to the host before another mint is allowed.
 */
const PENDING_ADOPTION_TTL_MS = 60_000;

/** Per host: when the claim was taken, and the mint-flow generation it was taken under. */
const awaitingAdoptionByHostId = new Map<
  string,
  { readonly mintedAt: number; readonly generation: number }
>();

/** Reports what a host says about its credential. */
export function noteHostCredentialState(
  _hostId: string,
  _state: HostCredentialState,
): void {
  // Intentionally empty. See above.
}

/**
 * Whether a mint for `hostId` is still awaiting adoption, expiring the claim if it has outlived {@link PENDING_ADOPTION_TTL_MS} or belongs to a superseded generation.
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

/** What is LEFT of this host's adoption claim, for the caller's retry timer. */
function remainingAdoptionClaimMs(hostId: string): number {
  const claim = awaitingAdoptionByHostId.get(hostId);
  if (claim === undefined) {
    return 0;
  }
  return Math.max(0, claim.mintedAt + PENDING_ADOPTION_TTL_MS - Date.now());
}

/** A running attempt, plus the per-caller gate that decides which single caller is handed the credential itself. */
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
    // A credential was minted for this host moments ago and has not been seen adopted yet.
    // The ask that brought us here is stale by construction - the host formed it before the credential now in flight reached it - and minting a second one would supersede the first, with each able to revoke the other.
    return Promise.resolve({
      kind: "pending-elsewhere",
      retryAfterMs: remainingAdoptionClaimMs(hostId),
    });
  }
  const existing = attemptsByHostId.get(hostId);
  if (existing !== undefined) {
    // A second transport noticed the same host mid-mint.
    // Join the first attempt instead of racing it.
    return existing.settled.then(existing.claim);
  }
  if (mintInBackoff(hostId)) {
    // The escalation ladder says this host has been minting too often to be healthy.
    // `pending-elsewhere`, not `unavailable`, for the same reason as the adoption claim above: the caller keeps its attempt, and it re-asks when the window it is told to wait for has passed.
    return Promise.resolve({
      kind: "pending-elsewhere",
      retryAfterMs: remainingBackoffMs(hostId),
    });
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
        // A reset (sign-out, or a switch to another account) overtook this attempt.
        // The credential was minted under an identity that is gone, so do not hand it to a transport that is now serving someone else.
        return { kind: "unavailable" };
      }
      attemptsByHostId.delete(hostId);
      if (outcome.kind === "provisioned") {
        // The attempt is over but the DELIVERY is not: the credential still has to ride a live socket to the host and be adopted.
        // Hold the claim across that gap - it is exactly the window a second transport would otherwise mint into.
        awaitingAdoptionByHostId.set(hostId, {
          mintedAt: Date.now(),
          generation: startedAt,
        });
        recordCompletedMint(hostId);
      }
      return outcome;
    });

  // Every joiner learns the attempt finished, but only ONE is given the credential itself.
  // A second holder buys no extra delivery chance - the transport that receives it already holds it until one of its sessions can carry it - so fanning it out would only copy a 30-day refresh JWE into more objects and make the frame's "sent at most once" claim.
  let claimed = false;
  const claim = (
    outcome: HostCredentialMintOutcome,
  ): HostCredentialMintOutcome => {
    if (outcome.kind !== "provisioned") {
      return outcome;
    }
    if (claimed) {
      // A joiner that did not win the credential.
      // `pending-elsewhere`, NOT `unavailable`: a credential for this host was successfully minted and is on its way, so nothing this caller asked for failed and it must not count the ask as its one attempt.
      return {
        kind: "pending-elsewhere",
        retryAfterMs: remainingAdoptionClaimMs(hostId),
      };
    }
    claimed = true;
    return outcome;
  };

  attemptsByHostId.set(hostId, { settled, claim });
  return settled.then(claim);
};
