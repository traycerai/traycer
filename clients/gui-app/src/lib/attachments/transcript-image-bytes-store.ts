/**
 * Bounded persistent store for transcript (chat and artifact) image bytes.
 *
 * Separate from `landing-image-store`. That partition is a bare-hash draft of
 * the user's own paste bytes. This one is keyed by the scoped cache identity
 * (`buildScopedImageCacheKey`) so one chat or artifact's authorization never
 * serves another's. IndexedDB name:
 * `traycer-gui-app:<accountBucket>:transcript-images`.
 *
 * The in-memory blob-URL cache (`imageBlobCache`) is gone on relaunch. Without
 * this store every visible transcript image re-enters as unary `bytesBase64`.
 */

import {
  clear as idbClear,
  createStore,
  del as idbDel,
  get as idbGet,
  keys as idbKeys,
  set as idbSet,
  type UseStore,
} from "idb-keyval";

import {
  buildScopedImageCacheKey,
  type ImageBytesResult,
  type ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";
import { PERSIST_PREFIX, scopeBucket } from "@/lib/persist/keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";

export const TRANSCRIPT_IMAGE_DB_SUFFIX = ":transcript-images";
export const TRANSCRIPT_IMAGE_META_DB_SUFFIX = ":transcript-image-meta";

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

function isStoredTranscriptImage(
  value: unknown,
): value is StoredTranscriptImage {
  if (value === null || typeof value !== "object") return false;
  if (
    !("bytes" in value) ||
    !("mediaType" in value) ||
    !("accessedAt" in value)
  ) {
    return false;
  }
  return (
    value.bytes instanceof Uint8Array &&
    (value.mediaType === null || typeof value.mediaType === "string") &&
    typeof value.accessedAt === "number"
  );
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
  };
}

function indexedDBFactory(): IDBFactory | undefined {
  // Annotated return is load-bearing: the DOM lib types `indexedDB` as
  // present, but node tests and non-browser runtimes omit it.
  return globalThis.indexedDB;
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
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

function createIdbBackend(
  identity: string | null,
): TranscriptImageBytesBackend {
  const bytesStore: UseStore = createStore(
    transcriptImageDbName(identity),
    "bytes",
  );
  const metaStore: UseStore = createStore(
    transcriptImageMetaDbName(identity),
    "meta",
  );
  return {
    get: async (key) => {
      const value: unknown = await idbGet<unknown>(key, bytesStore);
      return isStoredTranscriptImage(value) ? value : undefined;
    },
    set: async (key, value) => {
      await idbSet(key, value, bytesStore);
      await idbSet(
        key,
        {
          byteLength: value.bytes.byteLength,
          accessedAt: value.accessedAt,
        },
        metaStore,
      );
    },
    touch: async (key, accessedAt) => {
      const meta: unknown = await idbGet<unknown>(key, metaStore);
      if (!isIndexEntry(meta)) return;
      await idbSet(key, { byteLength: meta.byteLength, accessedAt }, metaStore);
    },
    del: async (key) => {
      await idbDel(key, bytesStore);
      await idbDel(key, metaStore);
    },
    listIndex: async () => {
      const found = await idbKeys(metaStore);
      const rows: TranscriptImageIndexRow[] = [];
      for (const key of found) {
        if (typeof key !== "string") continue;
        const meta: unknown = await idbGet<unknown>(key, metaStore);
        if (!isIndexEntry(meta)) continue;
        rows.push({
          key,
          byteLength: meta.byteLength,
          accessedAt: meta.accessedAt,
        });
      }
      return rows;
    },
    clear: async () => {
      await idbClear(bytesStore);
      await idbClear(metaStore);
    },
  };
}

class TranscriptImageBytesStore {
  private backend: TranscriptImageBytesBackend | null = null;
  private backendIdentity: string | null | undefined = undefined;
  private readonly index = new Map<string, IndexEntry>();
  private indexHydrated = false;
  private injectedBackend: TranscriptImageBytesBackend | null = null;

  installBackend(backend: TranscriptImageBytesBackend | null): void {
    this.injectedBackend = backend;
    this.backend = null;
    this.backendIdentity = undefined;
    this.index.clear();
    this.indexHydrated = false;
  }

  private identity(): string | null {
    return useAuthStore.getState().contextMetadata?.userId ?? null;
  }

  private resolveBackend(): TranscriptImageBytesBackend {
    if (this.injectedBackend !== null) return this.injectedBackend;
    const identity = this.identity();
    if (this.backend === null || this.backendIdentity !== identity) {
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

  async get(key: string): Promise<ImageBytesResult | null> {
    const backend = this.resolveBackend();
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
  }

  async put(key: string, result: ImageBytesResult): Promise<void> {
    const backend = this.resolveBackend();
    await this.hydrateIndex(backend);
    const byteLength = result.bytes.byteLength;
    const budget = getRetentionProfile().transcriptImageCacheBytes;
    if (byteLength > budget) return;
    this.index.delete(key);
    await this.evictUntilFit(backend, byteLength);
    const accessedAt = Date.now();
    const stored: StoredTranscriptImage = {
      bytes: copyBytes(result.bytes),
      mediaType: result.mediaType,
      accessedAt,
    };
    this.index.set(key, { byteLength, accessedAt });
    await backend.set(key, stored);
  }

  async clearPartition(identity: string | null): Promise<void> {
    if (this.injectedBackend !== null) {
      this.index.clear();
      this.indexHydrated = true;
      await this.injectedBackend.clear();
      return;
    }
    if (this.backend !== null && this.backendIdentity === identity) {
      this.index.clear();
      this.indexHydrated = true;
      await this.backend.clear();
      this.backend = null;
      this.backendIdentity = undefined;
    }
    const factory = indexedDBFactory();
    if (factory === undefined) return;
    await deleteDatabase(factory, transcriptImageDbName(identity));
    await deleteDatabase(factory, transcriptImageMetaDbName(identity));
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
    return await store.get(key);
  } catch {
    return null;
  }
}

export async function writeTranscriptImageBytes(
  key: string,
  result: ImageBytesResult,
): Promise<void> {
  try {
    await store.put(key, result);
  } catch {
    // Persistence is best-effort. A full disk must not fail the render.
  }
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

export function persistTranscriptImageBytes(
  fetcher: ScopedImageBytesFetcher,
): ScopedImageBytesFetcher {
  return {
    scopeKey: fetcher.scopeKey,
    fetch: async (hash, signal) => {
      const key = buildScopedImageCacheKey(fetcher.scopeKey, hash);
      if (!signal.aborted) {
        const hit = await readTranscriptImageBytes(key);
        if (hit !== null) return hit;
      }
      if (signal.aborted) {
        throw new Error("Image fetch was cancelled.");
      }
      const result = await fetcher.fetch(hash, signal);
      await writeTranscriptImageBytes(key, result);
      return result;
    },
  };
}
