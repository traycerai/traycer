/**
 * DROP-IN REPLACEMENT for
 * hooks/rate-limits/__tests__/status-bar-rate-limit-lanes.test.tsx.
 *
 * Only change from the original: `useLaneProbe` takes an `editing` param
 * (default `false`, so both pre-existing calls are untouched) and a new
 * describe block at the end proves review w3 should-fix 11 ("showing hidden
 * providers for editing starts their live queries") stays fixed - entering
 * an editing session with a hidden `httpFetch` provider must NOT start its
 * polling query or its mount/queue targets, using the exact same real-stack
 * mock boundary (`MockHostMessenger`) the rest of this file already uses to
 * prove request suppression, not just option wiring.
 *
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
  resolveStatusBarProfileIds: () => [null],
}));

import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import {
  useStatusBarRateLimitSegments,
  useStatusBarWindowedProviders,
  type StatusBarRateLimitMode,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";

const PROFILE_SELECTION = {
  shownProfiles: {},
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
function useLaneProbe(mode: StatusBarRateLimitMode, editing: boolean) {
  const providers = useStatusBarWindowedProviders();
  return useStatusBarRateLimitSegments({
    providers,
    profileSelection: PROFILE_SELECTION,
    mode,
    editing,
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

    renderHook(() => useLaneProbe("live", false), {
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

  it("reads neither lane in passive mode, and hands back nothing that could pull one", async () => {
    const harness = createLaneHarness();
    harnessClient = harness.client;
    configuredProviders = [
      configuredProvider("codex", "ephemeralProcess"),
      configuredProvider("opencode", "httpFetch"),
    ];

    const wrapper = createQueryClientWrapper(harness.queryClient);
    const passive = renderHook(() => useLaneProbe("passive", false), {
      wrapper,
    });

    // An enabled observer fetches on mount, so give one every chance to: a
    // macrotask turn is more than the httpFetch batch needs below.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(harness.calledProviderIds).toEqual([]);

    // Not merely "renders no refresh button": a passive reader is handed no
    // handle it could pull with. `refetch` on a disabled query still fetches,
    // and a mount target is a queue enqueue waiting for a component to mount
    // it.
    expect(passive.result.current.mountTargets).toEqual([]);
    expect(passive.result.current.refresh.queueTargets).toEqual([]);
    expect(passive.result.current.refresh.httpRefetches).toEqual([]);
    expect(passive.result.current.refresh.httpFetching).toBe(false);

    // The same harness, the same providers, the same query keys - only the
    // mode changes, and now opencode is read. Without this the empty list
    // above would also pass for a harness that could never have been called.
    passive.unmount();
    renderHook(() => useLaneProbe("live", false), { wrapper });
    await waitFor(() =>
      expect(harness.calledProviderIds).toContain("opencode"),
    );
  });
});

describe("status bar rate-limit editor-only segments never fetch (review w3, should-fix 11)", () => {
  afterEach(() => {
    cleanup();
    harnessClient = null;
    configuredProviders = [];
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  });

  it("keeps a HIDDEN httpFetch provider from polling or enqueueing while entering an editing session, and reads it once unhidden", async () => {
    const harness = createLaneHarness();
    harnessClient = harness.client;
    configuredProviders = [configuredProvider("opencode", "httpFetch")];
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: {
          ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
          hiddenProviders: ["opencode"],
        },
      },
    });

    const wrapper = createQueryClientWrapper(harness.queryClient);
    // `editing: true` is exactly what a Customize session passes so the
    // hidden provider's ghost can still register a hotspot - the bug this
    // guards is that doing so used to also admit it into the fetch-eligible
    // batch.
    const editing = renderHook(() => useLaneProbe("live", true), { wrapper });

    // Give an enabled observer every chance to fire on mount.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(harness.calledProviderIds).toEqual([]);
    expect(editing.result.current.mountTargets).toEqual([]);
    expect(editing.result.current.refresh.queueTargets).toEqual([]);
    expect(editing.result.current.refresh.httpRefetches).toEqual([]);

    // Same harness, same provider, same query keys - only the deny-list
    // changes. This proves the empty list above is specifically the hidden
    // provider being suppressed, not "editing mode never fetches anything".
    editing.unmount();
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: {
          ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
          hiddenProviders: [],
        },
      },
    });
    renderHook(() => useLaneProbe("live", true), { wrapper });
    await waitFor(() =>
      expect(harness.calledProviderIds).toContain("opencode"),
    );
  });

  it("keeps a hidden ephemeralProcess provider's queue enqueue off while editing", async () => {
    const harness = createLaneHarness();
    harnessClient = harness.client;
    configuredProviders = [configuredProvider("codex", "ephemeralProcess")];
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: {
          ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
          hiddenProviders: ["codex"],
        },
      },
    });

    const editing = renderHook(() => useLaneProbe("live", true), {
      wrapper: createQueryClientWrapper(harness.queryClient),
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    // The queue lane is always passive-observed regardless of hidden state
    // (proven above), so the load-bearing new assertion here is the mount
    // hook: a hidden provider must not hand back a cold-start enqueue target
    // just because a Customize session wants to draw its ghost.
    expect(harness.calledProviderIds).toEqual([]);
    expect(editing.result.current.mountTargets).toEqual([]);
    expect(editing.result.current.refresh.queueTargets).toEqual([]);
  });
});
