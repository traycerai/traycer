import { afterEach, describe, expect, it, vi } from "vitest";

import { imageBlobCache } from "@/lib/attachments/image-blob-cache";
import { clearImagePathForIdentityTeardown } from "@/lib/attachments/image-path-identity-teardown";
import {
  createMemoryTranscriptImageBytesBackend,
  installTranscriptImageBytesBackend,
  transcriptImageBytesStats,
  writeTranscriptImageBytes,
} from "@/lib/attachments/transcript-image-bytes-store";
import type {
  ImageBytesFetcher,
  ImageBytesResult,
  ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";

function scoped(fetch: ImageBytesFetcher): ScopedImageBytesFetcher {
  return {
    scopeKey: '["chat-attachment","host","epic","chat"]',
    fetch,
  };
}

describe("image-path identity teardown", () => {
  afterEach(() => {
    imageBlobCache.clear();
    installTranscriptImageBytesBackend(null);
  });

  it("clears the blob cache, in-flight fetches, and hydrated index", async () => {
    installTranscriptImageBytesBackend(
      createMemoryTranscriptImageBytesBackend(),
    );
    await writeTranscriptImageBytes("k", {
      bytes: new Uint8Array(8),
      mediaType: "image/jpeg",
    });
    expect(transcriptImageBytesStats().size).toBe(1);

    const fetcher = vi.fn(
      (_hash: string, signal: AbortSignal) =>
        new Promise<ImageBytesResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const lease = imageBlobCache.acquire(
      "h1",
      "image/png",
      scoped(fetcher),
      "grace",
    );
    lease.release();
    expect(imageBlobCache.size()).toBe(1);
    const settled = expect(lease.promise).rejects.toThrow();

    await clearImagePathForIdentityTeardown(null);
    await settled;
    expect(imageBlobCache.size()).toBe(0);
    expect(transcriptImageBytesStats().size).toBe(0);

    const again = imageBlobCache.acquire(
      "h1",
      "image/png",
      scoped(fetcher),
      "grace",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    const againSettled = expect(again.promise).rejects.toThrow();
    again.release();
    imageBlobCache.clear();
    await againSettled;
  });
});
