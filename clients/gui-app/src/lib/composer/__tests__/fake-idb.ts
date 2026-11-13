/**
 * Shared fake-IndexedDB harness for every suite that drives a real IndexedDB
 * (landing images, drafts, appearance cache, tab recovery). Installs a fresh
 * factory per test so prior DBs and connections cannot leak state.
 */
import { onTestFinished, vi } from "vitest";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
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

/** Deletes `key` from `dbName`'s `storeName`, over a connection of its own: the database stays, as when another window's sweep reclaims one image. */
export function rawDelete(
  dbName: string,
  storeName: string,
  key: string,
): Promise<void> {
  return withConnection(
    dbName,
    storeName,
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(failure(tx.error));
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

/**
 * Deletes `dbName` and answers once the deletion has gone through. A connection
 * that was told to close but still has transactions running keeps it waiting,
 * which is what the callers hold open on purpose; `deleteDatabaseOutcome`
 * answers `blocked` instead.
 */
export function deleteDatabaseWhenClosed(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(failure(request.error));
  });
}

/**
 * Starts the deletion of `dbName`. `invalidated` settles once the window's
 * store has let go of its connection to it and told its listeners
 * (`onLandingImagesDeleted`), which is before the deletion itself can finish
 * when a transaction is still running; `removed` settles when it has.
 */
export function deleteAndAwaitInvalidation(
  dbName: string,
  onDeleted: (listener: () => void) => void,
): { readonly invalidated: Promise<void>; readonly removed: Promise<void> } {
  const invalidated = new Promise<void>((resolve) => onDeleted(resolve));
  return { invalidated, removed: deleteDatabaseWhenClosed(dbName) };
}

/** A readwrite transaction kept running on a connection of its own, by {@link HoldingConnection.hold}. */
export interface HeldTransaction {
  /** Settles once the transaction has answered its first read: it is running, and what is queued after it waits. */
  readonly started: Promise<void>;
  /** Lets the transaction finish. */
  release(): void;
}

export interface HoldingConnection {
  /**
   * Starts, in this call, a readwrite transaction that keeps reading `key`
   * until it is released. Every transaction another connection starts on the
   * store afterwards queues behind it.
   */
  hold(key: string): HeldTransaction;
}

/**
 * Opens a connection to `dbName` (creating `storeName` if the database is new)
 * that lets go when the database is deleted, as a store's own does, though
 * the transaction it holds keeps running until released.
 */
export function openHoldingConnection(
  dbName: string,
  storeName: string,
): Promise<HoldingConnection> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(storeName);
    };
    open.onerror = () => reject(failure(open.error));
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      resolve({
        hold(key) {
          let released = false;
          let began = (): void => undefined;
          const started = new Promise<void>((resolveStarted) => {
            began = resolveStarted;
          });
          const objectStore = db
            .transaction(storeName, "readwrite")
            .objectStore(storeName);
          const poll = (): void => {
            const request = objectStore.get(key);
            request.onsuccess = () => {
              began();
              if (!released) poll();
            };
          };
          poll();
          return {
            started,
            release: () => {
              released = true;
            },
          };
        },
      });
    };
  });
}

/** The bytes a digest was asked about, as numbers, whatever view they came in. */
function digestKey(data: BufferSource): string {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  return bytes.join(",");
}

/**
 * Makes `crypto.subtle.digest` answer for each of `known` from its digest
 * taken now, in a microtask, until the test ends. The real digest settles on a
 * thread pool, so when an operation reaches the store after it is up to the
 * machine; with this it depends on the fake IndexedDB alone, and a test can
 * rely on "the operation has started" once a macrotask has passed. Bytes
 * outside `known` are digested for real.
 */
export async function stubDigestsOf(
  known: ReadonlyArray<ImageBytes>,
): Promise<void> {
  const real = crypto.subtle.digest.bind(crypto.subtle);
  const digests = new Map<string, ArrayBuffer>();
  for (const bytes of known) {
    digests.set(digestKey(bytes), await real("SHA-256", bytes));
  }
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation((algorithm, data) => {
      const digest = digests.get(digestKey(data));
      return digest === undefined
        ? real(algorithm, data)
        : Promise.resolve(digest.slice(0));
    });
  onTestFinished(() => spy.mockRestore());
}
