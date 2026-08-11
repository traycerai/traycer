import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageTurnDrilldown } from "@/components/usage-analytics/usage-turn-drilldown";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

afterEach(cleanup);

type UsageTurnRow = NonNullable<
  UsageSummaryResponse["summary"]["turnRows"]
>[number];

function row(overrides: Partial<UsageTurnRow>): UsageTurnRow {
  return {
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
    costUsd: 1.23,
    costProvenance: "providerReported",
    cacheSavingsUsd: null,
    toolCallCount: 0,
    toolCallErrorCount: 0,
    ...overrides,
  };
}

describe("UsageTurnDrilldown", () => {
  it("renders every turn's model, tokens, and cost", () => {
    render(<UsageTurnDrilldown rows={[row({})]} truncated={false} />);
    expect(screen.getByText("claude-sonnet-5")).not.toBeNull();
    expect(screen.getByText("150")).not.toBeNull();
    expect(screen.getByText("$1.23")).not.toBeNull();
  });

  it("renders an em dash for an unpriced turn - never $0.00", () => {
    render(
      <UsageTurnDrilldown
        rows={[row({ costUsd: null, costProvenance: "unpriced" })]}
        truncated={false}
      />,
    );
    expect(screen.getByText("—")).not.toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("labels every outcome", () => {
    render(
      <UsageTurnDrilldown
        rows={[
          row({ factId: "a", outcome: "completed" }),
          row({ factId: "b", outcome: "stopped" }),
          row({ factId: "c", outcome: "interrupted" }),
          row({ factId: "d", outcome: "abnormal_exit" }),
        ]}
        truncated={false}
      />,
    );
    expect(screen.getByText("Completed")).not.toBeNull();
    expect(screen.getByText("Stopped")).not.toBeNull();
    expect(screen.getByText("Interrupted")).not.toBeNull();
    expect(screen.getByText("Abnormal exit")).not.toBeNull();
  });

  it("surfaces the truncation flag as a note, only when truncated", () => {
    const { rerender } = render(
      <UsageTurnDrilldown rows={[row({})]} truncated={false} />,
    );
    expect(
      screen.queryByTestId("usage-turn-drilldown-truncated-note"),
    ).toBeNull();

    rerender(<UsageTurnDrilldown rows={[row({})]} truncated />);
    expect(
      screen.getByTestId("usage-turn-drilldown-truncated-note"),
    ).not.toBeNull();
  });

  it("shows an explicit empty state rather than a bare empty list", () => {
    render(<UsageTurnDrilldown rows={[]} truncated={false} />);
    expect(screen.getByTestId("usage-turn-drilldown-empty")).not.toBeNull();
  });
});
