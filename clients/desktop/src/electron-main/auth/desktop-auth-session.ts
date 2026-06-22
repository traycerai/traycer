import { EventEmitter } from "node:events";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";

type DesktopAuthSessionListener = (
  snapshot: DesktopAuthSessionSnapshot,
) => void;

export class DesktopAuthSession {
  private readonly events = new EventEmitter();
  private snapshotValue: DesktopAuthSessionSnapshot = {
    status: "signed-out",
    token: null,
    profile: null,
  };

  get(): DesktopAuthSessionSnapshot {
    return this.snapshotValue;
  }

  set(snapshot: DesktopAuthSessionSnapshot): void {
    const normalized = normalizeDesktopAuthSession(snapshot);
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
  a: DesktopAuthSessionSnapshot,
  b: DesktopAuthSessionSnapshot,
): boolean {
  return (
    a.status === b.status &&
    a.token === b.token &&
    a.profile?.userName === b.profile?.userName &&
    a.profile?.email === b.profile?.email
  );
}
