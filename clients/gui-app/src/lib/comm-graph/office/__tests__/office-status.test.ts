import { describe, expect, it } from "vitest";
import type { AgentActivityTier } from "@/lib/agent-activity";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import {
  officeAgentStatuses,
  officeOpenRequestCounts,
} from "@/lib/comm-graph/office/office-status";

function event(
  overrides: Partial<CommGraphEvent> & {
    readonly id: number;
    readonly timestamp: number;
  },
): CommGraphEvent {
  return {
    hostId: "host-a",
    kind: "a2a_message",
    senderAgentId: "alpha",
    receiverAgentId: "beta",
    responseId: "thread-1",
    inReplyTo: null,
    expectReply: false,
    messageText: "hello",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    ...overrides,
  };
}

const ALPHA = { id: "alpha", archived: false };
const BETA = { id: "beta", archived: false };
const ARCHIVED_ALPHA = { id: "alpha", archived: true };

const NO_TIERS: ReadonlyMap<string, AgentActivityTier> = new Map();
const NO_ATTENTION: ReadonlySet<string> = new Set<string>();
const NO_FAILURE: ReadonlySet<string> = new Set<string>();
const BOTH_VISIBLE: ReadonlySet<string> = new Set(["alpha", "beta"]);

describe("officeAgentStatuses", () => {
  it("reports idle for an agent with nothing going on", () => {
    const statuses = officeAgentStatuses({
      agents: [ALPHA, BETA],
      events: [],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: NO_TIERS,
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: NO_FAILURE,
    });

    expect(statuses.get("alpha")).toBe("idle");
    expect(statuses.get("beta")).toBe("idle");
  });

  it("marks the SENDER of an unanswered request as awaiting", () => {
    const statuses = officeAgentStatuses({
      agents: [ALPHA, BETA],
      events: [event({ id: 1, timestamp: 10, expectReply: true })],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: NO_TIERS,
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: NO_FAILURE,
    });

    expect(statuses.get("alpha")).toBe("awaiting");
    // The receiver owes an answer; it is not the one waiting for one.
    expect(statuses.get("beta")).toBe("idle");
  });

  it("clears awaiting once the thread is answered", () => {
    const statuses = officeAgentStatuses({
      agents: [ALPHA, BETA],
      events: [
        event({ id: 1, timestamp: 10, expectReply: true }),
        event({
          id: 2,
          timestamp: 11,
          senderAgentId: "beta",
          receiverAgentId: "alpha",
          inReplyTo: "thread-1",
        }),
      ],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: NO_TIERS,
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: NO_FAILURE,
    });

    expect(statuses.get("alpha")).toBe("idle");
  });

  it("re-opens awaiting when the thread is asked again after a reply", () => {
    const statuses = officeAgentStatuses({
      agents: [ALPHA, BETA],
      events: [
        event({ id: 1, timestamp: 10, expectReply: true }),
        event({
          id: 2,
          timestamp: 11,
          senderAgentId: "beta",
          receiverAgentId: "alpha",
          inReplyTo: "thread-1",
        }),
        event({ id: 3, timestamp: 12, expectReply: true }),
      ],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: NO_TIERS,
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: NO_FAILURE,
    });

    expect(statuses.get("alpha")).toBe("awaiting");
  });

  it("puts a failure above every other reading, attention included", () => {
    const statuses = officeAgentStatuses({
      agents: [ARCHIVED_ALPHA],
      events: [event({ id: 1, timestamp: 10, expectReply: true })],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: new Map<string, AgentActivityTier>([["alpha", "turn"]]),
      attentionAgentIds: new Set(["alpha"]),
      failureAgentIds: new Set(["alpha"]),
    });

    // Every other reading is simultaneously true here; a crashed agent is
    // still the one thing worth walking over to.
    expect(statuses.get("alpha")).toBe("failure");
  });

  it("has nothing to say about a failure on an agent off the floor", () => {
    const statuses = officeAgentStatuses({
      agents: [ALPHA, BETA],
      events: [],
      visibleAgentIds: new Set(["beta"]),
      activityTiers: NO_TIERS,
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: new Set(["alpha"]),
    });

    expect(statuses.has("alpha")).toBe(false);
    expect(statuses.get("beta")).toBe("idle");
  });

  it("puts attention above every other reading", () => {
    const statuses = officeAgentStatuses({
      agents: [ALPHA],
      events: [event({ id: 1, timestamp: 10, expectReply: true })],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: new Map<string, AgentActivityTier>([["alpha", "turn"]]),
      attentionAgentIds: new Set(["alpha"]),
      failureAgentIds: NO_FAILURE,
    });

    expect(statuses.get("alpha")).toBe("attention");
  });

  it("ranks awaiting above an active turn", () => {
    const statuses = officeAgentStatuses({
      agents: [ALPHA],
      events: [event({ id: 1, timestamp: 10, expectReply: true })],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: new Map<string, AgentActivityTier>([["alpha", "turn"]]),
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: NO_FAILURE,
    });

    expect(statuses.get("alpha")).toBe("awaiting");
  });

  it("separates a turn from background work", () => {
    const statuses = officeAgentStatuses({
      agents: [ALPHA, BETA],
      events: [],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: new Map<string, AgentActivityTier>([
        ["alpha", "turn"],
        ["beta", "background"],
      ]),
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: NO_FAILURE,
    });

    expect(statuses.get("alpha")).toBe("working");
    expect(statuses.get("beta")).toBe("background");
  });

  it("shows archived over background and idle, but never over a turn", () => {
    const quiet = officeAgentStatuses({
      agents: [ARCHIVED_ALPHA],
      events: [],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: NO_TIERS,
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: NO_FAILURE,
    });
    expect(quiet.get("alpha")).toBe("archived");

    const background = officeAgentStatuses({
      agents: [ARCHIVED_ALPHA],
      events: [],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: new Map<string, AgentActivityTier>([
        ["alpha", "background"],
      ]),
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: NO_FAILURE,
    });
    expect(background.get("alpha")).toBe("archived");

    // An archived agent should not be mid-turn; if the record says it is, the
    // floor shows what the record says rather than hiding it.
    const working = officeAgentStatuses({
      agents: [ARCHIVED_ALPHA],
      events: [],
      visibleAgentIds: BOTH_VISIBLE,
      activityTiers: new Map<string, AgentActivityTier>([["alpha", "turn"]]),
      attentionAgentIds: NO_ATTENTION,
      failureAgentIds: NO_FAILURE,
    });
    expect(working.get("alpha")).toBe("working");
  });

  it("has nothing to say about an agent that does not exist yet", () => {
    const statuses = officeAgentStatuses({
      agents: [ALPHA, BETA],
      events: [event({ id: 1, timestamp: 10, expectReply: true })],
      visibleAgentIds: new Set(["beta"]),
      activityTiers: new Map<string, AgentActivityTier>([["alpha", "turn"]]),
      attentionAgentIds: new Set(["alpha"]),
      failureAgentIds: NO_FAILURE,
    });

    expect(statuses.has("alpha")).toBe(false);
    // The open request's sender is off the floor, so nobody inherits its wait.
    expect(statuses.get("beta")).toBe("idle");
  });
});

describe("officeOpenRequestCounts", () => {
  it("counts nothing when no request is waiting on an answer", () => {
    const counts = officeOpenRequestCounts(
      [event({ id: 1, timestamp: 10 })],
      BOTH_VISIBLE,
    );

    expect(counts.size).toBe(0);
  });

  it("piles every unanswered request on its RECEIVER's desk", () => {
    const counts = officeOpenRequestCounts(
      [
        event({ id: 1, timestamp: 10, expectReply: true }),
        event({
          id: 2,
          timestamp: 11,
          responseId: "thread-2",
          expectReply: true,
        }),
        event({
          id: 3,
          timestamp: 12,
          responseId: "thread-3",
          senderAgentId: "beta",
          receiverAgentId: "alpha",
          expectReply: true,
        }),
      ],
      BOTH_VISIBLE,
    );

    // The sender is the one AWAITING; the pile belongs to whoever owes the
    // answer, which is the other end of the same open request.
    expect(counts.get("beta")).toBe(2);
    expect(counts.get("alpha")).toBe(1);
  });

  it("drops a request once its thread is answered", () => {
    const counts = officeOpenRequestCounts(
      [
        event({ id: 1, timestamp: 10, expectReply: true }),
        event({
          id: 2,
          timestamp: 11,
          senderAgentId: "beta",
          receiverAgentId: "alpha",
          inReplyTo: "thread-1",
        }),
      ],
      BOTH_VISIBLE,
    );

    expect(counts.size).toBe(0);
  });

  it("keeps a pile off a desk that is not on the floor", () => {
    const counts = officeOpenRequestCounts(
      [event({ id: 1, timestamp: 10, expectReply: true })],
      new Set(["alpha"]),
    );

    expect(counts.has("beta")).toBe(false);
  });
});
