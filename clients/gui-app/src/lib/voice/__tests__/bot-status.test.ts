import { describe, expect, it } from "vitest";
import {
  composeBotStatus,
  STATUS_FOLLOW_UP,
  type BotStatusFacts,
} from "../bot-status";

function facts(overrides: Partial<BotStatusFacts>): BotStatusFacts {
  return {
    botTitle: "Release bot",
    activity: null,
    tasks: 0,
    working: false,
    finishedThisWeek: 0,
    costUsd: null,
    costWindowDays: 7,
    ...overrides,
  };
}

describe("composeBotStatus", () => {
  it("says that work is going on in its tasks, and claims no count of agents", () => {
    const text = composeBotStatus(facts({ tasks: 1, working: true }));

    expect(text).toBe(
      `It runs 1 task, with work going on now. ${STATUS_FOLLOW_UP}`,
    );
    expect(text).not.toContain("agent");
  });

  it("says that work is going on when the bot runs no task of its own", () => {
    const text = composeBotStatus(facts({ working: true }));

    expect(text).toContain("It has work going on now.");
    expect(text).not.toContain("task");
    expect(text).not.toContain("agent");
  });

  it("says the tasks it runs, and no work going on, when nothing is running", () => {
    const text = composeBotStatus(facts({ tasks: 2 }));

    expect(text).toContain("It runs 2 tasks.");
    expect(text).not.toContain("work going on");
  });
});
