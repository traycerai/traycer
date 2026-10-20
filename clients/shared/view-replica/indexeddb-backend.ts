import type {
  ViewReplicaAccountMeta,
  ViewReplicaBackend,
  ViewReplicaStoredRecord,
} from "./store";

const RECORDS = "records";
const META = "meta";
const BY_ACCOUNT = "byAccount";

/**
 * The replica's IndexedDB store: one database, pages in `records` (indexed by
 * account) and each account's epochs, floors and withdrawals in `meta`.
 * Every call is one transaction, so a page and the meta that fences it land
 * together or not at all. An unavailable or blocked database reads as empty
 * and drops writes: the replica is an accelerator, never the authority.
 */
export function createIndexedDbViewReplicaBackend(
  /** Read at first use, not at construction: a runtime may install it late. */
  readFactory: () => IDBFactory | undefined,
  databaseName: string,
): ViewReplicaBackend {
  let opened: Promise<IDBDatabase | null> | null = null;

  function database(): Promise<IDBDatabase | null> {
    if (opened !== null) return opened;
    const factory = readFactory();
    if (factory === undefined) return Promise.resolve(null);
    opened = new Promise((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(databaseName, 1);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORDS)) {
          db.createObjectStore(RECORDS, { keyPath: "key" }).createIndex(
            BY_ACCOUNT,
            "identity.accountId",
          );
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: "accountId" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another window deleting the database (the explicit wipe) must not
        // be blocked by this connection.
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        opened = null;
        resolve(null);
      };
      request.onblocked = () => {
        opened = null;
        resolve(null);
      };
    });
    return opened;
  }

  return {
    async load(accountId) {
      const db = await database();
      if (db === null) return { records: [], meta: null };
      const tx = db.transaction([RECORDS, META], "readonly");
      const records = requestResult(
        tx.objectStore(RECORDS).index(BY_ACCOUNT).getAll(accountId),
      );
      const meta = requestResult(tx.objectStore(META).get(accountId));
      const loaded = await records;
      return {
        records: Array.isArray(loaded) ? loaded : [],
        meta: (await meta) ?? null,
      };
    },
    async write(
      records: readonly ViewReplicaStoredRecord[],
      deleteKeys: readonly string[],
      meta: ViewReplicaAccountMeta | null,
    ) {
      const db = await database();
      if (db === null) return;
      const tx = db.transaction([RECORDS, META], "readwrite");
      const recordStore = tx.objectStore(RECORDS);
      for (const key of deleteKeys) recordStore.delete(key);
      for (const record of records) recordStore.put(record);
      if (meta !== null) tx.objectStore(META).put(meta);
      await transactionDone(tx);
    },
    async deleteAccount(accountId) {
      const db = await database();
      if (db === null) return;
      const tx = db.transaction([RECORDS, META], "readwrite");
      const recordStore = tx.objectStore(RECORDS);
      const keys = recordStore.index(BY_ACCOUNT).getAllKeys(accountId);
      keys.onsuccess = () => {
        for (const key of keys.result) recordStore.delete(key);
      };
      tx.objectStore(META).delete(accountId);
      await transactionDone(tx);
    },
    async clear() {
      const db = await database();
      if (db === null) return;
      const tx = db.transaction([RECORDS, META], "readwrite");
      tx.objectStore(RECORDS).clear();
      tx.objectStore(META).clear();
      await transactionDone(tx);
    },
  };
}

function requestResult(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}
