import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  loadWindowOrdinaryDraftScope,
  setOrdinaryDraftScopeBinding,
} from "@/stores/composer/composer-canvas-persistence";
import {
  readOrdinaryDraftRow,
  resolveOrdinaryDraftScope,
  stageOrdinaryDraftBytes,
  writeOrdinaryDraftRow,
} from "@/lib/drafts/ordinary-draft-db";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDraftFirstImageFetcher } from "@/lib/attachments/use-draft-image-fetcher";
import type {
  ImageBytesResult,
  ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";

const resolveMocks = vi.hoisted(() => ({
  resolveDraftImageBytes: vi.fn<
    typeof import("@/lib/drafts/resolve-draft-image-bytes").resolvePartitionedDraftImageBytes
  >(() => Promise.resolve(null)),
}));

vi.mock("@/lib/drafts/resolve-draft-image-bytes", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/drafts/resolve-draft-image-bytes")
    >();
  return {
    ...actual,
    resolvePartitionedDraftImageBytes: resolveMocks.resolveDraftImageBytes,
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

  it.each(["account", "scope"])(
    "withholds a retained fetcher after switching %s",
    async (change) => {
      installFreshIndexedDb();
      const actual = await vi.importActual<
        typeof import("@/lib/drafts/resolve-draft-image-bytes")
      >("@/lib/drafts/resolve-draft-image-bytes");
      resolveMocks.resolveDraftImageBytes.mockImplementation(
        actual.resolvePartitionedDraftImageBytes,
      );
      const first = { ownerId: "image-owner", scopeId: "first-image-scope" };
      const second = {
        ownerId: change === "account" ? "new-image-owner" : first.ownerId,
        scopeId: change === "scope" ? "second-image-scope" : first.scopeId,
      };
      const scope = await resolveOrdinaryDraftScope(
        second.ownerId,
        second.scopeId,
      );
      if (scope === null) throw new Error("image scope unavailable");
      const { partition } = scope;
      await stageOrdinaryDraftBytes({
        partition,
        stageId: "image-stage",
        images: new Map([[HASH, DRAFT_BYTES]]),
      });
      await writeOrdinaryDraftRow({
        partition,
        draftId: "draft-image",
        cursor: null,
        stageId: "image-stage",
        signal: null,
        decide: () => ({
          partition,
          draftId: "draft-image",
          evidence: null,
          accepted: null,
          editor: null,
          recovery: null,
          roots: [HASH],
        }),
      });
      const stored = await readOrdinaryDraftRow(partition, "draft-image");
      expect(stored?.roots).toEqual([HASH]);
      await loadWindowOrdinaryDraftScope(second.ownerId, second.scopeId);
      await loadWindowOrdinaryDraftScope(first.ownerId, first.scopeId);
      setOrdinaryDraftScopeBinding(first);
      const fallback = baseFetcher(() =>
        Promise.resolve({ bytes: BASE_BYTES, mediaType: null }),
      );
      const { result } = renderHook(() =>
        useDraftFirstImageFetcher(fallback, null),
      );
      const retained = result.current;
      const signal = new AbortController().signal;
      act(() => setOrdinaryDraftScopeBinding(second));
      try {
        expect(result.current.scopeKey).not.toBe(retained.scopeKey);
        await expect(retained.fetch(HASH, signal)).rejects.toHaveProperty(
          "name",
          "AbortError",
        );
        expect(
          Array.from((await result.current.fetch(HASH, signal)).bytes),
        ).toEqual(Array.from(DRAFT_BYTES));
      } finally {
        act(() => setOrdinaryDraftScopeBinding(null));
      }
    },
  );

  it("gives the composed fetcher its own scope key, distinct from base's", () => {
    const base = baseFetcher(() =>
      Promise.resolve({ bytes: BASE_BYTES, mediaType: null }),
    );
    const { result } = renderHook(() => useDraftFirstImageFetcher(base, null));

    expect(result.current.scopeKey).not.toBe(base.scopeKey);
  });
});
