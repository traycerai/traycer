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
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { EpicUsageDialog } from "@/components/epic-canvas/panels/epic-usage-dialog";
import type { UsageChartOption } from "@/lib/usage-analytics/usage-chart-option";
import { getEChartsMockInstances } from "../../../../../__tests__/test-browser-apis";

/**
 * How many per-day points the mounted trend chart was actually given -
 * read from the option the mocked ECharts instance received, the area
 * chart's equivalent of counting the old per-day bar columns.
 */
function chartDayCount(): number {
  const option = getEChartsMockInstances().at(-1)?.options.at(-1);
  if (option === undefined) throw new Error("no ECharts option captured");
  const { xAxis } = option as UsageChartOption;
  const axis = Array.isArray(xAxis) ? xAxis[0] : xAxis;
  const data = axis !== undefined && "data" in axis ? axis.data : undefined;
  if (!Array.isArray(data)) throw new Error("x-axis carries no day labels");
  return data.length;
}

/**
 * The mounted trend chart's series names, in the last captured ECharts
 * option's series order - reads the same "last mocked instance, last
 * captured option" seam as {@link chartDayCount}, so a `chartGroupBy` switch
 * (which remounts the chart via its `key` prop) is picked up by re-reading
 * the newest mock instance rather than the original one.
 */
function chartSeriesNames(): readonly string[] {
  const option = getEChartsMockInstances().at(-1)?.options.at(-1);
  if (option === undefined) throw new Error("no ECharts option captured");
  const { series } = option as UsageChartOption;
  if (series === undefined) return [];
  const list = Array.isArray(series) ? series : [series];
  return list.map((entry) =>
    typeof entry.name === "string" ? entry.name : "",
  );
}

type UsageSummaryRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;
type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicTreeNode: (id: string) => ({ title: `Chat ${id}` }),
}));

afterEach(() => {
  cleanup();
  mocks.openSettings.mockClear();
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
        // A real 30-day window whose last included day is the bucket's own
        // `2026-08-09` - `endAtExclusive` is the first instant OUTSIDE it,
        // which is what the chart's x-axis is anchored on.
        startAtInclusive: Date.parse("2026-07-11T00:00:00Z"),
        endAtExclusive: Date.parse("2026-08-10T00:00:00Z"),
      },
      epicId: "epic-1",
      chatId: null,
      totals: {
        factCount: 1,
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
        },
        knownCostUsd: 2.5,
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
          knownCostUsd: 2.5,
          knownCacheSavingsUsd: 0,
          knownReasoningTokens: 0,
          costProvenance: "providerReported",
        },
      ],
      chatBuckets: [
        {
          chatId: "chat-1",
          epicId: "epic-1",
          factCount: 1,
          tokens: {
            uncachedInputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 50,
          },
          knownCostUsd: 2.5,
          knownCacheSavingsUsd: 0,
          knownReasoningTokens: 0,
          costProvenance: "providerReported",
        },
      ],
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

/**
 * `usageSummaryResponse()` plus a second same-day bucket from a different
 * harness/model, so the chart has something to actually regroup: switching
 * `chartGroupBy` folds the same two buckets by a different key and the
 * series names must change with it. `totals.factCount` tracks the bucket
 * count rather than staying pinned at the base fixture's `1`.
 */
function usageSummaryResponseWithTwoBuckets(): UsageSummaryResponse {
  const base = usageSummaryResponse();
  const secondBucket = {
    day: "2026-08-09",
    harnessId: "codex",
    model: "gpt-5.6-sol",
    factCount: 1,
    tokens: {
      uncachedInputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
    },
    knownCostUsd: 2.5,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
  } satisfies UsageSummaryResponse["summary"]["buckets"][number];
  return {
    ...base,
    summary: {
      ...base.summary,
      totals: {
        ...base.summary.totals,
        factCount: 2,
        knownCostUsd: 5,
      },
      buckets: [...base.summary.buckets, secondBucket],
    },
  };
}

function renderDialog(
  handler: (request: UsageSummaryRequest) => UsageSummaryResponse,
): {
  readonly onOpenChange: Mock<(open: boolean) => void>;
} {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: { "host.usage.summary": handler },
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
  const onOpenChange = vi.fn();
  render(
    <EpicUsageDialog
      epicId="epic-1"
      client={client}
      open
      onOpenChange={onOpenChange}
    />,
    { wrapper },
  );
  return { onOpenChange };
}

describe("<EpicUsageDialog />", () => {
  it("defaults to the last 7 days", async () => {
    const handler = vi.fn(
      (_request: UsageSummaryRequest): UsageSummaryResponse =>
        usageSummaryResponse(),
    );
    renderDialog(handler);
    await screen.findByTestId("usage-cost-figure");

    expect(handler.mock.calls.at(0)?.at(0)).toMatchObject({
      windowDays: 7,
      window: undefined,
      epicId: "epic-1",
    });
    expect(
      screen.getByTestId("usage-window-7").getAttribute("data-state"),
    ).toBe("active");
  });

  it("renders the headline and the by-chat breakdown once open", async () => {
    renderDialog(usageSummaryResponse);
    const costFigure = await screen.findByTestId("usage-cost-figure");
    expect(within(costFigure).getByText("$2.50*")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("usage-chat-breakdown")).toBeTruthy();
    });
    expect(screen.getByText("Chat chat-1")).toBeTruthy();
  });

  it("closes and hands off to the Settings usage dashboard from 'View full usage'", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");

    await user.click(screen.getByTestId("epic-usage-view-full-dashboard"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.openSettings).toHaveBeenCalledWith({
      section: "usage",
      resetToGeneral: false,
    });
  });

  it("plots the requested response window", async () => {
    renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");
    await waitFor(() => {
      expect(screen.getByTestId("usage-daily-chart")).toBeTruthy();
    });
    expect(chartDayCount()).toBe(30);
  });

  it("groups the chart by harness by default, and by model after switching the toggle", async () => {
    const user = userEvent.setup();
    renderDialog(usageSummaryResponseWithTwoBuckets);
    await screen.findByTestId("usage-cost-figure");
    await waitFor(() => {
      expect(screen.getByTestId("usage-daily-chart")).toBeTruthy();
    });
    expect(chartSeriesNames()).toEqual(["claude", "codex"]);

    await user.click(screen.getByTestId("usage-chart-groupby-model"));

    await waitFor(() => {
      expect(chartSeriesNames()).toEqual(["claude-sonnet-5", "gpt-5.6-sol"]);
    });
  });

  it("does not render the group-by toggle when the window has no facts", async () => {
    renderDialog(() => {
      const base = usageSummaryResponse();
      return {
        ...base,
        summary: {
          ...base.summary,
          totals: { ...base.summary.totals, factCount: 0, knownCostUsd: 0 },
          buckets: [],
        },
      };
    });

    const costFigure = await screen.findByTestId("usage-cost-figure");
    expect(costFigure).toBeTruthy();
    expect(screen.queryByTestId("usage-chart-groupby-harness")).toBeNull();
    expect(screen.queryByTestId("usage-chart-groupby-model")).toBeNull();
  });

  it("renders a retryable error card, never a silent fallback, when the RPC fails", async () => {
    renderDialog(() => {
      throw new Error("boom");
    });
    expect(await screen.findByTestId("usage-error-card")).toBeTruthy();
    expect(screen.queryByTestId("usage-cost-figure")).toBeNull();
  });
});
