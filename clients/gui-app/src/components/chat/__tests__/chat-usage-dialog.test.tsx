import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { ChatUsageDialog } from "@/components/chat/chat-usage-dialog";
import { useChatUsageDialogStore } from "@/stores/chats/chat-usage-dialog-store";

type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;

const usageSummaryCallCount = { current: 0 };

const liveHostClient = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: { invalidateHostScope: () => undefined },
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
    handlers: {
      "host.usage.summary": () => {
        usageSummaryCallCount.current += 1;
        return handlerHolder.current();
      },
    },
  }),
});
liveHostClient.bind(mockLocalHostEntry);
liveHostClient.setRequestContext(
  createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => liveHostClient,
}));

const handlerHolder: { current: () => UsageSummaryResponse } = {
  current: () => usageSummaryResponse(),
};

afterEach(() => {
  cleanup();
  act(() => {
    useChatUsageDialogStore.getState().close();
  });
  handlerHolder.current = () => usageSummaryResponse();
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
        windowDays: 12,
        startAtInclusive: 0,
        endAtExclusive: 1,
      },
      epicId: "epic-1",
      chatId: "chat-1",
      totals: {
        factCount: 1,
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
        },
        knownCostUsd: 0.42,
        knownCacheSavingsUsd: 0,
        knownReasoningTokens: 0,
        costProvenance: "providerReported",
        provenanceSplit: ZERO_PROVENANCE_SPLIT,
      },
      buckets: [],
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
      turnRows: [
        {
          factId: "fact-1",
          occurredAt: Date.UTC(2026, 7, 9, 14, 30),
          harnessId: "claude",
          model: "claude-sonnet-5",
          outcome: "completed",
          usageCompleteness: "measured",
          tokens: {
            uncachedInputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 50,
          },
          reasoningTokens: null,
          costUsd: 0.42,
          costProvenance: "providerReported",
          cacheSavingsUsd: null,
          toolCallCount: 2,
          toolCallErrorCount: 0,
        },
      ],
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

function renderWithClient(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  render(<ChatUsageDialog />, { wrapper });
}

describe("<ChatUsageDialog />", () => {
  it("renders nothing while the store target is null - cost is on-demand", async () => {
    usageSummaryCallCount.current = 0;
    renderWithClient();
    expect(screen.queryByTestId("chat-usage-dialog")).toBeNull();
    // "On-demand" is about the REQUEST, not just the markup: this dialog is
    // mounted for the whole session, so an ungated query here would price
    // every chat in the background. `enabled` is what has to hold.
    await act(async () => {
      await Promise.resolve();
    });
    expect(usageSummaryCallCount.current).toBe(0);

    act(() => {
      useChatUsageDialogStore.getState().open({
        hostId: mockLocalHostEntry.hostId,
        chatId: "chat-1",
        chatTitle: "Fix the flaky test",
      });
    });
    await screen.findByTestId("usage-cost-figure");
    expect(usageSummaryCallCount.current).toBeGreaterThan(0);
  });

  it("opens on a store target and renders the chat's headline + title", async () => {
    renderWithClient();
    act(() => {
      useChatUsageDialogStore.getState().open({
        hostId: mockLocalHostEntry.hostId,
        chatId: "chat-1",
        chatTitle: "Fix the flaky test",
      });
    });

    expect(await screen.findByText("Usage — Fix the flaky test")).toBeTruthy();
    const costFigure = await screen.findByTestId("usage-cost-figure");
    expect(costFigure.textContent).toContain("$0.42");
  });

  it("expands to the per-turn drill-down on click, honoring the truncation flag", async () => {
    const user = userEvent.setup();
    renderWithClient();
    act(() => {
      useChatUsageDialogStore.getState().open({
        hostId: mockLocalHostEntry.hostId,
        chatId: "chat-1",
        chatTitle: "Fix the flaky test",
      });
    });
    await screen.findByTestId("usage-cost-figure");

    expect(screen.queryByTestId("usage-turn-drilldown")).toBeNull();
    await user.click(screen.getByTestId("chat-usage-drilldown-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("usage-turn-drilldown")).toBeTruthy();
    });
    expect(screen.getByText("claude-sonnet-5")).toBeTruthy();
  });

  it("closing via the dialog's own close control clears the store target", async () => {
    const user = userEvent.setup();
    renderWithClient();
    act(() => {
      useChatUsageDialogStore.getState().open({
        hostId: mockLocalHostEntry.hostId,
        chatId: "chat-1",
        chatTitle: "Fix the flaky test",
      });
    });
    await screen.findByTestId("usage-cost-figure");

    await user.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() => {
      expect(useChatUsageDialogStore.getState().target).toBeNull();
    });
  });
});
