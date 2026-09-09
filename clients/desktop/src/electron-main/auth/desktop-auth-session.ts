import { EventEmitter } from "node:events";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";
import { readBearerExpiryMs } from "./bearer-verifier";

/**
 * What main HOLDS, as opposed to what a renderer sent: the same snapshot plus
 * whether main verified the bearer itself (`auth/bearer-verifier.ts`) rather
 * than taking the renderer's word for it. Only a signed-in session can carry
 * `verified: true`, and the flag is set by the ONE caller that ran the
 * verification - it is not a field a renderer can push.
 *
 * Consumers that speak FOR the account - the jar plane above all - assert it.
 */
export interface VerifiedDesktopAuthSessionSnapshot extends DesktopAuthSessionSnapshot {
  readonly verified: boolean;
}

type DesktopAuthSessionListener = (
  snapshot: VerifiedDesktopAuthSessionSnapshot,
) => void;

/**
 * The bearer verifier's own tolerance on `exp`, so a revocation is remembered
 * for exactly as long as the bearer could still pass verification.
 */
const REVOCATION_CLOCK_TOLERANCE_MS = 60_000;

/**
 * Ceiling on how long any single revocation is remembered, whatever `exp` the
 * token claims. Authn's interactive bearer lives hours (`ACCESS_TOKEN_EXPIRY_IN_
 * HOURS`, default 4), so a real bearer is always well inside this; the ceiling
 * exists for the OTHER input - a renderer can revoke any string, and one that
 * decodes as a JWT with a far-future `exp` would otherwise be remembered
 * forever. The residual is that a compromised renderer can grow the map by one
 * entry per distinct token-shaped string until each ages out; it cannot
 * DISPLACE a real revocation, which is what a count-bounded ring let it do.
 */
const MAX_REVOCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export class DesktopAuthSession {
  private readonly events = new EventEmitter();
  private snapshotValue: VerifiedDesktopAuthSessionSnapshot = {
    status: "signed-out",
    token: null,
    profile: null,
    verified: false,
  };
  /**
   * Bearers a renderer revoked, each with the instant after which the
   * revocation no longer matters - the bearer's own `exp` (plus the
   * verifier's tolerance), because past it no set for that bearer can verify
   * anyway. `setVerified` consults this, so a verification that lands after
   * its bearer's terminal verdict installs the session UNVERIFIED instead of
   * re-enabling the jar plane on a credential authn already rejected.
   *
   * Bounded by TIME, never by count. The eight-entry ring this replaces
   * evicted the oldest entry on the ninth revoke, and the revoke IPC accepts
   * any string from any renderer - so eight bogus revocations pushed a real
   * bearer's out, and a set for that still-unexpired bearer then verified
   * clean and restored `verified: true` after authn had terminally rejected
   * it. A string that does not decode as a bearer with an `exp` is not
   * retained at all: it could never have verified, so remembering it protects
   * nothing and would only be the growth the ceiling above guards against.
   */
  private readonly revokedBearers = new Map<string, number>();
  /**
   * Sets are fenced by GENERATION, and only a COMMITTED set supersedes.
   *
   * A verified set awaits JWKS before it can store, and IPC across renderers
   * is unordered, so a set begun earlier can complete later - after a sibling
   * window's fresh sign-in was verified and stored, or after a sign-out.
   * Committing it then replaced the newer session with the older one: a stale
   * signed-in snapshot fanned out to every window, and the jar plane's
   * principal moved to an account nobody is signed in to any more.
   *
   * The fence is against sets that COMMITTED, not sets that merely began: a
   * newer set that authn refused, or that is still verifying, installed
   * nothing, and dropping the older valid one behind it would leave main on
   * the previous (or empty) session while telling the older set's sender it
   * was accepted - a sender that then never retries.
   */
  private nextGeneration = 0;
  private latestCommittedGeneration = 0;

  get(): VerifiedDesktopAuthSessionSnapshot {
    return this.snapshotValue;
  }

  /**
   * Marks the start of a set whose commit is deferred (a verified set
   * awaiting JWKS). The returned generation is handed back to `setVerified`,
   * which drops the commit if a set begun after it has committed meanwhile.
   * Taken BEFORE the verification, not after: the fence is about which
   * intent is newest, and the intent is formed when the renderer sends it.
   */
  beginSet(): number {
    this.nextGeneration += 1;
    return this.nextGeneration;
  }

  /**
   * Adopts a session main has NOT authenticated. Nothing that speaks for the
   * account may rest on one - it is the shape-only trust the jar plane was
   * found resting on - so the stored snapshot says so.
   *
   * Synchronous, so it begins and commits in one step: a verified set still
   * in flight from before it is superseded (a sign-out must not be undone by
   * the sign-in it followed).
   */
  set(snapshot: DesktopAuthSessionSnapshot): void {
    this.commit(snapshot, false, this.beginSet());
  }

  /**
   * Adopts a session whose bearer main verified itself
   * (`auth/bearer-verifier.ts`): the signature, the issuer and audience, the
   * expiry, and the subject against `profile.userId`.
   *
   * `generation` is what `beginSet` returned when this set began. Returns
   * `false` - and installs nothing, not even an unverified session, which
   * would still replace the newer session's status and profile with the
   * older one's - when a set begun after this one has already committed.
   */
  setVerified(
    snapshot: DesktopAuthSessionSnapshot,
    generation: number,
  ): boolean {
    if (generation < this.latestCommittedGeneration) return false;
    // A bearer revoked while its verification was in flight (see
    // `revokedBearers`) lands as the session it is, minus the verification
    // the renderer has already withdrawn for it.
    const revoked =
      snapshot.token !== null && this.isRevoked(snapshot.token, Date.now());
    this.commit(snapshot, !revoked, generation);
    return true;
  }

  /**
   * Withdraws main's verification of the session it holds, leaving the
   * session itself in place. The renderer calls this on a TERMINAL verdict
   * loss (authn rejected the refresh credential): the bearer it verified may
   * still be inside its expiry, so nothing about the token tells main, and
   * the renderer's own `unverified` is deliberately never projected here -
   * the status it would flatten to signs sibling windows out.
   *
   * Everything that speaks for the account reads `verified`, so this is the
   * whole of the teardown: the jar plane's principal reads `null` from the
   * next change, and the status the change fans out is unchanged, so no
   * renderer applies a transition it did not make. A no-op when nothing was
   * verified.
   *
   * FENCED to the bearer the renderer is rejecting. IPC from different
   * renderers is unordered, so a terminal demotion in one window can land
   * after a sibling window's fresh sign-in was verified here; an unfenced
   * revoke would then strip the NEW session's verification and tear the jar
   * plane down for an account the cloud still vouches for. A revoke naming a
   * bearer this session does not hold never touches the held session.
   *
   * Every revoke is RETAINED (`revokedBearers`), the held bearer's included:
   * `authSessionSet` awaits JWKS verification before storing, so a set for
   * the revoked bearer - a sibling window's, or one still in flight for the
   * bearer main already holds - can complete after this revoke, and its
   * `setVerified` must land unverified. A genuinely stale revoke (a bearer a
   * sibling window has already replaced) is retained harmlessly: nothing
   * legitimately re-verifies a rejected bearer.
   */
  revokeVerification(rejectedToken: string): void {
    // Retained whether or not main holds the bearer: another window's
    // `authSessionSet` for this SAME bearer may still be awaiting JWKS, and
    // its `setVerified` landing after this revoke must not restore the
    // verification the renderer has already withdrawn.
    this.retainRevocation(rejectedToken, Date.now());
    if (this.snapshotValue.token !== rejectedToken) return;
    this.commit(this.snapshotValue, false, this.latestCommittedGeneration);
  }

  private retainRevocation(rejectedToken: string, now: number): void {
    this.pruneRevocations(now);
    const expiresAt = readBearerExpiryMs(rejectedToken);
    if (expiresAt === null) return;
    const retainUntil = Math.min(
      expiresAt + REVOCATION_CLOCK_TOLERANCE_MS,
      now + MAX_REVOCATION_RETENTION_MS,
    );
    if (retainUntil <= now) return;
    this.revokedBearers.set(rejectedToken, retainUntil);
  }

  private isRevoked(token: string, now: number): boolean {
    this.pruneRevocations(now);
    return this.revokedBearers.has(token);
  }

  private pruneRevocations(now: number): void {
    for (const [token, retainUntil] of this.revokedBearers) {
      if (retainUntil <= now) this.revokedBearers.delete(token);
    }
  }

  private commit(
    snapshot: DesktopAuthSessionSnapshot,
    verified: boolean,
    generation: number,
  ): void {
    this.latestCommittedGeneration = Math.max(
      this.latestCommittedGeneration,
      generation,
    );
    const base = normalizeDesktopAuthSession(snapshot);
    const normalized: VerifiedDesktopAuthSessionSnapshot = {
      ...base,
      verified: base.status === "signed-in" && verified,
    };
    if (authSessionsEqual(this.snapshotValue, normalized)) {
      return;
    }
    this.snapshotValue = normalized;
    this.events.emit("change", normalized);
  }

  on(event: "change", listener: DesktopAuthSessionListener): void {
    this.events.on(event, listener);
  }

  off(event: "change", listener: DesktopAuthSessionListener): void {
    this.events.off(event, listener);
  }
}

export function normalizeDesktopAuthSession(
  snapshot: DesktopAuthSessionSnapshot,
): DesktopAuthSessionSnapshot {
  if (
    snapshot.status === "signed-in" &&
    snapshot.token !== null &&
    snapshot.profile !== null
  ) {
    return snapshot;
  }
  if (snapshot.status === "signing-in") {
    return { status: "signing-in", token: null, profile: null };
  }
  return { status: "signed-out", token: null, profile: null };
}

function authSessionsEqual(
  a: VerifiedDesktopAuthSessionSnapshot,
  b: VerifiedDesktopAuthSessionSnapshot,
): boolean {
  return (
    a.status === b.status &&
    a.token === b.token &&
    a.verified === b.verified &&
    // The canonical id, not just the display fields: two accounts can share
    // an email and a userName, and a switch between them is a change.
    a.profile?.userId === b.profile?.userId &&
    a.profile?.userName === b.profile?.userName &&
    a.profile?.email === b.profile?.email
  );
}
