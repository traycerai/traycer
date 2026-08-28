import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { UsageSettingsPanelForClient } from "@/components/settings/panels/usage-settings-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

const ZERO_PROVENANCE_SPLIT: UsageSummaryResponse["summary"]["totals"]["provenanceSplit"] =
  {
    providerReported: { costUsd: 0, factCount: 0, tokenCount: 0 },
    modelPriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
    unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  };

function makeUsageSummaryResponse(): UsageSummaryResponse {
  return {
    servedBy: "cloud",
    summary: {
      window: {
        timezone: "UTC",
        windowDays: 30,
        // A real 30-day window whose last included day is 2026-08-09.
        // `endAtExclusive` is the first instant OUTSIDE it - local midnight
        // tomorrow - which is what the x-axis and range label anchor on.
        startAtInclusive: Date.parse("2026-07-11T00:00:00Z"),
        endAtExclusive: Date.parse("2026-08-10T00:00:00Z"),
      },
      epicId: null,
      chatId: null,
      totals: {
        factCount: 2,
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
        },
        knownCostUsd: 4.5,
        knownCacheSavingsUsd: 0,
        knownReasoningTokens: 0,
        costProvenance: "providerReported",
        provenanceSplit: ZERO_PROVENANCE_SPLIT,
      },
      buckets: [
        {
          day: "2026-08-01",
          harnessId: "claude",
          model: "claude-sonnet-5",
          factCount: 2,
          tokens: {
            uncachedInputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 50,
          },
          knownCostUsd: 4.5,
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
        completed: 2,
        stopped: 0,
        interrupted: 0,
        abnormal_exit: 0,
      },
      usageCompletenessBreakdown: { measured: 2, partial: 0, absent: 0 },
      turnRows: null,
      turnRowsTruncated: false,
    },
    coverage: {
      pricedFactCount: 2,
      unpricedFactCount: 0,
      pricedTokenCount: 150,
      unpricedTokenCount: 0,
    },
  };
}

function renderPanel(usageSummary: UsageSummaryResponse | undefined): {
  readonly client: HostClient<HostRpcRegistry>;
} {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "host.usage.summary": () => {
          if (usageSummary === undefined) {
            throw new Error("host.usage.summary not configured for this test");
          }
          return usageSummary;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  render(<UsageSettingsPanelForClient client={client} />, { wrapper });
  return { client };
}

describe("<UsageSettingsPanel />", () => {
  it("hides the surface entirely - renders the capability notice, never the panel body - on a host that hasn't negotiated host.usage.summary", () => {
    // No `recordNegotiatedHostMethods` call: the negotiated-manifest registry
    // fails closed to "unknown", which this hook collapses to "unsupported".
    renderPanel(makeUsageSummaryResponse());
    expect(screen.getByTestId("usage-unsupported-notice")).toBeTruthy();
    expect(screen.queryByTestId("usage-cost-figure")).toBeNull();
  });

  it("renders the real data path end to end once the host negotiates the method", async () => {
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
      "host.usage.summary",
    ]);
    renderPanel(makeUsageSummaryResponse());

    const costFigure = await screen.findByTestId("usage-cost-figure");
    expect(within(costFigure).getByText("$4.50*")).toBeTruthy();
    expect(screen.getByTestId("usage-daily-chart")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("usage-breakdown-table")).toBeTruthy();
    });
    expect(
      within(screen.getByTestId("usage-breakdown-table")).getByText("claude"),
    ).toBeTruthy();
    expect(screen.queryByTestId("usage-unsupported-notice")).toBeNull();

    // Ticket 11 dashboard build-out: per-harness split and stat tiles render
    // off the same summary. Fixup-01: no standing cost-quality panel.
    expect(screen.getByTestId("usage-harness-split")).toBeTruthy();
    expect(screen.getByTestId("usage-harness-split-row-claude")).toBeTruthy();
    expect(screen.getByTestId("usage-stat-tiles")).toBeTruthy();
    expect(screen.queryByTestId("usage-cost-quality-panel")).toBeNull();
    // Anchored on the RESPONSE's own window, not on a mount-time clock -
    // this panel outlives a local midnight, and a later refetch would
    // otherwise render new-day buckets against a stale axis.
    expect(screen.getByTestId("usage-date-range-label").textContent).toBe(
      "Jul 11 – Aug 9, 2026",
    );
  });

  it("renders a retryable error card, never a silent fallback, when the RPC fails", async () => {
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
      "host.usage.summary",
    ]);
    renderPanel(undefined);

    expect(await screen.findByTestId("usage-error-card")).toBeTruthy();
    expect(screen.getByTestId("usage-error-retry")).toBeTruthy();
    expect(screen.queryByTestId("usage-cost-figure")).toBeNull();
  });
});
