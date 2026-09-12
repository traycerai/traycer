import { describe, expect, it } from "vitest";
import {
  buildFocusTasks,
  focusAgentKey,
  type FocusTasksInput,
} from "@/lib/home-focus/focus-tasks";
import {
  makeEpicAgentActivity,
  makeFocusAgentIdentity,
  makeIndicatorFlags,
} from "@/lib/home-focus/__tests__/fixtures";

function baseInput(overrides: Partial<FocusTasksInput>): FocusTasksInput {
  return {
    byEpic: new Map(),
    taskTitles: new Map(),
    mountedEpicIds: new Set(),
    agentIdentities: new Map(),
    activityHostIds: new Map(),
    indicatorEpics: {},
    promptEpicIds: new Set(),
    coldEpicHostIds: new Map(),
    activeHostId: null,
    reachableHostIds: new Set(),
    ...overrides,
  };
}

describe("buildFocusTasks", () => {
  it("omits an epic whose working set is empty", () => {
    const input = baseInput({
      byEpic: new Map([["epic-1", makeEpicAgentActivity([], [])]]),
    });

    expect(buildFocusTasks(input, [])).toHaveLength(0);
  });

  describe("needsYou precedence", () => {
    it("is true when the epic is in promptEpicIds", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        promptEpicIds: new Set(["epic-1"]),
        indicatorEpics: {},
      });

      const [task] = buildFocusTasks(input, []);
      expect(task.needsYou).toBe(true);
    });

    it("is true when the indicator flags say pendingApproval or pendingInterview", () => {
      const approvalInput = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        indicatorEpics: {
          "epic-1": makeIndicatorFlags({ pendingApproval: true }),
        },
      });
      const interviewInput = baseInput({
        byEpic: new Map([["epic-2", makeEpicAgentActivity(["agent-1"], [])]]),
        indicatorEpics: {
          "epic-2": makeIndicatorFlags({ pendingInterview: true }),
        },
      });

      expect(buildFocusTasks(approvalInput, [])[0]?.needsYou).toBe(true);
      expect(buildFocusTasks(interviewInput, [])[0]?.needsYou).toBe(true);
    });

    it("is false, not throwing, when the epic is absent from the indicator batch and has no prompt row", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        indicatorEpics: {},
        promptEpicIds: new Set(),
      });

      const [task] = buildFocusTasks(input, []);
      expect(task.needsYou).toBe(false);
    });
  });

  it("orders tasks by needsYou first, then most agents in the turn tier, then most agents overall, then epic id ascending", () => {
    const input = baseInput({
      byEpic: new Map([
        // Needs-you loser on agent counts, but wins overall on needsYou.
        ["epic-needs-you", makeEpicAgentActivity(["a1"], [])],
        // Two epics tied on needsYou=false; "epic-b" has more turn agents.
        [
          "epic-more-turn",
          makeEpicAgentActivity(["a1", "a2", "a3"], ["a1", "a2"]),
        ],
        ["epic-fewer-turn", makeEpicAgentActivity(["a1", "a2"], ["a1"])],
        // Tied on turn-agent count (0) and total-agent count (1) with
        // "epic-fewer-turn-2" below; epic id ascending breaks the tie.
        ["epic-z-tiebreak", makeEpicAgentActivity(["a1"], [])],
        ["epic-a-tiebreak", makeEpicAgentActivity(["a1"], [])],
      ]),
      promptEpicIds: new Set(["epic-needs-you"]),
    });

    const tasks = buildFocusTasks(input, []);

    expect(tasks.map((task) => task.epicId)).toEqual([
      "epic-needs-you",
      "epic-more-turn",
      "epic-fewer-turn",
      "epic-a-tiebreak",
      "epic-z-tiebreak",
    ]);
  });

  it("orders agents within a task: turn before background, named before unnamed, then title ascending, then agentId ascending", () => {
    const input = baseInput({
      byEpic: new Map([
        [
          "epic-1",
          makeEpicAgentActivity(
            ["bg-unnamed", "bg-named-b", "turn-unnamed", "turn-named-a"],
            ["turn-unnamed", "turn-named-a"],
          ),
        ],
      ]),
      mountedEpicIds: new Set(["epic-1"]),
      agentIdentities: new Map([
        [
          focusAgentKey("epic-1", "turn-named-a"),
          makeFocusAgentIdentity({ surface: "chat", title: "Alpha" }),
        ],
        [
          focusAgentKey("epic-1", "bg-named-b"),
          makeFocusAgentIdentity({ surface: "chat", title: "Beta" }),
        ],
        // "turn-unnamed" and "bg-unnamed" deliberately have no identity entry.
      ]),
    });

    const [task] = buildFocusTasks(input, []);

    expect(task.agents.map((agent) => agent.agentId)).toEqual([
      "turn-named-a",
      "turn-unnamed",
      "bg-named-b",
      "bg-unnamed",
    ]);
  });

  it("marks an unmounted epic's agents fully null, while its title still comes from the titles map", () => {
    const input = baseInput({
      byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
      taskTitles: new Map([["epic-1", "Task One"]]),
      mountedEpicIds: new Set(),
      // No agentIdentities entry: an unmounted epic's agents are never
      // resolved by the real caller, which only populates identities for
      // mounted epics.
      agentIdentities: new Map(),
      activityHostIds: new Map(),
    });

    const [task] = buildFocusTasks(input, []);

    expect(task.mountedHere).toBe(false);
    expect(task.taskTitle).toBe("Task One");
    expect(task.agents[0]).toMatchObject({
      agentId: "agent-1",
      title: null,
      surface: null,
      parentId: null,
    });
  });

  it("resolves a mounted epic's agent identities through focusAgentKey", () => {
    const input = baseInput({
      byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
      mountedEpicIds: new Set(["epic-1"]),
      agentIdentities: new Map([
        [
          focusAgentKey("epic-1", "agent-1"),
          makeFocusAgentIdentity({
            surface: "terminal-agent",
            title: "Terminal Agent",
            parentId: "parent-1",
          }),
        ],
      ]),
    });

    const [task] = buildFocusTasks(input, []);

    expect(task.mountedHere).toBe(true);
    expect(task.agents[0]).toMatchObject({
      agentId: "agent-1",
      title: "Terminal Agent",
      surface: "terminal-agent",
      parentId: "parent-1",
    });
  });

  describe("agent hostId resolution", () => {
    it("uses the resolved identity's hostId when mounted, INCLUDING null (a legacy chat) - it must not fall through to the cold-epic guess", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        mountedEpicIds: new Set(["epic-1"]),
        agentIdentities: new Map([
          [
            focusAgentKey("epic-1", "agent-1"),
            makeFocusAgentIdentity({ surface: "chat", hostId: null }),
          ],
        ]),
        // A cold-epic guess is available too, but the resolved identity - even
        // though its own hostId is null - must win over it.
        coldEpicHostIds: new Map([["epic-1", "cold-host-should-not-show"]]),
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.agents[0]?.hostId).toBeNull();
    });

    it("uses the resolved identity's hostId when it names a real host", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        mountedEpicIds: new Set(["epic-1"]),
        agentIdentities: new Map([
          [
            focusAgentKey("epic-1", "agent-1"),
            makeFocusAgentIdentity({ surface: "chat", hostId: "host-known" }),
          ],
        ]),
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.agents[0]?.hostId).toBe("host-known");
    });

    it("falls back to the cold-epic guess when the agent is absent from agentIdentities", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        agentIdentities: new Map(),
        activityHostIds: new Map(),
        coldEpicHostIds: new Map([["epic-1", "cold-host-1"]]),
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.agents[0]?.hostId).toBe("cold-host-1");
    });

    it("is null when the epic is in neither agentIdentities nor coldEpicHostIds", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        agentIdentities: new Map(),
        activityHostIds: new Map(),
        coldEpicHostIds: new Map(),
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.agents[0]?.hostId).toBeNull();
    });
  });

  describe("task stoppable", () => {
    it("is false for a COLD epic's null-host agent - unmounted, absent from coldEpicHostIds, unresolved in agentIdentities", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        mountedEpicIds: new Set(),
        coldEpicHostIds: new Map(),
        agentIdentities: new Map(),
        activityHostIds: new Map(),
        activeHostId: "host-active",
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.agents[0]?.hostId).toBeNull();
      // Nothing resolved this agent, so a `null` host is a REFUSAL to guess,
      // not evidence the active host is where it lives - `agent.stop` would
      // resolve the subtree from shared cloud storage and let the wrong host
      // report an empty `stoppedAgentIds` while the real agent kept running.
      expect(task.stoppable).toBe(false);
    });

    it("is true for a MOUNTED epic's null-host agent - the projection resolved it and recorded no host (a legacy chat)", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        mountedEpicIds: new Set(["epic-1"]),
        agentIdentities: new Map([
          [
            focusAgentKey("epic-1", "agent-1"),
            makeFocusAgentIdentity({ surface: "chat", hostId: null }),
          ],
        ]),
        activeHostId: "host-active",
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.agents[0]?.hostId).toBeNull();
      // This window is already talking to that epic's host (it resolved the
      // agent's identity), so the active-host guess is honest here.
      expect(task.stoppable).toBe(true);
    });

    it("is true when the agent's host equals activeHostId", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        coldEpicHostIds: new Map([["epic-1", "host-active"]]),
        activeHostId: "host-active",
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.agents[0]?.hostId).toBe("host-active");
      expect(task.stoppable).toBe(true);
    });

    it("is true when the agent's host is in reachableHostIds (and is not the active host)", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        coldEpicHostIds: new Map([["epic-1", "host-reachable"]]),
        activeHostId: "host-active",
        reachableHostIds: new Set(["host-reachable"]),
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.stoppable).toBe(true);
    });

    it("is false when the agent's host is neither the active host nor reachable", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
        coldEpicHostIds: new Map([["epic-1", "host-unreachable"]]),
        activeHostId: "host-active",
        reachableHostIds: new Set(["host-reachable"]),
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.stoppable).toBe(false);
    });

    it("is false for a MIXED task - one stoppable agent plus one unreachable agent - because it is an every, not a some", () => {
      const input = baseInput({
        byEpic: new Map([
          [
            "epic-1",
            makeEpicAgentActivity(["agent-stoppable", "agent-stuck"], []),
          ],
        ]),
        mountedEpicIds: new Set(["epic-1"]),
        agentIdentities: new Map([
          [
            focusAgentKey("epic-1", "agent-stoppable"),
            makeFocusAgentIdentity({ surface: "chat", hostId: "host-active" }),
          ],
          [
            focusAgentKey("epic-1", "agent-stuck"),
            makeFocusAgentIdentity({
              surface: "chat",
              hostId: "host-unreachable",
            }),
          ],
        ]),
        activeHostId: "host-active",
        reachableHostIds: new Set(),
      });

      const [task] = buildFocusTasks(input, []);

      expect(task.stoppable).toBe(false);
    });
  });

  describe("identity stability", () => {
    it("returns the same array reference when rebuilt from unchanged content", () => {
      const input = baseInput({
        byEpic: new Map([["epic-1", makeEpicAgentActivity(["agent-1"], [])]]),
      });

      const first = buildFocusTasks(input, []);
      const second = buildFocusTasks(input, first);

      expect(second).toBe(first);
    });

    it("leaves an unrelated task's row identical when only a sibling task changes", () => {
      const unrelatedActivity = makeEpicAgentActivity(["agent-1"], []);
      const before = baseInput({
        byEpic: new Map([
          ["epic-unrelated", unrelatedActivity],
          ["epic-changing", makeEpicAgentActivity(["agent-1"], [])],
        ]),
      });
      const firstResult = buildFocusTasks(before, []);
      const unrelatedRowBefore = firstResult.find(
        (task) => task.epicId === "epic-unrelated",
      );
      expect(unrelatedRowBefore).toBeDefined();

      const after = baseInput({
        byEpic: new Map([
          ["epic-unrelated", unrelatedActivity],
          [
            "epic-changing",
            makeEpicAgentActivity(["agent-1", "agent-2"], ["agent-2"]),
          ],
        ]),
      });
      const secondResult = buildFocusTasks(after, firstResult);
      const unrelatedRowAfter = secondResult.find(
        (task) => task.epicId === "epic-unrelated",
      );

      expect(unrelatedRowAfter).toBe(unrelatedRowBefore);
    });
  });
});
