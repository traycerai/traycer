import { vi } from "vitest";

// In-memory stand-in for idb-keyval, ONE MAP PER DATABASE. The store argument is
// not decoration here: this module keeps image bytes and their measured sizes in
// two different databases under the SAME string hash, so a stand-in that folds
// every store into one map lets a size silently overwrite an image.
interface FakeObjectStore {
  readonly name: string;
  readonly transaction: { readonly db: object };
}
type FakeStore = (
  mode: IDBTransactionMode,
  callback: (objectStore: FakeObjectStore) => unknown,
) => unknown;

export const idb = (() => {
  const byDb = new Map<string, Map<string, unknown>>();
  // The module wraps its store handle, so the name is asked THROUGH the handle,
  // as the wrapper reaches the object store, not looked up by the handle's identity.
  function isFakeStore(store: unknown): store is FakeStore {
    return typeof store === "function";
  }
  function dbNameOf(store: unknown): string {
    if (!isFakeStore(store)) return "unregistered";
    const name = store("readonly", (objectStore) => objectStore.name);
    return typeof name === "string" ? name : "unregistered";
  }
  function dataFor(store: unknown): Map<string, unknown> {
    const dbName = dbNameOf(store);
    const existing = byDb.get(dbName);
    if (existing !== undefined) return existing;
    const created = new Map<string, unknown>();
    byDb.set(dbName, created);
    return created;
  }
  function dataForDb(suffix: string): Map<string, unknown> {
    for (const [dbName, data] of byDb) {
      if (dbName.endsWith(suffix)) return data;
    }
    const created = new Map<string, unknown>();
    byDb.set(`pending:${suffix}`, created);
    return created;
  }
  return {
    byDb,
    dbNameOf,
    dataFor,
    dataForDb,
    /** The image BYTES database - what the tests below assert about. */
    images: (): Map<string, unknown> => dataForDb(":landing-images"),
    clear: (): void => {
      byDb.clear();
    },
  };
})();

export function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

export const idbKeyvalMock = {
  createStore: vi.fn((dbName: string, _storeName: string) => {
    const objectStore: FakeObjectStore = {
      name: dbName,
      transaction: { db: {} },
    };
    const handle: FakeStore = (_mode, callback) => callback(objectStore);
    return handle;
  }),
  get: vi.fn((key: IDBValidKey, store: unknown) =>
    Promise.resolve(idb.dataFor(store).get(idbStringKey(key))),
  ),
  set: vi.fn((key: IDBValidKey, value: unknown, store: unknown) => {
    idb.dataFor(store).set(idbStringKey(key), value);
    return Promise.resolve();
  }),
  del: vi.fn((key: IDBValidKey, store: unknown) => {
    idb.dataFor(store).delete(idbStringKey(key));
    return Promise.resolve();
  }),
  keys: vi.fn((store: unknown) =>
    Promise.resolve(Array.from(idb.dataFor(store).keys())),
  ),
  entries: vi.fn((store: unknown) =>
    Promise.resolve(Array.from(idb.dataFor(store).entries())),
  ),
};
