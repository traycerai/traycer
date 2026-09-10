import { describe, expect, it } from "vitest";
import { FALLBACK_ACTION_OUTCOMES } from "@traycer/protocol/host/chat-fallback";
import {
  describeFallbackOutcome,
  fallbackLowUsageClause,
  fallbackReasonLabelFor,
  queuedMessagesMovingText,
  queuedMessagesReturningText,
  queuedMessagesWaitingText,
  siblingSwitchingText,
} from "@/components/chat/fallback/fallback-copy";

describe("describeFallbackOutcome", () => {
  it("returns null for applied and a sentence for every other FALLBACK_ACTION_OUTCOMES member", () => {
    for (const outcome of FALLBACK_ACTION_OUTCOMES) {
      const text = describeFallbackOutcome(outcome);
      if (outcome === "applied") {
        expect(text).toBeNull();
      } else {
        expect(text).not.toBeNull();
        expect(text).not.toBe("");
      }
    }
  });
});

describe("fallbackReasonLabelFor", () => {
  it("returns the shared label for a known code", () => {
    expect(fallbackReasonLabelFor("auth")).toBe("Signed out");
    expect(fallbackReasonLabelFor("rate_limit")).toBe("Rate limit reached");
  });

  it("returns null for an unrecognised code rather than echoing it", () => {
    // Falsification: make fallbackReasonLabelFor return the raw reason string as a fallback and THIS assertion must go red.
    expect(
      fallbackReasonLabelFor("something_this_build_has_never_heard_of"),
    ).toBeNull();
  });
});

describe("queued message copy family", () => {
  it("hides all three helpers at zero and uses singular vs plural above it", () => {
    expect(queuedMessagesMovingText(0)).toBeNull();
    expect(queuedMessagesWaitingText(0)).toBeNull();
    expect(queuedMessagesReturningText(0)).toBeNull();

    expect(queuedMessagesMovingText(1)).toBe(
      "1 queued message will run on the new settings too.",
    );
    expect(queuedMessagesWaitingText(1)).toBe(
      "1 queued message is waiting with it.",
    );
    expect(queuedMessagesReturningText(1)).toBe(
      " and moves 1 queued message back",
    );

    expect(queuedMessagesMovingText(3)).toBe(
      "3 queued messages will run on the new settings too.",
    );
    expect(queuedMessagesWaitingText(3)).toBe(
      "3 queued messages are waiting with it.",
    );
    expect(queuedMessagesReturningText(3)).toBe(
      " and moves 3 queued messages back",
    );
  });

  it("keeps the three helpers saying different things on purpose", () => {
    const moving = queuedMessagesMovingText(2);
    const waiting = queuedMessagesWaitingText(2);
    const returning = queuedMessagesReturningText(2);
    expect(moving).not.toBe(waiting);
    expect(moving).not.toBe(returning);
    expect(waiting).not.toBe(returning);
    expect(waiting).not.toMatch(/new settings/);
    expect(waiting).not.toMatch(/back/);
    expect(moving).toMatch(/new settings/);
    expect(returning).toMatch(/back/);
  });
});

describe("fallbackLowUsageClause", () => {
  it("says 'running low' for near_limit with no named family", () => {
    // Falsification: swap the severity check so hard_limit renders "running low" and THIS assertion must go red.
    expect(
      fallbackLowUsageClause({
        accountName: "work-account",
        severity: "near_limit",
        limitedFamilies: [],
      }),
    ).toBe("work-account is running low on usage");
  });

  it("says 'reached its rate limit' for hard_limit with no named family", () => {
    // Falsification: swap the severity check so near_limit renders "has reached its" and THIS assertion must go red.
    expect(
      fallbackLowUsageClause({
        accountName: "work-account",
        severity: "hard_limit",
        limitedFamilies: [],
      }),
    ).toBe("work-account has reached its rate limit");
  });

  it("names a single family as the qualifier before 'usage'", () => {
    // Falsification: drop the limitedFamilies qualifier from the near_limit branch and THIS assertion must go red.
    expect(
      fallbackLowUsageClause({
        accountName: "work-account",
        severity: "near_limit",
        limitedFamilies: ["Fable"],
      }),
    ).toBe("work-account is running low on Fable usage");
  });

  it("joins multiple families with ', ' before 'rate limit'", () => {
    // Falsification: join limitedFamilies with " and " instead of ", " and THIS assertion must go red.
    expect(
      fallbackLowUsageClause({
        accountName: "work-account",
        severity: "hard_limit",
        limitedFamilies: ["Fable", "Opus"],
      }),
    ).toBe("work-account has reached its Fable, Opus rate limit");
  });
});

describe("siblingSwitchingText", () => {
  it("is null at zero and singular vs plural above it", () => {
    expect(siblingSwitchingText(0)).toBeNull();
    expect(siblingSwitchingText(1)).toBe(
      "1 other chat in this task is also switching.",
    );
    expect(siblingSwitchingText(4)).toBe(
      "4 other chats in this task are also switching.",
    );
  });
});
