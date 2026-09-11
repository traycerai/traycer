import { describe, expect, it } from "vitest";
import {
  APPROVAL_PAUSED_LINE,
  JUDGE_CAP_NOTICE,
  approvalWaitLine,
  isJudgeUnavailableReason,
  judgeWaitDisclosure,
} from "@/components/chat/segments/approval-card-disclosure";

describe("judgeWaitDisclosure", () => {
  it("shows neither the elapsed counter nor the cap notice below the first rung", () => {
    expect(judgeWaitDisclosure(14)).toEqual({
      elapsedLabel: null,
      capNotice: null,
    });
  });

  it("shows only the elapsed counter once the first rung is reached", () => {
    expect(judgeWaitDisclosure(16)).toEqual({
      elapsedLabel: "16s",
      capNotice: null,
    });
  });

  it("adds the cap notice once the second rung is reached", () => {
    expect(judgeWaitDisclosure(31)).toEqual({
      elapsedLabel: "31s",
      capNotice: JUDGE_CAP_NOTICE,
    });
  });
});

describe("isJudgeUnavailableReason", () => {
  it("recognizes the 'auto: ' prefix every unavailability constant is built with", () => {
    expect(
      isJudgeUnavailableReason(
        "auto: judge unavailable (traycer: not signed in)",
      ),
    ).toBe(true);
  });

  it("does not treat the judge's own reasoning prose as an unavailability string", () => {
    expect(isJudgeUnavailableReason("This rewrites remote history.")).toBe(
      false,
    );
  });
});

describe("approvalWaitLine", () => {
  const REQUESTED_AT = 1_000_000;

  it("returns null under a minute", () => {
    expect(
      approvalWaitLine({
        requestedAt: REQUESTED_AT,
        nowMs: REQUESTED_AT + 59_000,
      }),
    ).toBeNull();
  });

  it("states the singular '1 minute' at exactly 60 seconds", () => {
    const result = approvalWaitLine({
      requestedAt: REQUESTED_AT,
      nowMs: REQUESTED_AT + 60_000,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Waiting for you since ");
    expect(result).toContain("· 1 minute");
    expect(result).not.toContain("1 minutes");
  });

  it("states the plural minutes at 12 minutes", () => {
    const result = approvalWaitLine({
      requestedAt: REQUESTED_AT,
      nowMs: REQUESTED_AT + 12 * 60_000,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Waiting for you since ");
    expect(result).toContain("· 12 minutes");
  });

  it("switches to hours once the wait crosses an hour", () => {
    const result = approvalWaitLine({
      requestedAt: REQUESTED_AT,
      nowMs: REQUESTED_AT + 2 * 3_600_000,
    });
    expect(result).toContain("· 2 hours");
  });

  it("switches to days once the wait crosses a day", () => {
    const result = approvalWaitLine({
      requestedAt: REQUESTED_AT,
      nowMs: REQUESTED_AT + 3 * 86_400_000,
    });
    expect(result).toContain("· 3 days");
  });
});

describe("APPROVAL_PAUSED_LINE", () => {
  it("is the exact companion sentence", () => {
    expect(APPROVAL_PAUSED_LINE).toBe("This turn is paused until you answer.");
  });
});
