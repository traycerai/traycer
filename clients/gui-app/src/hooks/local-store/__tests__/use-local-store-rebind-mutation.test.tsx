import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { useLocalStoreRebindMutation } from "@/hooks/local-store/use-local-store-rebind-mutation";
import { hostQueryKeys } from "@/lib/query-keys";

const SESSION_HOST_ID = mockLocalHostEntry.hostId;
const OTHER_HOST_ID = "host-other";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => ({ request: mocks.request }),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [mockLocalHostEntry],
    isPending: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => SESSION_HOST_ID,
}));

afterEach(() => {
  cleanup();
  mocks.request.mockReset();
});

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useLocalStoreRebindMutation", () => {
  it("removes INACTIVE host-scoped query data on a successful rebind, refetches the active one, and leaves other hosts alone", async () => {
    // A rebind republishes the host's durability store, so every read served
    // from the old one is stale. Invalidation refetches ACTIVE queries only;
    // an inactive scope (a History filter the user left) is merely marked
    // stale, and History's first pages mount with `refetchOnMount: false` -
    // so revisiting it kept rendering the abandoned store's page. Inactive
    // host-scoped data must go, not merely age.
    mocks.request.mockResolvedValue({ status: "rebound" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const inactiveKey = [
      ...hostQueryKeys.scope(SESSION_HOST_ID),
      "history",
      "a-filter-the-user-left",
    ];
    const otherHostKey = [...hostQueryKeys.scope(OTHER_HOST_ID), "history"];
    queryClient.setQueryData(inactiveKey, { page: "from the abandoned store" });
    queryClient.setQueryData(otherHostKey, { page: "another host's answer" });

    const activeKey = [...hostQueryKeys.scope(SESSION_HOST_ID), "active"];
    const activeFetch = vi.fn().mockResolvedValue({ page: "fresh" });
    const wrapper = makeWrapper(queryClient);
    const activeOptions = queryOptions({
      queryKey: activeKey,
      queryFn: activeFetch,
      staleTime: Infinity,
    });
    const active = renderHook(() => useQuery(activeOptions), { wrapper });
    await waitFor(() => {
      expect(active.result.current.data).toEqual({ page: "fresh" });
    });
    expect(activeFetch).toHaveBeenCalledTimes(1);

    const { result } = renderHook(() => useLocalStoreRebindMutation(), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ confirmOldHostStopped: true });
    });

    expect(queryClient.getQueryData(inactiveKey)).toBeUndefined();
    expect(queryClient.getQueryData(otherHostKey)).toEqual({
      page: "another host's answer",
    });
    // The active query is not removed out from under its observer; it
    // refetches in place through the invalidation.
    await waitFor(() => {
      expect(activeFetch).toHaveBeenCalledTimes(2);
    });
    expect(queryClient.getQueryData(activeKey)).toEqual({ page: "fresh" });
  });

  it("leaves every cache alone when the host refused the rebind", async () => {
    mocks.request.mockResolvedValue({
      status: "refused",
      message: "Another host holds the store.",
      remedy: "Stop the other host.",
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const inactiveKey = [...hostQueryKeys.scope(SESSION_HOST_ID), "history"];
    queryClient.setQueryData(inactiveKey, { page: "still this window's" });

    const { result } = renderHook(() => useLocalStoreRebindMutation(), {
      wrapper: makeWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({ confirmOldHostStopped: true });
    });

    expect(queryClient.getQueryData(inactiveKey)).toEqual({
      page: "still this window's",
    });
  });
});
