import { useRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useTrayProjectionStore } from "@/stores/tray/tray-projection-store";
import { useNotificationEventsStore } from "@/stores/notifications/notification-events-store";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";

const testState = {
  historyQueryMounts: 0,
};

// `useTrayEpicsSource` is the only caller of `useHistoryQuery` under this
// bridge, so counting mounts of the hook counts History queries.
vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => {
    const hasMountedQuery = useRef(false);
    if (!hasMountedQuery.current) {
      hasMountedQuery.current = true;
      testState.historyQueryMounts += 1;
    }
    return {
      data: { items: [], totalCount: 0, hostRequiresCloudToList: false },
      isPending: false,
      cloudPagePending: false,
      isFetching: false,
      error: null,
      refetch: () => Promise.resolve(),
      refetchTasks: () => Promise.resolve(),
      fetchNextPage: () => undefined,
      hasNextPage: false,
      isFetchingNextPage: false,
      currentUserId: "u1",
    };
  },
}));

vi.mock("@/hooks/home/use-optimistic-activity-history-items", () => ({
  useOptimisticActivityHistoryItems: () => [],
}));

// The bridge's log-level sync needs a query client and is not under test.
vi.mock("@/hooks/runner/use-runner-log-levels-query", () => ({
  useRunnerLogLevelsQuery: () => ({ data: undefined }),
}));

import { RunnerHostBridges } from "@/components/layout/bridges/runner-host-bridges";

function renderBridgesWithTray(showsEpics: boolean) {
  const runnerHost: IRunnerHost = createFakeRunnerHost({
    tray: {
      showsEpics,
      setEpics: () => Promise.resolve(),
      setIndicator: () => Promise.resolve(),
      onEpicSelected: () => ({ dispose: () => undefined }),
    },
  });
  return render(
    <RunnerHostContext.Provider value={runnerHost}>
      <RunnerHostBridges />
    </RunnerHostContext.Provider>,
  );
}

describe("RunnerHostBridges tray epics source", () => {
  afterEach(() => {
    cleanup();
    testState.historyQueryMounts = 0;
    useTrayProjectionStore.getState().reset();
    useNotificationEventsStore.getState().clear();
  });

  it("mounts no History query when the tray shows no epics", () => {
    renderBridgesWithTray(false);

    expect(testState.historyQueryMounts).toBe(0);
  });

  it("mounts the History query when the tray shows epics", () => {
    renderBridgesWithTray(true);

    expect(testState.historyQueryMounts).toBe(1);
  });
});
