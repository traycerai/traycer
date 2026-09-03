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

export class DesktopAuthSession {
  private readonly events = new EventEmitter();
  private snapshotValue: VerifiedDesktopAuthSessionSnapshot = {
    status: "signed-out",
    token: null,
    profile: null,
    verified: false,
  };

  get(): VerifiedDesktopAuthSessionSnapshot {
    return this.snapshotValue;
  }

  /**
   * Adopts a session main has NOT authenticated. Nothing that speaks for the
   * account may rest on one - it is the shape-only trust the jar plane was
   * found resting on - so the stored snapshot says so.
   */
  set(snapshot: DesktopAuthSessionSnapshot): void {
    this.store(snapshot, false);
  }

  /**
   * Adopts a session whose bearer main verified itself
   * (`auth/bearer-verifier.ts`): the signature, the issuer and audience, the
   * expiry, and the subject against `profile.userId`.
   */
  setVerified(snapshot: DesktopAuthSessionSnapshot): void {
    this.store(snapshot, true);
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
   */
  revokeVerification(): void {
    this.store(this.snapshotValue, false);
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
