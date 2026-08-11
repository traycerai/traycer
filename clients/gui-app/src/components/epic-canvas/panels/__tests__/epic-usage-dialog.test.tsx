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

  it("switching to 'Entire epic' issues a new request with window: epic", async () => {
    const user = userEvent.setup();
    const handler = vi.fn(
      (_request: UsageSummaryRequest): UsageSummaryResponse =>
        usageSummaryResponse(),
    );
    renderDialog(handler);
    await screen.findByTestId("usage-cost-figure");
    // The default window must NOT already be scoping to the epic lifetime,
    // or the assertion below would pass on a repeat of the first request.
    expect(handler.mock.calls.at(0)?.at(0)).toMatchObject({
      window: undefined,
      epicId: "epic-1",
    });
    handler.mockClear();

    await user.click(screen.getByTestId("epic-usage-window-epic"));

    await waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
    expect(handler.mock.calls.at(-1)?.at(0)).toMatchObject({
      window: "epic",
      epicId: "epic-1",
    });
  });

  it("bounds the trend for a long-lived epic, and says so rather than capping silently", async () => {
    // `window: "epic"` resolves `windowDays` from the epic's own fact span,
    // so a near-epoch `occurredAt` (a valid non-negative integer on the
    // wire) asks for ~20k columns - each a tooltip-wrapped button.
    renderDialog(() => {
      const response = usageSummaryResponse();
      return {
        ...response,
        summary: {
          ...response.summary,
          window: { ...response.summary.window, windowDays: 20_000 },
        },
      };
    });

    await screen.findByTestId("usage-cost-figure");
    await waitFor(() => {
      expect(screen.getByTestId("usage-daily-chart")).toBeTruthy();
    });
    expect(screen.getAllByTestId("usage-daily-chart-column")).toHaveLength(90);
    expect(
      screen.getByTestId("epic-usage-trend-capped-note").textContent,
    ).toContain("Trend shows the last 90 days");
  });

  it("leaves an in-range trend uncapped and unannotated", async () => {
    renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");
    await waitFor(() => {
      expect(screen.getByTestId("usage-daily-chart")).toBeTruthy();
    });
    expect(screen.getAllByTestId("usage-daily-chart-column")).toHaveLength(30);
    expect(screen.queryByTestId("epic-usage-trend-capped-note")).toBeNull();
  });

  it("renders a retryable error card, never a silent fallback, when the RPC fails", async () => {
    renderDialog(() => {
      throw new Error("boom");
    });
    expect(await screen.findByTestId("usage-error-card")).toBeTruthy();
    expect(screen.queryByTestId("usage-cost-figure")).toBeNull();
  });
});
