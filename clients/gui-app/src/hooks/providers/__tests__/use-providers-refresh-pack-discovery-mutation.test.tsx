import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

/**
 * Must ride `useHostMutationWithResponseTimeout`. A silent regression to `useHostMutation` still compiles and still uses the transport's 30s default.
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

  it("declares exactly the budget the hook passes, and one longer than the transport's plain-request default", () => {
    // Equality: joinResponseTimeoutMs must match the row exactly or HostClient rejects. Floor: pair must stay above the frame default.
    const TRANSPORT_DEFAULT_FRAME_TIMEOUT_MS = 30_000;
    const declared = hostRpcSchedulingPolicy.joinResponseTimeoutMs(
      "providers.refreshPackDiscovery",
    );
    expect(declared).toBe(PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS);
    expect(declared).toBeGreaterThan(TRANSPORT_DEFAULT_FRAME_TIMEOUT_MS);
  });

  it("is sized for a joined full-set tick, not shrunk back toward the transport default", () => {
    // Floor, not derivation: OSS cannot import PROVIDERS.json. Four requests per pack (getSigned twice, object + minisig).
    const MANAGED_PACK_COUNT = 15; // traycer-host/resources/providers/PROVIDERS.json
    const SIGNED_READS_PER_PACK = 2; // reader.ts: generation pointer, then head
    const REQUESTS_PER_SIGNED_READ = 2; // registry-transport.ts: object + .minisig
    const REGISTRY_METADATA_TIMEOUT_MS = 10_000; // per-request transport ceiling

    expect(PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MANAGED_PACK_COUNT *
        SIGNED_READS_PER_PACK *
        REQUESTS_PER_SIGNED_READ *
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
