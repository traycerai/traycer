import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageChatBreakdown } from "@/components/usage-analytics/usage-chat-breakdown";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import {
  __getOpenEpicRegistryForTests,
  EpicSessionContext,
} from "@/lib/registries/epic-session-registry";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { TreeNode } from "@/stores/epics/open-epic/types";

const handles: OpenedStoreForTest[] = [];

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
  for (const handle of handles) handle.dispose();
  handles.length = 0;
});

type UsageChatBucket = UsageSummaryResponse["summary"]["chatBuckets"][number];

const treeTitles: Record<string, string> = {
  "chat-1": "Fix the flaky test",
  "chat-2": "Subagent: verify the fix",
  "chat-untitled": "",
};

/** A real open-epic store whose tree holds {@link treeTitles}, provided as the epic session. */
function withEpicSession(children: ReactNode): ReactNode {
  const handle = openStoreForTest({
    epicId: "epic-1",
    userId: null,
    factories: {
      streamClientFactory: () => ({
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => undefined,
      }),
      laneSelection: null,
    },
    writeCommand: null,
  });
  handles.push(handle);
  const nodeById: Record<string, TreeNode> = {};
  for (const [id, title] of Object.entries(treeTitles)) {
    nodeById[id] = {
      id,
      parentId: null,
      title,
      type: "chat",
      status: null,
      createdAt: 0,
      updatedAt: 0,
    };
  }
  handle.store.setState({
    tree: {
      rootIds: Object.keys(nodeById),
      childrenByParent: {},
      nodeById,
    },
  });
  return (
    <EpicSessionContext.Provider value={handle}>
      {children}
    </EpicSessionContext.Provider>
  );
}

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
      withEpicSession(
        <UsageChatBreakdown
          rows={[
            bucket({ chatId: "chat-1", knownCostUsd: 3 }),
            bucket({ chatId: "chat-2", knownCostUsd: 1 }),
          ]}
          chatTitles={null}
        />,
      ),
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Fix the flaky test"),
      expect.stringContaining("Subagent: verify the fix"),
    ]);
  });

  it("uses a generic title when a chat is absent from the open tree", () => {
    render(
      withEpicSession(
        <UsageChatBreakdown
          rows={[bucket({ chatId: "chat-unknown" })]}
          chatTitles={null}
        />,
      ),
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Untitled chat"),
    ]);
    expect(rows[0].textContent).not.toContain("chat-unknown");
  });

  it("uses a generic title when the tree node has no title", () => {
    render(
      withEpicSession(
        <UsageChatBreakdown
          rows={[bucket({ chatId: "chat-untitled" })]}
          chatTitles={null}
        />,
      ),
    );
    const row = screen.getAllByRole("row")[1];
    expect(row.textContent).toContain("Untitled chat");
    expect(row.textContent).not.toContain("chat-untitled");
  });

  it("sorts rows by cost descending", () => {
    render(
      withEpicSession(
        <UsageChatBreakdown
          rows={[
            bucket({ chatId: "chat-2", knownCostUsd: 1 }),
            bucket({ chatId: "chat-1", knownCostUsd: 5 }),
          ]}
          chatTitles={null}
        />,
      ),
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Fix the flaky test"),
      expect.stringContaining("Subagent: verify the fix"),
    ]);
  });

  it("shows an explicit empty state rather than a bare empty table", () => {
    render(<UsageChatBreakdown rows={[]} chatTitles={null} />);
    expect(screen.getByTestId("usage-chat-breakdown-empty")).not.toBeNull();
  });

  it("renders as a real table with named columns", () => {
    render(
      <UsageChatBreakdown
        rows={[bucket({ chatId: "chat-1" })]}
        chatTitles={null}
      />,
    );
    const table = screen.getByRole("table");
    expect(table.getAttribute("data-testid")).toBe("usage-chat-breakdown");
    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["Chat / agent", "Tokens", "Cost"]);
  });

  describe("outside an epic session (a bot's tab)", () => {
    it("renders without throwing and names chats from chatTitles, else a generic title", () => {
      render(
        <UsageChatBreakdown
          rows={[
            bucket({ chatId: "trunk-chat", knownCostUsd: 3 }),
            bucket({ chatId: "other-chat", knownCostUsd: 1 }),
          ]}
          chatTitles={new Map([["trunk-chat", "Tracy"]])}
        />,
      );
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("Tracy"),
        expect.stringContaining("Untitled chat"),
      ]);
    });
  });

  it("prefers the open epic's tree title over chatTitles", () => {
    render(
      withEpicSession(
        <UsageChatBreakdown
          rows={[
            bucket({ chatId: "chat-1", knownCostUsd: 3 }),
            bucket({ chatId: "chat-untitled", knownCostUsd: 2 }),
            bucket({ chatId: "chat-fallback", knownCostUsd: 1 }),
          ]}
          chatTitles={
            new Map([
              ["chat-1", "Ignored"],
              ["chat-untitled", "Ignored too"],
              ["chat-fallback", "From titles"],
            ])
          }
        />,
      ),
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Fix the flaky test"),
      expect.stringContaining("Untitled chat"),
      expect.stringContaining("From titles"),
    ]);
  });
});
