import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProfileSyncOverview,
  ProfileSyncProvider,
} from "@traycer/protocol/host/profile-sync-link-schemas";
import {
  useProfileSyncAcceptAccount,
  useProfileSyncAcceptAccountPending,
  useProfileSyncNow,
  useProfileSyncNowPending,
  useProfileSyncOverview,
  useProfileSyncRequestedKeepInSync,
  useProfileSyncSetKeepInSync,
} from "@/hooks/providers/use-profile-sync";
import { profileSyncKeys } from "@/lib/query-keys/profile-sync-keys";

const SOURCE_HOST_ID = "host-source";
const OTHER_SOURCE_HOST_ID = "host-other-source";
const DEST_A = "host-a";
const DEST_B = "host-b";
const PROVIDER_ID: ProfileSyncProvider = "claude";
const SOURCE_PROFILE_ID = "11111111-1111-4111-8111-111111111111";

const testState = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    return {
      getActiveHostId: () => hostId,
      getRequestContextUserId: () => "user-1",
      request: (method: string, params: unknown) =>
        testState.request(method, params),
      requestWithSignal: (
        method: string,
        params: unknown,
        _signal: AbortSignal | undefined,
      ) => testState.request(method, params),
    };
  },
}));

function hang(): Promise<never> {
  return new Promise(() => undefined);
}

function overviewFor(
  sourceHostId: string,
  destinationHostId: string,
): ProfileSyncOverview {
  return {
    sourceHostId,
    profileCount: 1,
    devices: [
      {
        hostId: destinationHostId,
        keepInSync: false,
        items: [
          {
            providerId: PROVIDER_ID,
            sourceProfileId: SOURCE_PROFILE_ID,
            name: "Work",
            status: "synced",
            reason: null,
          },
        ],
      },
    ],
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

describe("useProfileSyncOverview", () => {
  beforeEach(() => {
    testState.request.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("rejects an overview whose sourceHostId differs from the requested one", async () => {
    const queryClient = makeQueryClient();
    testState.request.mockResolvedValue(
      overviewFor(OTHER_SOURCE_HOST_ID, DEST_A),
    );

    const rendered = renderHook(() => useProfileSyncOverview(SOURCE_HOST_ID), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => {
      expect(rendered.result.current.isError).toBe(true);
    });
    expect(
      queryClient.getQueryData(profileSyncKeys.overview(SOURCE_HOST_ID)),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(profileSyncKeys.overview(OTHER_SOURCE_HOST_ID)),
    ).toBeUndefined();
  });
});

describe("profile sync mutations", () => {
  beforeEach(() => {
    testState.request.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("sends syncNow params and publishes the returned overview", async () => {
    const queryClient = makeQueryClient();
    const returned = overviewFor(SOURCE_HOST_ID, DEST_A);
    testState.request.mockImplementation((method) => {
      if (method === "providers.profileSync.syncNow") {
        return Promise.resolve(returned);
      }
      return hang();
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const rendered = renderHook(
      () => useProfileSyncNow(SOURCE_HOST_ID, DEST_A),
      { wrapper: wrapperFor(queryClient) },
    );
    act(() => {
      rendered.result.current.mutate();
    });

    await waitFor(() => {
      expect(rendered.result.current.isSuccess).toBe(true);
    });
    expect(testState.request).toHaveBeenCalledWith(
      "providers.profileSync.syncNow",
      { sourceHostId: SOURCE_HOST_ID, destinationHostId: DEST_A },
    );
    expect(
      queryClient.getQueryData(profileSyncKeys.overview(SOURCE_HOST_ID)),
    ).toEqual(returned);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: profileSyncKeys.overview(SOURCE_HOST_ID),
    });
  });

  it("sends setKeepInSync params and publishes the returned overview", async () => {
    const queryClient = makeQueryClient();
    const returned = overviewFor(SOURCE_HOST_ID, DEST_A);
    testState.request.mockImplementation((method) => {
      if (method === "providers.profileSync.setKeepInSync") {
        return Promise.resolve(returned);
      }
      return hang();
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const rendered = renderHook(
      () => useProfileSyncSetKeepInSync(SOURCE_HOST_ID, DEST_A),
      { wrapper: wrapperFor(queryClient) },
    );
    act(() => {
      rendered.result.current.mutate({ enabled: true });
    });

    await waitFor(() => {
      expect(rendered.result.current.isSuccess).toBe(true);
    });
    expect(testState.request).toHaveBeenCalledWith(
      "providers.profileSync.setKeepInSync",
      {
        sourceHostId: SOURCE_HOST_ID,
        destinationHostId: DEST_A,
        enabled: true,
      },
    );
    expect(
      queryClient.getQueryData(profileSyncKeys.overview(SOURCE_HOST_ID)),
    ).toEqual(returned);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: profileSyncKeys.overview(SOURCE_HOST_ID),
    });
  });

  it("sends acceptAccount params and publishes the returned overview", async () => {
    const queryClient = makeQueryClient();
    const returned = overviewFor(SOURCE_HOST_ID, DEST_A);
    testState.request.mockImplementation((method) => {
      if (method === "providers.profileSync.acceptAccount") {
        return Promise.resolve(returned);
      }
      return hang();
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const rendered = renderHook(
      () =>
        useProfileSyncAcceptAccount(
          SOURCE_HOST_ID,
          DEST_A,
          PROVIDER_ID,
          SOURCE_PROFILE_ID,
        ),
      { wrapper: wrapperFor(queryClient) },
    );
    act(() => {
      rendered.result.current.mutate();
    });

    await waitFor(() => {
      expect(rendered.result.current.isSuccess).toBe(true);
    });
    expect(testState.request).toHaveBeenCalledWith(
      "providers.profileSync.acceptAccount",
      {
        sourceHostId: SOURCE_HOST_ID,
        destinationHostId: DEST_A,
        providerId: PROVIDER_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
      },
    );
    expect(
      queryClient.getQueryData(profileSyncKeys.overview(SOURCE_HOST_ID)),
    ).toEqual(returned);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: profileSyncKeys.overview(SOURCE_HOST_ID),
    });
  });

  it("rejects a mutation answer for another source and does not touch the cache", async () => {
    const queryClient = makeQueryClient();
    const planted = overviewFor(SOURCE_HOST_ID, DEST_B);
    queryClient.setQueryData(profileSyncKeys.overview(SOURCE_HOST_ID), planted);
    testState.request.mockResolvedValue(
      overviewFor(OTHER_SOURCE_HOST_ID, DEST_A),
    );

    const rendered = renderHook(
      () => useProfileSyncNow(SOURCE_HOST_ID, DEST_A),
      { wrapper: wrapperFor(queryClient) },
    );
    act(() => {
      rendered.result.current.mutate();
    });

    await waitFor(() => {
      expect(rendered.result.current.isError).toBe(true);
    });
    expect(
      queryClient.getQueryData(profileSyncKeys.overview(SOURCE_HOST_ID)),
    ).toEqual(planted);
    expect(
      queryClient.getQueryData(profileSyncKeys.overview(OTHER_SOURCE_HOST_ID)),
    ).toBeUndefined();
  });
});

describe("profile sync pending readers", () => {
  beforeEach(() => {
    testState.request.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("reflects a pending syncNow from a different hook instance with the same key, and not another device", async () => {
    const queryClient = makeQueryClient();
    testState.request.mockImplementation(() => hang());
    const wrapper = wrapperFor(queryClient);

    const sender = renderHook(() => useProfileSyncNow(SOURCE_HOST_ID, DEST_A), {
      wrapper,
    });
    const sameKey = renderHook(
      () => useProfileSyncNowPending(SOURCE_HOST_ID, DEST_A),
      { wrapper },
    );
    const otherDevice = renderHook(
      () => useProfileSyncNowPending(SOURCE_HOST_ID, DEST_B),
      { wrapper },
    );

    act(() => {
      sender.result.current.mutate();
    });

    await waitFor(() => {
      expect(sameKey.result.current).toBe(true);
    });
    expect(otherDevice.result.current).toBe(false);
  });

  it("reflects a pending Keep in sync request from a different hook instance with the same key, and not another device", async () => {
    const queryClient = makeQueryClient();
    testState.request.mockImplementation(() => hang());
    const wrapper = wrapperFor(queryClient);

    const sender = renderHook(
      () => useProfileSyncSetKeepInSync(SOURCE_HOST_ID, DEST_A),
      { wrapper },
    );
    const sameKey = renderHook(
      () => useProfileSyncRequestedKeepInSync(SOURCE_HOST_ID, DEST_A),
      { wrapper },
    );
    const otherDevice = renderHook(
      () => useProfileSyncRequestedKeepInSync(SOURCE_HOST_ID, DEST_B),
      { wrapper },
    );

    act(() => {
      sender.result.current.mutate({ enabled: true });
    });

    await waitFor(() => {
      expect(sameKey.result.current).toBe(true);
    });
    expect(otherDevice.result.current).toBeNull();
  });

  it("reflects a pending acceptAccount from a different hook instance with the same key, and not another device", async () => {
    const queryClient = makeQueryClient();
    testState.request.mockImplementation(() => hang());
    const wrapper = wrapperFor(queryClient);

    const sender = renderHook(
      () =>
        useProfileSyncAcceptAccount(
          SOURCE_HOST_ID,
          DEST_A,
          PROVIDER_ID,
          SOURCE_PROFILE_ID,
        ),
      { wrapper },
    );
    const sameKey = renderHook(
      () =>
        useProfileSyncAcceptAccountPending(
          SOURCE_HOST_ID,
          DEST_A,
          PROVIDER_ID,
          SOURCE_PROFILE_ID,
        ),
      { wrapper },
    );
    const otherDevice = renderHook(
      () =>
        useProfileSyncAcceptAccountPending(
          SOURCE_HOST_ID,
          DEST_B,
          PROVIDER_ID,
          SOURCE_PROFILE_ID,
        ),
      { wrapper },
    );

    act(() => {
      sender.result.current.mutate();
    });

    await waitFor(() => {
      expect(sameKey.result.current).toBe(true);
    });
    expect(otherDevice.result.current).toBe(false);
  });
});
