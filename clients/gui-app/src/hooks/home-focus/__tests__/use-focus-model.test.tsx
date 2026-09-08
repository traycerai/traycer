import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP } from "@traycer/protocol/host/notifications/contracts";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
  __setHostAgentActivityHealthForTests,
  __setHostAgentActivityStateForTests,
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

/**
 * Mutable so a case can state the FLEET's shape, which is half of what
 * `focusActivityCoverage` needs: a narrow union is complete on a single-host
 * install and incomplete once there is somewhere else to look, and the count
 * is what tells those apart. Set it BEFORE `renderHook` - the hook reads it
 * during render and nothing here re-renders on a mutation.
 *
 * Defaults to the empty, resolved fleet every other case in this file wants,
 * and is restored in `beforeEach` so one case cannot leak into the next.
 */
const { connectableHostsMock } = vi.hoisted(() => ({
  connectableHostsMock: {
    hostIds: [] as readonly string[],
    resolved: true,
  },
}));

vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => connectableHostsMock,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: function useAuthStoreMock<T>(
    selector: (state: {
      contextMetadata: { userId: string; username: string } | null;
      status: string;
    }) => T,
  ): T {
    return selector({
      contextMetadata: { userId: "user-1", username: "user" },
      status: "signed-in",
    });
  },
  // The title batch's cloud-spend gate. A `signed-in` session authorizes it,
  // which is the state every case here runs in.
  authorizesCloudCapability: (status: string): boolean =>
    status === "signed-in",
}));

beforeEach(() => {
  notificationRowsMock.mockReturnValue([]);
  notificationIndicatorsMock.mockClear();
  connectableHostsMock.hostIds = [];
  connectableHostsMock.resolved = true;
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

/**
 * The activity store keys a slice per host, so both of this hook's reads of it
 * are folds across hosts rather than reads of one socket. The two folds answer
 * DIFFERENT questions and are deliberately opposite: the Running list is the
 * UNION of what every host reports, while `coverage.activity` is the verdict of
 * the WORST host - because a host whose stream is down contributes no epics to
 * that union, and its absent tasks are exactly what the coverage notice exists
 * to declare.
 *
 * A single host is the overwhelmingly common install, and both folds have to
 * leave it reading exactly as the pre-host-dimension store did; the last case
 * pins that.
 */
describe("useFocusModel - multi-host activity", () => {
  /** Open, this epoch's frame seen, cloud stamp attached: a slice that answers. */
  function makeHostHealthy(hostId: string): void {
    __setHostAgentActivityHealthForTests(hostId, {
      connectionStatus: "open",
      servedBy: "cloud",
      cloudSyncStatus: "connected",
      stateFrameSeenThisEpoch: true,
    });
  }

  it("unions the Running list across hosts, attributing each epic's agents to the host that reported them", () => {
    const { result } = renderHook(() => useFocusModel());

    act(() => {
      makeHostHealthy("host-a");
      __setHostAgentActivityStateForTests(
        "host-a",
        { "epic-a": { working: ["agent-a"], turn: [] } },
        "cloud",
        "connected",
      );
      makeHostHealthy("host-b");
      __setHostAgentActivityStateForTests(
        "host-b",
        { "epic-b": { working: ["agent-b"], turn: [] } },
        "cloud",
        "connected",
      );
    });

    // Neither host's slice alone answers for the account: before the union
    // this returned whichever slice was read, so one machine's running tasks
    // were simply invisible.
    expect(result.current.tasks).toHaveLength(2);
    const agentsByEpic = new Map(
      result.current.tasks.map((task) => [
        task.epicId,
        task.agents.map((agent) => agent.agentId),
      ]),
    );
    expect(agentsByEpic.get("epic-a")).toEqual(["agent-a"]);
    expect(agentsByEpic.get("epic-b")).toEqual(["agent-b"]);
  });

  it("merges one epic worked from two hosts into a single row carrying both agents", () => {
    const { result } = renderHook(() => useFocusModel());

    act(() => {
      makeHostHealthy("host-a");
      __setHostAgentActivityStateForTests(
        "host-a",
        { "epic-shared": { working: ["agent-a"], turn: [] } },
        "cloud",
        "connected",
      );
      makeHostHealthy("host-b");
      __setHostAgentActivityStateForTests(
        "host-b",
        { "epic-shared": { working: ["agent-b"], turn: [] } },
        "cloud",
        "connected",
      );
    });

    // An epic is cloud-homed and can be worked from more than one machine, so
    // the two slices are merged rather than one replacing the other.
    expect(result.current.tasks).toHaveLength(1);
    expect(
      result.current.tasks[0]?.agents.map((agent) => agent.agentId).sort(),
    ).toEqual(["agent-a", "agent-b"]);
  });

  it("reports the WORST host's coverage: one live host beside one whose stream is closed reads disconnected", () => {
    const { result } = renderHook(() => useFocusModel());

    act(() => {
      makeHostHealthy("host-a");
      __setHostAgentActivityStateForTests(
        "host-a",
        { "epic-a": { working: ["agent-a"], turn: [] } },
        "cloud",
        "connected",
      );
      // No state frame and a dead socket: this host is reporting nothing, so
      // whatever it is running is missing from the union above.
      __setHostAgentActivityHealthForTests("host-b", {
        connectionStatus: "closed",
        stateFrameSeenThisEpoch: false,
      });
    });

    // `host-a` alone would read "live" (the next case proves it). Taking the
    // best slice would therefore caption a list that is missing every one of
    // `host-b`'s tasks as complete - the failure this fold exists to prevent.
    expect(result.current.coverage.activity).toBe("disconnected");
    expect(result.current.tasks).toHaveLength(1);
  });

  it("reads unknown when two hosts are connectable and no slice carries a connected stamp - a narrow union with somewhere else to look", () => {
    // The fleet arm, not the worst-host arm: nothing here is disconnected or
    // reconnecting, and both slices answer. What they cannot do is vouch for
    // the OTHER machine - only a `connected` stamp proves a union reached
    // beyond the host that built it - and with two connectable hosts the
    // Running list's "every task on the account" caption would be a claim
    // neither slice can support.
    connectableHostsMock.hostIds = ["host-a", "host-b"];
    const { result } = renderHook(() => useFocusModel());

    act(() => {
      // `null` stamp is NO CLAIM, not proof of the negative: a host with no
      // cloud link, or one on the `@1.0` minor that predates the field.
      __setHostAgentActivityStateForTests(
        "host-a",
        { "epic-a": { working: ["agent-a"], turn: [] } },
        "local",
        null,
      );
      __setHostAgentActivityHealthForTests("host-a", {
        connectionStatus: "open",
      });
      __setHostAgentActivityStateForTests(
        "host-b",
        { "epic-b": { working: ["agent-b"], turn: [] } },
        "local",
        null,
      );
      __setHostAgentActivityHealthForTests("host-b", {
        connectionStatus: "open",
      });
    });

    expect(result.current.coverage.activity).toBe("unknown");
    // The union is still built and still shown - "unknown" captions the list,
    // it does not empty it.
    expect(result.current.tasks).toHaveLength(2);
  });

  it("keeps the single-host reading unchanged - one healthy host reads live", () => {
    const { result } = renderHook(() => useFocusModel());

    act(() => {
      __setAgentActivityPlaneAnsweringForTests();
      __setAgentActivityStateForTests(
        { "epic-1": { working: ["agent-1"], turn: [] } },
        "cloud",
        "connected",
      );
    });

    expect(result.current.coverage.activity).toBe("live");
  });
});
