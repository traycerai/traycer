/**
 * Proves the G6 review-A fix at the one level `rate-limit-icon.test.tsx`
 * cannot reach: that file mocks `useStatusBarRateLimitSegments` at the
 * boundary, so it can only prove a trigger ASKS for `mode: "live"` - not that
 * asking for it actually starts a fetch. This file runs the real hook over a
 * real `HostClient` + `MockHostMessenger`, the same real-stack pattern
 * `status-bar-rate-limit-lanes.test.tsx` uses, but mounts the actual
 * `RateLimitIconButton form="glyph"` instead of calling the hook directly -
 * the phone header's exact tree, with no footer in it to fetch on the
 * glyph's behalf.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

let harnessClient: HostRequester<
  typeof import("@/lib/host").hostRpcRegistry
> | null = null;
let configuredProviders: ReadonlyArray<ConfiguredRateLimitProvider> = [];

const AMBIENT_BINDING_STUB = { stub: "ambient-binding" };

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => harnessClient,
    HostRuntimeContext: {
      Provider: (props: { readonly children: unknown }) => props.children,
    },
    useHostBinding: () => AMBIENT_BINDING_STUB,
  };
});

vi.mock("@/hooks/rate-limits/use-rate-limit-host-scope", () => ({
  useRateLimitResolveHostScope: () => ({
    scope: hostScopeFixture({}),
    hasExplicitPick: false,
  }),
}));

vi.mock(
  "@/hooks/rate-limits/use-rate-limit-profile-selection",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-rate-limit-profile-selection")
      >();
    return {
      ...actual,
      useRateLimitProfileSelection: () => ({
        shownProfiles: {},
        lastProfileByHarness: {},
      }),
    };
  },
);

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

vi.mock("@/components/layout/header/rate-limit-popover", async () => {
  const { PopoverContent } = await import("@/components/ui/popover");
  return {
    RateLimitPopover: (_props: { readonly onClose: () => void }) => (
      <PopoverContent data-testid="rate-limit-popover" />
    ),
  };
});

import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { RateLimitIconButton } from "@/components/layout/header/rate-limit-icon";

interface FetchHarness {
  readonly queryClient: QueryClient;
  readonly client: HostRequester<HostRpcRegistry>;
  readonly calledProviderIds: Array<ProviderId | undefined>;
}

// Byte-identical wiring to `status-bar-rate-limit-lanes.test.tsx`'s
// `createLaneHarness` - same registry, same mock messenger shape - so a
// divergence here can only be about the COMPONENT under test, not the harness.
function createFetchHarness(): FetchHarness {
  const queryClient = createAppQueryClient();
  const calledProviderIds: Array<ProviderId | undefined> = [];
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "glyph-fetch-req-1",
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
  providerId: ConfiguredRateLimitProvider["providerId"],
  lane: "ephemeralProcess" | "httpFetch",
): ConfiguredRateLimitProvider {
  return {
    providerId,
    lane,
    profiles: [],
    fetchEligibility: { ambient: true, managedProfiles: true },
  };
}

function renderGlyph(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RateLimitIconButton form="glyph" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  harnessClient = null;
  configuredProviders = [];
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

describe('<RateLimitIconButton form="glyph" /> fetches its own httpFetch provider (G6 review A)', () => {
  it("calls host.getRateLimitUsage for a configured, selected httpFetch provider on mount, with no footer and the popover closed", async () => {
    const harness = createFetchHarness();
    harnessClient = harness.client;
    configuredProviders = [configuredProvider("opencode", "httpFetch")];

    renderGlyph(harness.queryClient);

    // The glyph form draws no footer and nothing else in this tree can call
    // the host - the fetch below can only be the glyph's own `mode: "live"`.
    await waitFor(() =>
      expect(harness.calledProviderIds).toContain("opencode"),
    );
  });
});
