import { describe, expect, it } from "vitest";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  selectActiveThinkingTokensEstimate,
  thinkingTokensAfterFrame,
  thinkingTokensAfterTurnState,
  thinkingTokensFromSnapshot,
} from "@/stores/chats/chat-thinking-tokens";

function turn(turnId: string, status: ChatActiveTurn["status"]): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId,
    status,
    harnessId: "claude",
    model: "claude-sonnet-5",
    profileId: null,
    userMessageId: "message-1",
    startedAt: 1,
    updatedAt: 1,
    reasoningEffort: null,
    serviceTier: null,
  };
}

const LIVE_STATUSES: ChatActiveTurn["status"][] = [
  "starting",
  "running",
  "stopping",
];
const TERMINAL_STATUSES: ChatActiveTurn["status"][] = [
  "completed",
  "stopped",
  "interrupted",
  "errored",
];

describe("thinkingTokensFromSnapshot", () => {
  it("pairs the estimate with the live active turn", () => {
    for (const status of LIVE_STATUSES) {
      expect(thinkingTokensFromSnapshot(turn("t1", status), 50)).toEqual({
        turnId: "t1",
        estimate: 50,
      });
    }
  });

  it("is null without an estimate, without a turn, or with a terminal turn", () => {
    expect(thinkingTokensFromSnapshot(turn("t1", "running"), undefined)).toBe(
      null,
    );
    expect(thinkingTokensFromSnapshot(null, 50)).toBe(null);
    for (const status of TERMINAL_STATUSES) {
      expect(thinkingTokensFromSnapshot(turn("t1", status), 50)).toBe(null);
    }
  });
});

describe("thinkingTokensAfterTurnState", () => {
  const current = { turnId: "t1", estimate: 10 };

  it("keeps the reading only while the same turn is live", () => {
    expect(thinkingTokensAfterTurnState(current, turn("t1", "running"))).toBe(
      current,
    );
  });

  it("clears on turn end, no turn, or a different turn", () => {
    expect(thinkingTokensAfterTurnState(current, null)).toBe(null);
    expect(thinkingTokensAfterTurnState(current, turn("t1", "completed"))).toBe(
      null,
    );
    expect(thinkingTokensAfterTurnState(current, turn("t2", "running"))).toBe(
      null,
    );
  });

  it("stays null when there was no reading", () => {
    expect(thinkingTokensAfterTurnState(null, turn("t1", "running"))).toBe(
      null,
    );
  });
});

describe("thinkingTokensAfterFrame", () => {
  const current = { turnId: "t1", estimate: 10 };

  it("applies a frame for the live active turn", () => {
    expect(
      thinkingTokensAfterFrame(current, turn("t1", "running"), {
        turnId: "t1",
        estimate: 20,
      }),
    ).toEqual({ turnId: "t1", estimate: 20 });
    expect(
      thinkingTokensAfterFrame(null, turn("t1", "starting"), {
        turnId: "t1",
        estimate: 5,
      }),
    ).toEqual({ turnId: "t1", estimate: 5 });
  });

  it("ignores a frame for another turn, a terminal turn, or no turn", () => {
    const frame = { turnId: "t2", estimate: 99 };
    expect(thinkingTokensAfterFrame(current, turn("t1", "running"), frame)).toBe(
      current,
    );
    expect(
      thinkingTokensAfterFrame(current, turn("t2", "completed"), frame),
    ).toBe(current);
    expect(thinkingTokensAfterFrame(current, null, frame)).toBe(current);
    expect(thinkingTokensAfterFrame(null, null, frame)).toBe(null);
  });

  it("returns the same reference for an unchanged number", () => {
    expect(
      thinkingTokensAfterFrame(current, turn("t1", "running"), {
        turnId: "t1",
        estimate: 10,
      }),
    ).toBe(current);
  });
});

describe("selectActiveThinkingTokensEstimate", () => {
  it("returns the estimate only for the matching live turn", () => {
    const reading = { turnId: "t1", estimate: 7 };
    expect(
      selectActiveThinkingTokensEstimate({
        activeTurn: turn("t1", "running"),
        thinkingTokens: reading,
      }),
    ).toBe(7);
    expect(
      selectActiveThinkingTokensEstimate({
        activeTurn: turn("t2", "running"),
        thinkingTokens: reading,
      }),
    ).toBe(null);
    expect(
      selectActiveThinkingTokensEstimate({
        activeTurn: turn("t1", "completed"),
        thinkingTokens: reading,
      }),
    ).toBe(null);
    expect(
      selectActiveThinkingTokensEstimate({
        activeTurn: null,
        thinkingTokens: reading,
      }),
    ).toBe(null);
    expect(
      selectActiveThinkingTokensEstimate({
        activeTurn: turn("t1", "running"),
        thinkingTokens: null,
      }),
    ).toBe(null);
  });
});
