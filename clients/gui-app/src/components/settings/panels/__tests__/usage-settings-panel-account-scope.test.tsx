import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { UsageSettingsPanel } from "@/components/settings/panels/usage-settings-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;

const ACTIVE_HOST_ID = mockLocalHostEntry.hostId;
/** The host the sidebar's Host-group picker is pointed at - dead, and unrelated to this section. */
const DEAD_PICKED_HOST_ID = "host-that-vanished";

const liveHostClientSpine = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: { invalidateHostScope: () => undefined },
  findHostById: (hostId) =>
    hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: { "host.usage.summary": () => usageSummaryResponse() },
  }),
});
liveHostClientSpine.setRequestContext(
  createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
);
const liveHostClient = liveHostClientSpine.createRequester(mockLocalHostEntry);

// The Host-group pick is unreachable, so the scope carries NO client and a
// non-`following` status - exactly the shape `HostScopeGate` used to refuse to
// render behind. This section must not consult any of it for transport.
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => ({
    hosts: [
      { hostId: ACTIVE_HOST_ID, name: "This machine" },
      { hostId: DEAD_PICKED_HOST_ID, name: "Old laptop" },
    ],
    host: null,
    hostId: DEAD_PICKED_HOST_ID,
    hostLabel: "Old laptop",
    vanishedHostId: DEAD_PICKED_HOST_ID,
    activeHostId: ACTIVE_HOST_ID,
    activeHost: { hostId: ACTIVE_HOST_ID, name: "This machine" },
    isViewingActive: false,
    status: "vanished",
    client: null,
    isLoading: false,
    listsFailed: false,
  }),
}));

const activeHostIdHolder: { current: string | null } = {
  current: ACTIVE_HOST_ID,
};

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => activeHostIdHolder.current,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => liveHostClient };
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  activeHostIdHolder.current = ACTIVE_HOST_ID;
});

const ZERO_PROVENANCE_SPLIT: UsageSummaryResponse["summary"]["totals"]["provenanceSplit"] =
  {
    providerReported: { costUsd: 0, factCount: 0, tokenCount: 0 },
    modelPriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
    unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  };

function usageSummaryResponse(): UsageSummaryResponse {
  return {
    servedBy: "cloud",
    summary: {
      window: {
        timezone: "UTC",
        windowDays: 30,
        startAtInclusive: Date.parse("2026-07-11T00:00:00Z"),
        endAtExclusive: Date.parse("2026-08-10T00:00:00Z"),
      },
      epicId: null,
      chatId: null,
      totals: {
        factCount: 1,
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
        },
        knownCostUsd: 7.25,
        knownCacheSavingsUsd: 0,
        knownReasoningTokens: 0,
        costProvenance: "providerReported",
        provenanceSplit: ZERO_PROVENANCE_SPLIT,
      },
      buckets: [
        {
          day: "2026-08-09",
          harnessId: "claude",
          model: "claude-sonnet-5",
          factCount: 1,
          tokens: {
            uncachedInputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 50,
          },
          knownCostUsd: 7.25,
          knownCacheSavingsUsd: 0,
          knownReasoningTokens: 0,
          costProvenance: "providerReported",
        },
      ],
      chatBuckets: [],
      hostBuckets: [],
      distinctEpicCount: 1,
      distinctChatCount: 1,
      outcomeBreakdown: {
        completed: 1,
        stopped: 0,
        interrupted: 0,
        abnormal_exit: 0,
      },
      usageCompletenessBreakdown: { measured: 1, partial: 0, absent: 0 },
      turnRows: null,
      turnRowsTruncated: false,
    },
    coverage: {
      pricedFactCount: 1,
      unpricedFactCount: 0,
      pricedTokenCount: 150,
      unpricedTokenCount: 0,
    },
  };
}

function renderPanel(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  render(<UsageSettingsPanel />, { wrapper });
}

describe("<UsageSettingsPanel /> account-group scoping", () => {
  it("reads through the active host even when the sidebar's host pick is dead", async () => {
    // Ticket 13 moved this section from the Host group to Account, but it kept
    // resolving transport and gating through the Host-group picker's REMEMBERED
    // scope. Picking a host that had gone away therefore hid an account-level
    // dashboard whose own default is "All hosts", behind a notice about a host
    // it never needed.
    recordNegotiatedHostMethods(ACTIVE_HOST_ID, ["host.usage.summary"]);
    renderPanel();

    const costFigure = await screen.findByTestId("usage-cost-figure");
    expect(costFigure.textContent).toContain("$7.25");
    await waitFor(() => {
      expect(screen.getByTestId("usage-daily-chart")).toBeTruthy();
    });
    // None of the host-scope refusals may appear on an Account section.
    expect(screen.queryByTestId("host-scope-vanished")).toBeNull();
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(screen.queryByTestId("host-scope-connecting")).toBeNull();
    expect(screen.queryByTestId("usage-unsupported-notice")).toBeNull();
  });

  it("reports capability against the active host, not the picked one", async () => {
    // The dead pick advertising the method must not enable the section, and -
    // more importantly - its silence must not disable it either.
    recordNegotiatedHostMethods(DEAD_PICKED_HOST_ID, ["host.usage.summary"]);
    renderPanel();

    expect(await screen.findByTestId("usage-support-pending")).toBeTruthy();
    expect(screen.queryByTestId("usage-cost-figure")).toBeNull();
  });

  it("gives a terminal answer with no active host, rather than spinning forever", async () => {
    // With no active host there is nothing to hand shake with, so the support
    // signal stays `null` permanently - the pending branch could never
    // resolve. This section is reachable for any scope, so a fresh install
    // reaches exactly this state.
    activeHostIdHolder.current = null;
    renderPanel();

    expect(await screen.findByTestId("usage-no-host-notice")).toBeTruthy();
    expect(screen.queryByTestId("usage-support-pending")).toBeNull();
    expect(screen.queryByTestId("usage-cost-figure")).toBeNull();
  });

  it("says the host is too old only once it has actually answered without the method", async () => {
    recordNegotiatedHostMethods(ACTIVE_HOST_ID, ["epic.list"]);
    renderPanel();

    const notice = await screen.findByTestId("usage-unsupported-notice");
    // Named from the ACTIVE host, since that is the one that fell short.
    expect(notice.textContent).toContain("This machine");
    expect(screen.queryByTestId("usage-support-pending")).toBeNull();
  });
});
