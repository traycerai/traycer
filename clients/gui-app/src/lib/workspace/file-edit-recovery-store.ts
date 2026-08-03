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

// Every browser tab without a desktop `windowId` used to fall back to the same
// "default" partition, so two tabs editing the same file shared one IndexedDB
// database and one identity key - either tab's save (or delete-on-clean)
// could silently clobber the other's still-unsaved draft. `sessionStorage` is
// per-tab (unlike `localStorage`, which is shared across same-origin tabs),
// so caching a random id there gives each tab a stable partition of its own
// that a duplicated tab still gets a fresh copy of.
function browserTabPartition(): string {
  if (typeof window === "undefined") return "default";
  try {
    const existing = window.sessionStorage.getItem(BROWSER_TAB_PARTITION_KEY);
    if (existing !== null && existing.length > 0) return existing;
    const generated = crypto.randomUUID();
    window.sessionStorage.setItem(BROWSER_TAB_PARTITION_KEY, generated);
    return generated;
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
}
