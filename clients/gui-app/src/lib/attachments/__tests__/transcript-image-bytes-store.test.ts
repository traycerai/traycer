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
    const backend: TranscriptImageBytesBackend = {
      get: (key) => inner.get(key),
      set: async (key, value) => {
        setStarted = true;
        await new Promise<void>((resolve) => {
          releasePut = resolve;
        });
        await inner.set(key, value);
        setFinished = true;
      },
      touch: (key, accessedAt) => inner.touch(key, accessedAt),
      del: (key) => inner.del(key),
      listIndex: () => inner.listIndex(),
      clear: () => inner.clear(),
      close: () => inner.close(),
    };
    installTranscriptImageBytesBackend(backend);
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
    installTranscriptImageBytesBackend({
      get: (key) => inner.get(key),
      set: () => Promise.reject(new Error("QuotaExceededError")),
      touch: (key, accessedAt) => inner.touch(key, accessedAt),
      del: (key) => inner.del(key),
      listIndex: () => inner.listIndex(),
      clear: () => inner.clear(),
      close: () => inner.close(),
    });
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
    installTranscriptImageBytesBackend({
      get: (key) => {
        if (key !== lookupKey) return inner.get(key);
        getStarted = true;
        return new Promise((resolve) => {
          releaseGet = () => resolve(undefined);
        });
      },
      set: (key, value) => inner.set(key, value),
      touch: (key, accessedAt) => inner.touch(key, accessedAt),
      del: (key) => inner.del(key),
      listIndex: () => inner.listIndex(),
      clear: () => inner.clear(),
      close: () => inner.close(),
    });
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
});
