/**
 * End-to-end proof of the load-bearing property `useStatusBarRateLimitSegments`
 * exists to guarantee: an `ephemeralProcess` provider (codex, claude-code)
 * NEVER gets read by this hook's own observer, no matter how the batches split.
 * A codex read spawns a real CLI subprocess, and the serial queue is the only
 * thing allowed to own that spawn - `use-status-bar-rate-limit-segments.ts`'s
 * own doc comment names this exact failure mode (`options: null` defaulting
 * `enabled` to `true` and calling the host directly).
 *
 * Runs the REAL TanStack query stack (production `QueryClient` config, a real
 * `HostClient` over a `MockHostMessenger`) rather than a mocked
 * `useHostQueriesWithResponseMap` - a mock can only prove the hook PASSED the
 * right `options`; only the real stack proves those options actually suppress
 * the fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { createQueryClientWrapper } from "@/lib/rate-limits/__tests__/provider-rate-limit-sharing-harness";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

// Filled in by each test before render; read lazily inside the `@/lib/host`
// mock closure below, so the mock module never needs its own state.
let harnessClient: HostRequester<
  typeof import("@/lib/host").hostRpcRegistry
> | null = null;
let configuredProviders: ReadonlyArray<ConfiguredRateLimitProvider> = [];

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => harnessClient,
  };
});

vi.mock(
  "@/hooks/rate-limits/use-configured-rate-limit-providers",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-configured-rate-limit-providers")
      >();
    return {
      ...actual,
      useConfiguredRateLimitProviders: () => configuredProviders,
      useVisibleRateLimitProviders: () => configuredProviders,
    };
  },
);

vi.mock("@/hooks/rate-limits/use-rate-limit-profile-selection", () => ({
  resolveRateLimitProfileId: () => null,
}));

import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import {
  useStatusBarRateLimitSegments,
  useStatusBarWindowedProviders,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";

const PROFILE_SELECTION = {
  activeChatSettings: null,
  lastProfileByHarness: {},
};

interface LaneHarness {
  readonly queryClient: QueryClient;
  readonly client: HostRequester<HostRpcRegistry>;
  // The request schema types `providerId` as the FULL `ProviderId` union
  // (optional at that) - narrower application-level convention (only
  // rate-limit-capable providers are ever asked) is not encoded on the wire.
  readonly calledProviderIds: Array<ProviderId | undefined>;
}

// Modeled on `provider-rate-limit-sharing-harness.tsx`'s `HostClient` +
// `MockHostMessenger` wiring, but this handler RECORDS every provider id it is
// asked to read rather than gating a single call. `providerRateLimits: null`
// is enough - these tests are about which providers get READ, not what they
// read back.
function createLaneHarness(): LaneHarness {
  const queryClient = createAppQueryClient();
  const calledProviderIds: Array<ProviderId | undefined> = [];
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "lane-req-1",
      handlers: {
        "host.getRateLimitUsage": (params) => {
          calledProviderIds.push(params.providerId);
          return {
            totalTokens: 0,
            remainingTokens: 0,
            providerRateLimits: null,
          };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return {
    queryClient,
    client: spine.createRequester(mockLocalHostEntry),
    calledProviderIds,
  };
}

function configuredProvider(
  providerId: RateLimitProviderId,
  lane: "ephemeralProcess" | "httpFetch",
): ConfiguredRateLimitProvider {
  return {
    providerId,
    lane,
    profiles: [],
    fetchEligibility: { ambient: true, managedProfiles: true },
  };
}

// Mirrors what `StatusBarRateLimitCluster` actually does: resolve the
// windowed-provider list, then feed it into the segments hook. Exercising
// both together (rather than hand-building the `providers` array) is what
// makes this an end-to-end proof of the real composition, not just of the
// segments hook in isolation.
function useLaneProbe() {
  const providers = useStatusBarWindowedProviders();
  return useStatusBarRateLimitSegments({
    providers,
    profileSelection: PROFILE_SELECTION,
  });
}

describe("status bar rate-limit lane isolation (real query stack)", () => {
  afterEach(() => {
    cleanup();
    harnessClient = null;
    configuredProviders = [];
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  });

  it("reads the eligible httpFetch provider but never spawns a read for the ephemeralProcess provider beside it", async () => {
    const harness = createLaneHarness();
    harnessClient = harness.client;
    configuredProviders = [
      configuredProvider("codex", "ephemeralProcess"),
      configuredProvider("opencode", "httpFetch"),
    ];

    renderHook(() => useLaneProbe(), {
      wrapper: createQueryClientWrapper(harness.queryClient),
    });

    // The httpFetch batch is `enabled: true` and settles on its own; wait for
    // it rather than a fixed delay.
    await waitFor(() =>
      expect(harness.calledProviderIds).toContain("opencode"),
    );

    // The regression this whole design exists to prevent: codex's batch is
    // ephemeralProcess, so its observer is `enabled: false` no matter how
    // fetch-eligible the target is - a codex read spawns a CLI subprocess, and
    // only the serial queue (never this observer) may trigger one.
    expect(harness.calledProviderIds).not.toContain("codex");
  });
});
