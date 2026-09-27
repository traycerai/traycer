/**
 * Bounded persistent store for transcript (chat and artifact) image bytes.
 *
 * Separate from `landing-image-store`. That partition is a bare-hash draft of
 * the user's own paste bytes. This one is keyed by the scoped cache identity
 * (`buildScopedImageCacheKey`) so one chat or artifact's authorization never
 * serves another's. IndexedDB name:
 * `traycer-gui-app:<accountBucket>:transcript-images`, one database with
 * `bytes` and `meta` object stores. Writes land in a single transaction so a
 * crash cannot leave bytes the LRU cannot see.
 *
 * The in-memory blob-URL cache (`imageBlobCache`) is gone on relaunch. Without
 * this store every visible transcript image re-enters as unary `bytesBase64`.
 */

import {
  buildScopedImageCacheKey,
  type ImageBytesResult,
  type ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";
import { PERSIST_PREFIX, scopeBucket } from "@/lib/persist/keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";

export const TRANSCRIPT_IMAGE_DB_SUFFIX = ":transcript-images";
/**
 * Retired second-database name from the first persist commit. Wipe and
 * partition clear still delete it so a machine that opened that pair does
 * not keep an orphan meta db.
 */
export const TRANSCRIPT_IMAGE_META_DB_SUFFIX = ":transcript-image-meta";

const BYTES_STORE = "bytes";
const META_STORE = "meta";
/** Version 2 adds the `meta` store beside `bytes` (v1 was bytes-only). */
const TRANSCRIPT_IMAGE_DB_VERSION = 2;

export function transcriptImageDbName(identity: string | null): string {
  return `${PERSIST_PREFIX}:${scopeBucket(identity)}${TRANSCRIPT_IMAGE_DB_SUFFIX}`;
}

export function transcriptImageMetaDbName(identity: string | null): string {
  return `${PERSIST_PREFIX}:${scopeBucket(identity)}${TRANSCRIPT_IMAGE_META_DB_SUFFIX}`;
}

export interface StoredTranscriptImage {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mediaType: string | null;
  readonly accessedAt: number;
}

export interface TranscriptImageIndexRow {
  readonly key: string;
  readonly byteLength: number;
  readonly accessedAt: number;
}

export interface TranscriptImageCommit {
  readonly del: readonly string[];
  readonly set?: {
    readonly key: string;
    readonly value: StoredTranscriptImage;
  };
}

export interface TranscriptImageBytesBackend {
  get(key: string): Promise<StoredTranscriptImage | undefined>;
  set(key: string, value: StoredTranscriptImage): Promise<void>;
  touch(key: string, accessedAt: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Apply deletes and an optional insert in one mutation. IndexedDB uses one
   * transaction so a failed insert does not keep the deletes.
   */
  commit(change: TranscriptImageCommit): Promise<void>;
  listIndex(): Promise<readonly TranscriptImageIndexRow[]>;
  clear(): Promise<void>;
  /** Release any held IndexedDB connection so `deleteDatabase` can finish. */
  close(): void;
}

interface IndexEntry {
  byteLength: number;
  accessedAt: number;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function coerceStoredBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // `instanceof Uint8Array` fails across jsdom/Node realms after an IDB clone.
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return copyBytes(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  return null;
}

function parseStoredTranscriptImage(
  value: unknown,
): StoredTranscriptImage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (
    !("bytes" in value) ||
    !("mediaType" in value) ||
    !("accessedAt" in value)
  ) {
    return undefined;
  }
  const bytes = coerceStoredBytes(value.bytes);
  if (bytes === null) return undefined;
  if (!(value.mediaType === null || typeof value.mediaType === "string")) {
    return undefined;
  }
  if (typeof value.accessedAt !== "number") return undefined;
  return { bytes, mediaType: value.mediaType, accessedAt: value.accessedAt };
}

export function createMemoryTranscriptImageBytesBackend(): TranscriptImageBytesBackend {
  const data = new Map<string, StoredTranscriptImage>();
  return {
    get: (key) => Promise.resolve(data.get(key)),
    set: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    touch: (key, accessedAt) => {
      const stored = data.get(key);
      if (stored !== undefined) {
        data.set(key, {
          bytes: stored.bytes,
          mediaType: stored.mediaType,
          accessedAt,
        });
      }
      return Promise.resolve();
    },
    del: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    commit: (change) => {
      for (const key of change.del) data.delete(key);
      if (change.set !== undefined) {
        data.set(change.set.key, change.set.value);
      }
      return Promise.resolve();
    },
    listIndex: () =>
      Promise.resolve(
        [...data.entries()].map(([key, value]) => ({
          key,
          byteLength: value.bytes.byteLength,
          accessedAt: value.accessedAt,
        })),
      ),
    clear: () => {
      data.clear();
      return Promise.resolve();
    },
    close: () => undefined,
  };
}

function indexedDBFactory(): IDBFactory | undefined {
  // Annotated return is load-bearing: the DOM lib types `indexedDB` as
  // present, but node tests and non-browser runtimes omit it.
  return globalThis.indexedDB;
}

function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    };
  });
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    };
  });
}

function collectStoreRows<T>(
  store: IDBObjectStore,
): Promise<readonly { readonly key: string; readonly value: T }[]> {
  return Promise.all([
    awaitRequest(store.getAllKeys()),
    awaitRequest(store.getAll()),
  ]).then(([keys, values]) => {
    const rows: { key: string; value: T }[] = [];
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (typeof key !== "string") continue;
      rows.push({ key, value: values[i] as T });
    }
    return rows;
  });
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onblocked = () =>
      reject(new Error(`Database deletion blocked: ${name}`));
    request.onerror = () =>
      reject(request.error ?? new Error(`deleteDatabase failed: ${name}`));
  });
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (value === null || typeof value !== "object") return false;
  if (!("byteLength" in value) || !("accessedAt" in value)) return false;
  return (
    typeof value.byteLength === "number" && typeof value.accessedAt === "number"
  );
}

function openTranscriptImageDb(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase> {
  const request = factory.open(name, TRANSCRIPT_IMAGE_DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(BYTES_STORE)) {
      db.createObjectStore(BYTES_STORE);
    }
    if (!db.objectStoreNames.contains(META_STORE)) {
      db.createObjectStore(META_STORE);
    }
  };
  return awaitRequest(request);
}

interface TranscriptImageSnapshot {
  readonly bytesByKey: ReadonlyMap<string, unknown>;
  readonly metaByKey: ReadonlyMap<string, IndexEntry>;
}

class HeldIdbBackend implements TranscriptImageBytesBackend {
  private db: IDBDatabase | null = null;

  constructor(private readonly identity: string | null) {}

  private async ensureOpen(): Promise<IDBDatabase> {
    if (this.db !== null) return this.db;
    const factory = indexedDBFactory();
    if (factory === undefined) {
      throw new Error("IndexedDB is not available");
    }
    const db = await openTranscriptImageDb(
      factory,
      transcriptImageDbName(this.identity),
    );
    db.onversionchange = () => {
      db.close();
      if (this.db === db) this.db = null;
    };
    this.db = db;
    return db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private async readSnapshot(
    db: IDBDatabase,
  ): Promise<TranscriptImageSnapshot> {
    const readTxn = db.transaction([BYTES_STORE, META_STORE], "readonly");
    const [byteRows, metaRows] = await Promise.all([
      collectStoreRows<unknown>(readTxn.objectStore(BYTES_STORE)),
      collectStoreRows<unknown>(readTxn.objectStore(META_STORE)),
    ]);
    const bytesByKey = new Map(byteRows.map((row) => [row.key, row.value]));
    const metaByKey = new Map<string, IndexEntry>();
    for (const row of metaRows) {
      if (!isIndexEntry(row.value)) continue;
      metaByKey.set(row.key, row.value);
    }
    return { bytesByKey, metaByKey };
  }

  private indexFromSnapshot(
    snapshot: TranscriptImageSnapshot,
  ): TranscriptImageIndexRow[] {
    const rows: TranscriptImageIndexRow[] = [];
    const seen = new Set<string>();
    for (const [key, meta] of snapshot.metaByKey) {
      if (!snapshot.bytesByKey.has(key)) continue;
      rows.push({
        key,
        byteLength: meta.byteLength,
        accessedAt: meta.accessedAt,
      });
      seen.add(key);
    }
    for (const [key, stored] of snapshot.bytesByKey) {
      if (seen.has(key)) continue;
      const parsed = parseStoredTranscriptImage(stored);
      if (parsed === undefined) continue;
      rows.push({
        key,
        byteLength: parsed.bytes.byteLength,
        accessedAt: parsed.accessedAt,
      });
    }
    return rows;
  }

  private async repairFromSnapshot(
    db: IDBDatabase,
    snapshot: TranscriptImageSnapshot,
  ): Promise<void> {
    const metaPuts: { key: string; value: IndexEntry }[] = [];
    const byteDeletes: string[] = [];
    const metaDeletes: string[] = [];
    for (const [key, stored] of snapshot.bytesByKey) {
      if (snapshot.metaByKey.has(key)) continue;
      const parsed = parseStoredTranscriptImage(stored);
      if (parsed === undefined) {
        byteDeletes.push(key);
        continue;
      }
      metaPuts.push({
        key,
        value: {
          byteLength: parsed.bytes.byteLength,
          accessedAt: parsed.accessedAt,
        },
      });
    }
    for (const key of snapshot.metaByKey.keys()) {
      if (!snapshot.bytesByKey.has(key)) metaDeletes.push(key);
    }
    if (
      metaPuts.length === 0 &&
      byteDeletes.length === 0 &&
      metaDeletes.length === 0
    ) {
      return;
    }
    const writeTxn = db.transaction([BYTES_STORE, META_STORE], "readwrite");
    const bytesStore = writeTxn.objectStore(BYTES_STORE);
    const metaStore = writeTxn.objectStore(META_STORE);
    for (const row of metaPuts) metaStore.put(row.value, row.key);
    for (const key of byteDeletes) bytesStore.delete(key);
    for (const key of metaDeletes) metaStore.delete(key);
    await awaitTransaction(writeTxn);
  }

  async get(key: string): Promise<StoredTranscriptImage | undefined> {
    const db = await this.ensureOpen();
    const txn = db.transaction([BYTES_STORE], "readonly");
    const value: unknown = await awaitRequest(
      txn.objectStore(BYTES_STORE).get(key),
    );
    return parseStoredTranscriptImage(value);
  }

  async set(key: string, value: StoredTranscriptImage): Promise<void> {
    await this.commit({ del: [], set: { key, value } });
  }

  async touch(key: string, accessedAt: number): Promise<void> {
    const db = await this.ensureOpen();
    const readTxn = db.transaction([META_STORE], "readonly");
    const meta: unknown = await awaitRequest(
      readTxn.objectStore(META_STORE).get(key),
    );
    if (!isIndexEntry(meta)) return;
    const writeTxn = db.transaction([META_STORE], "readwrite");
    writeTxn
      .objectStore(META_STORE)
      .put({ byteLength: meta.byteLength, accessedAt }, key);
    await awaitTransaction(writeTxn);
  }

  async del(key: string): Promise<void> {
    await this.commit({ del: [key] });
  }

  async commit(change: TranscriptImageCommit): Promise<void> {
    const db = await this.ensureOpen();
    const txn = db.transaction([BYTES_STORE, META_STORE], "readwrite");
    const bytesStore = txn.objectStore(BYTES_STORE);
    const metaStore = txn.objectStore(META_STORE);
    for (const key of change.del) {
      bytesStore.delete(key);
      metaStore.delete(key);
    }
    if (change.set !== undefined) {
      bytesStore.put(change.set.value, change.set.key);
      metaStore.put(
        {
          byteLength: change.set.value.bytes.byteLength,
          accessedAt: change.set.value.accessedAt,
        },
        change.set.key,
      );
    }
    await awaitTransaction(txn);
  }

  async listIndex(): Promise<readonly TranscriptImageIndexRow[]> {
    const db = await this.ensureOpen();
    const snapshot = await this.readSnapshot(db);
    const index = this.indexFromSnapshot(snapshot);
    try {
      await this.repairFromSnapshot(db, snapshot);
    } catch {
      // Repair is write admission. The index above already includes
      // orphan bytes, so hydrate/eviction can see them.
    }
    return index;
  }

  async clear(): Promise<void> {
    const db = await this.ensureOpen();
    const txn = db.transaction([BYTES_STORE, META_STORE], "readwrite");
    txn.objectStore(BYTES_STORE).clear();
    txn.objectStore(META_STORE).clear();
    await awaitTransaction(txn);
  }
}

function createIdbBackend(
  identity: string | null,
): TranscriptImageBytesBackend {
  return new HeldIdbBackend(identity);
}

class TranscriptImageBytesStore {
  private backend: TranscriptImageBytesBackend | null = null;
  private backendIdentity: string | null | undefined = undefined;
  private readonly index = new Map<string, IndexEntry>();
  private indexHydrated = false;
  private injectedBackend: TranscriptImageBytesBackend | null = null;
  private readonly generationByIdentity = new Map<string, number>();
  private mutation: Promise<void> = Promise.resolve();

  installBackend(backend: TranscriptImageBytesBackend | null): void {
    this.backend?.close();
    this.injectedBackend = backend;
    this.backend = null;
    this.backendIdentity = undefined;
    this.index.clear();
    this.indexHydrated = false;
  }

  private identityKey(identity: string | null): string {
    return identity ?? "";
  }

  generationOf(identity: string | null): number {
    return this.generationByIdentity.get(this.identityKey(identity)) ?? 0;
  }

  private bumpGeneration(identity: string | null): void {
    const key = this.identityKey(identity);
    this.generationByIdentity.set(key, this.generationOf(identity) + 1);
  }

  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(work, work);
    this.mutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private resolveBackendFor(
    identity: string | null,
  ): TranscriptImageBytesBackend {
    if (this.injectedBackend !== null) return this.injectedBackend;
    if (this.backend === null || this.backendIdentity !== identity) {
      this.backend?.close();
      this.backend = createIdbBackend(identity);
      this.backendIdentity = identity;
      this.index.clear();
      this.indexHydrated = false;
    }
    return this.backend;
  }

  private async hydrateIndex(
    backend: TranscriptImageBytesBackend,
  ): Promise<void> {
    if (this.indexHydrated) return;
    const rows = await backend.listIndex();
    this.index.clear();
    for (const row of rows) {
      this.index.set(row.key, {
        byteLength: row.byteLength,
        accessedAt: row.accessedAt,
      });
    }
    this.indexHydrated = true;
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.index.values()) total += entry.byteLength;
    return total;
  }

  private keysToEvict(incoming: number, replacing: string): string[] {
    const budget = getRetentionProfile().transcriptImageCacheBytes;
    if (incoming > budget) return [];
    const remaining = new Map(this.index);
    remaining.delete(replacing);
    const keys: string[] = [];
    const totalOf = (): number => {
      let total = 0;
      for (const entry of remaining.values()) total += entry.byteLength;
      return total;
    };
    while (totalOf() + incoming > budget && remaining.size > 0) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of remaining) {
        if (entry.accessedAt < oldestAt) {
          oldestAt = entry.accessedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      remaining.delete(oldestKey);
      keys.push(oldestKey);
    }
    return keys;
  }

  async get(
    key: string,
    identity: string | null,
  ): Promise<ImageBytesResult | null> {
    return this.runExclusive(async () => {
      const backend = this.resolveBackendFor(identity);
      await this.hydrateIndex(backend);
      const stored = await backend.get(key);
      if (stored === undefined) return null;
      const accessedAt = Date.now();
      this.index.set(key, {
        byteLength: stored.bytes.byteLength,
        accessedAt,
      });
      try {
        await backend.touch(key, accessedAt);
      } catch {
        // LRU meta is bookkeeping. A failed touch must not turn a hit into a
        // host re-fetch.
      }
      return {
        bytes: copyBytes(stored.bytes),
        mediaType: stored.mediaType,
      };
    });
  }

  async put(
    key: string,
    result: ImageBytesResult,
    identity: string | null,
    generation: number,
  ): Promise<void> {
    return this.runExclusive(async () => {
      if (generation !== this.generationOf(identity)) return;
      const backend = this.resolveBackendFor(identity);
      await this.hydrateIndex(backend);
      if (generation !== this.generationOf(identity)) return;
      const byteLength = result.bytes.byteLength;
      const budget = getRetentionProfile().transcriptImageCacheBytes;
      if (byteLength > budget) return;
      const evictKeys = this.keysToEvict(byteLength, key);
      if (generation !== this.generationOf(identity)) return;
      const accessedAt = Date.now();
      const stored: StoredTranscriptImage = {
        bytes: copyBytes(result.bytes),
        mediaType: result.mediaType,
        accessedAt,
      };
      await backend.commit({
        del: evictKeys,
        set: { key, value: stored },
      });
      for (const evicted of evictKeys) this.index.delete(evicted);
      this.index.set(key, { byteLength, accessedAt });
    });
  }

  async clearPartition(identity: string | null): Promise<void> {
    return this.runExclusive(async () => {
      this.bumpGeneration(identity);
      if (this.injectedBackend !== null) {
        this.index.clear();
        this.indexHydrated = false;
        await this.injectedBackend.clear();
        return;
      }
      if (this.backend !== null && this.backendIdentity === identity) {
        this.index.clear();
        this.indexHydrated = false;
        this.backend.close();
        this.backend = null;
        this.backendIdentity = undefined;
      }
      const factory = indexedDBFactory();
      if (factory === undefined) return;
      await deleteDatabase(factory, transcriptImageDbName(identity));
      await deleteDatabase(factory, transcriptImageMetaDbName(identity));
    });
  }

  size(): number {
    return this.index.size;
  }

  residentBytes(): number {
    return this.totalBytes();
  }
}

const store = new TranscriptImageBytesStore();

/** Test-only: swap the durable backend. Pass `null` to restore IndexedDB. */
export function installTranscriptImageBytesBackend(
  backend: TranscriptImageBytesBackend | null,
): void {
  store.installBackend(backend);
}

export async function readTranscriptImageBytes(
  key: string,
): Promise<ImageBytesResult | null> {
  try {
    return await store.get(key, storeIdentity());
  } catch {
    return null;
  }
}

export async function writeTranscriptImageBytes(
  key: string,
  result: ImageBytesResult,
): Promise<void> {
  try {
    const identity = storeIdentity();
    await store.put(key, result, identity, store.generationOf(identity));
  } catch {
    // Persistence is best-effort. A full disk must not fail the render.
  }
}

function storeIdentity(): string | null {
  return useAuthStore.getState().contextMetadata?.userId ?? null;
}

/**
 * Drops one account partition. Pass the OUTGOING identity: sign-out and
 * user-switch rewrite auth before this runs, so "current" is the next account.
 */
export async function clearTranscriptImageBytesFor(
  identity: string | null,
): Promise<void> {
  try {
    await store.clearPartition(identity);
  } catch {
    // Same best-effort as the rest of identity teardown.
  }
}

export function transcriptImageBytesStats(): {
  readonly size: number;
  readonly residentBytes: number;
} {
  return { size: store.size(), residentBytes: store.residentBytes() };
}

function lookupUntilAborted(
  signal: AbortSignal,
  lookup: () => Promise<ImageBytesResult | null>,
): Promise<ImageBytesResult | null | "aborted"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ImageBytesResult | null | "aborted"): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      finish("aborted");
    };
    if (signal.aborted) {
      finish("aborted");
      return;
    }
    signal.addEventListener("abort", onAbort);
    lookup().then(
      (value) => {
        finish(value);
      },
      () => {
        finish(null);
      },
    );
  });
}

export function persistTranscriptImageBytes(
  fetcher: ScopedImageBytesFetcher,
): ScopedImageBytesFetcher {
  return {
    scopeKey: fetcher.scopeKey,
    fetch: async (hash, signal) => {
      const identity = storeIdentity();
      const generation = store.generationOf(identity);
      const key = buildScopedImageCacheKey(fetcher.scopeKey, hash);
      const cached = await lookupUntilAborted(signal, () =>
        store.get(key, identity),
      );
      if (cached === "aborted") {
        throw new Error("Image fetch was cancelled.");
      }
      if (cached !== null && storeIdentity() === identity) return cached;
      const result = await fetcher.fetch(hash, signal);
      // Landing and doc-replica legs return `mediaType: null`. Persist only
      // host-authoritative sniffs so an SVG cannot ride a declared PNG type.
      if (
        result.mediaType !== null &&
        storeIdentity() === identity &&
        store.generationOf(identity) === generation
      ) {
        // Paint with the live bytes; IndexedDB is best-effort and must not
        // sit on the blob-cache promise.
        void store.put(key, result, identity, generation).catch(() => {
          // Quota or a closed partition: the live fetch already returned.
        });
      }
      return result;
    },
  };
}
