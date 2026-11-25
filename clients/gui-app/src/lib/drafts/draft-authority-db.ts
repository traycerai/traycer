import type {
  DraftAuthorityBorrowedStore,
  DraftAuthorityRecoveryStores,
} from "./draft-authority-types";
import { persistKey } from "@/lib/persist/keys";

export const DRAFT_AUTHORITY_DB_NAME = persistKey("draft-authority");

const DB_VERSION = 1;
const schema = {
  drafts: "drafts",
  sidecars: "draft-sidecars",
  receipts: "receipts",
  claims: "effect-claims",
  pending: "pending-outbox",
  retirements: "host-retirements",
  blobs: "recovery-blobs",
  refs: "recovery-refs",
  budget: "recovery-budget",
} as const;

type Store = (typeof schema)[keyof typeof schema];

interface DraftAuthorityIndexedStore extends DraftAuthorityBorrowedStore<IDBValidKey> {
  readAll(query: IDBKeyRange): Promise<readonly unknown[]>;
}

export interface DraftAuthorityTransaction {
  readonly drafts: DraftAuthorityIndexedStore;
  readonly sidecars: DraftAuthorityIndexedStore;
  readonly receipts: DraftAuthorityIndexedStore;
  readonly claims: DraftAuthorityIndexedStore;
  readonly pending: DraftAuthorityIndexedStore;
  readonly retirements: DraftAuthorityIndexedStore;
  readonly recovery: DraftAuthorityRecoveryStores;
}

export type DraftAuthorityStoreName = keyof DraftAuthorityTransaction;

const transactionStores: Record<DraftAuthorityStoreName, readonly Store[]> = {
  drafts: [schema.drafts],
  sidecars: [schema.sidecars],
  receipts: [schema.receipts],
  claims: [schema.claims],
  pending: [schema.pending],
  retirements: [schema.retirements],
  recovery: [schema.blobs, schema.refs, schema.budget],
};

type TransactionOutcome<Value> =
  | { readonly kind: "complete"; readonly value: Value }
  | { readonly kind: "unavailable" | "unverified"; readonly cause?: unknown };

let connection: Promise<IDBDatabase> | undefined;
let retired = false;

export function retireDraftAuthorityStorage(): void {
  retired = true;
  void connection?.then((database) => database.close(), () => undefined);
}

function openDraftAuthorityDatabase(): Promise<IDBDatabase> {
  if (retired) return Promise.reject(new Error("Draft authority was retired"));
  if (connection !== undefined) return connection;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(DRAFT_AUTHORITY_DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      for (const store of Object.values(schema)) {
        if (!database.objectStoreNames.contains(store)) {
          database.createObjectStore(store);
        }
      }
      if (event.oldVersion === 0) {
        request.transaction?.objectStore(schema.budget).put(0, "resident-bytes");
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = (event) => {
        database.close();
        if (connection === opening) connection = undefined;
        if (event.newVersion === null) retired = true;
      };
      database.onclose = () => {
        if (connection === opening) connection = undefined;
      };
      if (retired) {
        database.close();
        reject(new Error("Draft authority was retired"));
        return;
      }
      resolve(database);
    };
  });
  connection = opening;
  void opening.catch(() => {
    if (connection === opening) connection = undefined;
  });
  return opening;
}

function resultOfRequest<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function borrowStore<Key>(
  transaction: IDBTransaction,
  name: Store,
  keyOf: (key: Key) => IDBValidKey,
): DraftAuthorityBorrowedStore<Key> {
  return {
    read: (key) =>
      resultOfRequest<unknown>(transaction.objectStore(name).get(keyOf(key))),
    write: async (key, value) => {
      await resultOfRequest(transaction.objectStore(name).put(value, keyOf(key)));
    },
    remove: async (key) => {
      await resultOfRequest(transaction.objectStore(name).delete(keyOf(key)));
    },
  };
}

type RecoveryKey = readonly [accountId: string, digest: string];

function borrowIndexedStore(
  transaction: IDBTransaction,
  name: Store,
): DraftAuthorityIndexedStore {
  return {
    ...borrowStore(transaction, name, (key: IDBValidKey) => key),
    readAll(query): Promise<readonly unknown[]> {
      const rows = resultOfRequest(transaction.objectStore(name).getAll(query));
      return rows;
    },
  };
}

function borrowTransaction(
  transaction: IDBTransaction,
): DraftAuthorityTransaction {
  const recoveryKey = (key: RecoveryKey): IDBValidKey => [...key];
  return {
    drafts: borrowIndexedStore(transaction, schema.drafts),
    sidecars: borrowIndexedStore(transaction, schema.sidecars),
    receipts: borrowIndexedStore(transaction, schema.receipts),
    claims: borrowIndexedStore(transaction, schema.claims),
    pending: borrowIndexedStore(transaction, schema.pending),
    retirements: borrowIndexedStore(transaction, schema.retirements),
    recovery: {
      blobs: borrowStore(transaction, schema.blobs, recoveryKey),
      refs: borrowStore(transaction, schema.refs, recoveryKey),
      budget: borrowStore(transaction, schema.budget, (key: string) => key),
    },
  };
}

function openTransaction(
  database: IDBDatabase,
  stores: Store[],
  mode: IDBTransactionMode,
): IDBTransaction {
  if (mode !== "readwrite") return database.transaction(stores, mode);
  try {
    return database.transaction(stores, mode, { durability: "strict" });
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    return database.transaction(stores, mode);
  }
}

/** The callback may wait only on requests made through this transaction. */
export async function runDraftAuthorityTransaction<
  Value,
  Name extends DraftAuthorityStoreName,
>(
  stores: readonly Name[],
  mode: "readonly" | "readwrite",
  run: (transaction: Pick<DraftAuthorityTransaction, Name>) => Promise<Value>,
): Promise<TransactionOutcome<Value>> {
  let transaction: IDBTransaction;
  try {
    const database = await openDraftAuthorityDatabase();
    if (retired) return { kind: "unavailable" };
    const enlisted = stores.flatMap((store) => transactionStores[store]);
    transaction = openTransaction(database, enlisted, mode);
  } catch {
    return { kind: "unavailable" };
  }

  const completion = new Promise<"complete" | "aborted">((resolve) => {
    transaction.oncomplete = () => resolve("complete");
    transaction.onabort = () => resolve("aborted");
  });
  try {
    const value = await run(borrowTransaction(transaction));
    return (await completion) === "complete"
      ? { kind: "complete", value }
      : { kind: "unavailable" };
  } catch (cause: unknown) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have completed before throwing.
    }
    return (await completion) === "aborted"
      ? { kind: "unavailable", cause }
      : { kind: "unverified", cause };
  }
}
