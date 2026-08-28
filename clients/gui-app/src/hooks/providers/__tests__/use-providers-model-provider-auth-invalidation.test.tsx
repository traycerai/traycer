import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useProvidersModelProviderAuth } from "@/hooks/providers/use-providers-model-provider-auth-mutation";
import { modelProvidersQueryKeys } from "@/lib/query-keys/model-providers-query-keys";
import { queryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

function openCodeRateLimitKey() {
  return queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
    "host-1",
    "host.getRateLimitUsage",
    {
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "opencode",
      profileId: null,
    },
  );
}

/**
 * Does a settled credential mutation actually bring the TAB's own list back to
 * truth?
 *
 * Written as a repro for a live report: a disconnected provider kept showing
 * Disconnect until the panel's manual refresh. The two candidate mechanisms
 * were "the list key is never invalidated" and "it is, but the refetch answers
 * from a pre-rotation server". This settles the first one at the layer that
 * owns it, so the second is diagnosed against evidence rather than by
 * elimination.
 */

const hostMocks = vi.hoisted(() => ({
  activeHostId: "host-1",
  request: vi.fn(),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // A full-enough client: `useHostQuery` builds its key off
    // `useReactiveHostReadiness`, which reads BOTH ids and subscribes for
    // changes. A stub missing either makes the query throw rather than
    // register - which would have made this test unable to see the very thing
    // it exists to check.
    useHostClient: () => ({
      getActiveHostId: () => hostMocks.activeHostId,
      getRequestContextUserId: () => "user-1",
      onChange: () => () => undefined,
      request: hostMocks.request,
    }),
  };
});

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

function wrapper(client: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  // Hoisted state is shared across every test in the file; without this a host
  // id or a queued response from one leaks into the next, and the failure shows
  // up in whichever test happens to run after the one that set it.
  hostMocks.activeHostId = "host-1";
  hostMocks.request.mockReset();
});

describe("model provider auth invalidation", () => {
  it("retires the tab's own catalog when a disconnect lands", async () => {
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    hostMocks.request.mockResolvedValue({ result: { kind: "done" } });

    const { result } = renderHook(() => useProvidersModelProviderAuth(), {
      wrapper: wrapper(client),
    });
    result.current.mutate({
      providerId: "opencode",
      action: { action: "disconnect", modelProviderId: "huggingface" },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const keys = invalidate.mock.calls.map((call) =>
      JSON.stringify(call[0]?.queryKey),
    );
    // The catalog the ROW renders from. Without this the panel keeps its
    // pre-mutation answer until something else refetches it - which is exactly
    // what the manual refresh was doing.
    expect(keys).toContain(
      JSON.stringify(modelProvidersQueryKeys.listScope("host-1")),
    );
    // And the model picker, which is the point of connecting at all.
    expect(keys).toContain(
      JSON.stringify(modelProvidersQueryKeys.modelCatalogScope("host-1")),
    );
  });

  it("invalidates the EXACT key the catalog query registers under", () => {
    // Asserting the invalidate call only proves the key we passed; it says
    // nothing about whether that key is a prefix of the one the list query
    // actually holds. A scope that does not match is indistinguishable from no
    // invalidation at all, and it is the shape of bug that survives a green
    // suite - so this pins the two builders against each other.
    const client = new QueryClient();
    const liveKey = queryKeys.hostMethod<
      HostRpcRegistry,
      "providers.listModelProviders"
    >("host-1", "providers.listModelProviders", { providerId: "opencode" });
    client.setQueryData(liveKey, { result: { ok: true, providers: [] } });

    void client.invalidateQueries({
      queryKey: modelProvidersQueryKeys.listScope("host-1"),
    });

    expect(client.getQueryState(liveKey)?.isInvalidated).toBe(true);
  });

  it("retires the caches for a PARTIALLY failed config write", async () => {
    // The host commits the config block and rotates before it reports the
    // credential step, so a `createCustom` whose key failed has still changed
    // what the next list says. Reporting the failure while leaving the row on
    // its old state is exactly the staleness this surface is prone to.
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    hostMocks.request.mockResolvedValue({
      result: {
        kind: "error",
        code: "provider_auth_failed",
        detail: "key rejected",
      },
    });

    const { result } = renderHook(() => useProvidersModelProviderAuth(), {
      wrapper: wrapper(client),
    });
    result.current.mutate({
      providerId: "opencode",
      action: {
        action: "createCustom",
        modelProviderId: "myprovider",
        name: "My AI Provider",
        baseUrl: "https://api.myprovider.com/v1",
        models: [{ id: "a", name: "A" }],
        headers: [],
        key: "sk-live-123",
        env: [],
      },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const keys = invalidate.mock.calls.map((call) =>
      JSON.stringify(call[0]?.queryKey),
    );
    expect(keys).toContain(
      JSON.stringify(modelProvidersQueryKeys.listScope("host-1")),
    );
  });

  it("invalidates the host the mutation STARTED on, not the one it ended on", async () => {
    // `onMutate` captures the host id for exactly this: Settings can be
    // re-pointed mid-flight, and reading the active host in `onSuccess` would
    // retire the NEW host's caches with the old host's result - leaving the
    // host that actually changed showing stale rows.
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    hostMocks.request.mockImplementation(() => {
      // The swap lands while the request is in flight.
      hostMocks.activeHostId = "host-2";
      return Promise.resolve({ result: { kind: "done" } });
    });

    const { result } = renderHook(() => useProvidersModelProviderAuth(), {
      wrapper: wrapper(client),
    });
    result.current.mutate({
      providerId: "opencode",
      action: { action: "disconnect", modelProviderId: "openai" },
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const keys = invalidate.mock.calls.map((call) =>
      JSON.stringify(call[0]?.queryKey),
    );
    expect(keys).toContain(
      JSON.stringify(modelProvidersQueryKeys.listScope("host-1")),
    );
    expect(keys).not.toContain(
      JSON.stringify(modelProvidersQueryKeys.listScope("host-2")),
    );
  });

  it("does NOT retire anything for a result that changed nothing", async () => {
    // A pending OAuth attempt invalidating on every poll tick would re-list -
    // and so re-lease a managed server - once a second.
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    hostMocks.request.mockResolvedValue({
      result: {
        kind: "pending",
        attemptId: "a",
        authorizationUrl: "https://x",
      },
    });

    const { result } = renderHook(() => useProvidersModelProviderAuth(), {
      wrapper: wrapper(client),
    });
    result.current.mutate({
      providerId: "opencode",
      action: {
        action: "startOauth",
        modelProviderId: "openai",
        methodIndex: 0,
        inputs: {},
      },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("resets the exact OpenCode usage key so last-good cannot survive a credential mutation", async () => {
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const rateLimitKey = openCodeRateLimitKey();
    client.setQueryData(rateLimitKey, {
      latest: { provider: "opencode", available: true },
      lastGood: { provider: "opencode", available: true },
      lastGoodAt: 1,
      lastFailureAt: null,
    });
    const reset = vi.spyOn(client, "resetQueries");
    const remove = vi.spyOn(client, "removeQueries");
    hostMocks.request.mockResolvedValue({ result: { kind: "done" } });

    const { result } = renderHook(() => useProvidersModelProviderAuth(), {
      wrapper: wrapper(client),
    });
    result.current.mutate({
      providerId: "opencode",
      action: { action: "disconnect", modelProviderId: "huggingface" },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(reset).toHaveBeenCalledWith({
      queryKey: rateLimitKey,
      exact: true,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(client.getQueryData(rateLimitKey)).toBeUndefined();
  });

  it("does not reset OpenCode usage when a different provider mutates", async () => {
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const rateLimitKey = openCodeRateLimitKey();
    const cached = {
      latest: { provider: "opencode" as const, available: true as const },
      lastGood: { provider: "opencode" as const, available: true as const },
      lastGoodAt: 1,
      lastFailureAt: null,
    };
    client.setQueryData(rateLimitKey, cached);
    const reset = vi.spyOn(client, "resetQueries");
    hostMocks.request.mockResolvedValue({ result: { kind: "done" } });

    const { result } = renderHook(() => useProvidersModelProviderAuth(), {
      wrapper: wrapper(client),
    });
    result.current.mutate({
      providerId: "claude-code",
      action: { action: "disconnect", modelProviderId: "openai" },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(reset).not.toHaveBeenCalled();
    expect(client.getQueryData(rateLimitKey)).toEqual(cached);
  });
});
