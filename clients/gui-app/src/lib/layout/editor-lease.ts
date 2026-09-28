import { persistKey, STORE_KEYS } from "@/lib/persist";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * One window at a time holds the layout editor open (L-32).
 *
 * Carried over unchanged from the editor this replaces - a 6s lease renewed on
 * a 2s heartbeat, watched through the `storage` event AND a 2s poll, because
 * expiry itself emits no storage event and a crashed window would otherwise
 * hold the editor shut forever. What changed is only where it is written: the
 * leaf is registered in `PERSIST_STORES`, so it is inside the module-load
 * uniqueness assertion rather than beside it.
 */
export const LAYOUT_EDITOR_LEASE_KEY = persistKey(STORE_KEYS.layoutEditorLease);

export interface LayoutEditorLease {
  readonly token: string;
  readonly expiresAt: number;
}

/** How long a lease stands without a heartbeat, and how often one is sent. */
const LEASE_TTL_MS = 6000;
const HEARTBEAT_MS = 2000;

let token: string | null = null;
let heartbeat: number | null = null;

export function initializeLayoutEditorWindow(windowId: string | null): void {
  token ??= windowId ?? crypto.randomUUID();
}

export function readLayoutEditorLease(): LayoutEditorLease | null {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY) ?? "null",
    );
    if (
      raw !== null &&
      typeof raw === "object" &&
      "token" in raw &&
      typeof raw.token === "string" &&
      "expiresAt" in raw &&
      typeof raw.expiresAt === "number" &&
      Number.isFinite(raw.expiresAt)
    ) {
      return { token: raw.token, expiresAt: raw.expiresAt };
    }
  } catch {
    // Invalid or blocked storage must not leave the editor locked forever.
  }
  return null;
}

/** Whether ANOTHER window holds a live lease, recorded on the editor store. */
export function refreshLayoutEditorLock(): boolean {
  const lease = readLayoutEditorLease();
  const other =
    lease !== null && lease.token !== token && lease.expiresAt > Date.now();
  useLayoutEditorStore.getState().setLockedBy(other ? "other-window" : "none");
  return other;
}

export function acquireLayoutEditorLease(): boolean {
  initializeLayoutEditorWindow(null);
  if (refreshLayoutEditorLock()) return false;
  try {
    localStorage.setItem(
      LAYOUT_EDITOR_LEASE_KEY,
      JSON.stringify({ token, expiresAt: Date.now() + LEASE_TTL_MS }),
    );
  } catch {
    return false;
  }
  return !refreshLayoutEditorLock();
}

function renewLayoutEditorLease(): boolean {
  if (refreshLayoutEditorLock()) return false;
  return acquireLayoutEditorLease();
}

export function releaseLayoutEditorLease(): void {
  if (heartbeat !== null) window.clearInterval(heartbeat);
  heartbeat = null;
  if (readLayoutEditorLease()?.token === token) {
    localStorage.removeItem(LAYOUT_EDITOR_LEASE_KEY);
  }
  refreshLayoutEditorLock();
}

export function watchLayoutEditorLease(onLost: () => void): () => void {
  const check = (): void => {
    if (
      refreshLayoutEditorLock() &&
      useLayoutEditorStore.getState().session !== null
    ) {
      onLost();
    }
  };
  const storage = (event: StorageEvent): void => {
    if (event.key === null || event.key === LAYOUT_EDITOR_LEASE_KEY) check();
  };
  window.addEventListener("storage", storage);
  // Also expires a crashed window's lease: expiry itself emits no storage event.
  const poll = window.setInterval(check, HEARTBEAT_MS);
  check();
  return () => {
    window.removeEventListener("storage", storage);
    window.clearInterval(poll);
  };
}

export function startLayoutEditorHeartbeat(onLost: () => void): void {
  if (heartbeat !== null) window.clearInterval(heartbeat);
  heartbeat = window.setInterval(() => {
    if (!renewLayoutEditorLease()) onLost();
  }, HEARTBEAT_MS);
}
