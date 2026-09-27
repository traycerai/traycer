/**
 * Which byte source an ARTIFACT image resolves through, per installed arm.
 *
 * The lane arm never seeds the root document - only the `@1` adapter emits on
 * the root plane - so the epic doc's `attachments` map cannot answer there and
 * the WAITING read parks for the life of the session while the image renders
 * "unavailable". These pin both directions: the lane arm asks the host, and the
 * legacy arm keeps the waiting doc read it always had.
 */
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetArtifactAttachmentHostSupport,
  resetEpicImageFetcherArmAbort,
  useEpicImageFetcher,
} from "@/lib/attachments/use-attachment-blob-src";
import {
  ArtifactAttachmentScopeContext,
  type ArtifactAttachmentScopeValue,
} from "@/lib/attachments/artifact-attachment-scope-context";

const mocks = vi.hoisted(() => ({
  installedArm: "legacy" as "lanes" | "legacy" | null,
  readEpicAttachmentBytes: vi.fn(),
  readHeldEpicAttachmentBytes: vi.fn(),
}));

/**
 * The store surface `useEpicImageFetcher` actually consumes.
 *
 * `subscribe` is not decoration: the hook reads `installedArm` through
 * `useSyncExternalStore`, and the arm-abort lease subscribes on the same
 * handle so an arm change after unmount still cancels a retained fetch.
 * One handle object for the suite so that lease is keyed on a stable
 * identity across remounts.
 */
const storeListeners = new Set<() => void>();

const fakeHandle: {
  readonly epicId: string;
  readonly store: {
    readonly getState: () => {
      readonly installedArm: typeof mocks.installedArm;
    };
    readonly subscribe: (onStoreChange: () => void) => () => void;
  };
} = {
  epicId: "epic-1",
  store: {
    getState: () => ({ installedArm: mocks.installedArm }),
    subscribe: (onStoreChange: () => void) => {
      storeListeners.add(onStoreChange);
      return () => {
        storeListeners.delete(onStoreChange);
      };
    },
  },
};

function notifyArmChange(next: typeof mocks.installedArm): void {
  mocks.installedArm = next;
  for (const listener of [...storeListeners]) listener();
}

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => fakeHandle,
  useOpenEpicHandle: () => fakeHandle,
}));

vi.mock("@/lib/epic-replica-reads", () => ({
  readEpicAttachmentBytes: mocks.readEpicAttachmentBytes,
  readHeldEpicAttachmentBytes: mocks.readHeldEpicAttachmentBytes,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicSnapshotLoaded: () => true,
}));

const HASH = "a".repeat(64);
/** `[1, 2, 3]`, so a decode failure cannot masquerade as an empty success. */
const BYTES_BASE64 = "AQID";

function scopeWith(
  requestWithSignal: ArtifactAttachmentScopeValue["client"] extends null
    ? never
    : NonNullable<ArtifactAttachmentScopeValue["client"]>["requestWithSignal"],
): ArtifactAttachmentScopeValue {
  return {
    epicId: "epic-1",
    artifactId: "artifact-1",
    hostId: "host-1",
    hostVersion: "1.2.3",
    client: { requestWithSignal },
  };
}

function wrapperFor(
  scope: ArtifactAttachmentScopeValue | null,
): ({ children }: { children: ReactNode }) => ReactNode {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <ArtifactAttachmentScopeContext.Provider value={scope}>
        {children}
      </ArtifactAttachmentScopeContext.Provider>
    );
  };
}

beforeEach(() => {
  resetArtifactAttachmentHostSupport();
});

afterEach(() => {
  mocks.installedArm = "legacy";
  mocks.readEpicAttachmentBytes.mockReset();
  mocks.readHeldEpicAttachmentBytes.mockReset();
  resetEpicImageFetcherArmAbort();
  storeListeners.clear();
});

describe("useEpicImageFetcher - byte source per arm", () => {
  it("asks the HOST on the lane arm, and never the waiting doc read", async () => {
    mocks.installedArm = "lanes";
    const requestWithSignal = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        bytesBase64: BYTES_BASE64,
        mediaType: "image/png" as const,
      }),
    );
    const { result } = renderHook(() => useEpicImageFetcher(), {
      wrapper: wrapperFor(scopeWith(requestWithSignal)),
    });

    const resolved = await result.current.fetch(
      HASH,
      new AbortController().signal,
    );

    expect(requestWithSignal).toHaveBeenCalledWith(
      "epic.fetchArtifactAttachment",
      // The id pair is the AUTHORIZATION subject, not decoration: a bare hash
      // is a content address, and serving one unproven would turn a cache key
      // into a capability.
      { epicId: "epic-1", artifactId: "artifact-1", hash: HASH },
      expect.anything(),
    );
    expect(Array.from(resolved.bytes)).toEqual([1, 2, 3]);
    // The host's verdict, sniffed from the delivered bytes - the only
    // non-forgeable statement about what this image IS.
    expect(resolved.mediaType).toBe("image/png");
    // THE REDDENING ASSERTION. Before the lane leg this call was the whole
    // fetcher, and on the lane arm it waits forever for bytes no lane delivers.
    expect(mocks.readEpicAttachmentBytes).not.toHaveBeenCalled();
  });

  it("falls back to the HELD read - never the waiting one - when the host predates the method", async () => {
    mocks.installedArm = "lanes";
    mocks.readHeldEpicAttachmentBytes.mockResolvedValue(new Uint8Array([9, 9]));
    const requestWithSignal = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        reason: "missing" as const,
      }),
    );
    const { result } = renderHook(() => useEpicImageFetcher(), {
      wrapper: wrapperFor(scopeWith(requestWithSignal)),
    });

    const resolved = await result.current.fetch(
      HASH,
      new AbortController().signal,
    );

    expect(Array.from(resolved.bytes)).toEqual([9, 9]);
    // The doc map holds raw bytes with no sniffed header, so this leg has no
    // verdict and the caller's declared type stands.
    expect(resolved.mediaType).toBeNull();
    // Non-waiting: an absent hash must fail fast and stay retryable rather
    // than parking on a lane that will never carry it.
    expect(mocks.readEpicAttachmentBytes).not.toHaveBeenCalled();
  });

  it("throws on the lane arm when neither the host nor the replica can answer", async () => {
    mocks.installedArm = "lanes";
    mocks.readHeldEpicAttachmentBytes.mockResolvedValue(null);
    const { result } = renderHook(() => useEpicImageFetcher(), {
      wrapper: wrapperFor(null),
    });

    await expect(
      result.current.fetch(HASH, new AbortController().signal),
    ).rejects.toThrow(/unavailable/);
  });

  it("keeps the waiting doc read on `@1`, and asks no host", async () => {
    mocks.installedArm = "legacy";
    mocks.readEpicAttachmentBytes.mockResolvedValue(new Uint8Array([7]));
    const requestWithSignal = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        bytesBase64: BYTES_BASE64,
        mediaType: "image/png" as const,
      }),
    );
    const { result } = renderHook(() => useEpicImageFetcher(), {
      wrapper: wrapperFor(scopeWith(requestWithSignal)),
    });

    const resolved = await result.current.fetch(
      HASH,
      new AbortController().signal,
    );

    // The COMPATIBILITY direction, and it is the half a lane-arm fix is most
    // likely to break: a legacy session's artifact images are byte-for-byte
    // what they always were, host scope present or not. Waiting is the feature
    // there - an image still replicating must resolve when it lands.
    expect(Array.from(resolved.bytes)).toEqual([7]);
    expect(mocks.readEpicAttachmentBytes).toHaveBeenCalledTimes(1);
    expect(requestWithSignal).not.toHaveBeenCalled();
  });

  it("aborts a retained legacy fetch when the arm changes after unmount", async () => {
    mocks.installedArm = "legacy";
    mocks.readEpicAttachmentBytes.mockImplementation(
      (_handle: unknown, _hash: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          const fail = (): void => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          };
          if (signal.aborted) {
            fail();
            return;
          }
          signal.addEventListener("abort", fail, { once: true });
        }),
    );
    const { result, unmount } = renderHook(() => useEpicImageFetcher(), {
      wrapper: wrapperFor(null),
    });

    const pending = result.current.fetch(HASH, new AbortController().signal);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => {
      expect(mocks.readEpicAttachmentBytes).toHaveBeenCalledTimes(1);
    });
    unmount();
    await Promise.resolve();
    expect(settled).toBe(false);

    notifyArmChange("lanes");
    await expect(pending).rejects.toThrow(/abort|cancelled/i);
    expect(settled).toBe(true);
  });
});
