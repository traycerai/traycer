import { persistKey, PERSIST_PREFIX } from "@/lib/persist/keys";

/** THIS BROWSER TAB's stable identity. */

// BOTH NAMES ARE HISTORICAL AND STAY VERBATIM.
// They read as file-edit-recovery's own, and the identity is now shared - but renaming them would hand every tab already holding an id a fresh one on upgrade, orphaning the recovery partition an in-flight edit is filed under.
const BROWSER_TAB_PARTITION_KEY = persistKey("file-edit-recovery-tab");
const BROWSER_TAB_CLAIM_CHANNEL = `${PERSIST_PREFIX}:file-edit-recovery-tab-claim:v1`;

function generateBrowserTabId(): string {
  // `crypto.randomUUID` throws in a non-secure (plain http) context rather than being merely absent, so a bare feature check is not enough - a tab on such an origin would otherwise always hit the catch below and collapse onto the shared "default" partition.
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    try {
      return crypto.randomUUID();
    } catch {
      // Fall through to the non-crypto id below.
    }
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readClaimedTabId(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const id = (data as { readonly id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

let currentBrowserTabId: string | null = null;
let tabClaimChannel: BroadcastChannel | null = null;
const identityListeners = new Set<() => void>();

/** Subscribe to REGENERATION of this tab's identity, for `useSyncExternalStore`. */
export function subscribeBrowserTabId(listener: () => void): () => void {
  identityListeners.add(listener);
  return () => {
    identityListeners.delete(listener);
  };
}

function ensureTabClaimChannel(): BroadcastChannel | null {
  if (typeof globalThis.BroadcastChannel !== "function") return null;
  if (tabClaimChannel !== null) return tabClaimChannel;
  try {
    const channel = new globalThis.BroadcastChannel(BROWSER_TAB_CLAIM_CHANNEL);
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const claimedId = readClaimedTabId(event.data);
      // Another tab is broadcasting the exact id this tab is currently using.
      // Chrome and Firefox copy `sessionStorage` into a duplicated tab, so the cached id alone never disambiguates a duplicate from its origin - only a live collision like this one does.
      if (claimedId !== null && claimedId === currentBrowserTabId) {
        claimBrowserTabId(generateBrowserTabId());
      }
    });
    tabClaimChannel = channel;
  } catch {
    return null;
  }
  return tabClaimChannel;
}

/** Returns `null` when `sessionStorage` itself is unavailable/denied. */
function claimBrowserTabId(id: string): string | null {
  try {
    window.sessionStorage.setItem(BROWSER_TAB_PARTITION_KEY, id);
  } catch {
    return null;
  }
  // Only a REGENERATION notifies, never the first claim of a tab's life.
  // That first claim runs inside `browserTabId()`, which a subscriber calls from `getSnapshot` - i.e.
  const regenerated =
    currentBrowserTabId !== null && currentBrowserTabId !== id;
  currentBrowserTabId = id;
  const channel = ensureTabClaimChannel();
  try {
    channel?.postMessage({ id });
  } catch {
    // Best-effort - a missed claim just means a duplicate tab isn't caught
    // until its own next regeneration cycle.
  }
  if (regenerated) {
    for (const listener of identityListeners) listener();
  }
  return id;
}

// Every browser tab without a desktop `windowId` used to fall back to the same "default" partition, so two tabs editing the same file shared one IndexedDB database and one identity key - either tab's save (or delete-on-clean) could silently clobber the.
export function browserTabId(): string {
  if (typeof window === "undefined") return "default";
  if (currentBrowserTabId !== null) return currentBrowserTabId;
  try {
    const existing = window.sessionStorage.getItem(BROWSER_TAB_PARTITION_KEY);
    const resolved =
      existing !== null && existing.length > 0
        ? existing
        : generateBrowserTabId();
    return claimBrowserTabId(resolved) ?? "default";
  } catch {
    return "default";
  }
}

/**
 * Test seam.
 * Drops the cached id and closes the claim channel, so a suite can drive a fresh tab identity - and so a suite that opened a `BroadcastChannel` does not leave it listening across cases.
 */
export function resetBrowserTabIdentityForTesting(): void {
  currentBrowserTabId = null;
  tabClaimChannel?.close();
  tabClaimChannel = null;
}
