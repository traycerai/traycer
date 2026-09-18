import { persistKey } from "@/lib/persist";
import { useCustomizeStore } from "@/stores/customize/customize-store";

export const CUSTOMIZE_LEASE_KEY = persistKey("customize-lease");
export interface CustomizeLease {
  readonly token: string;
  readonly expiresAt: number;
}
let token: string | null = null;
let heartbeat: number | null = null;
export function initializeCustomizeWindow(windowId: string | null): void {
  token ??= windowId ?? crypto.randomUUID();
}
export function readCustomizeLease(): CustomizeLease | null {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(CUSTOMIZE_LEASE_KEY) ?? "null",
    );
    if (
      raw &&
      typeof raw === "object" &&
      "token" in raw &&
      typeof raw.token === "string" &&
      "expiresAt" in raw &&
      typeof raw.expiresAt === "number" &&
      Number.isFinite(raw.expiresAt)
    )
      return { token: raw.token, expiresAt: raw.expiresAt };
  } catch {
    /* Invalid/blocked storage must not leave the editor locked forever. */
  }
  return null;
}
export function refreshCustomizeLock(): boolean {
  const lease = readCustomizeLease();
  const other =
    lease !== null && lease.token !== token && lease.expiresAt > Date.now();
  useCustomizeStore.setState({ lockedBy: other ? "other-window" : "none" });
  return other;
}
export function acquireCustomizeLease(): boolean {
  initializeCustomizeWindow(null);
  if (refreshCustomizeLock()) return false;
  try {
    localStorage.setItem(
      CUSTOMIZE_LEASE_KEY,
      JSON.stringify({ token, expiresAt: Date.now() + 6000 }),
    );
  } catch {
    return false;
  }
  return !refreshCustomizeLock();
}
export function renewCustomizeLease(): boolean {
  if (refreshCustomizeLock()) return false;
  return acquireCustomizeLease();
}
export function releaseCustomizeLease(): void {
  if (heartbeat !== null) window.clearInterval(heartbeat);
  heartbeat = null;
  if (readCustomizeLease()?.token === token)
    localStorage.removeItem(CUSTOMIZE_LEASE_KEY);
  refreshCustomizeLock();
}
export function watchCustomizeLease(onLost: () => void): () => void {
  const check = () => {
    if (refreshCustomizeLock() && useCustomizeStore.getState().session)
      onLost();
  };
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === CUSTOMIZE_LEASE_KEY) check();
  };
  window.addEventListener("storage", storage);
  // Also expire a crashed window's lease: expiry itself emits no storage event.
  const poll = window.setInterval(check, 2000);
  check();
  return () => {
    window.removeEventListener("storage", storage);
    window.clearInterval(poll);
  };
}
export function startCustomizeHeartbeat(onLost: () => void): void {
  if (heartbeat !== null) window.clearInterval(heartbeat);
  heartbeat = window.setInterval(() => {
    if (!renewCustomizeLease()) onLost();
  }, 2000);
}
