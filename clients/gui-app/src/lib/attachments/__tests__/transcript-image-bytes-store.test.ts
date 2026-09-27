import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
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
  writeTranscriptImageBytes,
} from "@/lib/attachments/transcript-image-bytes-store";
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

describe("transcript-image-bytes-store", () => {
  beforeEach(() => {
    installTranscriptImageBytesBackend(
      createMemoryTranscriptImageBytesBackend(),
    );
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  afterEach(() => {
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
