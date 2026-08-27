import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ProviderMutationCliStateV21 } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-schemas";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

const HOST_ID = "host-1";
const OTHER_HOST_ID = "host-2";

const mocks = vi.hoisted(() => ({
  requestWithResponseTimeout: vi.fn(),
  tabHostId: vi.fn<() => string | null>(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    requestWithResponseTimeout: mocks.requestWithResponseTimeout,
  }),
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => mocks.tabHostId(),
}));

import { useProvidersAwaitLogin } from "@/hooks/providers/use-providers-await-login-mutation";

type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;
type ProviderListEntry = ProvidersListResponse["providers"][number];

// The real @2.1 echo shape: `loginCapability` is PRESENT but frozen at v4.0,
// which has no `terminalLogin` key at all - not `null`, genuinely absent.
// `ProviderMutationCliStateV21` is that frozen wire type, so building the
// fixture directly against it (rather than against the live
// `ProviderCliState`) is what keeps this fixture honest without a cast.
function v21Echo(
  overrides: Partial<ProviderMutationCliStateV21>,
): ProviderMutationCliStateV21 {
  return {
    providerId: "copilot",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: {
      oauthArgs: ["auth", "login"],
      token: null,
      // Deliberately NO `terminalLogin`: this is the frozen @2.1 echo shape,
      // which does not model the field. Adding it here would make the fixture
      // pass whether or not the overlay strips the capability.
      codePaste: null,
    },
    availabilityPending: false,
    profiles: [],
    ...overrides,
  };
}

function legacyV21Profile(): ProviderMutationCliStateV21["profiles"][number] {
  return {
    profileId: "managed-1",
    kind: "managed",
    authType: "oauth",
    label: "Work",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: {
      email: "work@example.test",
      tier: "Pro",
      accountUuid: null,
    },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

function seededProvidersList(): ProvidersListResponse {
  return {
    native: null,
    providers: [
      {
        providerId: "copilot",
        enabled: true,
        disabledBy: null,
        selected: { kind: "bundled" },
        candidates: [],
        auth: {
          status: "unauthenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
        authPending: false,
        checkedAt: null,
        apiKey: { supported: false, configured: false, source: null },
        terminalAgentArgs: "",
        envOverrides: [],
        loginCapability: {
          oauthArgs: ["auth", "login"],
          token: null,
          codePaste: null,
          terminalLogin: {},
        },
        availabilityPending: false,
        profiles: [],
        nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
        managedInstallState: null,
        versionVisibility: null,
        advisory: null,
      },
    ],
  };
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = (props: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("useProvidersAwaitLogin overlay merge", () => {
  beforeEach(() => {
    mocks.tabHostId.mockReturnValue(HOST_ID);
  });
  afterEach(() => {
    cleanup();
    mocks.requestWithResponseTimeout.mockReset();
    mocks.tabHostId.mockReset();
  });

  // Row 8 of the terminal-login contract table: the cached `terminalLogin`
  // capability (set by `providers.list`) must survive a login echo whose own
  // `loginCapability` is present but frozen-shaped (no `terminalLogin` key at
  // all). Getting the fixture wrong - giving the echo an ABSENT or NULL
  // `loginCapability` - would pass whether or not the merge strips it, since
  // there would be nothing to overwrite with.
  it("keeps the seeded terminalLogin capability after a login echo lands", async () => {
    const { queryClient, wrapper } = makeWrapper();
    // `{ native: null }`, not `{}` - the classic (non-native) poll is keyed
    // that way and `commitAuthoritativeProvidersList` targets that exact
    // entry. Seeding a different key would leave the overlay writing into a
    // cache row this test never reads.
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    const seeded = seededProvidersList();
    queryClient.setQueryData(listKey, {
      ...seeded,
      providers: seeded.providers.map((provider) => ({
        ...provider,
        profiles: [
          {
            ...legacyV21Profile(),
            enabled: false,
            launchCommand: {
              command: "copilot --profile work",
              shell: "posix" as const,
            },
          },
        ],
      })),
    });
    mocks.requestWithResponseTimeout.mockResolvedValue({
      state: v21Echo({ profiles: [legacyV21Profile()] }),
      existingProfileId: null,
      codeRejected: false,
    });

    const { result } = renderHook(() => useProvidersAwaitLogin(), { wrapper });
    act(() => {
      result.current.mutate({ providerId: "copilot", profileId: null });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData<ProvidersListResponse>(listKey);
    const copilot = cached?.providers.find(
      (p: ProviderListEntry) => p.providerId === "copilot",
    );
    expect(copilot?.loginCapability?.terminalLogin).toEqual({});
    expect(copilot?.profiles[0]?.enabled).toBe(false);
    expect(copilot?.profiles[0]?.launchCommand).toEqual({
      command: "copilot --profile work",
      shell: "posix",
    });
    // The missing direction: `terminalLogin` staying `{}` is also what a
    // no-op merge (one that dropped the WHOLE echo, not just its
    // `loginCapability`) would produce, since the seeded cache already has
    // it. Only a merge that actually overlays the echo's other fields would
    // flip `auth.status` from the seeded "unauthenticated" to the echo's
    // "authenticated" - proving the echo is authoritative for what it models,
    // not merely inert here.
    expect(copilot?.auth.status).toBe("authenticated");
  });

  it("invalidates both harness catalogs for the awaiting host on a successful login - a sign-in can flip `available`", async () => {
    const { queryClient, wrapper } = makeWrapper();
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    queryClient.setQueryData(listKey, seededProvidersList());
    const guiKey = hostQueryKeys.method<
      HostRpcRegistry,
      "agent.gui.listHarnesses"
    >(HOST_ID, "agent.gui.listHarnesses", {});
    const tuiKey = hostQueryKeys.method<
      HostRpcRegistry,
      "agent.tui.listHarnesses"
    >(HOST_ID, "agent.tui.listHarnesses", {});
    queryClient.setQueryData(guiKey, { harnesses: [] });
    queryClient.setQueryData(tuiKey, { harnesses: [] });
    mocks.requestWithResponseTimeout.mockResolvedValue({
      state: v21Echo({}),
      existingProfileId: null,
      codeRejected: false,
    });

    const { result } = renderHook(() => useProvidersAwaitLogin(), { wrapper });
    act(() => {
      result.current.mutate({ providerId: "copilot", profileId: null });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryState(guiKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(tuiKey)?.isInvalidated).toBe(true);
  });
});

// The echo is pinned to `providerMutationCliStateSchemaV21`, whose field set
// is the hand-frozen `providerCliStateBaseShapeV40` - strictly narrower than
// the live `providers.list` row, and a login is exactly when the rest of that
// row moves too (the profile list gains the new account, its ambient identity
// resolves). So the overlay in the suite above cannot be the last word;
// invalidating `providers.list` here is not belt-and-braces on top of it, it
// is the only way those fields are ever refreshed after a login completes.
describe("useProvidersAwaitLogin providers.list invalidation", () => {
  beforeEach(() => {
    mocks.tabHostId.mockReturnValue(HOST_ID);
  });
  afterEach(() => {
    cleanup();
    mocks.requestWithResponseTimeout.mockReset();
    mocks.tabHostId.mockReset();
  });

  it("invalidates the awaiting host's providers.list entry after a successful login", async () => {
    const { queryClient, wrapper } = makeWrapper();
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    queryClient.setQueryData(listKey, seededProvidersList());
    mocks.requestWithResponseTimeout.mockResolvedValue({
      state: v21Echo({}),
      existingProfileId: null,
      codeRejected: false,
    });

    const { result } = renderHook(() => useProvidersAwaitLogin(), { wrapper });
    act(() => {
      result.current.mutate({ providerId: "copilot", profileId: null });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  it("leaves a different host's providers.list entry untouched", async () => {
    const { queryClient, wrapper } = makeWrapper();
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    const otherListKey = hostQueryKeys.method<
      HostRpcRegistry,
      "providers.list"
    >(OTHER_HOST_ID, "providers.list", { native: null });
    queryClient.setQueryData(listKey, seededProvidersList());
    queryClient.setQueryData(otherListKey, seededProvidersList());
    mocks.requestWithResponseTimeout.mockResolvedValue({
      state: v21Echo({}),
      existingProfileId: null,
      codeRejected: false,
    });

    const { result } = renderHook(() => useProvidersAwaitLogin(), { wrapper });
    act(() => {
      result.current.mutate({ providerId: "copilot", profileId: null });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherListKey)?.isInvalidated).toBe(false);
  });

  it("invalidates nothing when the echo carries a null state", async () => {
    const { queryClient, wrapper } = makeWrapper();
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    queryClient.setQueryData(listKey, seededProvidersList());
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mocks.requestWithResponseTimeout.mockResolvedValue({
      state: null,
      existingProfileId: null,
      codeRejected: false,
    });

    const { result } = renderHook(() => useProvidersAwaitLogin(), { wrapper });
    act(() => {
      result.current.mutate({ providerId: "copilot", profileId: null });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("writes and invalidates nothing when the cached host id is null", async () => {
    mocks.tabHostId.mockReturnValue(null);
    const { queryClient, wrapper } = makeWrapper();
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    queryClient.setQueryData(listKey, seededProvidersList());
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const setQueryDataSpy = vi.spyOn(queryClient, "setQueryData");
    mocks.requestWithResponseTimeout.mockResolvedValue({
      state: v21Echo({}),
      existingProfileId: null,
      codeRejected: false,
    });

    const { result } = renderHook(() => useProvidersAwaitLogin(), { wrapper });
    act(() => {
      result.current.mutate({ providerId: "copilot", profileId: null });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(setQueryDataSpy).not.toHaveBeenCalled();
  });
});
