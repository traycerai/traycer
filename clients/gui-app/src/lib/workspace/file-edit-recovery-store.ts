import { createStore, del, get, set, type UseStore } from "idb-keyval";

import { persistKey, PERSIST_PREFIX } from "@/lib/persist/keys";
import type {
  FileEditIdentity,
  FileEditRecoveryEntry,
  FileEditRecoveryJournal,
} from "@/lib/workspace/file-edit-runtime";

export const FILE_EDIT_RECOVERY_DB_SUFFIX = ":file-edit-recovery";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value: unknown): value is FileEditIdentity {
  if (!isRecord(value)) return false;
  return (
    (value.userId === null || typeof value.userId === "string") &&
    typeof value.hostId === "string" &&
    typeof value.workspacePath === "string" &&
    typeof value.filePath === "string"
  );
}

function isRecoveryEntry(value: unknown): value is FileEditRecoveryEntry {
  if (!isRecord(value)) return false;
  return (
    value.version === 2 &&
    isIdentity(value.identity) &&
    typeof value.baselineRevision === "string" &&
    typeof value.draftContent === "string" &&
    typeof value.contentRevision === "number" &&
    Number.isSafeInteger(value.contentRevision) &&
    value.contentRevision >= 0
  );
}

function recoveryDbName(partition: string): string {
  return `${PERSIST_PREFIX}:${partition}${FILE_EDIT_RECOVERY_DB_SUFFIX}`;
}

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
  currentBrowserTabId = id;
  const channel = ensureTabClaimChannel();
  try {
    channel?.postMessage({ id });
  } catch {
    // Best-effort - a missed claim just means a duplicate tab isn't caught
    // until its own next regeneration cycle.
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
function browserTabPartition(): string {
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

/** Mirrors the desktop-window partition used by the other renderer journals. */
export function fileEditRecoveryPartition(): string {
  const runnerHost: unknown = Reflect.get(globalThis, "runnerHost");
  if (!isRecord(runnerHost)) return browserTabPartition();
  const windows = runnerHost.windows;
  if (!isRecord(windows)) return browserTabPartition();
  const windowId = windows.windowId;
  return typeof windowId === "string" && windowId.length > 0
    ? windowId
    : browserTabPartition();
}

let cachedStore: {
  readonly partition: string;
  readonly store: UseStore;
} | null = null;

function recoveryStore(): UseStore {
  const partition = fileEditRecoveryPartition();
  if (cachedStore === null || cachedStore.partition !== partition) {
    cachedStore = {
      partition,
      store: createStore(recoveryDbName(partition), "drafts"),
    };
  }
  return cachedStore.store;
}

export const indexedDbFileEditRecoveryJournal: FileEditRecoveryJournal = {
  load: async (identityKey) => {
    const entry = await get<unknown>(identityKey, recoveryStore());
    return isRecoveryEntry(entry) ? entry : null;
  },
  save: async (identityKey, entry) => {
    await set(identityKey, entry, recoveryStore());
  },
  remove: async (identityKey) => {
    await del(identityKey, recoveryStore());
  },
};

export function resetFileEditRecoveryStoreForTesting(): void {
  cachedStore = null;
  currentBrowserTabId = null;
  tabClaimChannel?.close();
  tabClaimChannel = null;
}
