import { cleanup, render, screen } from "@testing-library/react";
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
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { EpicCostBadge } from "@/components/epic-canvas/panels/epic-cost-badge";

type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;

const clientHolder: { current: HostClient<HostRpcRegistry> | null } = {
  current: null,
};

// `vi.mock` calls are hoisted above every import in this file, so the plain
// static import of `EpicCostBadge` below already sees these stubs.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => clientHolder.current };
});
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mockLocalHostEntry.hostId,
}));

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  clientHolder.current = null;
});

function emptyUsageSummaryResponse(): UsageSummaryResponse {
  return {
    servedBy: "cloud",
    summary: {
      window: {
        timezone: "UTC",
        windowDays: 30,
        startAtInclusive: 0,
        endAtExclusive: 1,
      },
      epicId: "epic-1",
      totals: {
        factCount: 0,
        tokens: {
          uncachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
        },
        knownCostUsd: 0,
        costProvenance: null,
      },
      buckets: [],
      distinctEpicCount: 0,
      distinctChatCount: 0,
      outcomeBreakdown: {
        completed: 0,
        stopped: 0,
        interrupted: 0,
        abnormal_exit: 0,
      },
      usageCompletenessBreakdown: { measured: 0, partial: 0, absent: 0 },
    },
    coverage: {
      pricedFactCount: 0,
      unpricedFactCount: 0,
      pricedTokenCount: 0,
      unpricedTokenCount: 0,
    },
  };
}

function nonZeroUsageSummaryResponse(): UsageSummaryResponse {
  const empty = emptyUsageSummaryResponse();
  return {
    ...empty,
    summary: {
      ...empty.summary,
      totals: {
        ...empty.summary.totals,
        factCount: 1,
        knownCostUsd: 2.5,
        costProvenance: "providerReported",
      },
    },
    coverage: { ...empty.coverage, pricedFactCount: 1 },
  };
}

function renderBadge(response: UsageSummaryResponse): void {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: { "host.usage.summary": () => response },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  clientHolder.current = client;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  render(<EpicCostBadge epicId="epic-1" />, { wrapper });
}

describe("<EpicCostBadge />", () => {
  it("renders nothing on a host that hasn't negotiated host.usage.summary", () => {
    renderBadge(nonZeroUsageSummaryResponse());
    expect(screen.queryByTestId("epic-cost-badge")).toBeNull();
  });

  it("renders nothing for an epic with no usage yet - not a bare $0.00", async () => {
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
      "host.usage.summary",
    ]);
    renderBadge(emptyUsageSummaryResponse());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("epic-cost-badge")).toBeNull();
  });

  it("renders the cost figure once supported and priced", async () => {
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
      "host.usage.summary",
    ]);
    renderBadge(nonZeroUsageSummaryResponse());
    expect((await screen.findByTestId("epic-cost-badge")).textContent).toBe(
      "$2.50",
    );
  });
});
