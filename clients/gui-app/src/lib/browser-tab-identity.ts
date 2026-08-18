import { persistKey, PERSIST_PREFIX } from "@/lib/persist/keys";

/**
 * THIS BROWSER TAB's stable identity.
 *
 * Extracted from `file-edit-recovery-store.ts`, which solved this first and was
 * for a while the only place in the tree that knew the hard part. Anything that
 * needs "which browser tab am I" shares this one implementation rather than
 * minting a second scheme beside it - two per-tab identities that disagree is a
 * worse failure than the one either was written to prevent.
 *
 * PER-TAB IDENTITY IS A CLAIM PROTOCOL, NOT A STORAGE CHOICE, and that is the
 * whole reason this is a module rather than a one-line `sessionStorage` read.
 * `sessionStorage` is per-tab in the sense that a reload keeps it and a sibling
 * tab does not see it - but Chrome and Firefox COPY it into a duplicated tab,
 * so a cached id alone can never tell a duplicate from its origin. The
 * `BroadcastChannel` claim below is what actually disambiguates: whichever tab
 * observes a live collision on its own id regenerates.
 *
 * KNOWN, SHARED, ACCEPTED: nothing reclaims the durable rows a retired tab id
 * leaves behind - not here, and not in `file-edit-recovery-store.ts`, which has
 * had this property since it was written. A consumer keying durable state by
 * this id inherits it rather than introducing it. The bound is one row per
 * browser-tab lifetime.
 *
 * `"default"` is the last resort - no `window`, or storage denied - and it
 * deliberately collapses every such tab onto one identity: a caller that cannot
 * tell tabs apart must fail to the SAME shared answer every time rather than
 * mint a fresh id per call and fragment its own state.
 */

// BOTH NAMES ARE HISTORICAL AND STAY VERBATIM. They read as file-edit-recovery's
// own, and the identity is now shared - but renaming them would hand every tab
// already holding an id a fresh one on upgrade, orphaning the recovery
// partition an in-flight edit is filed under. The name is cosmetic; the
// continuity is not.
const BROWSER_TAB_PARTITION_KEY = persistKey("file-edit-recovery-tab");
const BROWSER_TAB_CLAIM_CHANNEL = `${PERSIST_PREFIX}:file-edit-recovery-tab-claim:v1`;

function generateBrowserTabId(): string {
  // `crypto.randomUUID` throws in a non-secure (plain http) context rather
  // than being merely absent, so a bare feature check is not enough - a tab
  // on such an origin would otherwise always hit the catch below and
  // collapse onto the shared "default" partition, the exact clobber this
  // exists to prevent.
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

/**
 * Subscribe to REGENERATION of this tab's identity, for `useSyncExternalStore`.
 *
 * This id used to be read only imperatively - `file-edit-recovery-store` asks
 * for it at save/recover time and therefore always observes the current value.
 * A React consumer that resolves it once per mount does not: the collision
 * handler below fires asynchronously, off any render, so a mounted component
 * would keep addressing the superseded id - and so keep sharing state with the
 * duplicate that displaced it - until something unrelated re-rendered it.
 *
 * The rule that follows: anything keying COMPONENT state by this id subscribes;
 * anything reading it at the moment of an action may still just call
 * `browserTabId()`.
 */
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
      // Another tab is broadcasting the exact id this tab is currently
      // using. Chrome and Firefox copy `sessionStorage` into a duplicated
      // tab, so the cached id alone never disambiguates a duplicate from
      // its origin - only a live collision like this one does. Regenerate
      // and re-claim so the two tabs stop sharing one recovery partition.
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
  // Only a REGENERATION notifies, never the first claim of a tab's life. That
  // first claim runs inside `browserTabId()`, which a subscriber calls from
  // `getSnapshot` - i.e. DURING render, where publishing a store change is not
  // allowed. A regeneration can only originate in the channel listener above,
  // which is asynchronous and safely outside every render.
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

// Every browser tab without a desktop `windowId` used to fall back to the same
// "default" partition, so two tabs editing the same file shared one IndexedDB
// database and one identity key - either tab's save (or delete-on-clean)
// could silently clobber the other's still-unsaved draft. `sessionStorage` is
// per-tab (unlike `localStorage`, which is shared across same-origin tabs),
// so caching an id there gives each tab a stable partition that survives a
// reload. That alone is not sufficient: a *duplicated* tab inherits the same
// sessionStorage entry, so `ensureTabClaimChannel`'s collision listener above
// is what actually disambiguates that case, by having whichever tab observes
// the live collision regenerate.
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
 * Test seam. Drops the cached id and closes the claim channel, so a suite can
 * drive a fresh tab identity - and so a suite that opened a `BroadcastChannel`
 * does not leave it listening across cases.
 */
export function resetBrowserTabIdentityForTesting(): void {
  currentBrowserTabId = null;
  tabClaimChannel?.close();
  tabClaimChannel = null;
}
