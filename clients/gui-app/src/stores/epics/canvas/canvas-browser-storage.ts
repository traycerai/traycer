import { createStore, del, set, type UseStore } from "idb-keyval";
import type { StateStorage } from "zustand/middleware";
import { epicCanvasKey, persistKey } from "@/lib/persist/keys";
import { appLogger, describeLogError } from "@/lib/logger";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

export const CANVAS_BROWSER_DB_NAME = persistKey("epic-canvas");

let connection: UseStore | null = null;
let retired = false;
let operations: Promise<void> = Promise.resolve();
const pendingWrites = new Map<string, string | null>();
const scheduledWrites = new Set<string>();
let writeFailureReported = false;

function database(): UseStore {
  if (connection !== null) return connection;
  const opened = createStore(CANVAS_BROWSER_DB_NAME, "canvases");
  const store: UseStore = (mode, callback) =>
    opened(mode, (objectStore) => {
      const db = objectStore.transaction.db;
      db.onversionchange = () => {
        db.close();
        connection = null;
        retired = true;
        pendingWrites.clear();
      };
      return callback(objectStore);
    });
  connection = store;
  return store;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(() => {
    if (retired) throw new Error("Saved tab storage is being cleared.");
    return operation();
  });
  // One failed transaction must not poison future writes, and Zustand does
  // not await or handle promises returned from its storage's setItem.
  operations = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function scheduleWrite(name: string, value: string | null): void {
  if (retired) return;
  pendingWrites.set(name, value);
  if (scheduledWrites.has(name)) return;
  scheduledWrites.add(name);
  void enqueue(async () => {
    const next = pendingWrites.get(name);
    pendingWrites.delete(name);
    scheduledWrites.delete(name);
    if (next === undefined) return;
    if (next === null) {
      await del(name, database());
    } else {
      await set(name, next, database());
    }
    if (!retired) window.localStorage.removeItem(name);
    writeFailureReported = false;
  }).catch((error: unknown) => {
    if (retired) return;
    appLogger.warn("[epic-canvas] browser save failed", {
      error: describeLogError(error),
    });
    if (!writeFailureReported) {
      writeFailureReported = true;
      toastFromRunnerError(
        error,
        "Could not save your tabs. Reloading may lose recent tab changes.",
      );
    }
  });
}

/** Waits for writes already accepted; new changes are coalesced per account. */
export async function drainCanvasBrowserStorage(): Promise<void> {
  let pending: Promise<void>;
  do {
    pending = operations;
    await pending;
  } while (pending !== operations);
}

/** The wipe calls this before removing either the legacy keys or the database. */
export async function retireCanvasBrowserStorage(): Promise<void> {
  retired = true;
  pendingWrites.clear();
  await drainCanvasBrowserStorage();
}

interface RestoredCanvas {
  readonly value: string | null;
  readonly legacyKey: string | null;
  readonly legacyValue: string | null;
}

function readCanvas(
  name: string,
  legacyName: string | null,
): Promise<RestoredCanvas> {
  return database()(
    "readwrite",
    (store) =>
      new Promise<RestoredCanvas>((resolve, reject) => {
        let restored: RestoredCanvas = {
          value: null,
          legacyKey: null,
          legacyValue: null,
        };
        const transaction = store.transaction;
        transaction.oncomplete = () => resolve(restored);
        transaction.onabort = transaction.onerror = () =>
          reject(
            transaction.error ??
              new Error("Saved tab storage could not be read."),
          );
        const fail = (error: unknown): void => {
          transaction.abort();
          reject(
            error instanceof Error
              ? error
              : new Error("Saved tab storage could not be read."),
          );
        };
        const adopt = (key: string, claim: IDBValidKey | null): void => {
          const value = window.localStorage.getItem(key);
          if (value === null) return;
          store.put(value, name);
          if (claim !== null) store.put(name, claim);
          restored = { value, legacyKey: key, legacyValue: value };
        };
        const request = store.get(name);
        request.onsuccess = () => {
          try {
            const current: unknown = request.result;
            if (typeof current === "string") {
              restored = {
                value: current,
                legacyKey: name,
                legacyValue: window.localStorage.getItem(name),
              };
            } else if (current !== undefined) {
              throw new Error(
                "Saved tab storage contains an unreadable layout.",
              );
            } else if (window.localStorage.getItem(name) !== null) {
              adopt(name, null);
            } else if (legacyName !== null && legacyName !== name) {
              // Claim an old email bucket in the same transaction as adoption.
              // Two accounts sharing an email cannot both take that old layout,
              // even when different windows begin migration at the same time.
              const claim: IDBValidKey = ["legacy", legacyName];
              const claimed = store.get(claim);
              claimed.onsuccess = () => {
                try {
                  if (claimed.result === undefined) adopt(legacyName, claim);
                } catch (error) {
                  fail(error);
                }
              };
            }
          } catch (error) {
            fail(error);
          }
        };
      }),
  );
}

/**
 * The complete canvas envelope lives in IndexedDB. HTML selections keep all
 * their immutable hashes; no localStorage quota can turn a pin into Latest.
 * The factory captures the legacy key for this hydration, not a mutable user.
 */
export function createCanvasBrowserStorage(
  legacyName: string | null,
): StateStorage {
  return {
    getItem: (name) => {
      // Anonymous state is never restored into an account or after sign-out.
      if (name === epicCanvasKey(null)) return null;
      return enqueue(async () => {
        const restored = await readCanvas(name, legacyName);
        if (retired) throw new Error("Saved tab storage is being cleared.");
        // Retire only the bytes we considered, and only after the transaction
        // committed. A failed migration leaves the sole old copy untouched.
        if (
          restored.legacyKey !== null &&
          restored.legacyValue !== null &&
          window.localStorage.getItem(restored.legacyKey) ===
            restored.legacyValue
        ) {
          window.localStorage.removeItem(restored.legacyKey);
        }
        return restored.value;
      });
    },
    setItem: (name, value) => {
      if (name !== epicCanvasKey(null)) scheduleWrite(name, value);
    },
    removeItem: (name) => {
      scheduleWrite(name, null);
    },
  };
}
