import { describe, expect, it } from "vitest";
import {
  buildFocusModel,
  EMPTY_FOCUS_MODEL,
  focusActivityCoverage,
  type BuildFocusModelInput,
  type FocusActivityHealth,
} from "@/lib/home-focus/build-focus-model";
import {
  makeApprovalPayload,
  makeEpicAgentActivity,
  makeMergedNotificationRow,
} from "@/lib/home-focus/__tests__/fixtures";

function baseModelInput(
  overrides: Partial<BuildFocusModelInput>,
): BuildFocusModelInput {
  return {
    notificationRows: [],
    tasks: {
      byEpic: new Map(),
      taskTitles: new Map(),
      mountedEpicIds: new Set(),
      agentIdentities: new Map(),
      indicatorEpics: {},
      coldEpicHostIds: new Map(),
      activeHostId: null,
      reachableHostIds: new Set(),
    },
    backgroundChats: [],
    activity: {
      connectionStatus: "open",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
      connectableHostCount: 1,
      connectableHostsResolved: true,
    },
    feedMode: "local",
    ...overrides,
  };
}

function health(overrides: Partial<FocusActivityHealth>): FocusActivityHealth {
  return {
    connectionStatus: "open",
    cloudSyncStatus: null,
    stateFrameSeenThisEpoch: true,
    connectableHostCount: 1,
    connectableHostsResolved: true,
    ...overrides,
  };
}

describe("buildFocusModel", () => {
  it("badgeCount equals prompts.length", () => {
    const approvalRow = makeMergedNotificationRow({
      feedId: "host:approval-1",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    const input = baseModelInput({ notificationRows: [approvalRow] });

    const model = buildFocusModel(input, EMPTY_FOCUS_MODEL);

    expect(model.badgeCount).toBe(model.prompts.length);
    expect(model.badgeCount).toBe(1);
  });

  it("gives needsYou: true to a task that only a prompt names, when it also has running agents", () => {
    const approvalRow = makeMergedNotificationRow({
      feedId: "host:approval-1",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    const input = baseModelInput({
      notificationRows: [approvalRow],
      tasks: {
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        taskTitles: new Map(),
        mountedEpicIds: new Set(),
        agentIdentities: new Map(),
        // Deliberately NOT covering epic-1: the host's indicator batch is
        // silent, so only the prompt row can supply needsYou.
        indicatorEpics: {},
        coldEpicHostIds: new Map(),
        activeHostId: null,
        reachableHostIds: new Set(),
      },
    });

    const model = buildFocusModel(input, EMPTY_FOCUS_MODEL);

    expect(model.tasks).toHaveLength(1);
    expect(model.tasks[0]).toMatchObject({ epicId: "epic-1", needsYou: true });
  });

  it("threads coldEpicHostIds/activeHostId/reachableHostIds through to tasks[0].stoppable", () => {
    const input = baseModelInput({
      tasks: {
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        taskTitles: new Map(),
        mountedEpicIds: new Set(),
        agentIdentities: new Map(),
        indicatorEpics: {},
        // The agent's host resolves through the cold-epic guess (no mounted
        // identity), and that host is neither the active host nor reachable -
        // so the task must read stoppable: false end to end.
        coldEpicHostIds: new Map([["epic-1", "host-unreachable"]]),
        activeHostId: "host-active",
        reachableHostIds: new Set(["host-reachable"]),
      },
    });

    const model = buildFocusModel(input, EMPTY_FOCUS_MODEL);

    expect(model.tasks[0]?.agents[0]?.hostId).toBe("host-unreachable");
    expect(model.tasks[0]?.stoppable).toBe(false);
  });

  describe("focusActivityCoverage", () => {
    it("closed -> disconnected", () => {
      expect(
        focusActivityCoverage(health({ connectionStatus: "closed" })),
      ).toBe("disconnected");
    });

    it("connecting -> reconnecting", () => {
      expect(
        focusActivityCoverage(health({ connectionStatus: "connecting" })),
      ).toBe("reconnecting");
    });

    it("reconnecting -> reconnecting", () => {
      expect(
        focusActivityCoverage(health({ connectionStatus: "reconnecting" })),
      ).toBe("reconnecting");
    });

    it("open without a state frame this epoch -> unknown", () => {
      expect(
        focusActivityCoverage(
          health({ connectionStatus: "open", stateFrameSeenThisEpoch: false }),
        ),
      ).toBe("unknown");
    });

    it("open + frame + cloudSyncStatus null -> live", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: null,
          }),
        ),
      ).toBe("live");
    });

    it("open + frame + cloudSyncStatus connected -> live", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: "connected",
          }),
        ),
      ).toBe("live");
    });

    it("open + frame + cloudSyncStatus reconnecting -> reconnecting", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: "reconnecting",
          }),
        ),
      ).toBe("reconnecting");
    });

    it("open + frame + cloudSyncStatus disconnected -> disconnected", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: "disconnected",
          }),
        ),
      ).toBe("disconnected");
    });

    it("RESOLVED + connectableHostCount 1 + cloudSyncStatus null -> live (a single-host install has nothing else to look at)", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: null,
            connectableHostCount: 1,
            connectableHostsResolved: true,
          }),
        ),
      ).toBe("live");
    });

    it("resolved + connectableHostCount 2 -> unknown (a narrow union is now an incomplete one)", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: null,
            connectableHostCount: 2,
            connectableHostsResolved: true,
          }),
        ),
      ).toBe("unknown");
    });

    it("UNRESOLVED directory + cloudSyncStatus null + connectableHostCount 0 -> unknown (a loading directory reports zero hosts, indistinguishable from a single-host install by count alone)", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: null,
            connectableHostCount: 0,
            connectableHostsResolved: false,
          }),
        ),
      ).toBe("unknown");
    });

    it("unresolved directory + connectableHostCount 1 -> unknown (the count cannot be trusted before the directory answers)", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: null,
            connectableHostCount: 1,
            connectableHostsResolved: false,
          }),
        ),
      ).toBe("unknown");
    });

    it("cloudSyncStatus connected + UNRESOLVED directory -> live (a connected stamp spans the fleet regardless of what the directory knows)", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: "connected",
            connectableHostCount: 0,
            connectableHostsResolved: false,
          }),
        ),
      ).toBe("live");
    });

    it("open + frame + cloudSyncStatus connected + connectableHostCount 5 -> live (a fleet-wide union proves itself regardless of host count)", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: true,
            cloudSyncStatus: "connected",
            connectableHostCount: 5,
          }),
        ),
      ).toBe("live");
    });

    it("closed still wins over the new arm regardless of connectableHostCount", () => {
      expect(
        focusActivityCoverage(
          health({ connectionStatus: "closed", connectableHostCount: 5 }),
        ),
      ).toBe("disconnected");
    });

    it("reconnecting connectionStatus still wins over the new arm regardless of connectableHostCount", () => {
      expect(
        focusActivityCoverage(
          health({ connectionStatus: "reconnecting", connectableHostCount: 5 }),
        ),
      ).toBe("reconnecting");
    });

    it("no state frame this epoch still wins over the new arm regardless of connectableHostCount", () => {
      expect(
        focusActivityCoverage(
          health({
            connectionStatus: "open",
            stateFrameSeenThisEpoch: false,
            connectableHostCount: 5,
          }),
        ),
      ).toBe("unknown");
    });
  });

  it("coverage.notifications follows feed mode", () => {
    const cloudModel = buildFocusModel(
      baseModelInput({ feedMode: "cloud" }),
      EMPTY_FOCUS_MODEL,
    );
    const localModel = buildFocusModel(
      baseModelInput({ feedMode: "local" }),
      EMPTY_FOCUS_MODEL,
    );
    const upgradeModel = buildFocusModel(
      baseModelInput({ feedMode: "upgrade-required" }),
      EMPTY_FOCUS_MODEL,
    );

    expect(cloudModel.coverage.notifications).toBe("cloud");
    expect(localModel.coverage.notifications).toBe("local");
    expect(upgradeModel.coverage.notifications).toBe("local");
  });

  it("coverage.backgroundIsMountedOnly is the literal true", () => {
    const model = buildFocusModel(baseModelInput({}), EMPTY_FOCUS_MODEL);
    expect(model.coverage.backgroundIsMountedOnly).toBe(true);
  });

  it("returns the SAME model object when rebuilt from identical inputs", () => {
    const input = baseModelInput({
      tasks: {
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        taskTitles: new Map(),
        mountedEpicIds: new Set(),
        agentIdentities: new Map(),
        indicatorEpics: {},
        coldEpicHostIds: new Map(),
        activeHostId: null,
        reachableHostIds: new Set(),
      },
    });

    const first = buildFocusModel(input, EMPTY_FOCUS_MODEL);
    const second = buildFocusModel(input, first);

    expect(second).toBe(first);
  });
});
