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

export interface TranscriptImageBytesBackend {
  get(key: string): Promise<StoredTranscriptImage | undefined>;
  set(key: string, value: StoredTranscriptImage): Promise<void>;
  touch(key: string, accessedAt: number): Promise<void>;
  del(key: string): Promise<void>;
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

class HeldIdbBackend implements TranscriptImageBytesBackend {
  private db: IDBDatabase | null = null;
  private reconciled = false;

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
    this.reconciled = false;
  }

  private async reconcile(db: IDBDatabase): Promise<void> {
    if (this.reconciled) return;
    const readTxn = db.transaction([BYTES_STORE, META_STORE], "readonly");
    const [byteRows, metaRows] = await Promise.all([
      collectStoreRows<unknown>(readTxn.objectStore(BYTES_STORE)),
      collectStoreRows<unknown>(readTxn.objectStore(META_STORE)),
    ]);
    const bytesByKey = new Map(byteRows.map((row) => [row.key, row.value]));
    const metaKeys = new Set(metaRows.map((row) => row.key));
    const metaPuts: { key: string; value: IndexEntry }[] = [];
    const byteDeletes: string[] = [];
    const metaDeletes: string[] = [];
    for (const [key, stored] of bytesByKey) {
      if (metaKeys.has(key)) continue;
      const storedImage = parseStoredTranscriptImage(stored);
      if (storedImage === undefined) {
        byteDeletes.push(key);
        continue;
      }
      metaPuts.push({
        key,
        value: {
          byteLength: storedImage.bytes.byteLength,
          accessedAt: storedImage.accessedAt,
        },
      });
    }
    for (const key of metaKeys) {
      if (!bytesByKey.has(key)) metaDeletes.push(key);
    }
    if (
      metaPuts.length === 0 &&
      byteDeletes.length === 0 &&
      metaDeletes.length === 0
    ) {
      this.reconciled = true;
      return;
    }
    const writeTxn = db.transaction([BYTES_STORE, META_STORE], "readwrite");
    const bytesStore = writeTxn.objectStore(BYTES_STORE);
    const metaStore = writeTxn.objectStore(META_STORE);
    for (const row of metaPuts) metaStore.put(row.value, row.key);
    for (const key of byteDeletes) bytesStore.delete(key);
    for (const key of metaDeletes) metaStore.delete(key);
    await awaitTransaction(writeTxn);
    this.reconciled = true;
  }

  async get(key: string): Promise<StoredTranscriptImage | undefined> {
    const db = await this.ensureOpen();
    await this.reconcile(db);
    const txn = db.transaction([BYTES_STORE], "readonly");
    const value: unknown = await awaitRequest(
      txn.objectStore(BYTES_STORE).get(key),
    );
    return parseStoredTranscriptImage(value);
  }

  async set(key: string, value: StoredTranscriptImage): Promise<void> {
    const db = await this.ensureOpen();
    await this.reconcile(db);
    const txn = db.transaction([BYTES_STORE, META_STORE], "readwrite");
    txn.objectStore(BYTES_STORE).put(value, key);
    txn.objectStore(META_STORE).put(
      {
        byteLength: value.bytes.byteLength,
        accessedAt: value.accessedAt,
      },
      key,
    );
    await awaitTransaction(txn);
  }

  async touch(key: string, accessedAt: number): Promise<void> {
    const db = await this.ensureOpen();
    await this.reconcile(db);
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
    const db = await this.ensureOpen();
    await this.reconcile(db);
    const txn = db.transaction([BYTES_STORE, META_STORE], "readwrite");
    txn.objectStore(BYTES_STORE).delete(key);
    txn.objectStore(META_STORE).delete(key);
    await awaitTransaction(txn);
  }

  async listIndex(): Promise<readonly TranscriptImageIndexRow[]> {
    const db = await this.ensureOpen();
    await this.reconcile(db);
    const txn = db.transaction([META_STORE], "readonly");
    const rows = await collectStoreRows<unknown>(txn.objectStore(META_STORE));
    const index: TranscriptImageIndexRow[] = [];
    for (const row of rows) {
      if (!isIndexEntry(row.value)) continue;
      index.push({
        key: row.key,
        byteLength: row.value.byteLength,
        accessedAt: row.value.accessedAt,
      });
    }
    return index;
  }

  async clear(): Promise<void> {
    const db = await this.ensureOpen();
    const txn = db.transaction([BYTES_STORE, META_STORE], "readwrite");
    txn.objectStore(BYTES_STORE).clear();
    txn.objectStore(META_STORE).clear();
    await awaitTransaction(txn);
    this.reconciled = true;
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
  private injectedBackend: TranscriptImageBytesBackend | null = null;
  private readonly generationByIdentity = new Map<string, number>();
  private mutation: Promise<void> = Promise.resolve();

  installBackend(backend: TranscriptImageBytesBackend | null): void {
    this.backend?.close();
    this.injectedBackend = backend;
    this.backend = null;
    this.backendIdentity = undefined;
    this.index.clear();
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
    }
    return this.backend;
  }

  private async hydrateIndex(
    backend: TranscriptImageBytesBackend,
  ): Promise<void> {
    const rows = await backend.listIndex();
    this.index.clear();
    for (const row of rows) {
      this.index.set(row.key, {
        byteLength: row.byteLength,
        accessedAt: row.accessedAt,
      });
    }
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.index.values()) total += entry.byteLength;
    return total;
  }

  private async evictUntilFit(
    backend: TranscriptImageBytesBackend,
    incoming: number,
  ): Promise<void> {
    const budget = getRetentionProfile().transcriptImageCacheBytes;
    if (incoming > budget) return;
    while (this.totalBytes() + incoming > budget && this.index.size > 0) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.index) {
        if (entry.accessedAt < oldestAt) {
          oldestAt = entry.accessedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.index.delete(oldestKey);
      await backend.del(oldestKey);
    }
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
      await backend.touch(key, accessedAt);
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
      this.index.delete(key);
      await this.evictUntilFit(backend, byteLength);
      if (generation !== this.generationOf(identity)) return;
      const accessedAt = Date.now();
      const stored: StoredTranscriptImage = {
        bytes: copyBytes(result.bytes),
        mediaType: result.mediaType,
        accessedAt,
      };
      this.index.set(key, { byteLength, accessedAt });
      await backend.set(key, stored);
    });
  }

  async clearPartition(identity: string | null): Promise<void> {
    return this.runExclusive(async () => {
      this.bumpGeneration(identity);
      if (this.injectedBackend !== null) {
        this.index.clear();
        await this.injectedBackend.clear();
        return;
      }
      if (this.backend !== null && this.backendIdentity === identity) {
        this.index.clear();
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
