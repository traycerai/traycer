import { describe, expect, it } from "vitest";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { AgentActivityCloudSyncStatus } from "@traycer/protocol/host/agent/activity";
import {
  buildFocusModel,
  EMPTY_FOCUS_MODEL,
  focusActivityCoverage,
  focusActivityDegradedReason,
  type BuildFocusModelInput,
  type FocusActivityHealth,
} from "@/lib/home-focus/build-focus-model";
import type {
  FocusDegradedHost,
  FocusDegradedReason,
} from "@/lib/home-focus/focus-model";
import {
  makeApprovalPayload,
  makeBrowserSessionPayload,
  makeEpicAgentActivity,
  makeMergedNotificationRow,
} from "@/lib/home-focus/__tests__/fixtures";

function baseModelInput(
  overrides: Partial<BuildFocusModelInput>,
): BuildFocusModelInput {
  return {
    notificationRows: [],
    degradedHosts: [],
    browsers: { epics: [], agentIdentities: new Map() },
    tasks: {
      byEpic: new Map(),
      taskTitles: new Map(),
      mountedEpicIds: new Set(),
      agentIdentities: new Map(),
      activityHostIds: new Map(),
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
        activityHostIds: new Map(),
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
        activityHostIds: new Map(),
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

  describe("focusActivityDegradedReason", () => {
    interface DegradedReasonCase {
      readonly name: string;
      readonly connectionStatus: StreamConnectionStatus;
      readonly cloudSyncStatus: AgentActivityCloudSyncStatus | null;
      readonly stateFrameSeenThisEpoch: boolean;
      readonly expected: FocusDegradedReason | null;
    }

    const CASES: ReadonlyArray<DegradedReasonCase> = [
      {
        name: "closed -> host-lost",
        connectionStatus: "closed",
        cloudSyncStatus: null,
        stateFrameSeenThisEpoch: true,
        expected: "host-lost",
      },
      {
        name: "closed -> host-lost even with cloud disconnected",
        connectionStatus: "closed",
        cloudSyncStatus: "disconnected",
        stateFrameSeenThisEpoch: true,
        expected: "host-lost",
      },
      {
        name: "connecting -> host-reconnecting",
        connectionStatus: "connecting",
        cloudSyncStatus: null,
        stateFrameSeenThisEpoch: true,
        expected: "host-reconnecting",
      },
      {
        name: "reconnecting -> host-reconnecting",
        connectionStatus: "reconnecting",
        cloudSyncStatus: null,
        stateFrameSeenThisEpoch: true,
        expected: "host-reconnecting",
      },
      {
        name: "reconnecting -> host-reconnecting even with cloud disconnected",
        connectionStatus: "reconnecting",
        cloudSyncStatus: "disconnected",
        stateFrameSeenThisEpoch: true,
        expected: "host-reconnecting",
      },
      {
        name: "open without a state frame this epoch -> null",
        connectionStatus: "open",
        cloudSyncStatus: null,
        stateFrameSeenThisEpoch: false,
        expected: null,
      },
      {
        name: "open without a state frame this epoch -> null, even with cloud disconnected",
        connectionStatus: "open",
        cloudSyncStatus: "disconnected",
        stateFrameSeenThisEpoch: false,
        expected: null,
      },
      {
        name: "open + frame + cloud reconnecting -> cloud-reconnecting",
        connectionStatus: "open",
        cloudSyncStatus: "reconnecting",
        stateFrameSeenThisEpoch: true,
        expected: "cloud-reconnecting",
      },
      {
        name: "open + frame + cloud disconnected -> cloud-disconnected",
        connectionStatus: "open",
        cloudSyncStatus: "disconnected",
        stateFrameSeenThisEpoch: true,
        expected: "cloud-disconnected",
      },
      {
        name: "open + frame + cloud connected -> null",
        connectionStatus: "open",
        cloudSyncStatus: "connected",
        stateFrameSeenThisEpoch: true,
        expected: null,
      },
      {
        name: "open + frame + cloud null -> null",
        connectionStatus: "open",
        cloudSyncStatus: null,
        stateFrameSeenThisEpoch: true,
        expected: null,
      },
    ];

    it.each(CASES)("$name", (testCase) => {
      expect(
        focusActivityDegradedReason({
          connectionStatus: testCase.connectionStatus,
          cloudSyncStatus: testCase.cloudSyncStatus,
          stateFrameSeenThisEpoch: testCase.stateFrameSeenThisEpoch,
        }),
      ).toBe(testCase.expected);
    });
  });

  it("focusActivityCoverage still returns disconnected/reconnecting/unknown/live for the matching reasons", () => {
    // host-lost and cloud-disconnected both read as "disconnected".
    expect(focusActivityCoverage(health({ connectionStatus: "closed" }))).toBe(
      "disconnected",
    );
    expect(
      focusActivityCoverage(
        health({
          connectionStatus: "open",
          stateFrameSeenThisEpoch: true,
          cloudSyncStatus: "disconnected",
        }),
      ),
    ).toBe("disconnected");
    // host-reconnecting and cloud-reconnecting both read as "reconnecting".
    expect(
      focusActivityCoverage(health({ connectionStatus: "reconnecting" })),
    ).toBe("reconnecting");
    expect(
      focusActivityCoverage(
        health({
          connectionStatus: "open",
          stateFrameSeenThisEpoch: true,
          cloudSyncStatus: "reconnecting",
        }),
      ),
    ).toBe("reconnecting");
    // No reason (null), but no state frame yet this epoch -> "unknown".
    expect(
      focusActivityCoverage(
        health({ connectionStatus: "open", stateFrameSeenThisEpoch: false }),
      ),
    ).toBe("unknown");
    // No reason (null), frame seen, cloud connected -> "live".
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
        activityHostIds: new Map(),
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

  it("reuses previous.coverage.degradedHosts by identity when hosts and reasons are equal, and mints a new array when a reason changes", () => {
    const degradedHostsA: ReadonlyArray<FocusDegradedHost> = [
      { hostId: "host-a", reason: "host-reconnecting" },
      { hostId: "host-b", reason: "cloud-disconnected" },
    ];
    const first = buildFocusModel(
      baseModelInput({ degradedHosts: degradedHostsA }),
      EMPTY_FOCUS_MODEL,
    );
    // A fresh model built against the EMPTY baseline (whose degradedHosts is
    // empty) has nothing to reuse, so it carries the input array itself.
    expect(first.coverage.degradedHosts).toBe(degradedHostsA);

    const second = buildFocusModel(
      baseModelInput({
        // A new array, same hostId/reason pairs in the same order.
        degradedHosts: [
          { hostId: "host-a", reason: "host-reconnecting" },
          { hostId: "host-b", reason: "cloud-disconnected" },
        ],
      }),
      first,
    );
    expect(second.coverage.degradedHosts).toBe(first.coverage.degradedHosts);

    const third = buildFocusModel(
      baseModelInput({
        degradedHosts: [
          // Only the reason for host-a changed.
          { hostId: "host-a", reason: "host-lost" },
          { hostId: "host-b", reason: "cloud-disconnected" },
        ],
      }),
      second,
    );
    expect(third.coverage.degradedHosts).not.toBe(
      second.coverage.degradedHosts,
    );
    expect(third.coverage.degradedHosts).toEqual([
      { hostId: "host-a", reason: "host-lost" },
      { hostId: "host-b", reason: "cloud-disconnected" },
    ]);
  });

  // The browser plane is window-local for the same shape of reason the
  // background plane is, and the literal `true` is what puts that in the type.
  it("declares both mounted-only limits in its coverage", () => {
    const model = buildFocusModel(baseModelInput({}), EMPTY_FOCUS_MODEL);

    expect(model.coverage.backgroundIsMountedOnly).toBe(true);
    expect(model.coverage.browsersAreMountedOnly).toBe(true);
  });

  it("decorates a browser prompt with the tab title from its own browser rows", () => {
    const model = buildFocusModel(
      baseModelInput({
        notificationRows: [
          makeMergedNotificationRow({
            feedId: "host:browser-1",
            hostKind: "browser.human.needed",
            severity: "needs_action",
            payload: makeBrowserSessionPayload("epic-1", "session-1", "tab-1"),
          }),
        ],
        browsers: {
          epics: [
            {
              epicId: "epic-1",
              taskTitle: "Storefront",
              sessions: [
                {
                  sessionId: "session-1",
                  scope: { kind: "epic", epicId: "epic-1" },
                  hostId: "host-a",
                  profile: "primary",
                  lastActivityAt: 0,
                  runtime: { kind: "headless", revision: 1 },
                  tabs: [
                    {
                      tabId: "tab-1",
                      url: "https://shop.example.com/checkout",
                      originTier: "external",
                      status: "ready",
                      title: "Checkout",
                      viewed: false,
                      drivenBy: [],
                      boundWindowId: null,
                    },
                  ],
                },
              ],
            },
          ],
          agentIdentities: new Map(),
        },
      }),
      EMPTY_FOCUS_MODEL,
    );

    // Built from the rows the page is showing, so the prompt can never name a
    // tab the section below it is not listing.
    expect(model.prompts[0]?.browserTabTitle).toBe("Checkout");
    expect(model.browsers).toHaveLength(1);
  });
});
