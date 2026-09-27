import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildScopedImageCacheKey,
  type ImageBytesResult,
  type ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";
import {
  clearTranscriptImageBytesFor,
  createMemoryTranscriptImageBytesBackend,
  installTranscriptImageBytesBackend,
  persistTranscriptImageBytes,
  readTranscriptImageBytes,
  transcriptImageBytesStats,
  transcriptImageDbName,
  transcriptImageMetaDbName,
  writeTranscriptImageBytes,
  type TranscriptImageBytesBackend,
} from "@/lib/attachments/transcript-image-bytes-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { PREPARED_IMAGE_MAX_BYTES } from "@/lib/composer/composer-image-preparation-session";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

function wireBytesFor(decoded: number): number {
  return 4 * Math.ceil(decoded / 3);
}

function resultOf(byteLength: number): ImageBytesResult {
  return {
    bytes: new Uint8Array(byteLength),
    mediaType: "image/jpeg",
  };
}

function scopedFetcher(
  fetch: ScopedImageBytesFetcher["fetch"],
  scopeKey: string,
): ScopedImageBytesFetcher {
  return { scopeKey, fetch };
}

/** Waits for any in-flight persist `put` chained on the exclusive queue. */
async function drainTranscriptImageMutations(): Promise<void> {
  await readTranscriptImageBytes("__drain__");
}

function wrapBackend(
  inner: TranscriptImageBytesBackend,
  overrides: Partial<TranscriptImageBytesBackend>,
): TranscriptImageBytesBackend {
  const get = overrides.get ?? ((key) => inner.get(key));
  const set = overrides.set ?? ((key, value) => inner.set(key, value));
  const touch =
    overrides.touch ?? ((key, accessedAt) => inner.touch(key, accessedAt));
  const del = overrides.del ?? ((key) => inner.del(key));
  const listIndex = overrides.listIndex ?? (() => inner.listIndex());
  const clear = overrides.clear ?? (() => inner.clear());
  const close = overrides.close ?? (() => inner.close());
  const commit =
    overrides.commit ??
    (async (change) => {
      for (const key of change.del) await del(key);
      if (change.set !== undefined) {
        await set(change.set.key, change.set.value);
      }
    });
  return { get, set, touch, del, commit, listIndex, clear, close };
}

describe("transcript-image-bytes-store", () => {
  beforeEach(() => {
    installTranscriptImageBytesBackend(
      createMemoryTranscriptImageBytesBackend(),
    );
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await drainTranscriptImageMutations();
    installTranscriptImageBytesBackend(null);
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  });

  it("names the database by account bucket, not the draft partition", () => {
    expect(transcriptImageDbName(null)).toBe(
      "traycer-gui-app:anon:transcript-images",
    );
    expect(transcriptImageDbName("user-1")).toBe(
      "traycer-gui-app:user-1:transcript-images",
    );
    expect(transcriptImageDbName("user-1")).not.toContain("landing-images");
  });

  it("does not serve one chat's bytes under another chat's scope", async () => {
    let fetchCount = 0;
    const fetch = vi.fn((_hash: string) => {
      fetchCount += 1;
      return Promise.resolve(resultOf(16));
    });
    const chatA = persistTranscriptImageBytes(scopedFetcher(fetch, "chat-a"));
    const chatB = persistTranscriptImageBytes(scopedFetcher(fetch, "chat-b"));
    await chatA.fetch("same-hash", new AbortController().signal);
    expect(fetchCount).toBe(1);
    await chatB.fetch("same-hash", new AbortController().signal);
    expect(fetchCount).toBe(2);
    await chatA.fetch("same-hash", new AbortController().signal);
    expect(fetchCount).toBe(2);
  });

  it("evicts the least-recently used entry to stay inside the retention budget", async () => {
    setRetentionProfile({
      ...MOBILE_RETENTION_PROFILE,
      transcriptImageCacheBytes: 100,
    });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await writeTranscriptImageBytes("old", resultOf(40));
    vi.setSystemTime(2_000);
    await writeTranscriptImageBytes("mid", resultOf(40));
    vi.setSystemTime(3_000);
    await readTranscriptImageBytes("old");
    vi.setSystemTime(4_000);
    await writeTranscriptImageBytes("new", resultOf(40));
    vi.useRealTimers();
    expect(await readTranscriptImageBytes("mid")).toBeNull();
    expect(await readTranscriptImageBytes("old")).not.toBeNull();
    expect(await readTranscriptImageBytes("new")).not.toBeNull();
    expect(transcriptImageBytesStats().residentBytes).toBe(80);
  });

  it("does not persist a landing fallback with no host media type", async () => {
    const fetch = vi.fn((_hash: string) =>
      Promise.resolve({
        bytes: new Uint8Array(8),
        mediaType: null,
      }),
    );
    const fetcher = persistTranscriptImageBytes(
      scopedFetcher(fetch, "epic:chat"),
    );
    await fetcher.fetch("svg-hash", new AbortController().signal);
    await fetcher.fetch("svg-hash", new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clears on the identity-teardown path", async () => {
    await writeTranscriptImageBytes("k", resultOf(8));
    await clearTranscriptImageBytesFor(null);
    expect(await readTranscriptImageBytes("k")).toBeNull();
    expect(transcriptImageBytesStats().size).toBe(0);
  });
});

describe("transcript image relaunch cost", () => {
  /**
   * A chat open lands at the end of the transcript. The virtualizer keeps
   * roughly a viewport of rows mounted (existing ChatTimeline test: 400
   * messages → fewer than 80 DOM rows, ~700px viewport). Four unique images
   * in that viewport is a conservative "chat with images" open.
   */
  const VISIBLE_UNIQUE_IMAGES = 4;
  /**
   * Mean decoded size implied by the staging launch measurement of 5.10 MB
   * in 4 `epic.readCloudChatPayload` image-attachment replies
   * (5.10e6 * 3/4).
   */
  const TYPICAL_DECODED_BYTES = 956_250;

  beforeEach(() => {
    installTranscriptImageBytesBackend(
      createMemoryTranscriptImageBytesBackend(),
    );
  });

  afterEach(async () => {
    await drainTranscriptImageMutations();
    installTranscriptImageBytesBackend(null);
  });

  it("a task open of a chat with images re-transfers megabytes without persistence", async () => {
    let decodedTransferred = 0;
    let fetchCount = 0;
    const fetch = vi.fn((_hash: string) => {
      fetchCount += 1;
      const bytes = new Uint8Array(TYPICAL_DECODED_BYTES);
      decodedTransferred += bytes.byteLength;
      return Promise.resolve({ bytes, mediaType: "image/jpeg" });
    });
    const fetcher = scopedFetcher(fetch, "epic:chat");

    for (let i = 0; i < VISIBLE_UNIQUE_IMAGES; i++) {
      await fetcher.fetch(`hash-${i}`, new AbortController().signal);
    }
    const firstDecoded = decodedTransferred;
    const firstWire = wireBytesFor(firstDecoded);
    expect(fetchCount).toBe(VISIBLE_UNIQUE_IMAGES);
    expect(firstDecoded).toBe(VISIBLE_UNIQUE_IMAGES * TYPICAL_DECODED_BYTES);
    expect(firstWire).toBeGreaterThan(1_000_000);

    decodedTransferred = 0;
    fetchCount = 0;
    for (let i = 0; i < VISIBLE_UNIQUE_IMAGES; i++) {
      await fetcher.fetch(`hash-${i}`, new AbortController().signal);
    }
    expect(fetchCount).toBe(VISIBLE_UNIQUE_IMAGES);
    expect(wireBytesFor(decodedTransferred)).toBe(firstWire);
  });

  it("a relaunch of the same visible images does not re-transfer after persistence", async () => {
    let decodedTransferred = 0;
    const fetch = vi.fn((_hash: string) => {
      const bytes = new Uint8Array(TYPICAL_DECODED_BYTES);
      decodedTransferred += bytes.byteLength;
      return Promise.resolve({ bytes, mediaType: "image/jpeg" });
    });
    const fetcher = persistTranscriptImageBytes(
      scopedFetcher(fetch, "epic:chat"),
    );

    for (let i = 0; i < VISIBLE_UNIQUE_IMAGES; i++) {
      await fetcher.fetch(`hash-${i}`, new AbortController().signal);
    }
    expect(fetch).toHaveBeenCalledTimes(VISIBLE_UNIQUE_IMAGES);
    expect(wireBytesFor(decodedTransferred)).toBe(
      VISIBLE_UNIQUE_IMAGES * wireBytesFor(TYPICAL_DECODED_BYTES),
    );

    decodedTransferred = 0;
    fetch.mockClear();
    for (let i = 0; i < VISIBLE_UNIQUE_IMAGES; i++) {
      await fetcher.fetch(`hash-${i}`, new AbortController().signal);
    }
    expect(fetch).toHaveBeenCalledTimes(0);
    expect(decodedTransferred).toBe(0);
  });

  it("two images at the paste output ceiling are 10 MiB on the wire per relaunch without persistence", () => {
    const decoded = 2 * PREPARED_IMAGE_MAX_BYTES;
    const wire = wireBytesFor(decoded);
    expect(PREPARED_IMAGE_MAX_BYTES).toBe(3_932_160);
    expect(wire).toBe(10_485_760);
    expect(wire).toBeGreaterThan(10 * 1024 * 1024 - 1);
  });
});

describe("transcript-image-bytes-store mechanism", () => {
  beforeEach(() => {
    installTranscriptImageBytesBackend(
      createMemoryTranscriptImageBytesBackend(),
    );
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  });

  afterEach(async () => {
    await drainTranscriptImageMutations();
    installTranscriptImageBytesBackend(null);
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  });

  it("returns fetched bytes before the durable put finishes", async () => {
    const inner = createMemoryTranscriptImageBytesBackend();
    let releasePut: () => void = () => {};
    let setStarted = false;
    let setFinished = false;
    installTranscriptImageBytesBackend(
      wrapBackend(inner, {
        set: async (key, value) => {
          setStarted = true;
          await new Promise<void>((resolve) => {
            releasePut = resolve;
          });
          await inner.set(key, value);
          setFinished = true;
        },
      }),
    );
    const fetch = vi.fn(() => Promise.resolve(resultOf(8)));
    const fetcher = persistTranscriptImageBytes(
      scopedFetcher(fetch, "epic:chat"),
    );

    try {
      const resolved = await fetcher.fetch(
        "paint-first",
        new AbortController().signal,
      );
      expect(resolved.bytes.byteLength).toBe(8);
      await vi.waitFor(() => {
        expect(setStarted).toBe(true);
      });
      expect(setFinished).toBe(false);
    } finally {
      releasePut();
    }
    await vi.waitFor(() => {
      expect(setFinished).toBe(true);
    });
    fetch.mockClear();
    await fetcher.fetch("paint-first", new AbortController().signal);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips persist after the outgoing partition is cleared mid-fetch", async () => {
    let releaseFetch: (() => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<ImageBytesResult>((resolve) => {
          releaseFetch = () => resolve(resultOf(8));
        }),
    );
    const fetcher = persistTranscriptImageBytes(
      scopedFetcher(fetch, "epic:chat"),
    );
    const pending = fetcher.fetch("mid-clear", new AbortController().signal);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    await clearTranscriptImageBytesFor(null);
    releaseFetch?.();
    await pending;
    expect(
      await readTranscriptImageBytes(
        buildScopedImageCacheKey("epic:chat", "mid-clear"),
      ),
    ).toBeNull();
  });

  it("still returns live bytes when the durable put is rejected", async () => {
    const inner = createMemoryTranscriptImageBytesBackend();
    installTranscriptImageBytesBackend(
      wrapBackend(inner, {
        set: () => Promise.reject(new Error("QuotaExceededError")),
      }),
    );
    const fetcher = persistTranscriptImageBytes(
      scopedFetcher(() => Promise.resolve(resultOf(8)), "epic:chat"),
    );
    const resolved = await fetcher.fetch("quota", new AbortController().signal);
    expect(resolved.bytes.byteLength).toBe(8);
  });

  it("keeps concurrent puts inside the byte budget", async () => {
    setRetentionProfile({
      ...MOBILE_RETENTION_PROFILE,
      transcriptImageCacheBytes: 100,
    });
    const fetch = vi.fn((_hash: string) => Promise.resolve(resultOf(60)));
    const fetcher = persistTranscriptImageBytes(
      scopedFetcher(fetch, "epic:chat"),
    );
    await Promise.all([
      fetcher.fetch("a", new AbortController().signal),
      fetcher.fetch("b", new AbortController().signal),
    ]);
    await vi.waitFor(() => {
      expect(transcriptImageBytesStats().size).toBe(1);
    });
    expect(transcriptImageBytesStats().residentBytes).toBeLessThanOrEqual(100);
  });

  it("aborts a durable lookup from the caller signal without starting the fetch", async () => {
    const inner = createMemoryTranscriptImageBytesBackend();
    const lookupKey = buildScopedImageCacheKey("epic:chat", "aborted");
    let releaseGet: () => void = () => {};
    let getStarted = false;
    installTranscriptImageBytesBackend(
      wrapBackend(inner, {
        get: (key) => {
          if (key !== lookupKey) return inner.get(key);
          getStarted = true;
          return new Promise((resolve) => {
            releaseGet = () => resolve(undefined);
          });
        },
      }),
    );
    const fetch = vi.fn(() => Promise.resolve(resultOf(8)));
    const fetcher = persistTranscriptImageBytes(
      scopedFetcher(fetch, "epic:chat"),
    );
    const controller = new AbortController();
    const pending = fetcher.fetch("aborted", controller.signal);
    try {
      await vi.waitFor(() => {
        expect(getStarted).toBe(true);
      });
      controller.abort();
      await expect(pending).rejects.toThrow(/cancelled/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      releaseGet();
    }
  });

  it("releases the mutation queue when a never-settling lookup is aborted", async () => {
    const inner = createMemoryTranscriptImageBytesBackend();
    const hungKey = buildScopedImageCacheKey("epic:chat", "hung");
    let getStarted = false;
    installTranscriptImageBytesBackend(
      wrapBackend(inner, {
        get: (key) => {
          if (key !== hungKey) return inner.get(key);
          getStarted = true;
          return new Promise(() => {
            // Never settles: blocked open / hung transaction.
          });
        },
      }),
    );
    const fetcher = persistTranscriptImageBytes(
      scopedFetcher(() => Promise.resolve(resultOf(8)), "epic:chat"),
    );
    const controller = new AbortController();
    const pending = fetcher.fetch("hung", controller.signal);
    await vi.waitFor(() => {
      expect(getStarted).toBe(true);
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    await writeTranscriptImageBytes("other", resultOf(8));
    expect(await readTranscriptImageBytes("other")).not.toBeNull();
  });

  it("scans the durable index once, not on every get", async () => {
    const inner = createMemoryTranscriptImageBytesBackend();
    let listIndexCalls = 0;
    installTranscriptImageBytesBackend(
      wrapBackend(inner, {
        listIndex: async () => {
          listIndexCalls += 1;
          return inner.listIndex();
        },
      }),
    );
    await writeTranscriptImageBytes("a", resultOf(8));
    await readTranscriptImageBytes("a");
    await readTranscriptImageBytes("a");
    expect(listIndexCalls).toBe(1);
  });

  it("serves a durable hit when the LRU touch write fails", async () => {
    const inner = createMemoryTranscriptImageBytesBackend();
    installTranscriptImageBytesBackend(wrapBackend(inner, {}));
    const fetch = vi.fn(() => Promise.resolve(resultOf(8)));
    const fetcher = persistTranscriptImageBytes(
      scopedFetcher(fetch, "epic:chat"),
    );
    await fetcher.fetch("hit", new AbortController().signal);
    await drainTranscriptImageMutations();
    expect(fetch).toHaveBeenCalledTimes(1);
    installTranscriptImageBytesBackend(
      wrapBackend(inner, {
        touch: () => Promise.reject(new Error("QuotaExceededError")),
      }),
    );
    fetch.mockClear();
    const resolved = await fetcher.fetch("hit", new AbortController().signal);
    expect(resolved.bytes.byteLength).toBe(8);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves existing entries in place when a put that needs eviction fails", async () => {
    const inner = createMemoryTranscriptImageBytesBackend();
    installTranscriptImageBytesBackend(
      wrapBackend(inner, {
        set: async (key, value) => {
          if (key === "incoming") {
            throw new Error("QuotaExceededError");
          }
          await inner.set(key, value);
        },
        commit: async (change) => {
          if (change.set?.key === "incoming") {
            throw new Error("QuotaExceededError");
          }
          for (const key of change.del) await inner.del(key);
          if (change.set !== undefined) {
            await inner.set(change.set.key, change.set.value);
          }
        },
      }),
    );
    setRetentionProfile({
      ...MOBILE_RETENTION_PROFILE,
      transcriptImageCacheBytes: 100,
    });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await writeTranscriptImageBytes("kept", resultOf(60));
    vi.setSystemTime(2_000);
    await writeTranscriptImageBytes("incoming", resultOf(60));
    vi.useRealTimers();
    expect(await readTranscriptImageBytes("kept")).not.toBeNull();
  });
});

describe("transcript-image-bytes-store IndexedDB", () => {
  beforeEach(() => {
    installFreshIndexedDb();
    installTranscriptImageBytesBackend(null);
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  });

  afterEach(async () => {
    await clearTranscriptImageBytesFor(null);
    installTranscriptImageBytesBackend(null);
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  });

  it("stores bytes and meta in one database and closes before delete", async () => {
    await writeTranscriptImageBytes("k", resultOf(8));
    expect(await readTranscriptImageBytes("k")).not.toBeNull();
    const names = (await indexedDB.databases())
      .map((info) => info.name)
      .filter((name): name is string => typeof name === "string");
    expect(names).toContain(transcriptImageDbName(null));
    expect(names).not.toContain(transcriptImageMetaDbName(null));

    await clearTranscriptImageBytesFor(null);
    const after = (await indexedDB.databases())
      .map((info) => info.name)
      .filter((name): name is string => typeof name === "string");
    expect(after).not.toContain(transcriptImageDbName(null));
  });

  it("reads bytes when the meta row is missing", async () => {
    const dbName = transcriptImageDbName(null);
    const request = indexedDB.open(dbName, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("bytes")) {
        db.createObjectStore("bytes");
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    await new Promise<void>((resolve, reject) => {
      const txn = db.transaction(["bytes"], "readwrite");
      txn.objectStore("bytes").put(
        {
          bytes: new Uint8Array(8),
          mediaType: "image/jpeg",
          accessedAt: 1,
        },
        "orphan",
      );
      txn.oncomplete = () => resolve();
      txn.onerror = () => reject(txn.error ?? new Error("orphan put failed"));
    });
    db.close();
    expect(await readTranscriptImageBytes("orphan")).not.toBeNull();
  });

  it("evicts v1 bytes-only rows even when the first meta repair aborts", async () => {
    const dbName = transcriptImageDbName(null);
    const openV1 = indexedDB.open(dbName, 1);
    openV1.onupgradeneeded = () => {
      openV1.result.createObjectStore("bytes");
    };
    const v1 = await new Promise<IDBDatabase>((resolve, reject) => {
      openV1.onsuccess = () => resolve(openV1.result);
      openV1.onerror = () =>
        reject(openV1.error ?? new Error("v1 open failed"));
    });
    await new Promise<void>((resolve, reject) => {
      const txn = v1.transaction(["bytes"], "readwrite");
      txn.objectStore("bytes").put(
        {
          bytes: new Uint8Array(60),
          mediaType: "image/jpeg",
          accessedAt: 1,
        },
        "old",
      );
      txn.oncomplete = () => resolve();
      txn.onerror = () => reject(txn.error ?? new Error("v1 put failed"));
    });
    const restoreTransaction = abortFirstReadwrite(v1);
    v1.close();
    try {
      setRetentionProfile({
        ...MOBILE_RETENTION_PROFILE,
        transcriptImageCacheBytes: 100,
      });
      expect(await readTranscriptImageBytes("missing")).toBeNull();
      await writeTranscriptImageBytes("new", resultOf(60));
      expect(transcriptImageBytesStats().residentBytes).toBe(60);
      expect(transcriptImageBytesStats().size).toBe(1);
      expect(await countByteRows(dbName)).toBe(1);
    } finally {
      restoreTransaction();
    }
  });
});

function abortFirstReadwrite(db: IDBDatabase): () => void {
  const proto = Object.getPrototypeOf(db) as IDBDatabase;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "transaction");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("IDBDatabase.transaction is not a function");
  }
  const original = descriptor.value as (
    this: IDBDatabase,
    storeNames: string | Iterable<string>,
    mode: IDBTransactionMode | undefined,
  ) => IDBTransaction;
  let abortNextReadwrite = true;
  proto.transaction = function (
    this: IDBDatabase,
    storeNames: string | Iterable<string>,
    mode: IDBTransactionMode | undefined,
  ): IDBTransaction {
    const txn = original.call(this, storeNames, mode);
    if (abortNextReadwrite && mode === "readwrite") {
      abortNextReadwrite = false;
      queueMicrotask(() => {
        try {
          txn.abort();
        } catch {
          // Already finished.
        }
      });
    }
    return txn;
  };
  return () => {
    Object.defineProperty(proto, "transaction", descriptor);
  };
}

async function countByteRows(dbName: string): Promise<number> {
  const request = indexedDB.open(dbName, 2);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("count open failed"));
  });
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const txn = db.transaction(["bytes"], "readonly");
      const getKeys = txn.objectStore("bytes").getAllKeys();
      getKeys.onsuccess = () => resolve(getKeys.result);
      getKeys.onerror = () =>
        reject(getKeys.error ?? new Error("count failed"));
    });
    return keys.length;
  } finally {
    db.close();
  }
}
