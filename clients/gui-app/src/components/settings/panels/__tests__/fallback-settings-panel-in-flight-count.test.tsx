import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
  type ProvidersFallbackPolicySetRequest,
  type ProvidersFallbackPolicySetResponse,
} from "@traycer/protocol/host/fallback-policy";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";

/**
 * The polled `providers.fallbackPolicy.get` cache entry
 * (`useFallbackInFlightCountQuery`) versus the read-once one
 * (`useFallbackPolicyQuery`), driven end to end - a real `HostClient` over
 * `MockHostMessenger`, the real `QueryClient` production defaults, and the
 * real panel. `useFallbackPolicyQuery`, `useFallbackInFlightCountQuery` and
 * `useFallbackPolicySetMutation` are left UNMOCKED - the whole subject is
 * their interaction through the shared `QueryClient` and the RPC layer, which
 * a mocked hook cannot exercise. Everything the panel needs that is out of
 * scope here (harness/model catalog, providers list, tier-group preview,
 * reset/restore) is stubbed inert, the same way `fallback-settings-panel.test.tsx`
 * does for the same reason.
 *
 * No `<StrictMode>`, unlike the sibling `fallback-settings-panel*.test.tsx`
 * suites: the read-once cell below counts exact `dataUpdateCount`s, and
 * StrictMode's dev-only double-invocation is a variable those suites never
 * had to hold constant because none of them assert against a real
 * network-call count. The other
 * real-`HostClient` suites in this codebase
 * (`worktrees-listing-query.test.tsx`, `use-notification-indicators-query.test.tsx`)
 * make the same choice for the same reason.
 */

const hostClientRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));

function requireHostClient(): HostClient<HostRpcRegistry> {
  const client = hostClientRef.current;
  if (client === null) throw new Error("host client not created");
  return client;
}

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostClient: () => requireHostClient() };
});
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => requireHostClient() };
});

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const host = hostScopeOptionFixture({ hostId: "host-a", name: "Test Host" });
  return {
    useHostScope: () =>
      hostScopeFixture({
        hosts: [host],
        host,
        hostId: host.hostId,
        hostLabel: host.name,
        activeHost: host,
        isViewingActive: true,
        status: "following",
        client: null,
      }),
  };
});

vi.mock("@/hooks/providers/use-fallback-policy-reset-mutation", () => ({
  useFallbackPolicyResetMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock(
  "@/hooks/providers/use-fallback-policy-restore-tier-groups-mutation",
  () => ({
    useFallbackPolicyRestoreTierGroupsMutation: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  }),
);
vi.mock(
  "@/hooks/providers/use-fallback-policy-preview-tier-groups-query",
  () => ({
    useFallbackPolicyPreviewTierGroupsQuery: () => ({
      data: undefined,
      isFetching: false,
    }),
  }),
);
vi.mock(
  "@/components/settings/panels/fallback/fallback-effort-options",
  () => ({
    useFallbackEffortOptions: () => () => [],
  }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessModelsQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined }),
}));

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";

// Copied verbatim from `fallback-settings-panel.tsx`'s private
// `MASTER_TOGGLE_DESCRIPTION` - not exported, so restated here the same way
// the sibling suites restate other private production strings.
const MASTER_TOGGLE_DESCRIPTION =
  "Stops new Traycer recovery. Recovery already in progress continues; stop it from the chat. Your coding agent's own recovery settings are unchanged.";

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), enabled: true, ...overrides };
}

interface FallbackPolicyState {
  policy: FallbackPolicy;
  storedPolicyUnreadable: boolean;
  inFlightCount: number;
}

interface Fixture {
  readonly queryClient: QueryClient;
  readonly hostId: string;
  readonly getCallCount: () => number;
  readonly setCallCount: () => number;
  readonly currentPolicy: () => FallbackPolicy;
  readonly setPolicy: (next: FallbackPolicy) => void;
  readonly setInFlightCount: (next: number) => void;
}

function createFixture(initial: FallbackPolicyState): Fixture {
  const queryClient = createAppQueryClient();
  let state: FallbackPolicyState = { ...initial };
  let getCalls = 0;
  let setCalls = 0;
  let requestId = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestId += 1;
        return `req-${String(requestId)}`;
      },
      handlers: {
        "providers.fallbackPolicy.get":
          (): ProvidersFallbackPolicyGetResponse => {
            getCalls += 1;
            return {
              policy: state.policy,
              storedPolicyUnreadable: state.storedPolicyUnreadable,
              inFlightCount: state.inFlightCount,
            };
          },
        "providers.fallbackPolicy.set": (
          params: ProvidersFallbackPolicySetRequest,
        ): ProvidersFallbackPolicySetResponse => {
          setCalls += 1;
          state = {
            ...state,
            policy: params.policy,
            storedPolicyUnreadable: false,
          };
          return { policy: params.policy };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostClientRef.current = spine.createRequester(mockLocalHostEntry);
  return {
    queryClient,
    hostId: mockLocalHostEntry.hostId,
    getCallCount: () => getCalls,
    setCallCount: () => setCalls,
    currentPolicy: () => state.policy,
    setPolicy: (next) => {
      state = { ...state, policy: next };
    },
    setInFlightCount: (next) => {
      state = { ...state, inFlightCount: next };
    },
  };
}

function renderPanel(fixture: Fixture): RenderResult {
  const ui: ReactElement = (
    <QueryClientProvider client={fixture.queryClient}>
      <FallbackSettingsPanel />
    </QueryClientProvider>
  );
  return render(ui);
}

/** The switch's live description, read through `aria-describedby` rather
 * than a text query - the exact sentence, including the trailing clause. */
function masterToggleDescriptionText(): string {
  const toggle = screen.getByRole("switch", { name: "Automatic fallback" });
  const describedBy = toggle.getAttribute("aria-describedby");
  if (describedBy === null) {
    throw new Error("expected the master toggle to carry aria-describedby");
  }
  const description = document.getElementById(describedBy);
  if (description === null) {
    throw new Error("expected the description node to exist");
  }
  return description.textContent;
}

/** Radix's select: open with the keyboard - copied from
 * `fallback-settings-panel.test.tsx`'s own helpers. */
function openCombobox(name: string): void {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), {
    key: "ArrowDown",
  });
}

function policyEntryKey(hostId: string): readonly unknown[] {
  return hostQueryKeys.method<HostRpcRegistry, "providers.fallbackPolicy.get">(
    hostId,
    "providers.fallbackPolicy.get",
    {},
  );
}

function countEntryKey(hostId: string): readonly unknown[] {
  return [...policyEntryKey(hostId), "inFlightCount"];
}

function dataUpdateCountOf(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): number {
  return queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  hostClientRef.current = null;
});

describe("FallbackSettingsPanel - the polled in-flight count", () => {
  // REAL timers, deliberately, unlike the read-once describe below.
  // TanStack's `refetchInterval` for this entry re-arms its own
  // `setInterval` on every successful fetch (through `timeoutManager`'s
  // call-time wrapper around the global `setInterval`), and observed
  // empirically: under `vi.useFakeTimers()`, a
  // SECOND interval-driven refetch updates the cache correctly (confirmed via
  // `queryClient.getQueryState` and the query cache's own
  // `observerResultsUpdated` event) but the mounted `<FallbackSettingsPanel>`
  // does not repaint from it inside the same `act()` window - a
  // commit-timing gap specific to a REPEATED interval refetch under fake
  // timers, not a fact about production (the read-once describe below
  // proves the polling and caching side of this same mechanism directly,
  // under fake timers, with no such gap). `waitFor` polling on real
  // wall-clock time sidesteps it entirely.
  it("tracks the host while the page stays open, independent of the once-read policy", async () => {
    const fixture = createFixture({
      policy: policy({}),
      storedPolicyUnreadable: false,
      inFlightCount: 1,
    });
    renderPanel(fixture);

    await waitFor(() => {
      expect(masterToggleDescriptionText()).toBe(
        `${MASTER_TOGGLE_DESCRIPTION} 1 in progress right now.`,
      );
    });

    fixture.setInFlightCount(0);
    // Falsification: disable the table's poll entry, or drop `poll: true`
    // from `useFallbackInFlightCountQuery` - this never satisfies, since
    // nothing ever re-reads the count, and the assertion times out instead
    // of going red on a value - an ablation reads that timeout as the
    // falsifier firing.
    await waitFor(
      () => {
        expect(masterToggleDescriptionText()).toBe(MASTER_TOGGLE_DESCRIPTION);
      },
      { timeout: 8_000 },
    );
    expect(masterToggleDescriptionText()).not.toMatch(/in progress right now/);

    fixture.setInFlightCount(2);
    await waitFor(
      () => {
        expect(masterToggleDescriptionText()).toBe(
          `${MASTER_TOGGLE_DESCRIPTION} 2 in progress right now.`,
        );
      },
      { timeout: 8_000 },
    );
  }, 20_000);
});

describe("FallbackSettingsPanel - the policy read stays read-once while the count polls", () => {
  it("keeps the policy entry's dataUpdateCount at exactly 1 across >=3 poll intervals, while the count entry's grows, and a later host-side policy change never reaches the seeded control", async () => {
    vi.useFakeTimers();
    const fixture = createFixture({
      policy: policy({ graceWindowSeconds: 15 }),
      storedPolicyUnreadable: false,
      inFlightCount: 0,
    });
    renderPanel(fixture);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const policyKey = policyEntryKey(fixture.hostId);
    const countKey = countEntryKey(fixture.hostId);

    // Falsification: give `useFallbackPolicyQuery` `options: { poll: true }`
    // - this becomes 2, then 3, then 4 across the loop below instead of
    // staying at 1.
    expect(dataUpdateCountOf(fixture.queryClient, policyKey)).toBe(1);
    const countUpdatesAtMount = dataUpdateCountOf(
      fixture.queryClient,
      countKey,
    );
    expect(countUpdatesAtMount).toBeGreaterThanOrEqual(1);

    // The host's stored policy changes UNDERNEATH the page - a real edit made
    // somewhere else, seen here only as whatever the next GET would answer.
    fixture.setPolicy(policy({ graceWindowSeconds: 45 }));

    for (let interval = 0; interval < 3; interval += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }

    // The policy entry never refetched, so it never saw the change - still
    // exactly one fetch, ever.
    expect(dataUpdateCountOf(fixture.queryClient, policyKey)).toBe(1);
    // Falsification: the table's poll interval not firing on the count entry
    // (a count hook that shares the policy read's cache entry, or never opts
    // into polling) - this stays at `countUpdatesAtMount` instead of growing
    // by at least 3 more.
    expect(dataUpdateCountOf(fixture.queryClient, countKey)).toBeGreaterThan(
      countUpdatesAtMount + 2,
    );

    // The seeded control still shows the ORIGINAL value (15s) - the changed
    // one (45s) was never read back, because the policy read is read-once.
    openCombobox("Time to cancel before switching");
    expect(
      screen
        .getByRole("option", { name: "15 seconds" })
        .getAttribute("data-state"),
    ).toBe("checked");
  });
});

describe("FallbackSettingsPanel - a save keeps the polled count a NUMBER (control)", () => {
  // REAL timers, like the polled-count describe and for the same reason:
  // proving the panel tracks
  // a SECOND interval-driven refetch (the divergence step below) needs a
  // DOM read, and a DOM read of a repeated poll's result does not reliably
  // repaint inside one `act()` window under fake timers (see the polled-count
  // describe's comment).
  // `waitFor` on real wall-clock time sidesteps it.
  it("leaves the description reading the LIVE polled count after a real save, never [object Object] or the read-once value", async () => {
    const fixture = createFixture({
      policy: policy({}),
      storedPolicyUnreadable: false,
      // Seeded at 2 - the value the READ-ONCE policy query's mount fetch
      // sees. It is deliberately never fed back to that entry again, so
      // any assertion this value alone would satisfy proves nothing about
      // which source the panel is actually reading.
      inFlightCount: 2,
    });
    renderPanel(fixture);

    await waitFor(() => {
      expect(masterToggleDescriptionText()).toBe(
        `${MASTER_TOGGLE_DESCRIPTION} 2 in progress right now.`,
      );
    });

    // Diverge the two sources BEFORE the save: the host's count moves to
    // 5, and a poll interval lands. The read-once policy entry never sees
    // this - only `useFallbackInFlightCountQuery`'s own poll does. If the
    // panel were (silently) reading the read-once entry - directly, or via
    // a fallback the polled entry's shape no longer satisfies - this
    // assertion would still see 2, not 5.
    fixture.setInFlightCount(5);
    await waitFor(
      () => {
        expect(masterToggleDescriptionText()).toBe(
          `${MASTER_TOGGLE_DESCRIPTION} 5 in progress right now.`,
        );
      },
      { timeout: 8_000 },
    );

    // A REAL save through the UI: the master switch is the one
    // "immediate" control in this panel (no blur/Enter needed), and it
    // commits through `useFallbackPolicySetMutation` - unmocked in this
    // file - which is the exact write-through path (`setQueriesData` on
    // the method's SCOPE, reaching both cache entries, per
    // `use-fallback-in-flight-count-query`'s own doc comment) the
    // near-miss bug lived in.
    fireEvent.click(screen.getByRole("switch", { name: "Automatic fallback" }));
    await waitFor(() => {
      expect(fixture.setCallCount()).toBe(1);
    });

    // Falsification A: cache the count query's response as a bare number
    // via `mapResponse` instead of the whole
    // `ProvidersFallbackPolicyGetResponse` - the save's `setQueriesData`
    // updater (`{ ...previous, policy, storedPolicyUnreadable: false }`)
    // spreads a PRIMITIVE (no own enumerable properties), replacing the
    // number with `{ policy, storedPolicyUnreadable: false }` and no
    // `inFlightCount` field at all - the description would read
    // "[object Object] in progress right now." instead of this.
    // Falsification B: the panel reads `query.data.inFlightCount`
    // (the read-once entry) directly, or it reads
    // `inFlightCountQuery.data?.inFlightCount ?? query.data.inFlightCount`
    // and the polled entry now caches a bare number - `?.inFlightCount` on
    // a number is `undefined`, so `??` silently takes the read-once value
    // anyway. Either way the description reads "2 in progress right
    // now.", the STALE mount value, since 2 is the one number the
    // read-once entry ever saw. Diverging the two sources above is what
    // makes that distinguishable from this pin's expected 5.
    await waitFor(
      () => {
        expect(masterToggleDescriptionText()).toBe(
          `${MASTER_TOGGLE_DESCRIPTION} 5 in progress right now.`,
        );
      },
      { timeout: 8_000 },
    );
    expect(masterToggleDescriptionText()).not.toContain("[object Object]");

    const countKey = countEntryKey(fixture.hostId);
    const cached =
      fixture.queryClient.getQueryData<ProvidersFallbackPolicyGetResponse>(
        countKey,
      );
    if (cached === undefined) {
      throw new Error("expected a cached count entry");
    }
    expect(typeof cached.inFlightCount).toBe("number");
    expect(cached.inFlightCount).toBe(5);
  }, 20_000);
});
