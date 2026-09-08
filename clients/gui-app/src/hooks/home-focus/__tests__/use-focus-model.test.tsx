import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP } from "@traycer/protocol/host/notifications/contracts";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import type { UseNotificationIndicatorsArgs } from "@/hooks/notifications/use-notification-indicators-query";
import { useHomeBadgeCount } from "@/components/home-focus/use-home-badge-count";
import { useFocusModel } from "@/hooks/home-focus/use-focus-model";
import {
  makeApprovalPayload,
  makeMergedNotificationRow,
} from "@/lib/home-focus/__tests__/fixtures";

/**
 * Everything the hook joins from OTHER stores/queries is mocked to a fixed,
 * referentially-stable answer, so the suite can drive the one live piece
 * (`useAgentActivityStore`, the real store + its test helpers) and observe
 * the model react - without a host runtime.
 *
 * `notificationRowsMock` is the one exception: the badge-equivalence case
 * needs a real prompt row on the feed, so it is a controllable `vi.fn`
 * reset to an empty array between tests.
 */
const { notificationRowsMock, notificationIndicatorsMock } = vi.hoisted(() => ({
  notificationRowsMock: vi.fn<() => ReadonlyArray<MergedNotificationRow>>(
    () => [],
  ),
  notificationIndicatorsMock: vi.fn((_args: UseNotificationIndicatorsArgs) => ({
    epics: {},
    chats: {},
  })),
}));

vi.mock("@/stores/notifications/merged-notifications", () => ({
  useMergedNotificationRows: notificationRowsMock,
}));

vi.mock("@/lib/notifications/notification-feed-mode", () => ({
  useNotificationFeedMode: () => "local",
}));

vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({
    tasksById: new Map(),
    isFetching: false,
    error: null,
  }),
}));

vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: notificationIndicatorsMock,
}));

vi.mock("@/hooks/home-focus/use-warm-chat-background", () => ({
  useWarmChatBackground: () => [],
}));

vi.mock("@/hooks/home-focus/use-mounted-epic-projection", () => ({
  useMountedEpicProjection: () => ({
    mountedEpicIds: new Set<string>(),
    liveTitles: new Map<string, string>(),
    agentIdentities: new Map(),
  }),
}));

// `useFocusModel` also resolves `coldEpicHostIds`/`activeHostId`/
// `reachableHostIds` for the task-level `stoppable` field. Neither hook is
// exercised by this suite's assertions (those live in
// `focus-tasks.test.ts`/`build-focus-model.test.ts`), so both are pinned to a
// fixed, dependency-free answer rather than wiring up a QueryClient +
// host-directory just to satisfy `useConnectableHostIds`.
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => null,
}));

vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: [], resolved: true }),
}));

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: function useAuthStoreMock<T>(
    selector: (state: {
      contextMetadata: { userId: string; username: string } | null;
    }) => T,
  ): T {
    return selector({
      contextMetadata: { userId: "user-1", username: "user" },
    });
  },
}));

beforeEach(() => {
  notificationRowsMock.mockReturnValue([]);
  notificationIndicatorsMock.mockClear();
  __resetAgentActivityStoreForTests();
});

afterEach(() => {
  cleanup();
  __resetAgentActivityStoreForTests();
});

describe("useFocusModel", () => {
  it("reflects an activity-store change without remounting the hook", () => {
    const { result } = renderHook(() => useFocusModel());
    expect(result.current.tasks).toHaveLength(0);

    act(() => {
      __setAgentActivityPlaneAnsweringForTests();
      __setAgentActivityStateForTests(
        { "epic-1": { working: ["agent-1"], turn: [] } },
        "local",
        "connected",
      );
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0]?.epicId).toBe("epic-1");
  });

  it("decodes multiple epics each holding multiple working agents without cross-epic misattribution - the multi-separator regression guard", () => {
    // The blocker this guards: an earlier single-separator encoding nested an
    // agent-id list inside a group list using the SAME separator, so an epic
    // with two working agents (a root plus a subagent - the most ordinary
    // state Home has) either threw inside the decoding `useMemo` or handed one
    // epic's second agent to a neighboring group. Two epics, two agents each,
    // is exactly the shape that broke.
    const { result } = renderHook(() => useFocusModel());

    act(() => {
      __setAgentActivityPlaneAnsweringForTests();
      __setAgentActivityStateForTests(
        {
          "epic-1": { working: ["agent-1a", "agent-1b"], turn: ["agent-1a"] },
          "epic-2": { working: ["agent-2a", "agent-2b"], turn: [] },
        },
        "local",
        "connected",
      );
    });

    expect(result.current.tasks).toHaveLength(2);
    const tasksByEpic = new Map(
      result.current.tasks.map((task) => [task.epicId, task]),
    );
    const epic1AgentIds = tasksByEpic
      .get("epic-1")
      ?.agents.map((agent) => agent.agentId)
      .sort();
    const epic2AgentIds = tasksByEpic
      .get("epic-2")
      ?.agents.map((agent) => agent.agentId)
      .sort();

    expect(epic1AgentIds).toEqual(["agent-1a", "agent-1b"]);
    expect(epic2AgentIds).toEqual(["agent-2a", "agent-2b"]);
    // No cross-epic contamination in either direction.
    expect(epic1AgentIds).not.toContain("agent-2a");
    expect(epic1AgentIds).not.toContain("agent-2b");
    expect(epic2AgentIds).not.toContain("agent-1a");
    expect(epic2AgentIds).not.toContain("agent-1b");
  });

  it("keeps the same model object across a re-render that changes nothing", () => {
    const { result, rerender } = renderHook(() => useFocusModel());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });

  it("caps indicatorEpicIds at HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP sorted ids, from a >500-epic activity fixture", () => {
    const epicCount = HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP + 37;
    const byEpic: Record<string, { working: string[]; turn: string[] }> = {};
    const epicIds: string[] = [];
    for (let index = 0; index < epicCount; index += 1) {
      // Zero-padded so byte-ascending string sort matches numeric order,
      // which is what makes the expected slice easy to state.
      const epicId = `epic-${String(index).padStart(6, "0")}`;
      epicIds.push(epicId);
      byEpic[epicId] = { working: [`${epicId}-agent`], turn: [] };
    }

    const { result } = renderHook(() => useFocusModel());
    act(() => {
      __setAgentActivityPlaneAnsweringForTests();
      __setAgentActivityStateForTests(byEpic, "local", "connected");
    });

    expect(result.current.tasks).toHaveLength(epicCount);
    expect(notificationIndicatorsMock).toHaveBeenCalled();

    const lastArgs = notificationIndicatorsMock.mock.calls.at(-1)?.[0];
    const expectedIds = [...epicIds]
      .sort()
      .slice(0, HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP);

    expect(lastArgs?.epicIds).toHaveLength(
      HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP,
    );
    expect(lastArgs?.epicIds).toEqual(expectedIds);
  });

  it("useHomeBadgeCount() equals useFocusModel().badgeCount", () => {
    const approvalRow = makeMergedNotificationRow({
      feedId: "host:approval-1",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    notificationRowsMock.mockReturnValue([approvalRow]);

    const model = renderHook(() => useFocusModel());
    const badge = renderHook(() => useHomeBadgeCount());

    expect(model.result.current.badgeCount).toBe(1);
    expect(badge.result.current).toBe(model.result.current.badgeCount);
  });
});
