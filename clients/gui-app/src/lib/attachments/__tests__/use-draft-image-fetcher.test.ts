import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDraftFirstImageFetcher } from "@/lib/attachments/use-draft-image-fetcher";
import type {
  ImageBytesResult,
  ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";

const resolveMocks = vi.hoisted(() => ({
  resolveDraftImageBytes: vi.fn<
    (hash: string, target: unknown) => Promise<Uint8Array | null>
  >(() => Promise.resolve(null)),
}));

vi.mock("@/lib/drafts/resolve-draft-image-bytes", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/drafts/resolve-draft-image-bytes")
    >();
  return {
    ...actual,
    resolveDraftImageBytes: resolveMocks.resolveDraftImageBytes,
  };
});

const HASH = "a".repeat(64);
const DRAFT_BYTES = new Uint8Array([1, 2, 3]);
const BASE_BYTES = new Uint8Array([9, 9, 9]);

function baseFetcher(
  fetch: ScopedImageBytesFetcher["fetch"],
): ScopedImageBytesFetcher {
  return { scopeKey: JSON.stringify(["base-scope"]), fetch };
}

beforeEach(() => {
  resolveMocks.resolveDraftImageBytes.mockReset();
  resolveMocks.resolveDraftImageBytes.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDraftFirstImageFetcher", () => {
  it("answers from the draft leg first and never consults base on a hit", async () => {
    resolveMocks.resolveDraftImageBytes.mockResolvedValue(DRAFT_BYTES);
    const base = vi.fn<ScopedImageBytesFetcher["fetch"]>(() =>
      Promise.resolve({ bytes: BASE_BYTES, mediaType: null }),
    );
    const { result } = renderHook(() =>
      useDraftFirstImageFetcher(baseFetcher(base), null),
    );

    const resolved: ImageBytesResult = await result.current.fetch(
      HASH,
      new AbortController().signal,
    );

    expect(resolved.bytes).toEqual(DRAFT_BYTES);
    expect(base).not.toHaveBeenCalled();
  });

  it("consults base only when the draft leg misses", async () => {
    resolveMocks.resolveDraftImageBytes.mockResolvedValue(null);
    const base = vi.fn<ScopedImageBytesFetcher["fetch"]>(() =>
      Promise.resolve({ bytes: BASE_BYTES, mediaType: null }),
    );
    const { result } = renderHook(() =>
      useDraftFirstImageFetcher(baseFetcher(base), null),
    );

    const resolved = await result.current.fetch(
      HASH,
      new AbortController().signal,
    );

    expect(base).toHaveBeenCalledTimes(1);
    expect(resolved.bytes).toEqual(BASE_BYTES);
  });

  it("gives the composed fetcher its own scope key, distinct from base's", () => {
    const base = baseFetcher(() =>
      Promise.resolve({ bytes: BASE_BYTES, mediaType: null }),
    );
    const { result } = renderHook(() => useDraftFirstImageFetcher(base, null));

    expect(result.current.scopeKey).not.toBe(base.scopeKey);
  });
});
