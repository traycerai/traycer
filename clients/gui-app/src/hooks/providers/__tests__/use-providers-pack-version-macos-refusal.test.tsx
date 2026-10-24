import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { JSX, ReactNode } from "react";

/**
 * First-refusal delivery for `providers.usePackVersion@1.1`'s typed
 * `macos-ineligible` arm. The sentence comes from the operation's own
 * response, so it must reach the person before - and regardless of - any
 * `providers.list` refetch. The real hook runs; only the transport and the
 * toast are faked.
 */

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  activeHostId: { current: "host-a" },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
  },
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    request: mocks.request,
    getActiveHostId: () => mocks.activeHostId.current,
  }),
}));

import {
  createVersionManagerPanelToken,
  registerVersionManagerPanel,
  resetVersionManagerPanelPresence,
} from "@/components/settings/panels/provider-pack-version-manager-presence";
import { useProvidersUsePackVersion } from "@/hooks/providers/use-providers-use-pack-version-mutation";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

const SENTENCE = "Needs macOS 15.0 or later. This Mac runs macOS 14.2.";
const OPERATOR_DETAIL = "operator-only text the person must never read";

const REFUSAL = {
  result: {
    ok: false,
    code: "macos-ineligible",
    requiredMacos: "15.0",
    runningMacos: "14.2",
    // Not part of the arm; proves nothing free-form is ever rendered.
    detail: OPERATOR_DETAIL,
  },
};

function setup(): {
  readonly queryClient: QueryClient;
  readonly invalidate: MockInstance<QueryClient["invalidateQueries"]>;
  readonly wrapper: (props: { children: ReactNode }) => JSX.Element;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  return {
    queryClient,
    invalidate,
    wrapper: function Wrapper(props: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      );
    },
  };
}

beforeEach(() => {
  resetVersionManagerPanelPresence();
  mocks.request.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.activeHostId.current = "host-a";
});

afterEach(() => {
  cleanup();
  resetVersionManagerPanelPresence();
});

describe("usePackVersion macos-ineligible first refusal", () => {
  it("toasts the typed sentence once when no panel is mounted, never the detail", async () => {
    mocks.request.mockResolvedValue(REFUSAL);
    const { wrapper } = setup();
    const { result } = renderHook(() => useProvidersUsePackVersion(null), {
      wrapper,
    });

    result.current.mutate({ packId: "antigravity", version: "2.0.0" });

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith(SENTENCE);
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      OPERATOR_DETAIL,
    );
  });

  it("toasts once when the popover closes during the request, leaving the panel nothing to store", async () => {
    const panel = createVersionManagerPanelToken("antigravity");
    const release = registerVersionManagerPanel(panel);
    let resolve: (value: unknown) => void = () => {};
    mocks.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useProvidersUsePackVersion(panel), {
      wrapper,
    });

    result.current.mutate({ packId: "antigravity", version: "2.0.0" });
    // Truly in flight: the transport has the request before the popover closes.
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    release();
    resolve(REFUSAL);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith(SENTENCE);
  });

  it("stays silent while the requesting panel is mounted, because the panel draws the sentence", async () => {
    const panel = createVersionManagerPanelToken("antigravity");
    const release = registerVersionManagerPanel(panel);
    mocks.request.mockResolvedValue(REFUSAL);
    const { wrapper } = setup();
    const { result } = renderHook(() => useProvidersUsePackVersion(panel), {
      wrapper,
    });

    result.current.mutate({ packId: "antigravity", version: "2.0.0" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.toastError).not.toHaveBeenCalled();
    release();
  });

  it("does not wait for, or get rewritten by, a deferred providers.list refetch", async () => {
    mocks.request.mockResolvedValue(REFUSAL);
    const { wrapper, invalidate } = setup();
    let finishRefetch: () => void = () => {};
    invalidate.mockImplementation(
      () =>
        new Promise<void>((done) => {
          finishRefetch = done;
        }),
    );
    const { result } = renderHook(() => useProvidersUsePackVersion(null), {
      wrapper,
    });

    result.current.mutate({ packId: "antigravity", version: "2.0.0" });

    // The refetch is still pending; the sentence is already out.
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith(SENTENCE);

    finishRefetch();
    await Promise.resolve();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenLastCalledWith(SENTENCE);
  });

  it("invalidates providers.list for the host captured at onMutate, not the one active at response time", async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useProvidersUsePackVersion(null), {
      wrapper,
    });

    result.current.mutate({ packId: "antigravity", version: "2.0.0" });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    mocks.activeHostId.current = "host-b";
    resolve(REFUSAL);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-a", "providers.list"),
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-b", "providers.list"),
    });
  });

  it("leaves the shown sentence alone when the real providers.list refetch fails", async () => {
    mocks.request.mockResolvedValue(REFUSAL);
    // A real client and a real active observer: the invalidation the hook
    // issues triggers a genuine second fetch, which rejects.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      "host-a",
      "providers.list",
      { native: null },
    );
    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: listKey,
      queryFn: () => {
        fetches += 1;
        return fetches === 1
          ? Promise.resolve({ providers: [], native: null })
          : Promise.reject(new Error("list refetch failed"));
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    await waitFor(() => expect(fetches).toBe(1));
    await waitFor(() =>
      expect(queryClient.getQueryState(listKey)?.status).toBe("success"),
    );
    const { result } = renderHook(() => useProvidersUsePackVersion(null), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    result.current.mutate({ packId: "antigravity", version: "2.0.0" });

    await waitFor(() => expect(fetches).toBe(2));
    await waitFor(() =>
      expect(queryClient.getQueryState(listKey)?.status).toBe("error"),
    );
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenLastCalledWith(SENTENCE);
    unsubscribe();
  });

  it("decides the toast by the token that asked, not by a newer panel for the same pack", async () => {
    // A host or pack change remints the panel's token. The old panel is gone,
    // the new one never asked, so the refusal has no inline surface left.
    const oldToken = createVersionManagerPanelToken("antigravity");
    const releaseOld = registerVersionManagerPanel(oldToken);
    const newToken = createVersionManagerPanelToken("antigravity");
    const releaseNew = registerVersionManagerPanel(newToken);
    let resolve: (value: unknown) => void = () => {};
    mocks.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useProvidersUsePackVersion(oldToken), {
      wrapper,
    });

    result.current.mutate({ packId: "antigravity", version: "2.0.0" });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    releaseOld();
    resolve(REFUSAL);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith(SENTENCE);
    releaseNew();
  });
});
