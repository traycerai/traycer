import { describe, expect, it } from "vitest";
import {
  chatFallbackRunManualRungRequestSchema,
  type ChatFallbackRunManualRungRequest,
} from "@traycer/protocol/host/chat-fallback";
import type { ChatRunSettings } from "@traycer/protocol/persistence/epic/foundation";

/**
 * The `rung`/`target` coupling on `chat.fallback.runManualRung`.
 *
 * Before the schema carried it, every combination parsed and the two illegal
 * ones failed SILENTLY, in opposite directions. `{ rung: "switch", target: null }`
 * reached the engine, which had nothing to switch to and could only answer
 * `rung_unavailable` - the deliberately NEUTRAL outcome, which renders as "that
 * action isn't available right now" over a menu the user had just picked from.
 * A `target` sent with `retry` or `wait_once` produced no refusal at all: both
 * rungs read the chat's own settings, so the destination was discarded and the
 * chat carried on against the tuple that had just failed - re-dispatched now
 * for `retry`, parked on that tuple's reset boundary for `wait_once`.
 *
 * Every rejection below is checked by its ISSUE PATH rather than by
 * `success: false` alone. A fixture malformed for some unrelated reason would
 * fail all of these cells while proving nothing about the coupling.
 */

type ManualRung = ChatFallbackRunManualRungRequest["rung"];

const RUNGS = chatFallbackRunManualRungRequestSchema.shape.rung.options;

const TARGET: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-opus-5",
  permissionMode: "full_access",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function manualRungRequest(
  rung: ManualRung,
  target: ChatRunSettings | null,
): ChatFallbackRunManualRungRequest {
  return {
    epicId: "epic-1",
    chatId: "chat-1",
    rung,
    target,
    userMessageId: "user-message-1",
    turnId: "turn-1",
  };
}

function parses(rung: ManualRung, target: ChatRunSettings | null): boolean {
  return chatFallbackRunManualRungRequestSchema.safeParse(
    manualRungRequest(rung, target),
  ).success;
}

function issuePaths(
  rung: ManualRung,
  target: ChatRunSettings | null,
): unknown[] {
  const result = chatFallbackRunManualRungRequestSchema.safeParse(
    manualRungRequest(rung, target),
  );
  return result.success ? [] : result.error.issues.map((issue) => issue.path);
}

describe("chat.fallback.runManualRung couples rung to target", () => {
  // The rungs are read off the schema rather than retyped, so the cells below
  // are about the RULE and not about a list that happens to agree with it
  // today. The exact-count pin is what keeps that from going vacuous: a fourth
  // rung reddens here and has to state its own target rule before it can ship.
  it("has exactly three rungs, only one of which takes a target", () => {
    expect([...RUNGS]).toEqual(["retry", "switch", "wait_once"]);
  });

  it("accepts `switch` with a target", () => {
    expect(parses("switch", TARGET)).toBe(true);
  });

  it("refuses `switch` with nothing to switch to", () => {
    expect(issuePaths("switch", null)).toEqual([["target"]]);
  });

  it("refuses a target on every rung that would discard it, and accepts null there", () => {
    const discardingRungs = RUNGS.filter((rung) => rung !== "switch");
    // Without this the loop below could iterate zero times and still pass.
    expect(discardingRungs).toEqual(["retry", "wait_once"]);
    for (const rung of discardingRungs) {
      expect(issuePaths(rung, TARGET)).toEqual([["target"]]);
      expect(parses(rung, null)).toBe(true);
    }
  });
});
