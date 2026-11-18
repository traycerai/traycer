/**
 * The reader's watched-host binding, proven against a REAL query cache
 * instead of a mocked `useStatusBarRateLimitSegments` / `useHostClient()`.
 *
 * Every other suite in this directory mocks the segments hook (or the
 * reader's own dependencies) at the module boundary, which is right for what
 * those suites are about but cannot prove the one thing this file is for:
 * that `ProviderLimitWindowsReader`'s `useScopedHostBinding` re-provide
 * actually changes which host's CACHE ENTRIES `useProviderLimitWindows`
 * reads - not just which `hostId` string a mock was handed. Two hosts, two
 * different warm `host.getRateLimitUsage` / `providers.list` cache entries,
 * one real `QueryClient`, one real `HostClient` per host built through
 * `createRequester` exactly as `useScopedHostBinding` does in production
 * (`{...realBinding, hostClient: scope.client, hostId: scope.hostId}`).
 *
 * Mocked: only the host-runtime transport seam (`@/providers/host-runtime-provider`,
 * the same substitution `window-host-client-resolution.test.tsx` uses so this
 * suite does not have to stand up a live WebSocket) and `useWatchHostScope`
 * (there is no host PICKER under test, only what its answer does downstream).
 * Everything from `useScopedHostBinding` through `useHostClient()`,
 * `useHostQueriesWithResponseMap`, `useProvidersList`, and the real
 * `queryKeys.hostMethod` builder runs for real.
 */
import { createContext, use, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import {
  buildProviderRateLimitEnvelope,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import type { AvailableProviderRateLimits } from "@/lib/rate-limits/rate-limit-envelope";

/** Same substitution `window-host-client-resolution.test.tsx` uses: the real
 * `@/providers/host-runtime-provider` dials a live transport at module scope,
 * so the SEAM is swapped for a controllable spine/binding instead. */
interface ProbeBinding {
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
}

const spineRef = vi.hoisted<{ value: HostClient<HostRpcRegistry> | null }>(
  () => ({ value: null }),
);
const bindingRef = vi.hoisted<{ value: ProbeBinding | null }>(() => ({
  value: null,
}));

function getSpine(): HostClient<HostRpcRegistry> {
  if (spineRef.value === null) throw new Error("test spine not configured");
  return spineRef.value;
}

vi.mock("@/providers/host-runtime-provider", () => {
  const context = createContext<ProbeBinding | null>(null);
  return {
    createHostRuntimeState: () => ({
      context: createContext(null),
      bindingSnapshot: { value: null },
    }),
    createHostRuntime: () => ({
      HostRuntimeProvider: () => null,
      HostRuntimeContext: context,
      useHostClient: getSpine,
      useHostDirectory: () => null,
      useAuthService: () => null,
      useHostBinding: () => use(context) ?? bindingRef.value,
      getBindingSnapshot: () => null,
    }),
  };
});

const watchScope = vi.hoisted<{ value: HostScope }>(() => ({
  // Overwritten in every test before render; this default is never read.
  value: {} as HostScope,
}));
vi.mock("@/hooks/host-scope/use-watch-host-scope", () => ({
  useWatchHostScope: () => ({
    scope: watchScope.value,
    hasExplicitPick: true,
  }),
}));

import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { ProviderLimitWindowsReader } from "@/components/layout-editor/inspector/provider-limit-windows";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

const HOST_A: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-a",
  websocketUrl: "ws://127.0.0.1:59001/stream",
};
const HOST_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59002/stream",
};
const DIRECTORY = [HOST_A, HOST_B];

const PROVIDER: RateLimitProviderId = "claude-code";

function ambientProfile(): ProviderProfile {
  return {
    profileId: "ambient",
    enabled: true,
    kind: "ambient",
    authType: "oauth",
    label: "Terminal",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function providerCliState(): ProviderCliState {
  return {
    providerId: PROVIDER,
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
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
    profiles: [ambientProfile()],
  };
}

function claudeRateLimits(usedPercent: number): AvailableProviderRateLimits {
  return {
    provider: "claude-code",
    available: true,
    subscriptionType: null,
    fiveHour: { usedPercent, resetsAt: null, durationMinutes: 300 },
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    modelScoped: [],
    extraUsage: null,
  };
}

/**
 * Seeds one host's ambient `host.getRateLimitUsage` cache entry directly -
 * the exact key `queryKeys.hostMethod` builds in production, and the exact
 * shape (`ProviderRateLimitEnvelope`) `mapResponseToProviderRateLimitEnvelope`
 * would have written from a real fetch.
 *
 * `host.getRateLimitUsage` is read PASSIVELY here (`enabled: false`,
 * `poll: false`) - it never gets a polling observer, so seeding it directly
 * is safe at any time, unlike `providers.list` below.
 */
function seedUsage(
  queryClient: QueryClient,
  hostId: string,
  usedPercent: number,
): void {
  const { method, params } = providerRateLimitQueryOptions(
    PROVIDER,
    null,
    true,
  );
  const envelope: ProviderRateLimitEnvelope = buildProviderRateLimitEnvelope(
    undefined,
    {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: claudeRateLimits(usedPercent),
    },
    Date.now(),
  );
  queryClient.setQueryData(
    queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
      hostId,
      method,
      params,
    ),
    envelope,
  );
}

function buildSpine(): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(getQueryClient()),
    findHostById: (hostId) =>
      DIRECTORY.find((entry) => entry.hostId === hostId) ?? null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        // `providers.list` is a REAL, enabled, polling observer
        // (`useVisibleRateLimitProviders` -> `useProvidersList`) - it fetches
        // on mount regardless of which host it targets, so it needs an actual
        // handler rather than a pre-seeded cache entry. The catalog is the
        // same provider on both hosts here; only each host's OWN
        // `host.getRateLimitUsage` reading (seeded separately, per host)
        // differs, which is what this suite is actually proving.
        "providers.list": () => ({
          providers: [providerCliState()],
          native: null,
        }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine;
}

function scopeFor(
  entry: HostDirectoryEntry,
  spine: HostClient<HostRpcRegistry>,
): HostScope {
  return hostScopeFixture({
    host: hostScopeOptionFixture({ hostId: entry.hostId }),
    hostId: entry.hostId,
    status: "ready",
    client: spine.createRequester(entry),
  });
}

const queryClientRef: { value: QueryClient | null } = { value: null };

function getQueryClient(): QueryClient {
  if (queryClientRef.value === null)
    throw new Error("test query client not configured");
  return queryClientRef.value;
}

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={getQueryClient()}>
      {props.children}
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  spineRef.value = null;
  bindingRef.value = null;
  queryClientRef.value = null;
});

describe("ProviderLimitWindowsReader watches ONE host's real cache (no mocked segment hook)", () => {
  it("draws the WATCHED host's own warm reading, never the other host's", async () => {
    const queryClient = createAppQueryClient();
    queryClientRef.value = queryClient;
    // Both hosts' passive usage readings are warm before anything mounts -
    // there is no fetch to race here (see `seedUsage`'s own doc comment).
    seedUsage(queryClient, HOST_A.hostId, 12);
    seedUsage(queryClient, HOST_B.hostId, 88);
    const spine = buildSpine();
    spineRef.value = spine;
    bindingRef.value = { hostClient: spine, hostId: null };
    watchScope.value = scopeFor(HOST_A, spine);

    const seen: Array<ReadonlyArray<number>> = [];
    function Tree(): ReactNode {
      return (
        <Wrapper>
          <ProviderLimitWindowsReader providerId={PROVIDER}>
            {(limits) => {
              seen.push(limits.windows.map((window) => window.usedPercent));
              return null;
            }}
          </ProviderLimitWindowsReader>
        </Wrapper>
      );
    }

    const { rerender } = render(<Tree />);
    // `providers.list` is a real fetch (see `buildSpine`'s handler), so the
    // provider catalog - and with it, the windowed-provider read this
    // suite is actually about - lands asynchronously.
    await waitFor(() => expect(seen.at(-1)).toEqual([12]));

    // Same tree, watched host moved to B: a genuine per-host scope re-reads
    // host B's own cache slot rather than replaying host A's answer (a stale
    // closure over the first-resolved client) or merging the two.
    watchScope.value = scopeFor(HOST_B, spine);
    rerender(<Tree />);
    await waitFor(() => expect(seen.at(-1)).toEqual([88]));
  });
});
