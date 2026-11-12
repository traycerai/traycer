/**
 * Shared fake-IndexedDB harness for every suite that drives a real IndexedDB
 * (landing images, drafts, appearance cache, tab recovery). Installs a fresh
 * factory per test so prior DBs and connections cannot leak state.
 */
import {
  IDBFactory as FakeIDBFactory,
  IDBKeyRange as FakeIDBKeyRange,
} from "fake-indexeddb";

export function installFreshIndexedDb(): void {
  // Fresh factory per test so prior DBs and connections cannot leak state.
  // The package re-exports its constructors as IDBFactory / IDBKeyRange.
  globalThis.indexedDB = new FakeIDBFactory();
  globalThis.IDBKeyRange = FakeIDBKeyRange;
}

/** A rejection reason that is an `Error`, whatever the request left. */
function failure(error: DOMException | null): Error {
  return error ?? new Error("the IndexedDB request failed");
}

/**
 * Opens `dbName` over the installed factory as a bare connection, creating
 * `storeName` if the database is new, and hands it to `run`; the connection is
 * closed afterwards, so it can never block a deletion.
 */
function withConnection<T>(
  dbName: string,
  storeName: string,
  run: (db: IDBDatabase) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(dbName);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(storeName);
    };
    open.onerror = () => reject(failure(open.error));
    open.onsuccess = () => {
      const db = open.result;
      run(db).then(
        (value) => {
          db.close();
          resolve(value);
        },
        (error: unknown) => {
          db.close();
          reject(
            error instanceof Error
              ? error
              : new Error("the IndexedDB use failed"),
          );
        },
      );
    };
  });
}

/** Writes `value` under `key` in `dbName`'s `storeName`, over a connection of its own. */
export function rawPut(
  dbName: string,
  storeName: string,
  key: string,
  value: unknown,
): Promise<void> {
  return withConnection(
    dbName,
    storeName,
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(failure(tx.error));
      }),
  );
}

/** Reads `key` from `dbName`'s `storeName`, over a connection of its own. */
export function rawGet(
  dbName: string,
  storeName: string,
  key: string,
): Promise<unknown> {
  return withConnection(
    dbName,
    storeName,
    (db) =>
      new Promise<unknown>((resolve, reject) => {
        const request = db
          .transaction(storeName, "readonly")
          .objectStore(storeName)
          .get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(failure(request.error));
      }),
  );
}

/**
 * Deletes `dbName` as the wipe does, and answers how it went at once: `blocked`
 * when a connection another window holds open refused to close, `deleted` when
 * the deletion went through.
 */
export function deleteDatabaseOutcome(
  dbName: string,
): Promise<"deleted" | "blocked"> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve("deleted");
    request.onblocked = () => resolve("blocked");
    request.onerror = () => reject(failure(request.error));
  });
}
