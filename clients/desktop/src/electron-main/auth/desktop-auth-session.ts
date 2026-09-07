import { EventEmitter } from "node:events";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";

/** Only a signed-in session can carry `verified: true`, and the flag is set by the ONE caller that ran the verification - it is not a field a renderer can push. */
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

  set(snapshot: DesktopAuthSessionSnapshot): void {
    this.store(snapshot, false);
  }

  setVerified(snapshot: DesktopAuthSessionSnapshot): void {
    this.store(snapshot, true);
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
