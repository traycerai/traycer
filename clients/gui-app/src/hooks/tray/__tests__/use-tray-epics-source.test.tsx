import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { useTrayProjectionStore } from "@/stores/tray/tray-projection-store";

const mocks = vi.hoisted(() => ({
  useHistoryQuery: vi.fn(),
  useOptimisticActivityHistoryItems: vi.fn(),
}));

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: mocks.useHistoryQuery,
}));

vi.mock("@/hooks/home/use-optimistic-activity-history-items", () => ({
  useOptimisticActivityHistoryItems: mocks.useOptimisticActivityHistoryItems,
}));

import { useTrayEpicsSource } from "@/hooks/tray/use-tray-epics-source";

function historyItem(overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id: "history-epic-a",
    epicId: "epic-a",
    taskType: "epic",
    title: "Epic A",
    initialUserPrompt: "",
    updatedAtMs: 100,
    updatedLabel: "old",
    updatedBucket: "earlier",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned: false,
    ...overrides,
  };
}

function Source(): null {
  useTrayEpicsSource();
  return null;
}

describe("useTrayEpicsSource", () => {
  afterEach(() => {
    cleanup();
    mocks.useHistoryQuery.mockReset();
    mocks.useOptimisticActivityHistoryItems.mockReset();
    useTrayProjectionStore.getState().reset();
  });

  it("keeps tray task ordering subscribed to own-record activity while History is closed", () => {
    const epicA = historyItem({
      epicId: "epic-a",
      title: "Epic A",
      updatedAtMs: 100,
    });
    const epicB = historyItem({
      epicId: "epic-b",
      title: "Epic B",
      updatedAtMs: 200,
    });
    const durableItems = [epicA, epicB];
    const activeItems = [epicB, epicA];
    mocks.useHistoryQuery.mockReturnValue({ data: { items: durableItems } });
    mocks.useOptimisticActivityHistoryItems.mockReturnValue(activeItems);

    render(<Source />);

    expect(mocks.useOptimisticActivityHistoryItems).toHaveBeenCalled();
    expect(
      useTrayProjectionStore.getState().epics.map((epic) => epic.epicId),
    ).toEqual(["epic-b", "epic-a"]);
  });
});
