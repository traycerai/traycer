import { describe, expect, it } from "vitest";
import {
  APPROVAL_PAUSED_LINE,
  JUDGE_CAP_NOTICE,
  JUDGE_DID_NOT_RUN_HUMAN_LINE,
  JUDGE_NO_VERDICT_HUMAN_LINE,
  JUDGE_OUT_OF_TIME_HUMAN_LINE,
  approvalWaitLine,
  isJudgeUnavailableReason,
  judgeFailureFamily,
  judgeUnavailableHumanLine,
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

describe("judgeFailureFamily", () => {
  // These are the host's machine strings (traycer-host/src/domain/chat/auto-judge/auto-judge-service.ts),
  // restated as literals ON PURPOSE: they reach the client only as free text
  // on the wire, and the point of this test is that a host that renames one
  // goes red here. Do not import them, do not build them from a helper.
  it("classifies 'did not run' strings", () => {
    expect(judgeFailureFamily("auto: no judge configured")).toBe("did-not-run");
    expect(judgeFailureFamily("auto: judge failed")).toBe("did-not-run");
    expect(
      judgeFailureFamily(
        "auto: judge unavailable (Traycer is still checking whether the judge provider is available on this machine)",
      ),
    ).toBe("did-not-run");
    expect(
      judgeFailureFamily(
        "auto: judge unavailable (the judge returned no text)",
      ),
    ).toBe("did-not-run");
  });

  it("classifies 'ran without deciding' strings", () => {
    expect(judgeFailureFamily("auto: judge returned no verdict")).toBe(
      "no-verdict",
    );
    expect(judgeFailureFamily("auto: unparseable verdict")).toBe("no-verdict");
  });

  it("classifies 'ran out of time' strings", () => {
    expect(judgeFailureFamily("auto: judge timed out")).toBe("out-of-time");
    expect(judgeFailureFamily("auto: judge exceeded 2 min")).toBe(
      "out-of-time",
    );
  });

  // These four are deliberately null, not an oversight: the ticket names
  // three families and each of these constants is already truthfully
  // described by the "couldn't run the judge" fallback, so they stay out of
  // the map rather than being force-fit into a family whose copy would be
  // wrong for them.
  it("falls back to null for recognised-but-uncategorised 'auto: ' strings", () => {
    expect(judgeFailureFamily("auto: turn stopped")).toBeNull();
    expect(judgeFailureFamily("auto: judge preflight timed out")).toBeNull();
    expect(judgeFailureFamily("auto: judge tools unavailable")).toBeNull();
    expect(
      judgeFailureFamily("auto: account policy could not be read"),
    ).toBeNull();
  });

  it("returns null for the judge's own reasoning prose", () => {
    expect(judgeFailureFamily("This rewrites remote history.")).toBeNull();
  });

  // The cap interpolates the host's stage-2 cap in minutes (2 today), so this
  // matches on the prefix rather than the exact string - the client cannot
  // read that host constant, and the match must survive it moving.
  it("classifies a different interpolated cap value via the prefix match", () => {
    expect(judgeFailureFamily("auto: judge exceeded 3 min")).toBe(
      "out-of-time",
    );
  });
});

describe("the three judge-unavailable human lines", () => {
  it("are the exact sentences", () => {
    expect(JUDGE_DID_NOT_RUN_HUMAN_LINE).toBe(
      "Traycer couldn't run the judge, so it's asking you instead.",
    );
    expect(JUDGE_NO_VERDICT_HUMAN_LINE).toBe(
      "The judge reviewed this but didn't reach a verdict, so it's asking you instead.",
    );
    expect(JUDGE_OUT_OF_TIME_HUMAN_LINE).toBe(
      "The judge didn't finish in time, so it's asking you instead.",
    );
  });
});

describe("judgeUnavailableHumanLine", () => {
  it("returns the did-not-run line for a did-not-run string", () => {
    expect(judgeUnavailableHumanLine("auto: no judge configured")).toBe(
      JUDGE_DID_NOT_RUN_HUMAN_LINE,
    );
  });

  it("returns the no-verdict line for a no-verdict string", () => {
    expect(judgeUnavailableHumanLine("auto: judge returned no verdict")).toBe(
      JUDGE_NO_VERDICT_HUMAN_LINE,
    );
  });

  it("returns the out-of-time line for an out-of-time string", () => {
    expect(judgeUnavailableHumanLine("auto: judge timed out")).toBe(
      JUDGE_OUT_OF_TIME_HUMAN_LINE,
    );
  });

  it("falls back to the did-not-run line for an unrecognised 'auto: ' string", () => {
    expect(judgeUnavailableHumanLine("auto: judge went fishing")).toBe(
      JUDGE_DID_NOT_RUN_HUMAN_LINE,
    );
  });

  it("falls back to the did-not-run line for each recognised-but-uncategorised constant", () => {
    expect(judgeUnavailableHumanLine("auto: turn stopped")).toBe(
      JUDGE_DID_NOT_RUN_HUMAN_LINE,
    );
    expect(judgeUnavailableHumanLine("auto: judge preflight timed out")).toBe(
      JUDGE_DID_NOT_RUN_HUMAN_LINE,
    );
    expect(judgeUnavailableHumanLine("auto: judge tools unavailable")).toBe(
      JUDGE_DID_NOT_RUN_HUMAN_LINE,
    );
    expect(
      judgeUnavailableHumanLine("auto: account policy could not be read"),
    ).toBe(JUDGE_DID_NOT_RUN_HUMAN_LINE);
  });
});
