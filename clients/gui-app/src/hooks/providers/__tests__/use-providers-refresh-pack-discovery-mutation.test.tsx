import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

/**
 * Coverage for `useProvidersRefreshPackDiscovery`. The extended
 * `joinResponseTimeoutMs` the policy table advertises for
 * `providers.refreshPackDiscovery` is only a PERMISSION: it does nothing
 * unless the caller actually rides `useHostMutationWithResponseTimeout`,
 * which calls `client.requestWithResponseTimeout(method, params,
 * responseTimeoutMs)` rather than plain `client.request`. A hook that
 * quietly regressed to plain `useHostMutation` would still compile, still
 * pass every outcome-shaped test, and silently run on the transport's 30s
 * default.
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
    // TWO assertions answering two different questions. Keep both.
    //
    // EQUALITY guards a hard runtime reject that no suite exercises FOR THIS
    // METHOD: `HostClient.requestWithResponseTimeout` rejects unless the row's
    // `joinResponseTimeoutMs` equals the passed value EXACTLY
    // (`expectedTimeout !== responseTimeoutMs -> Promise.reject`,
    // clients/shared/host-client/host-client.ts). The guard itself is pinned
    // generically (`host-request-coordinator.test.ts`,
    // `local-maintenance-fallback-client.test.ts`), but against other
    // methods; this suite mocks `@/lib/host` with a plain object, so nothing
    // here ever runs it against `providers.refreshPackDiscovery`.
    //
    // It reads like a tautology today because the row imports the constant.
    // It is not. Edit the row to `7 * 60 * 1000` - a plausible "give it more
    // room" change that forgets the shared constant - and without this line
    // EVERY suite stays green while EVERY real click rejects with "does not
    // permit response timeout 360000": the mocked-client test still sees the
    // hook pass the constant, the floor below still passes (420000 > 30000),
    // and the sizing test reads the constant, not the row. Do not remove it
    // again on the grounds that it cannot fail.
    //
    // The FLOOR is the non-vacuous half: it is the one that fails if the pair
    // shrinks back toward the frame default in lockstep.
    //
    // The literal mirrors `DEFAULT_HOST_RPC_FRAME_TIMEOUT_MS` in
    // `lib/host/host-messenger.ts`, which is module-private - naming it here
    // any other way would mean widening that module's surface.
    const TRANSPORT_DEFAULT_FRAME_TIMEOUT_MS = 30_000;
    const declared = hostRpcSchedulingPolicy.joinResponseTimeoutMs(
      "providers.refreshPackDiscovery",
    );
    expect(declared).toBe(PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS);
    expect(declared).toBeGreaterThan(TRANSPORT_DEFAULT_FRAME_TIMEOUT_MS);
  });

  it("is sized for a joined full-set tick, not shrunk back toward the transport default", () => {
    // The check above cannot see this on its own: it only bounds the row
    // against the transport default, not against the actual serial-poll cost.
    // Shrinking the constant to something still above 30s but below one full
    // tick would pass that check while silently restoring the failure mode
    // the budget exists to prevent.
    //
    // This pins the FLOOR, not the derivation: gui-app is OSS and cannot
    // import the internal `PROVIDERS.json` pack count or the host's registry
    // timeout constant, so the three factors below are forced literals fixed
    // at today's pack count (15). A 16th pack raises the correct value past
    // this floor rather than invalidating it, so this stays
    // `toBeGreaterThanOrEqual` and does not need to move when the pack count
    // does. The internal repo pins the other half - that `PROVIDERS.json`
    // still has exactly this many packs - at
    // `traycer-host/src/domain/providers/__tests__/provider-pack-count-fits-gui-discovery-check-budget.test.ts`.
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
