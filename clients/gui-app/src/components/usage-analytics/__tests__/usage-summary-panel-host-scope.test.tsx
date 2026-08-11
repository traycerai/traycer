import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageSummaryPanel } from "@/components/usage-analytics/usage-summary-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;
type UsageSummaryRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;
type HostBucket = UsageSummaryResponse["summary"]["hostBuckets"][number];

afterEach(cleanup);

const ZERO_PROVENANCE_SPLIT: UsageSummaryResponse["summary"]["totals"]["provenanceSplit"] =
  {
    providerReported: { costUsd: 0, factCount: 0, tokenCount: 0 },
    modelPriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
    unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  };

function hostBucket(hostId: string, knownCostUsd: number): HostBucket {
  return {
    hostId,
    factCount: 1,
    tokens: {
      uncachedInputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
    },
    knownCostUsd,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
  };
}

function response(input: {
  readonly servedBy: UsageSummaryResponse["servedBy"];
  readonly hostBuckets: readonly HostBucket[];
}): UsageSummaryResponse {
  return {
    servedBy: input.servedBy,
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
        factCount: input.hostBuckets.length,
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
        },
        knownCostUsd: input.hostBuckets.reduce(
          (sum, bucket) => sum + bucket.knownCostUsd,
          0,
        ),
        knownCacheSavingsUsd: 0,
        knownReasoningTokens: 0,
        costProvenance: "providerReported",
        provenanceSplit: ZERO_PROVENANCE_SPLIT,
      },
      buckets: [],
      chatBuckets: [],
      hostBuckets: [...input.hostBuckets],
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

function renderPanel(input: {
  /** A function receives the request, so a test can answer a FILTERED query differently. */
  readonly response:
    | UsageSummaryResponse
    | ((request: UsageSummaryRequest) => UsageSummaryResponse);
  readonly hostNames: ReadonlyMap<string, string>;
}): { readonly requests: UsageSummaryRequest[] } {
  const requests: UsageSummaryRequest[] = [];
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "host.usage.summary": (params) => {
          requests.push(params);
          return typeof input.response === "function"
            ? input.response(params)
            : input.response;
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
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  render(
    <UsageSummaryPanel
      client={client}
      hostNames={input.hostNames}
      currentHostId={mockLocalHostEntry.hostId}
    />,
    { wrapper },
  );
  return { requests };
}

describe("<UsageSummaryPanel /> host scope", () => {
  it("defaults to All hosts - the request carries no host filter at all", async () => {
    const { requests } = renderPanel({
      response: response({
        servedBy: "cloud",
        hostBuckets: [hostBucket("host-a", 3), hostBucket("host-b", 1)],
      }),
      hostNames: new Map([["host-a", "Studio Mac"]]),
    });

    await screen.findByTestId("usage-host-split");
    // ONE dashboard with a filter, not a per-host surface: the unfiltered
    // read is the default, so an account's total is what a reader sees first.
    expect(requests[0].hostId).toBeUndefined();
    expect(screen.getByTestId("usage-host-filter")).toBeTruthy();
    expect(screen.queryByTestId("usage-host-filter-pinned")).toBeNull();
  });

  it("names known hosts and falls back to a truncated id for the rest, never a blank", async () => {
    renderPanel({
      response: response({
        servedBy: "cloud",
        hostBuckets: [
          hostBucket("host-a", 3),
          hostBucket("01JX7Q2M9K4B8Z6T5N3P1V0WYD", 1),
        ],
      }),
      hostNames: new Map([["host-a", "Studio Mac"]]),
    });

    const split = await screen.findByTestId("usage-host-split");
    expect(within(split).getByText("Studio Mac")).toBeTruthy();
    expect(within(split).getByText("01JX7Q2M…")).toBeTruthy();
    const fallbackRow = screen.getByTestId(
      "usage-host-split-row-01JX7Q2M9K4B8Z6T5N3P1V0WYD",
    );
    expect(fallbackRow.textContent).toContain("01JX7Q2M…");
  });

  it("omits the by-host section when there is only one host to show", async () => {
    renderPanel({
      response: response({
        servedBy: "cloud",
        hostBuckets: [hostBucket("host-a", 3)],
      }),
      hostNames: new Map([["host-a", "Studio Mac"]]),
    });

    // A one-row "By host" list says nothing the filter did not already say.
    await screen.findByTestId("usage-cost-figure");
    expect(screen.queryByTestId("usage-host-split")).toBeNull();
  });

  it("pins the filter to this machine on the local plane, with copy instead of a dead dropdown", async () => {
    renderPanel({
      response: response({
        servedBy: "local",
        hostBuckets: [hostBucket(mockLocalHostEntry.hostId, 3)],
      }),
      hostNames: new Map([[mockLocalHostEntry.hostId, "Studio Mac"]]),
    });

    // Not a disabled dropdown: there is nothing to choose BETWEEN, because
    // that plane can only ever see the machine it runs on.
    const pinned = await screen.findByTestId("usage-host-filter-pinned");
    expect(pinned.textContent).toContain("Studio Mac");
    expect(screen.queryByTestId("usage-host-filter")).toBeNull();
    // And the headline still states the plane's own scope.
    expect(screen.getByTestId("usage-served-by-local-note")).toBeTruthy();
  });

  it("leaves the headline unqualified for an unfiltered cloud read", async () => {
    renderPanel({
      response: response({
        servedBy: "cloud",
        hostBuckets: [hostBucket("host-a", 3), hostBucket("host-b", 1)],
      }),
      hostNames: new Map(),
    });

    await screen.findByTestId("usage-cost-figure");
    // The account-wide total is exactly what the reader expects here, so a
    // scope note would be noise - the qualifier appears only once the read
    // is narrowed.
    expect(screen.queryByTestId("usage-served-by-local-note")).toBeNull();
  });

  it("keeps every discovered host in the picker after narrowing to one", async () => {
    // The shared aggregator filters facts by `hostId` BEFORE grouping, so a
    // filtered response's `hostBuckets` names only the selected host. With an
    // empty directory - hosts that have usage but the client cannot name -
    // rebuilding the options from the current response alone left no way to
    // move from one such host straight to another.
    const user = userEvent.setup();
    const { requests } = renderPanel({
      response: (request) =>
        response({
          servedBy: "cloud",
          hostBuckets:
            request.hostId === undefined || request.hostId === null
              ? [hostBucket("host-a", 3), hostBucket("host-b", 1)]
              : [hostBucket(request.hostId, 3)],
        }),
      hostNames: new Map(),
    });

    await screen.findByTestId("usage-cost-figure");
    await user.click(screen.getByTestId("usage-host-filter"));
    await user.click(
      await screen.findByTestId("usage-host-filter-option-host-a"),
    );

    await waitFor(() => {
      expect(screen.getByTestId("usage-host-filter").textContent).not.toContain(
        "All hosts",
      );
      // The picker updating locally is not enough - the follow-up request
      // must actually carry the narrowed host filter.
      expect(requests.at(-1)).toMatchObject({ hostId: "host-a" });
    });

    await user.click(screen.getByTestId("usage-host-filter"));
    // host-b is absent from THIS response's buckets and from the directory -
    // it survives only because the unfiltered response was remembered.
    expect(
      await screen.findByTestId("usage-host-filter-option-host-b"),
    ).toBeTruthy();
  });
});
