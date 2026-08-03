// The specific `keys` submodule, not the `@/lib/persist` barrel: the barrel
// re-exports `lib/persist/wipe.ts`, which imports `PROMPT_STASH_DB_NAME` from
// this module to delete the stash database by exact name - importing the
// barrel here would close that cycle.
import { PERSIST_PREFIX } from "@/lib/persist/keys";

import {
  inspectRawStashRecord,
  isUint8ArrayBytes,
  isValidStashBlobRecord,
  newestFirstRow,
  toPromptStashRow,
  type PromptStashManifest,
  type PromptStashRestoreBlob,
  type PromptStashRestoreRead,
  type PromptStashSnapshot,
  type RawStashRecordInfo,
  type StashBlobRecord,
} from "@/lib/composer/prompt-stash-codec";

interface StashMetaRecord {
  readonly key: "state";
  readonly revision: number;
}

export class PromptStashCapacityExceededError extends Error {
  constructor() {
    super("The prompt stash storage budget was exceeded.");
    this.name = "PromptStashCapacityExceededError";
  }
}

/** Every blob a restore needs was resolvable, but at least one is missing. */
export class PromptStashMissingBlobError extends Error {
  constructor() {
    super("A stashed image is missing from durable storage.");
    this.name = "PromptStashMissingBlobError";
  }
}

/** Every referenced blob exists but failed byte-level validation. */
export class PromptStashCorruptBlobError extends Error {
  constructor() {
    super("A stashed image is damaged and could not be verified.");
    this.name = "PromptStashCorruptBlobError";
  }
}

export const PROMPT_STASH_DB_NAME = `${PERSIST_PREFIX}:prompt-stash`;
/**
 * Actual physical blob budget, derived from `blobs` store contents inside
 * every save transaction (never a maintained counter). Exactly 64 MiB is
 * allowed; anything above is rejected with no eviction and no mutation.
 */
export const PROMPT_STASH_BUDGET_BYTES = 64 * 1024 * 1024;

const PROMPT_STASH_DB_VERSION = 2;
// idb-keyval's single dev-only keyval store, created under this name by the
// pre-v2 implementation. It never shipped in a release - this feature only
// ever existed on developer machines before this schema replaced it - so the
// upgrade drops it outright instead of migrating.
const DEV_STORE_NAME = "stash";
const ENTRIES_STORE = "entries";
const BLOBS_STORE = "blobs";
const META_STORE = "meta";
const META_KEY = "state";
let dbPromise: Promise<IDBDatabase> | null = null;

// The DOM lib declares `indexedDB` non-nullable, so checking its result for
// `undefined` in the SAME scope as this reference gets flagged as always-
// false. Returning it through its own function crosses a call boundary,
// so the wider return type annotation - not the lib's narrower one - is
// what `indexedDBFactory` below sees, matching `lib/persist/wipe.ts`'s
// identical `indexedDBFactory` guard for a runtime that really can lack it
// (e.g. a test environment without an IndexedDB polyfill).
function rawIndexedDBFactory(): IDBFactory | undefined {
  return globalThis.indexedDB;
}

function indexedDBFactory(): IDBFactory {
  const factory = rawIndexedDBFactory();
  if (factory === undefined) {
    throw new Error("This browser does not support IndexedDB.");
  }
  return factory;
}

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDBFactory().open(
      PROMPT_STASH_DB_NAME,
      PROMPT_STASH_DB_VERSION,
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(DEV_STORE_NAME)) {
        db.deleteObjectStore(DEV_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
        db.createObjectStore(ENTRIES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: "hash" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        const metaStore = db.createObjectStore(META_STORE, { keyPath: "key" });
        metaStore.put({ key: META_KEY, revision: 0 });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // Lets a `deleteDatabase` call from this or another window (see
      // `lib/persist/wipe.ts`) proceed instead of sitting in `onblocked`
      // behind a connection this module never explicitly closes. Also
      // re-arms the cache: the closed handle is unusable, so a LATER
      // `openDb()` call must open a fresh connection rather than keep
      // returning this now-resolved-but-closed one forever.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      dbPromise = null;
      reject(
        new Error("The prompt stash database is blocked by another window."),
      );
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      // Re-arm on failure too: caching a rejected promise would make every
      // later operation reject forever, even after a transient open error
      // (e.g. a momentary quota/permission issue) has since cleared.
      dbPromise = null;
      reject(
        request.error ?? new Error("Could not open the prompt stash database."),
      );
    };
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () =>
      reject(request.error ?? new Error("An IndexedDB request failed."));
  });
}

function iterateCursor(
  request: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      // A synchronous throw from `visit` (e.g. touching a corrupt stored
      // record) happens inside a DOM event handler, not inside this
      // Promise's executor - left uncaught, it would neither resolve nor
      // reject this promise, leaving the caller's `await` (and the whole
      // save/delete transaction) pending forever. Catching it here
      // settles the promise deterministically so `runTransaction` can abort
      // and propagate the real error instead.
      try {
        const cursor = request.result;
        if (cursor === null) {
          resolve();
          return;
        }
        visit(cursor);
        cursor.continue();
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error("An IndexedDB cursor request failed."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("An IndexedDB transaction failed."));
    tx.onabort = () =>
      reject(tx.error ?? new Error("An IndexedDB transaction was aborted."));
  });
}

/**
 * Runs `work` as the sole body of one transaction over `storeNames`. Every
 * request/cursor `work` issues must be awaited through `requestToPromise` /
 * `iterateCursor` (never an unrelated promise) so the transaction never idles
 * past a commit-eligible microtask boundary. A thrown error aborts the
 * transaction explicitly (rolling back every write already queued) and
 * propagates the original error, not IndexedDB's generic abort error.
 */
async function runTransaction<T>(
  storeNames: readonly string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(storeNames, mode);
  const done = transactionDone(tx);
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    outcome = { ok: true, value: await work(tx) };
  } catch (error) {
    outcome = { ok: false, error };
    try {
      tx.abort();
    } catch {
      // The transaction already finished (a failed request auto-aborts it) -
      // nothing left to do.
    }
  }
  if (!outcome.ok) {
    await done.catch(() => undefined);
    throw outcome.error;
  }
  await done;
  return outcome.value;
}

async function currentRevision(metaStore: IDBObjectStore): Promise<number> {
  const record = await requestToPromise<StashMetaRecord | undefined>(
    metaStore.get(META_KEY),
  );
  return record?.revision ?? 0;
}

async function bumpRevision(metaStore: IDBObjectStore): Promise<number> {
  const next = (await currentRevision(metaStore)) + 1;
  await requestToPromise(metaStore.put({ key: META_KEY, revision: next }));
  return next;
}

/**
 * One readonly transaction: every raw entry record plus every current blob
 * KEY (not bytes - `getAllKeys` never transfers blob content) so an entry
 * whose `blobHashes` reference something absent from the store surfaces as
 * unavailable immediately, without a byte read. Byte-level corruption
 * (wrong runtime type, size/hash/MIME mismatch) is only checked lazily, on
 * an actual restore attempt (`readPromptStashRestoreBlobs`) - validating
 * every stored byte on every load would cost the full budget's worth of I/O
 * on every hydrate for a check restore already performs.
 */
export function loadPromptStashSnapshot(): Promise<PromptStashManifest> {
  return runTransaction(
    [ENTRIES_STORE, BLOBS_STORE, META_STORE],
    "readonly",
    async (tx) => {
      const rawEntries = await requestToPromise<unknown[]>(
        tx.objectStore(ENTRIES_STORE).getAll(),
      );
      const presentBlobHashes = new Set(
        await requestToPromise<string[]>(
          tx.objectStore(BLOBS_STORE).getAllKeys(),
        ),
      );
      const revision = await currentRevision(tx.objectStore(META_STORE));
      const rows = rawEntries
        .map(inspectRawStashRecord)
        .filter((info): info is RawStashRecordInfo => info !== null)
        .map((info) => toPromptStashRow(info, presentBlobHashes))
        .toSorted(newestFirstRow);
      return { rows, revision };
    },
  );
}

/**
 * One readwrite transaction: reads existing entries/blobs, reclaims blobs no
 * longer referenced once this entry replaces any prior entry of the same id,
 * derives physical usage from what survives that cleanup, rejects above
 * budget with no mutation at all, then writes only the blobs missing from
 * the store plus the entry and bumped revision atomically.
 */
export function savePromptStashSnapshot(
  snapshot: PromptStashSnapshot,
): Promise<PromptStashManifest> {
  return runTransaction(
    [ENTRIES_STORE, BLOBS_STORE, META_STORE],
    "readwrite",
    async (tx) => {
      const entriesStore = tx.objectStore(ENTRIES_STORE);
      const blobsStore = tx.objectStore(BLOBS_STORE);
      const metaStore = tx.objectStore(META_STORE);

      // Tolerant of a corrupt sibling record: a malformed field on an
      // UNRELATED existing entry must never abort this save. Its
      // best-effort `blobHashes` still protects whatever blobs it can
      // identify; a record this repository can't even parse an id from
      // contributes nothing to `referenced` and is dropped (nothing to
      // display or delete by).
      const rawEntries = await requestToPromise<unknown[]>(
        entriesStore.getAll(),
      );
      const otherInfos = rawEntries
        .map(inspectRawStashRecord)
        .filter(
          (info): info is RawStashRecordInfo =>
            info !== null && info.id !== snapshot.entry.id,
        );
      const referenced = new Set<string>(snapshot.entry.blobHashes);
      for (const info of otherInfos) {
        for (const hash of info.blobHashes) referenced.add(hash);
      }

      // The current snapshot's own bytes are always authoritative for any
      // hash it references - never whatever happens to already be stored
      // there. A save cannot verify an existing record's content against
      // its key without hashing inside the transaction, so a typed
      // Uint8Array record with the wrong bytes under a colliding/reused
      // key would otherwise look "already present" and silently shadow
      // the snapshot's correct bytes forever.
      const ownBlobHashes = new Set<string>(snapshot.entry.blobHashes);

      // Reclaim orphans and derive kept usage in the same pass, BEFORE
      // admitting any new blob - usage is always summed from what the
      // store actually holds, never a maintained counter. Sum the actual
      // stored byte view's length, not the `byteLength` metadata field -
      // that field is redundant, cached data that could drift from the
      // real bytes and would otherwise weaken the physical-byte budget.
      let keptBytes = 0;
      const existingBlobHashes = new Set<string>();
      await iterateCursor(blobsStore.openCursor(), (cursor) => {
        const record = cursor.value as StashBlobRecord;
        if (!referenced.has(record.hash)) {
          cursor.delete();
          return;
        }
        if (ownBlobHashes.has(record.hash)) {
          // The snapshot itself supplies this hash's canonical bytes below
          // - delete whatever is here now (malformed, or a well-typed
          // record whose content happens to be wrong under this key) so
          // the insertion pass unconditionally repairs it with verified
          // bytes, counted exactly once as incoming. A sibling that also
          // references this hash benefits from the same repair.
          cursor.delete();
          return;
        }
        // A malformed retained blob (e.g. `null`/a plain array in `bytes`,
        // from corruption) must be runtime-validated before it feeds
        // arithmetic, and must never be left in place uncounted: doing so
        // would let it occupy real storage outside the physical budget
        // forever. Deleting a sibling-only malformed record here is safe -
        // that sibling's row/restore already surfaces as
        // unavailable/missing without this blob.
        if (!isUint8ArrayBytes(record.bytes)) {
          cursor.delete();
          return;
        }
        existingBlobHashes.add(record.hash);
        keptBytes += record.bytes.byteLength;
      });

      const missingRecords: StashBlobRecord[] = [];
      let incomingBytes = 0;
      for (const hash of snapshot.entry.blobHashes) {
        if (existingBlobHashes.has(hash)) continue;
        const blob = snapshot.imagesByHash.get(hash);
        if (blob === undefined) {
          throw new Error(
            "A stashed image is missing its bytes and cannot be saved.",
          );
        }
        incomingBytes += blob.bytes.byteLength;
        missingRecords.push({
          hash,
          bytes: blob.bytes,
          byteLength: blob.bytes.byteLength,
          mimeType: blob.mimeType,
        });
      }

      if (keptBytes + incomingBytes > PROMPT_STASH_BUDGET_BYTES) {
        throw new PromptStashCapacityExceededError();
      }

      for (const record of missingRecords) {
        await requestToPromise(blobsStore.put(record));
      }
      await requestToPromise(entriesStore.put(snapshot.entry));
      const revision = await bumpRevision(metaStore);

      const presentAfterSave = new Set(existingBlobHashes);
      for (const record of missingRecords) {
        presentAfterSave.add(record.hash);
      }
      const rows = [
        { kind: "entry" as const, entry: snapshot.entry },
        ...otherInfos.map((info) => toPromptStashRow(info, presentAfterSave)),
      ].toSorted(newestFirstRow);

      return { rows, revision };
    },
  );
}

/**
 * One readwrite transaction: deletes the entry (a missing id is a successful
 * no-op that touches nothing), derives the remaining live references, and
 * reclaims every blob no longer referenced, bumping revision only when an
 * entry actually changed.
 */
export function deletePromptStashEntry(
  entryId: string,
): Promise<PromptStashManifest> {
  return runTransaction(
    [ENTRIES_STORE, BLOBS_STORE, META_STORE],
    "readwrite",
    async (tx) => {
      const entriesStore = tx.objectStore(ENTRIES_STORE);
      const blobsStore = tx.objectStore(BLOBS_STORE);
      const metaStore = tx.objectStore(META_STORE);

      const rawEntries = await requestToPromise<unknown[]>(
        entriesStore.getAll(),
      );
      const infos = rawEntries
        .map(inspectRawStashRecord)
        .filter((info): info is RawStashRecordInfo => info !== null);
      const remainingInfos = infos.filter((info) => info.id !== entryId);
      if (remainingInfos.length === infos.length) {
        // No identifiable record matched `entryId` - a missing entry is a
        // successful no-op (also covers "a peer window already deleted
        // it"), never an error. Delete-by-id works uniformly for a
        // corrupt/unavailable row too, since identity only needs `id`.
        const revision = await currentRevision(metaStore);
        const presentBlobHashes = new Set(
          await requestToPromise<string[]>(blobsStore.getAllKeys()),
        );
        const rows = infos
          .map((info) => toPromptStashRow(info, presentBlobHashes))
          .toSorted(newestFirstRow);
        return { rows, revision };
      }

      await requestToPromise(entriesStore.delete(entryId));

      const referenced = new Set<string>();
      for (const info of remainingInfos) {
        for (const hash of info.blobHashes) referenced.add(hash);
      }
      const keptBlobHashes = new Set<string>();
      await iterateCursor(blobsStore.openCursor(), (cursor) => {
        const record = cursor.value as StashBlobRecord;
        if (referenced.has(record.hash)) {
          keptBlobHashes.add(record.hash);
        } else {
          cursor.delete();
        }
      });

      const revision = await bumpRevision(metaStore);
      const rows = remainingInfos
        .map((info) => toPromptStashRow(info, keptBlobHashes))
        .toSorted(newestFirstRow);
      return { rows, revision };
    },
  );
}

/**
 * One readonly transaction reading every requested blob as a consistent
 * snapshot: bytes already resolved here stay valid in memory even if another
 * window deletes the entry (and reclaims these blobs) immediately after this
 * resolves. `"missing"` if any requested hash isn't in the store; `"corrupt"`
 * if every hash resolved but at least one fails byte-level validation
 * (runtime type, measured length, canonical MIME, SHA-256 agreement) -
 * matches restore's all-or-nothing contract either way, only the reported
 * reason differs.
 */
export async function readPromptStashRestoreBlobs(
  blobHashes: readonly string[],
): Promise<PromptStashRestoreRead> {
  if (blobHashes.length === 0) return { status: "ok", blobs: new Map() };
  const records = await runTransaction(
    [BLOBS_STORE],
    "readonly",
    async (tx): Promise<ReadonlyMap<string, StashBlobRecord> | null> => {
      const blobsStore = tx.objectStore(BLOBS_STORE);
      const found = new Map<string, StashBlobRecord>();
      for (const hash of blobHashes) {
        const record = await requestToPromise<StashBlobRecord | undefined>(
          blobsStore.get(hash),
        );
        if (record === undefined) return null;
        found.set(hash, record);
      }
      return found;
    },
  );
  if (records === null) return { status: "missing" };
  // Validation runs AFTER the transaction resolves, deliberately: SHA-256
  // digesting is async across potentially several microtask/macrotask
  // boundaries, and `runTransaction`'s contract requires every request
  // inside `work` to be awaited without idling past a commit-eligible
  // boundary. The bytes read above are already a consistent in-memory
  // snapshot - valid even if another window deletes the entry immediately
  // after - so validating them outside the transaction changes nothing
  // about that guarantee.
  const blobs = new Map<string, PromptStashRestoreBlob>();
  for (const [hash, record] of records) {
    if (!(await isValidStashBlobRecord(hash, record))) {
      return { status: "corrupt" };
    }
    blobs.set(hash, {
      bytes: record.bytes,
      byteLength: record.byteLength,
      mimeType: record.mimeType,
    });
  }
  return { status: "ok", blobs };
}
