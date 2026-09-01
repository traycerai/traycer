import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

/**
 * Coverage for `useProvidersRefreshPackDiscovery` — critique finding 3 is what
 * this file exists to pin: the extended `joinResponseTimeoutMs` the policy
 * table advertises for `providers.refreshPackDiscovery` is only a PERMISSION.
 * It does nothing unless the caller actually rides
 * `useHostMutationWithResponseTimeout`, which calls
 * `client.requestWithResponseTimeout(method, params, responseTimeoutMs)`
 * rather than plain `client.request`. A hook that quietly regressed to
 * `useHostMutation` would still compile, still pass every outcome-shaped
 * test, and silently run on the transport's 30s default.
 */

const HOST_ID = "host-1";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  requestWithResponseTimeout: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  getActiveHostId: vi.fn<() => string | null>(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    request: mocks.request,
    requestWithResponseTimeout: mocks.requestWithResponseTimeout,
    getActiveHostId: mocks.getActiveHostId,
  }),
}));

import {
  createVersionManagerPanelToken,
  registerVersionManagerPanel,
  resetVersionManagerPanelPresence,
} from "@/components/settings/panels/provider-pack-version-manager-presence";
import { PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS } from "@/lib/host-rpc-policy/provider-pack-discovery-check-timeout";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { useProvidersRefreshPackDiscovery } from "@/hooks/providers/use-providers-refresh-pack-discovery-mutation";

function wrapper(
  queryClient: QueryClient,
): (props: { children: ReactNode }) => JSX.Element {
  return function Wrapper(props: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  resetVersionManagerPanelPresence();
  mocks.request.mockReset();
  mocks.requestWithResponseTimeout.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.toastInfo.mockReset();
  mocks.getActiveHostId.mockReset();
  mocks.getActiveHostId.mockReturnValue(HOST_ID);
});

afterEach(() => {
  cleanup();
  resetVersionManagerPanelPresence();
});

describe("useProvidersRefreshPackDiscovery response budget", () => {
  it("rides requestWithResponseTimeout with the extended budget, never the plain request", async () => {
    mocks.requestWithResponseTimeout.mockResolvedValue({
      result: { ok: true, outcome: "unchanged" },
    });
    const queryClient = makeQueryClient();
    const { result } = renderHook(
      () => useProvidersRefreshPackDiscovery(null),
      {
        wrapper: wrapper(queryClient),
      },
    );

    result.current.mutate({ packId: "opencode" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mocks.requestWithResponseTimeout).toHaveBeenCalledWith(
      "providers.refreshPackDiscovery",
      { packId: "opencode" },
      PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS,
    );
    // The whole point of this pin: a plain `useHostMutation` regression would
    // still pass every outcome-shaped test while quietly running on the
    // transport's 30s default via `request`.
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("declares the same number in the policy table that the hook passes", () => {
    // The host client rejects any `requestWithResponseTimeout` whose value is
    // not EXACTLY the row's `joinResponseTimeoutMs`, and that is a runtime
    // rejection with no other guard. Reads the table's declared value rather
    // than re-deriving it, so a row hand-edited to a literal fails here.
    const declared = hostRpcSchedulingPolicy.joinResponseTimeoutMs(
      "providers.refreshPackDiscovery",
    );
    expect(declared).toBe(PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS);
  });

  it("is sized for a joined full-set tick, not shrunk back toward the transport default", () => {
    // The check above cannot see this on its own: the table row IMPORTS the
    // same constant, so the two agree for any value - including a value small
    // enough to make the whole extended-budget mechanism pointless. Shrinking
    // the constant to the transport's 30s default frame timeout would keep
    // every other test in this file green while silently restoring the failure
    // mode the budget exists to prevent.
    //
    // So pin the DERIVATION the constant's doc comment claims. A manual check
    // joins an in-flight tick, so one press can be waiting on the whole enabled
    // set's serial poll.
    const MANAGED_PACK_COUNT = 15; // traycer-host/resources/providers/PROVIDERS.json
    const REGISTRY_GETS_PER_PACK = 2; // pointer read, then a conditional head read
    const REGISTRY_METADATA_TIMEOUT_MS = 10_000; // the registry transport's own ceiling

    expect(PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MANAGED_PACK_COUNT *
        REGISTRY_GETS_PER_PACK *
        REGISTRY_METADATA_TIMEOUT_MS,
    );
  });
});

describe("useProvidersRefreshPackDiscovery providers.list invalidation", () => {
  it("invalidates providers.list scoped to the host captured in onMutate", async () => {
    mocks.requestWithResponseTimeout.mockResolvedValue({
      result: { ok: true, outcome: "moved" },
    });
    const queryClient = makeQueryClient();
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    queryClient.setQueryData(listKey, { native: null, providers: [] });

    const { result } = renderHook(
      () => useProvidersRefreshPackDiscovery(null),
      {
        wrapper: wrapper(queryClient),
      },
    );
    result.current.mutate({ packId: "opencode" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  it("invalidates nothing when the captured host id is null", async () => {
    mocks.getActiveHostId.mockReturnValue(null);
    mocks.requestWithResponseTimeout.mockResolvedValue({
      result: { ok: true, outcome: "moved" },
    });
    const queryClient = makeQueryClient();
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    queryClient.setQueryData(listKey, { native: null, providers: [] });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () => useProvidersRefreshPackDiscovery(null),
      {
        wrapper: wrapper(queryClient),
      },
    );
    result.current.mutate({ packId: "opencode" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("useProvidersRefreshPackDiscovery refusal delivery", () => {
  it("toasts a typed refusal when no panel is mounted to draw it inline", async () => {
    mocks.requestWithResponseTimeout.mockResolvedValue({
      result: { ok: false, code: "pack-disabled", detail: null },
    });
    const queryClient = makeQueryClient();
    const { result } = renderHook(
      () => useProvidersRefreshPackDiscovery(null),
      {
        wrapper: wrapper(queryClient),
      },
    );

    result.current.mutate({ packId: "opencode" });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Enable this provider to check for updates.",
      );
    });
  });

  it("stays silent on a refusal while the requesting panel is still mounted", async () => {
    const panel = createVersionManagerPanelToken("opencode");
    const release = registerVersionManagerPanel(panel);
    mocks.requestWithResponseTimeout.mockResolvedValue({
      result: { ok: false, code: "discovery-unavailable", detail: null },
    });
    const queryClient = makeQueryClient();
    const { result } = renderHook(
      () => useProvidersRefreshPackDiscovery(panel),
      { wrapper: wrapper(queryClient) },
    );

    result.current.mutate({ packId: "opencode" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The panel owns the inline notice; a toast here would double-report it.
    expect(mocks.toastError).not.toHaveBeenCalled();
    release();
  });

  it("toasts once the requesting panel has unmounted, even though it was mounted at the start", async () => {
    const panel = createVersionManagerPanelToken("opencode");
    const release = registerVersionManagerPanel(panel);
    mocks.requestWithResponseTimeout.mockResolvedValue({
      result: { ok: false, code: "pack-disabled", detail: null },
    });
    const queryClient = makeQueryClient();
    const { result } = renderHook(
      () => useProvidersRefreshPackDiscovery(panel),
      { wrapper: wrapper(queryClient) },
    );

    result.current.mutate({ packId: "opencode" });
    // The popover closes mid-flight.
    release();

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Enable this provider to check for updates.",
      );
    });
  });
});

describe("useProvidersRefreshPackDiscovery success delivery", () => {
  it("never toasts a successful outcome while a panel is mounted", async () => {
    const panel = createVersionManagerPanelToken("opencode");
    const release = registerVersionManagerPanel(panel);
    mocks.requestWithResponseTimeout.mockResolvedValue({
      result: { ok: true, outcome: "unchanged" },
    });
    const queryClient = makeQueryClient();
    const { result } = renderHook(
      () => useProvidersRefreshPackDiscovery(panel),
      { wrapper: wrapper(queryClient) },
    );

    result.current.mutate({ packId: "opencode" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    release();
  });

  it("never toasts a successful outcome with no panel mounted either — the plan is explicit: no result toast on success", async () => {
    mocks.requestWithResponseTimeout.mockResolvedValue({
      result: { ok: true, outcome: "moved" },
    });
    const queryClient = makeQueryClient();
    const { result } = renderHook(
      () => useProvidersRefreshPackDiscovery(null),
      {
        wrapper: wrapper(queryClient),
      },
    );

    result.current.mutate({ packId: "opencode" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });
});
