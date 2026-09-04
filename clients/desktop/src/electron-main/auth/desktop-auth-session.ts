import { EventEmitter } from "node:events";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";

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
 * How many revoked bearers main remembers. A verdict is per bearer and bearers
 * rotate, so only the most recent few can still have a verification in
 * flight; the list is a ring, not a ledger.
 */
const REVOKED_BEARERS_RETAINED = 8;

export class DesktopAuthSession {
  private readonly events = new EventEmitter();
  private snapshotValue: VerifiedDesktopAuthSessionSnapshot = {
    status: "signed-out",
    token: null,
    profile: null,
    verified: false,
  };
  /**
   * Bearers a renderer revoked while main was NOT holding them - because their
   * `authSessionSet` was still awaiting JWKS verification. `setVerified`
   * consults this, so a verification that lands after its bearer's terminal
   * verdict installs the session UNVERIFIED instead of re-enabling the jar
   * plane on a credential authn already rejected. Without it the revoke was
   * dropped as stale (main held the previous token) and the pending set then
   * completed as `verified`.
   */
  private readonly revokedBearers: string[] = [];
  /**
   * The newest set anyone has BEGUN, verified or not. A verified set awaits
   * JWKS before it can store, and IPC across renderers is unordered, so a
   * set begun earlier can complete later - after a sibling window's fresh
   * sign-in was verified and stored, or after a sign-out. Committing it then
   * replaced the newer session with the older one: a stale signed-in snapshot
   * fanned out to every window, and the jar plane's principal moved to an
   * account nobody is signed in to any more. Each set therefore commits only
   * while it is still the newest begun.
   */
  private setGeneration = 0;

  get(): VerifiedDesktopAuthSessionSnapshot {
    return this.snapshotValue;
  }

  /**
   * Marks the start of a set whose commit is deferred (a verified set
   * awaiting JWKS). The returned generation is handed back to `setVerified`,
   * which drops the commit if any set - verified or shape-only - began after
   * it. Taken BEFORE the verification, not after: the fence is about which
   * intent is newest, and the intent is formed when the renderer sends it.
   */
  beginSet(): number {
    this.setGeneration += 1;
    return this.setGeneration;
  }

  /**
   * Adopts a session main has NOT authenticated. Nothing that speaks for the
   * account may rest on one - it is the shape-only trust the jar plane was
   * found resting on - so the stored snapshot says so.
   *
   * Synchronous, so it is its own newest intent: it begins and commits in one
   * step, and a verified set still in flight from before it is superseded
   * (a sign-out must not be undone by the sign-in it followed).
   */
  set(snapshot: DesktopAuthSessionSnapshot): void {
    this.beginSet();
    this.store(snapshot, false);
  }

  /**
   * Adopts a session whose bearer main verified itself
   * (`auth/bearer-verifier.ts`): the signature, the issuer and audience, the
   * expiry, and the subject against `profile.userId`.
   *
   * `generation` is what `beginSet` returned when this set began. A set that
   * is no longer the newest begun is dropped whole - not installed
   * unverified, which would still replace the newer session's status and
   * profile with the older one's.
   */
  setVerified(snapshot: DesktopAuthSessionSnapshot, generation: number): void {
    if (generation !== this.setGeneration) return;
    // A bearer revoked while its verification was in flight (see
    // `revokedBearers`) lands as the session it is, minus the verification
    // the renderer has already withdrawn for it.
    const revoked =
      snapshot.token !== null && this.revokedBearers.includes(snapshot.token);
    this.store(snapshot, !revoked);
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
    this.retainRevocation(rejectedToken);
    if (this.snapshotValue.token !== rejectedToken) return;
    this.store(this.snapshotValue, false);
  }

  private retainRevocation(rejectedToken: string): void {
    if (this.revokedBearers.includes(rejectedToken)) return;
    this.revokedBearers.push(rejectedToken);
    if (this.revokedBearers.length > REVOKED_BEARERS_RETAINED) {
      this.revokedBearers.shift();
    }
  }

  private store(snapshot: DesktopAuthSessionSnapshot, verified: boolean): void {
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
