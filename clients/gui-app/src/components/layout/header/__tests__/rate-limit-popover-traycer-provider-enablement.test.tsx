import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * `useTraycerSubscription` gates the synthetic Traycer rail entry on a
 * `providers.list` row's `enabled` flag. This file runs the real
 * `useProvidersList` hook against a fake host-RPC boundary (`HostClient` +
 * `MockHostMessenger`, as `use-providers-list-query.test.tsx` uses for the
 * hook alone) with one `QueryClient` for the whole test, so the popover's
 * live query subscription - not a remount or a swapped `QueryClient` - is
 * what drives the tab appearing and disappearing.
 *
 * Every other host-RPC hook the popover tree touches stays stubbed, as in
 * `rate-limit-popover.test.tsx`; the two files need opposite treatment of
 * `@/lib/host` and `use-providers-list-query`, so the stubs are duplicated
 * here rather than shared.
 */

function traycerProviderFixture(enabled: boolean): ProviderCliState {
  return {
    providerId: "traycer",
    enabled,
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
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

function authUserFixture(): AuthenticatedUser {
  const epoch = new Date(0);
  return {
    user: {
      id: "u1",
      name: "Ada",
      providerId: "p1",
      providerHandle: "ada",
      providerType: "GITHUB",
      email: "ada@example.com",
      avatarUrl: null,
      activatedAt: epoch,
      createdAt: epoch,
      updatedAt: epoch,
      lastSeenAt: epoch,
      privacyMode: false,
      isLearningEnabled: true,
    },
    userSubscription: {
      id: "sub",
      userID: "u1",
      orgID: null,
      teamID: null,
      customerId: "cus",
      createdAt: epoch,
      updatedAt: epoch,
      subscriptionExpiry: null,
      trialEndsAt: null,
      hasPaymentMethod: true,
      rechargeRateSeconds: 60,
      subscriptionStatus: "PRO_V3",
      isInTrial: false,
      totalPlanCredits: 100,
      credit: {
        id: "c1",
        userId: "u1",
        customerId: "cus",
        bonusCredits: 0,
        consumedFromPlan: 30,
        consumedFromBonus: 0,
        lastResetAt: epoch,
      },
    },
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: [],
    environments: { personal: null, teams: [] },
    actingAs: null,
  };
}

/**
 * Only this mutable placeholder lives in `vi.hoisted`: Vitest hoists that
 * call (and every `vi.mock` factory below) above this file's own imports, so
 * a hoisted callback cannot call an imported constructor yet. The real
 * `HostClient` is built further down, as an ordinary top-level statement
 * that runs after imports resolve, and fills `client` in place; the
 * `@/lib/host` mock below only reads it lazily, when the popover renders.
 */
const providersFixtureState = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  providers: [] as ProviderCliState[],
}));

const mocks = vi.hoisted(() => ({
  authUser: {
    data: null as AuthenticatedUser | null,
    isPending: false,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: vi.fn(() => Promise.resolve({})),
  },
}));

// `@/hooks/providers/use-providers-list-query` is deliberately left unmocked.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (providersFixtureState.client === null) {
        throw new Error("providers fixture not initialized yet");
      }
      return providersFixtureState.client;
    },
  };
});
vi.mock("@/hooks/rate-limits/use-configured-rate-limit-providers", () => ({
  useConfiguredRateLimitProviders: () => [],
  useVisibleRateLimitProviders: () => [],
}));
vi.mock("@/hooks/rate-limits/use-status-bar-rate-limit-segments", () => ({
  useStatusBarRateLimitSegments: () => ({
    cluster: { kind: "hidden" },
    mountTargets: [],
    refresh: {
      ephemeralTargets: [],
      ephemeralFetching: false,
      httpRefetches: [],
      httpFetching: false,
    },
  }),
}));
vi.mock("@/hooks/host/use-host-provider-rate-limits-query", () => ({
  useHostProviderRateLimitsQuery: () => ({
    data: undefined,
    isPending: true,
    isFetching: false,
    isError: false,
    dataUpdatedAt: 0,
    refetch: () => Promise.resolve({}),
  }),
}));
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: { requests: ReadonlyArray<unknown> }) =>
    args.requests.map(() => ({
      data: undefined,
      isPending: true,
      isFetching: false,
      isError: false,
      dataUpdatedAt: 0,
      refetch: () => Promise.resolve({}),
    })),
  useHostQueriesWithResponseMap: (args: { requests: ReadonlyArray<unknown> }) =>
    args.requests.map(() => ({
      data: undefined,
      isPending: true,
      isFetching: false,
      isError: false,
      dataUpdatedAt: 0,
      refetch: () => Promise.resolve({}),
    })),
}));
vi.mock(
  "@/hooks/providers/use-providers-refresh-profile-status-mutation",
  () => ({
    useProvidersRefreshProfileStatusForClient: () => ({
      isPending: false,
      mutateAsync: () => Promise.resolve(),
    }),
  }),
);
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));
vi.mock("@/hooks/rate-limits/use-provider-rate-limit-fetch-scope", () => ({
  useProviderRateLimitFetchScope: () => ({ hostId: "host-1" }),
}));
vi.mock(
  "@/hooks/providers/use-consume-rate-limit-reset-credit-mutation",
  () => ({
    useConsumeRateLimitResetCreditMutation: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
  }),
);
vi.mock("@/lib/rate-limits/provider-rate-limit-fetch", () => ({
  fetchProviderRateLimits: () => Promise.resolve(),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
  useSystemOverlayActive: () => false,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouterState: (args: {
      select: (state: { location: { pathname: string } }) => unknown;
    }) => args.select({ location: { pathname: "/" } }),
  };
});
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/host-scope/use-host-scope")
      >();
    return { ...actual, useHostScope: () => ({ host: null }) };
  },
);
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => mocks.authUser,
}));
vi.mock("@/hooks/host/use-host-rate-limit-usage-query", () => ({
  useHostRateLimitUsageQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/host/use-refresh-rate-limit-usage-on-traycer-turn", () => ({
  useRefreshRateLimitUsageOnTraycerTurn: () => {},
}));

import { RateLimitPopover } from "@/components/layout/header/rate-limit-popover";

/** Only `providers.list` has a handler - the only method this popover's
 * real query (`useTraycerSubscription`'s `useProvidersList`) calls. */
function buildProvidersFixture() {
  const queryClient = createAppQueryClient();
  let requestSeq = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq += 1;
        return `req-${String(requestSeq)}`;
      },
      handlers: {
        "providers.list": () => ({
          providers: [...providersFixtureState.providers],
          native: null,
        }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  providersFixtureState.client = spine.createRequester(mockLocalHostEntry);
  return {
    queryClient,
    setProviders: (next: ReadonlyArray<ProviderCliState>) => {
      providersFixtureState.providers = [...next];
    },
  };
}

const providersFixture = buildProvidersFixture();

const SINGLE_HOST_SCOPE = hostScopeFixture({});
const PROFILE_SELECTION = { shownProfiles: {}, lastProfileByHarness: {} };

function renderTraycerPopover() {
  return render(
    <QueryClientProvider client={providersFixture.queryClient}>
      <TooltipProvider>
        <Popover open>
          <PopoverTrigger>trigger</PopoverTrigger>
          <RateLimitPopover
            side="bottom"
            align="end"
            onClose={() => {}}
            profileSelection={PROFILE_SELECTION}
            scope={SINGLE_HOST_SCOPE}
            hasExplicitPick={false}
          />
        </Popover>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The live `providers.list` query backing `useTraycerSubscription`. */
function providersListQuery() {
  return providersFixture.queryClient
    .getQueryCache()
    .getAll()
    .find((entry) => entry.queryKey.includes("providers.list"));
}

async function settleProvidersListOn(enabled: boolean): Promise<void> {
  providersFixture.setProviders([traycerProviderFixture(enabled)]);
  await act(async () => {
    await providersFixture.queryClient.invalidateQueries();
  });
  await waitFor(() => {
    const query = providersListQuery();
    expect(query?.state.status).toBe("success");
    expect(query?.state.data).toMatchObject({
      providers: [{ providerId: "traycer", enabled }],
    });
  });
}

describe("<RateLimitPopover /> Traycer provider enablement (integrated)", () => {
  beforeEach(() => {
    providersFixture.setProviders([traycerProviderFixture(false)]);
    providersFixture.queryClient.clear();
    mocks.authUser = {
      data: authUserFixture(),
      isPending: false,
      isError: false,
      isFetching: false,
      dataUpdatedAt: Date.now() - 60_000,
      refetch: vi.fn(() => Promise.resolve({})),
    };
    useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
    useRateLimitPopoverStore.setState({
      activeTab: "overview",
      size: null,
      revealProfile: null,
    });
    useRateLimitPopoverStore.persist.clearStorage();
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows and hides the Traycer tab as providers.list toggles it, on one open panel", async () => {
    renderTraycerPopover();

    await settleProvidersListOn(false);
    expect(
      screen.getByText("Connect a supported provider to see usage here."),
    ).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Traycer Inference" })).toBeNull();

    await settleProvidersListOn(true);
    expect(screen.getByRole("tab", { name: "Traycer Inference" })).toBeTruthy();
    expect(
      screen.queryByText("Connect a supported provider to see usage here."),
    ).toBeNull();

    await settleProvidersListOn(false);
    expect(
      screen.getByText("Connect a supported provider to see usage here."),
    ).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Traycer Inference" })).toBeNull();
  });
});
