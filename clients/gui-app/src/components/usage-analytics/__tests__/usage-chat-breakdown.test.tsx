import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageChatBreakdown } from "@/components/usage-analytics/usage-chat-breakdown";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

afterEach(cleanup);

type UsageChatBucket = UsageSummaryResponse["summary"]["chatBuckets"][number];

const titlesById: Record<string, string> = {
  "chat-1": "Fix the flaky test",
  "chat-2": "Subagent: verify the fix",
};

vi.mock("@/lib/epic-selectors", () => ({
  useEpicTreeNode: (id: string) =>
    id in titlesById ? { title: titlesById[id] } : null,
}));

function bucket(overrides: Partial<UsageChatBucket>): UsageChatBucket {
  return {
    chatId: "chat-1",
    epicId: "epic-1",
    factCount: 2,
    tokens: {
      uncachedInputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
    },
    knownCostUsd: 1.5,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
    ...overrides,
  };
}

describe("UsageChatBreakdown", () => {
  it("joins each chat's title from the open epic's tree - including an A2A child chat, doubling as by-agent", () => {
    render(
      <UsageChatBreakdown
        rows={[
          bucket({ chatId: "chat-1", knownCostUsd: 3 }),
          bucket({ chatId: "chat-2", knownCostUsd: 1 }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Fix the flaky test"),
      expect.stringContaining("Subagent: verify the fix"),
    ]);
  });

  it("falls back to the raw chatId when the chat is not in the open tree (e.g. swept)", () => {
    render(<UsageChatBreakdown rows={[bucket({ chatId: "chat-unknown" })]} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("chat-unknown"),
    ]);
  });

  it("sorts rows by cost descending", () => {
    render(
      <UsageChatBreakdown
        rows={[
          bucket({ chatId: "chat-2", knownCostUsd: 1 }),
          bucket({ chatId: "chat-1", knownCostUsd: 5 }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Fix the flaky test"),
      expect.stringContaining("Subagent: verify the fix"),
    ]);
  });

  it("shows an explicit empty state rather than a bare empty list", () => {
    render(<UsageChatBreakdown rows={[]} />);
    expect(screen.getByTestId("usage-chat-breakdown-empty")).not.toBeNull();
  });
});
