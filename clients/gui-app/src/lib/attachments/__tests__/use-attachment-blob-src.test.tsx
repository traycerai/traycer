import {
  act,
  cleanup,
  renderHook,
  type RenderHookResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetArtifactAttachmentHostSupport,
  resetEpicImageFetcherArmAbort,
  useAttachmentBlobSrc,
  useEpicAttachmentBytesPresence,
  type AttachmentBlobSrcState,
} from "@/lib/attachments/use-attachment-blob-src";
import type { ArtifactAttachmentReadClient } from "@/lib/attachments/artifact-attachment-scope-context";
import { imageBlobCache } from "@/lib/attachments/image-blob-cache";
import {
  IMAGE_FETCH_MAX_ATTEMPTS,
  IMAGE_FETCH_RETRY_BASE_MS,
  IMAGE_UNAVAILABLE_GRACE_MS,
} from "@/lib/attachments/use-image-blob-url";
import { ARTIFACT_OBJECT_DOWNLOADING_POLL_LANE } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  DOWNLOADING_ANSWER,
  FOUND_ANSWER,
  MISSING_ANSWER,
  scopeWith,
  wrapperFor,
} from "./artifact-attachment-fixtures";

const mocks = vi.hoisted(() => ({
  snapshotLoaded: false,
  hasAttachmentBytes: vi.fn((hash: string) => hash === "present-hash"),
  // One object for the file: the image fetcher is memoized on its identity.
  lanesHandle: {
    epicId: "epic-1",
    store: {
      getState: () => ({ installedArm: "lanes" }),
      subscribe: () => () => undefined,
    },
  },
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => mocks.lanesHandle,
  useOpenEpicHandle: () => ({
    store: {
      getState: () => ({
        hasAttachmentBytes: mocks.hasAttachmentBytes,
      }),
    },
  }),
}));

// What a lane-arm replica holds for an artifact image: nothing.
vi.mock("@/lib/epic-replica-reads", () => ({
  readHeldEpicAttachmentBytes: () => Promise.resolve(null),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicSnapshotLoaded: () => mocks.snapshotLoaded,
}));

afterEach(() => {
  mocks.snapshotLoaded = false;
  mocks.hasAttachmentBytes.mockClear();
});

describe("useEpicAttachmentBytesPresence", () => {
  it("returns no predicate until the root snapshot is loaded", () => {
    const { result, rerender } = renderHook(() =>
      useEpicAttachmentBytesPresence(),
    );

    expect(result.current).toBeNull();

    mocks.snapshotLoaded = true;
    rerender();

    const hasAttachmentBytes = result.current;
    if (hasAttachmentBytes === null) {
      throw new Error("expected attachment presence after snapshot readiness");
    }
    expect(hasAttachmentBytes("present-hash")).toBe(true);
    expect(hasAttachmentBytes("missing-hash")).toBe(false);
  });
});

function renderArtifactImage(
  hash: string,
  requestWithSignal: ArtifactAttachmentReadClient["requestWithSignal"],
): RenderHookResult<AttachmentBlobSrcState, unknown> {
  return renderHook(() => useAttachmentBlobSrc(hash, "image/png", null), {
    wrapper: wrapperFor(scopeWith(requestWithSignal)),
  });
}

describe("useAttachmentBlobSrc - an image the host is still downloading", () => {
  const originalCreate = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  const originalRevoke = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL",
  );

  beforeEach(() => {
    vi.useFakeTimers();
    resetArtifactAttachmentHostSupport();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: () => "blob:artifact-image",
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
  });

  afterEach(() => {
    cleanup();
    imageBlobCache.clear();
    resetEpicImageFetcherArmAbort();
    vi.useRealTimers();
    if (originalCreate === undefined) {
      Reflect.deleteProperty(URL, "createObjectURL");
    } else {
      Object.defineProperty(URL, "createObjectURL", originalCreate);
    }
    if (originalRevoke === undefined) {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    } else {
      Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    }
  });

  it.each([
    { when: "within the grace window", firstAnswerMs: 700 },
    { when: "after the grace window", firstAnswerMs: 12_500 },
  ])(
    "stays loading past the grace window and shows the bytes when they land, one request at a time, first answered $when",
    async ({ firstAnswerMs }) => {
      // Longer than the first wait between requests, so a second polling loop for
      // the same image would overlap the first.
      const laterAnswerMs = 700;
      let answerMs = firstAnswerMs;
      const bytesLandAt = Date.now() + 20_000;
      let inFlight = 0;
      let mostInFlight = 0;
      const requestWithSignal: ArtifactAttachmentReadClient["requestWithSignal"] =
        async () => {
          inFlight += 1;
          mostInFlight = Math.max(mostInFlight, inFlight);
          const delayMs = answerMs;
          answerMs = laterAnswerMs;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          inFlight -= 1;
          return Date.now() < bytesLandAt ? DOWNLOADING_ANSWER : FOUND_ANSWER;
        };
      const { result } = renderArtifactImage("a".repeat(64), requestWithSignal);

      await act(() =>
        vi.advanceTimersByTimeAsync(IMAGE_UNAVAILABLE_GRACE_MS + 1_000),
      );
      expect(result.current).toEqual({ status: "loading", src: null });

      await act(() => vi.advanceTimersByTimeAsync(12_000));
      expect(result.current).toEqual({
        status: "ready",
        src: "blob:artifact-image",
        mediaType: "image/png",
      });
      expect(mostInFlight).toBe(1);
    },
  );

  it("gives a later mount its grace window once the download is over", async () => {
    const hash = "b".repeat(64);
    const downloadsThenFinds = vi
      .fn<ArtifactAttachmentReadClient["requestWithSignal"]>()
      .mockResolvedValueOnce(DOWNLOADING_ANSWER)
      .mockResolvedValue(FOUND_ANSWER);
    const first = renderArtifactImage(hash, downloadsThenFinds);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(first.result.current.status).toBe("ready");
    first.unmount();
    imageBlobCache.clear();

    const neverAnswers = vi.fn<
      ArtifactAttachmentReadClient["requestWithSignal"]
    >(() => new Promise(() => undefined));
    const second = renderArtifactImage(hash, neverAnswers);
    await act(() =>
      vi.advanceTimersByTimeAsync(IMAGE_UNAVAILABLE_GRACE_MS + 1_000),
    );

    // Asked, so neither the blob cache nor the stored bytes answered for it.
    expect(neverAnswers).toHaveBeenCalledTimes(1);
    expect(second.result.current).toEqual({
      status: "unavailable",
      src: null,
    });
  });

  it.each([
    { when: "at once", firstAnswerMs: 0 },
    { when: "after the grace window", firstAnswerMs: 12_500 },
  ])(
    "gives a fresh grace window when the host stops downloading without the bytes, first answered $when",
    async ({ firstAnswerMs }) => {
      const downloadEndsAfterMs = 14_000;
      const missingAfterMs = 16_000;
      const downloadStartedAt = Date.now();
      let answerMs = firstAnswerMs;
      let saidMissing = false;
      let leftUnanswered = 0;
      const requestWithSignal: ArtifactAttachmentReadClient["requestWithSignal"] =
        async () => {
          const delayMs = answerMs;
          answerMs = 0;
          // A zero-length timer would still push the answer to a later tick.
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          const elapsedMs = Date.now() - downloadStartedAt;
          if (elapsedMs < downloadEndsAfterMs) return DOWNLOADING_ANSWER;
          if (saidMissing) {
            leftUnanswered += 1;
            return new Promise(() => undefined);
          }
          saidMissing = true;
          await new Promise((resolve) =>
            setTimeout(resolve, missingAfterMs - elapsedMs),
          );
          return MISSING_ANSWER;
        };
      const { result } = renderArtifactImage("c".repeat(64), requestWithSignal);
      // Its own step: the first downloading answer has to render before the
      // clock moves on.
      await act(() => vi.advanceTimersByTimeAsync(firstAnswerMs + 1_000));
      await act(() =>
        vi.advanceTimersByTimeAsync(missingAfterMs - firstAnswerMs - 1_000),
      );

      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(result.current).toEqual({ status: "loading", src: null });
      // The retry is parked on the host, so only the grace window can end this.
      expect(leftUnanswered).toBe(1);

      await act(() =>
        vi.advanceTimersByTimeAsync(IMAGE_UNAVAILABLE_GRACE_MS - 1_001),
      );
      expect(result.current).toEqual({ status: "loading", src: null });
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(result.current).toEqual({ status: "unavailable", src: null });
      expect(leftUnanswered).toBe(1);
    },
  );

  it("spends one retry attempt on each download that ends without the bytes", async () => {
    let asked = 0;
    const requestWithSignal = vi.fn<
      ArtifactAttachmentReadClient["requestWithSignal"]
    >(() => {
      asked += 1;
      // Odd requests start a download, even ones end it empty-handed.
      return Promise.resolve(
        asked % 2 === 1 ? DOWNLOADING_ANSWER : MISSING_ANSWER,
      );
    });
    const { result } = renderArtifactImage("d".repeat(64), requestWithSignal);

    // Short of the grace window, so only the spent ladder can end the loading.
    await act(() =>
      vi.advanceTimersByTimeAsync(IMAGE_UNAVAILABLE_GRACE_MS - 1),
    );
    expect(requestWithSignal).toHaveBeenCalledTimes(
      IMAGE_FETCH_MAX_ATTEMPTS * 2,
    );
    expect(result.current).toEqual({ status: "unavailable", src: null });

    await act(() =>
      vi.advanceTimersByTimeAsync(IMAGE_UNAVAILABLE_GRACE_MS * 5),
    );
    expect(requestWithSignal).toHaveBeenCalledTimes(
      IMAGE_FETCH_MAX_ATTEMPTS * 2,
    );
  });

  it("adds exactly one request at each scheduled poll while the image renders the download", async () => {
    const requestWithSignal = vi
      .fn<ArtifactAttachmentReadClient["requestWithSignal"]>()
      .mockResolvedValueOnce(DOWNLOADING_ANSWER)
      .mockResolvedValueOnce(DOWNLOADING_ANSWER)
      .mockResolvedValue(FOUND_ANSWER);
    const firstWaitMs = ARTIFACT_OBJECT_DOWNLOADING_POLL_LANE.initialDelayMs;
    const { result } = renderArtifactImage("e".repeat(64), requestWithSignal);

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(requestWithSignal).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(firstWaitMs - 1));
    expect(requestWithSignal).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(requestWithSignal).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(firstWaitMs * 2 - 1));
    expect(requestWithSignal).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(requestWithSignal).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe("ready");
  });

  it("stops polling at missing and leaves the next request to the retry ladder", async () => {
    const requestWithSignal = vi
      .fn<ArtifactAttachmentReadClient["requestWithSignal"]>(
        () => new Promise(() => undefined),
      )
      .mockResolvedValueOnce(DOWNLOADING_ANSWER)
      .mockResolvedValueOnce(MISSING_ANSWER);
    renderArtifactImage("f".repeat(64), requestWithSignal);

    await act(() => vi.advanceTimersByTimeAsync(0));
    // The one poll, which is answered `missing`.
    await act(() =>
      vi.advanceTimersByTimeAsync(
        ARTIFACT_OBJECT_DOWNLOADING_POLL_LANE.initialDelayMs,
      ),
    );
    expect(requestWithSignal).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(IMAGE_FETCH_RETRY_BASE_MS - 1));
    expect(requestWithSignal).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(requestWithSignal).toHaveBeenCalledTimes(3);
  });
});
