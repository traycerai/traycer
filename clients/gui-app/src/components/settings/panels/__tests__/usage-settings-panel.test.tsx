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

function makeUsageSummaryResponse(): UsageSummaryResponse {
  return {
    servedBy: "cloud",
    summary: {
      window: {
        timezone: "UTC",
        windowDays: 30,
        startAtInclusive: 0,
        endAtExclusive: 1,
      },
      epicId: null,
      totals: {
        factCount: 2,
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
        },
        knownCostUsd: 4.5,
        costProvenance: "providerReported",
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
          costProvenance: "providerReported",
        },
      ],
      distinctEpicCount: 1,
      distinctChatCount: 1,
      outcomeBreakdown: {
        completed: 2,
        stopped: 0,
        interrupted: 0,
        abnormal_exit: 0,
      },
      usageCompletenessBreakdown: { measured: 2, partial: 0, absent: 0 },
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
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
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
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
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
    expect(within(costFigure).getByText("$4.50")).toBeTruthy();
    expect(screen.getByTestId("usage-daily-chart")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("usage-breakdown-table")).toBeTruthy();
    });
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.queryByTestId("usage-unsupported-notice")).toBeNull();
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
