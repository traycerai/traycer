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
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FetchArtifactAttachmentRequest,
  FetchArtifactAttachmentResponse,
} from "@traycer/protocol/host/epic/artifact-attachment";
import {
  decideHostRpcDispatch,
  HOST_UNARY_RPC_ROUTES,
  NO_POOL_HOST_RPC_TIER_PLAN,
  NO_SERVING_PEER_DECISION,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

import { imageBlobCache } from "@/lib/attachments/image-blob-cache";
import {
  resetArtifactAttachmentHostSupport,
  resetEpicImageFetcherArmAbort,
  useEpicImageFetcher,
} from "@/lib/attachments/use-attachment-blob-src";
import { useImageBlobUrlState } from "@/lib/attachments/use-image-blob-url";
import {
  ArtifactAttachmentScopeContext,
  type ArtifactAttachmentScopeValue,
} from "@/lib/attachments/artifact-attachment-scope-context";
import { useAuthStore } from "@/stores/auth/auth-store";

const mocks = vi.hoisted(() => ({
  installedArm: "legacy" as "lanes" | "legacy" | null,
  readEpicAttachmentBytes: vi.fn(),
  readHeldEpicAttachmentBytes: vi.fn(),
}));

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

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

type AttachmentRequestWithSignal = NonNullable<
  ArtifactAttachmentScopeValue["client"]
>["requestWithSignal"];

function scopeWith(
  requestWithSignal: AttachmentRequestWithSignal,
): ArtifactAttachmentScopeValue {
  return {
    epicId: "epic-1",
    artifactId: "artifact-1",
    hostId: "host-1",
    hostVersion: "1.2.3",
    client: { requestWithSignal },
  };
}

function scopeAtVersion(
  hostVersion: string,
  requestWithSignal: AttachmentRequestWithSignal,
): ArtifactAttachmentScopeValue {
  return {
    ...scopeWith(requestWithSignal),
    hostId: "computer-upgrade",
    hostVersion,
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
  imageBlobCache.clear();
  resetArtifactAttachmentHostSupport();
});

afterEach(() => {
  cleanup();
  imageBlobCache.clear();
  if (originalCreateObjectURL === undefined) {
    Reflect.deleteProperty(URL, "createObjectURL");
  } else {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  }
  if (originalRevokeObjectURL === undefined) {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  } else {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  }
  useAuthStore.getState().setSignedOut();
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

  it("rejects a fetch captured on the legacy arm if the store is lanes before it runs", async () => {
    mocks.installedArm = "legacy";
    mocks.readEpicAttachmentBytes.mockResolvedValue(new Uint8Array([7]));
    const { result } = renderHook(() => useEpicImageFetcher(), {
      wrapper: wrapperFor(null),
    });
    const captured = result.current.fetch;
    notifyArmChange("lanes");
    await expect(captured(HASH, new AbortController().signal)).rejects.toThrow(
      /cancelled|abort/i,
    );
    expect(mocks.readEpicAttachmentBytes).not.toHaveBeenCalled();
  });

  it("renders a fresh artifact image after the signed-in account changes", async () => {
    let urlCount = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: () => `blob:account-switch/${++urlCount}`,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: () => undefined,
    });

    let activeAccount: "synthetic-account-a" | "synthetic-account-b" =
      "synthetic-account-a";
    let resolveAccountB: (
      value: FetchArtifactAttachmentResponse,
    ) => void = () => {
      throw new Error("account B image response was not requested");
    };
    const accountBResponse = new Promise<FetchArtifactAttachmentResponse>(
      (resolve) => {
        resolveAccountB = resolve;
      },
    );
    const requestWithSignal = vi.fn(
      (
        _method: "epic.fetchArtifactAttachment",
        _params: FetchArtifactAttachmentRequest,
        _signal: AbortSignal | undefined,
      ): Promise<FetchArtifactAttachmentResponse> =>
        activeAccount === "synthetic-account-a"
          ? Promise.resolve({
              ok: true,
              bytesBase64: "AQID",
              mediaType: "image/png",
            })
          : accountBResponse,
    );
    const scope = scopeWith(requestWithSignal);
    useAuthStore.getState().setSignedIn(
      {
        userId: "synthetic-account-a",
        userName: "A",
        email: "a@example.test",
      },
      { userId: "synthetic-account-a", username: "A" },
      [],
    );
    mocks.installedArm = "lanes";

    const ArtifactImage = (): ReactNode => {
      const image = useImageBlobUrlState(
        HASH,
        "image/png",
        useEpicImageFetcher(),
        null,
      );
      return <img alt="Synthetic attachment" src={image.url ?? undefined} />;
    };
    const rendered = render(<ArtifactImage />, { wrapper: wrapperFor(scope) });

    await waitFor(() => {
      expect(
        screen
          .getByRole("img", { name: "Synthetic attachment" })
          .getAttribute("src"),
      ).toBe("blob:account-switch/1");
    });
    const accountAUrl = screen
      .getByRole("img", { name: "Synthetic attachment" })
      .getAttribute("src");
    expect(accountAUrl).toBe("blob:account-switch/1");
    expect(requestWithSignal).toHaveBeenCalledTimes(1);

    activeAccount = "synthetic-account-b";
    act(() => {
      useAuthStore.getState().setSignedIn(
        {
          userId: "synthetic-account-b",
          userName: "B",
          email: "b@example.test",
        },
        { userId: "synthetic-account-b", username: "B" },
        [],
      );
    });
    rendered.rerender(<ArtifactImage />);

    expect(
      screen
        .getByRole("img", { name: "Synthetic attachment" })
        .getAttribute("src"),
    ).toBeNull();
    await waitFor(() => {
      expect(requestWithSignal).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      resolveAccountB({
        ok: true,
        bytesBase64: "BAUG",
        mediaType: "image/png",
      });
      await accountBResponse;
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("img", { name: "Synthetic attachment" })
          .getAttribute("src"),
      ).toBe("blob:account-switch/2");
    });
    expect(
      screen
        .getByRole("img", { name: "Synthetic attachment" })
        .getAttribute("src"),
    ).not.toBe(accountAUrl);
  });

  it("loads an artifact image from the upgraded computer despite its stale negative manifest", async () => {
    let urlCount = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: () => `blob:computer-upgrade/${++urlCount}`,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
    mocks.installedArm = "lanes";
    mocks.readHeldEpicAttachmentBytes.mockResolvedValue(null);

    const oldBuildError = new HostRpcError({
      code: "E_HOST_UNSUPPORTED",
      message: "The old computer build does not serve artifact attachments",
      requestId: "old-build-request",
      method: "epic.fetchArtifactAttachment",
      fatalDetails: null,
    });
    const oldBuildRequest = vi.fn(() => Promise.reject(oldBuildError));
    const oldBuildScope = scopeAtVersion("1.4.0", oldBuildRequest);
    const oldBuildFetcher = renderHook(() => useEpicImageFetcher(), {
      wrapper: wrapperFor(oldBuildScope),
    });

    await expect(
      oldBuildFetcher.result.current.fetch(HASH, new AbortController().signal),
    ).rejects.toThrow(/unavailable/);
    await expect(
      oldBuildFetcher.result.current.fetch(HASH, new AbortController().signal),
    ).rejects.toThrow(/unavailable/);
    expect(oldBuildRequest).toHaveBeenCalledTimes(1);
    oldBuildFetcher.unmount();

    const computer: HostDirectoryEntry = {
      hostId: "computer-upgrade",
      label: "Computer",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "1.5.0",
      transportDialability: "dialable",
    };
    const computerCalls: string[] = [];
    let resolveUpgradeAttempt: () => void = () => {
      throw new Error("the upgraded computer was not called");
    };
    const upgradeAttempt = new Promise<void>((resolve) => {
      resolveUpgradeAttempt = resolve;
    });
    const upgradedComputerRequest = vi.fn(
      (
        method: "epic.fetchArtifactAttachment",
        _params: FetchArtifactAttachmentRequest,
        _signal: AbortSignal | undefined,
      ): Promise<FetchArtifactAttachmentResponse> => {
        const decision = decideHostRpcDispatch(
          method,
          HOST_UNARY_RPC_ROUTES[method],
          computer,
          new Set<string>(),
          NO_POOL_HOST_RPC_TIER_PLAN,
          null,
          NO_SERVING_PEER_DECISION,
          null,
        );
        resolveUpgradeAttempt();
        if (decision.kind === "refuse") {
          return Promise.reject(
            new HostRpcError({
              code: decision.code,
              message: decision.message,
              requestId: "upgraded-build-request",
              method,
              fatalDetails: null,
            }),
          );
        }
        computerCalls.push(decision.entry.hostId);
        return Promise.resolve({
          ok: true,
          bytesBase64: BYTES_BASE64,
          mediaType: "image/png",
        });
      },
    );
    const upgradedScope = scopeAtVersion("1.5.0", upgradedComputerRequest);
    const ArtifactImage = (): ReactNode => {
      const image = useImageBlobUrlState(
        HASH,
        "image/png",
        useEpicImageFetcher(),
        null,
      );
      return (
        <img alt="Upgraded computer attachment" src={image.url ?? undefined} />
      );
    };

    render(
      <ArtifactAttachmentScopeContext.Provider value={upgradedScope}>
        <ArtifactImage />
      </ArtifactAttachmentScopeContext.Provider>,
    );
    await upgradeAttempt;

    expect(computerCalls).toEqual([computer.hostId]);
    expect(upgradedComputerRequest).toHaveBeenCalledWith(
      "epic.fetchArtifactAttachment",
      { epicId: "epic-1", artifactId: "artifact-1", hash: HASH },
      expect.any(AbortSignal),
    );
    await waitFor(() => {
      expect(
        screen
          .getByRole("img", { name: "Upgraded computer attachment" })
          .getAttribute("src"),
      ).toBe("blob:computer-upgrade/1");
    });
  });
});
