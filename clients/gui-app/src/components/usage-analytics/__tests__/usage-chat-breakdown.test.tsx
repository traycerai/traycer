import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageChatBreakdown } from "@/components/usage-analytics/usage-chat-breakdown";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

afterEach(cleanup);

type UsageChatBucket = UsageSummaryResponse["summary"]["chatBuckets"][number];

const titlesById: Record<string, string | null> = {
  "chat-1": "Fix the flaky test",
  "chat-2": "Subagent: verify the fix",
  "chat-untitled": null,
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
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Fix the flaky test"),
      expect.stringContaining("Subagent: verify the fix"),
    ]);
  });

  it("uses a generic title when a chat is absent from the open tree", () => {
    render(<UsageChatBreakdown rows={[bucket({ chatId: "chat-unknown" })]} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Untitled chat"),
    ]);
    expect(rows[0].textContent).not.toContain("chat-unknown");
  });

  it("uses a generic title when the tree node has no title", () => {
    render(<UsageChatBreakdown rows={[bucket({ chatId: "chat-untitled" })]} />);
    const row = screen.getAllByRole("row")[1];
    expect(row.textContent).toContain("Untitled chat");
    expect(row.textContent).not.toContain("chat-untitled");
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
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Fix the flaky test"),
      expect.stringContaining("Subagent: verify the fix"),
    ]);
  });

  it("shows an explicit empty state rather than a bare empty table", () => {
    render(<UsageChatBreakdown rows={[]} />);
    expect(screen.getByTestId("usage-chat-breakdown-empty")).not.toBeNull();
  });

  it("renders as a real table with named columns", () => {
    render(<UsageChatBreakdown rows={[bucket({ chatId: "chat-1" })]} />);
    const table = screen.getByRole("table");
    expect(table.getAttribute("data-testid")).toBe("usage-chat-breakdown");
    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["Chat / agent", "Tokens", "Cost"]);
  });
});
