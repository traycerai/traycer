import { describe, expect, it } from "vitest";
import { feedbackDraftRefusalMessage } from "../use-chat-feedback-draft";

describe("feedbackDraftRefusalMessage", () => {
  it("says nothing for a settled decision", () => {
    expect(
      feedbackDraftRefusalMessage({
        kind: "settled",
        feedbackDraft: { state: "skipped" } as never,
      }),
    ).toBeNull();
  });

  it("says nothing for already-decided, whose stamp the card shows", () => {
    expect(
      feedbackDraftRefusalMessage({
        kind: "error",
        code: "already-decided",
        feedbackDraft: { state: "sent" } as never,
      }),
    ).toBeNull();
  });

  it.each(["not-allowed", "session-unavailable", "not-draft-block"] as const)(
    "tells the user nothing was sent on %s",
    (code) => {
      expect(
        feedbackDraftRefusalMessage({
          kind: "error",
          code,
          feedbackDraft: null,
        }),
      ).toMatch(/^Nothing was sent/);
    },
  );
});
