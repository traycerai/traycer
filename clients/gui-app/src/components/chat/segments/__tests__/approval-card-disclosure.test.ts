import { describe, expect, it } from "vitest";
import {
  APPROVAL_PAUSED_LINE,
  JUDGE_CAP_NOTICE,
  JUDGE_FIX_IN_SETTINGS_LABEL,
  JUDGE_NO_VERDICT_HUMAN_LINE,
  JUDGE_OUT_OF_TIME_HUMAN_LINE,
  approvalWaitLine,
  isJudgeUnavailableReason,
  judgeCouldNotRunSentence,
  judgeFailureFamily,
  judgeUnavailableCause,
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

  it("shows the elapsed counter at exactly the first rung, without the cap notice", () => {
    expect(judgeWaitDisclosure(15)).toEqual({
      elapsedLabel: "15s",
      capNotice: null,
    });
  });

  it("adds the cap notice at exactly the second rung", () => {
    expect(judgeWaitDisclosure(30)).toEqual({
      elapsedLabel: "30s",
      capNotice: JUDGE_CAP_NOTICE,
    });
  });

  it("adds the cap notice once the second rung is reached", () => {
    expect(judgeWaitDisclosure(31)).toEqual({
      elapsedLabel: "31s",
      capNotice: JUDGE_CAP_NOTICE,
    });
  });
});

describe("JUDGE_CAP_NOTICE", () => {
  it("is per check, and names the checks as serialized", () => {
    expect(JUDGE_CAP_NOTICE).toBe(
      "Checks run one at a time, up to 2 minutes each, then it asks you. Stop the turn to cancel.",
    );
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

  it("classifies a different interpolated cap value via the prefix match", () => {
    expect(judgeFailureFamily("auto: judge exceeded 3 min")).toBe(
      "out-of-time",
    );
  });
});

describe("judgeUnavailableCause", () => {
  it("extracts the cause inside the parenthesised unavailable string", () => {
    expect(
      judgeUnavailableCause("auto: judge unavailable (not signed in)"),
    ).toBe("not signed in");
  });

  it("strips trailing dots from the extracted cause", () => {
    expect(
      judgeUnavailableCause("auto: judge unavailable (not signed in...)"),
    ).toBe("not signed in");
  });

  it("returns null for a string with no parenthesised cause", () => {
    expect(judgeUnavailableCause("auto: judge timed out")).toBeNull();
  });

  it("returns null for the judge's own reasoning prose", () => {
    expect(judgeUnavailableCause("This rewrites remote history.")).toBeNull();
  });
});

describe("judgeCouldNotRunSentence", () => {
  it("names the cause when one is given", () => {
    expect(judgeCouldNotRunSentence("not signed in")).toBe(
      "The judge couldn't run: not signed in.",
    );
  });

  it("falls back to the bare sentence when there is no cause", () => {
    expect(judgeCouldNotRunSentence(null)).toBe("The judge couldn't run.");
  });
});

describe("JUDGE_FIX_IN_SETTINGS_LABEL", () => {
  it("is the exact link label", () => {
    expect(JUDGE_FIX_IN_SETTINGS_LABEL).toBe("Fix in Permissions ▸ Judge");
  });
});

describe("judgeUnavailableHumanLine", () => {
  it("returns the couldn't-run sentence with its cause and the settings link for a did-not-run string", () => {
    expect(
      judgeUnavailableHumanLine(
        "auto: judge unavailable (traycer: not signed in)",
      ),
    ).toEqual({
      sentence: "The judge couldn't run: traycer: not signed in.",
      fixInJudgeSettings: true,
    });
  });

  it("returns the bare couldn't-run sentence with the settings link for a cause-less did-not-run string", () => {
    expect(judgeUnavailableHumanLine("auto: no judge configured")).toEqual({
      sentence: "The judge couldn't run.",
      fixInJudgeSettings: true,
    });
  });

  it("returns the no-verdict line with no settings link", () => {
    expect(
      judgeUnavailableHumanLine("auto: judge returned no verdict"),
    ).toEqual({
      sentence: JUDGE_NO_VERDICT_HUMAN_LINE,
      fixInJudgeSettings: false,
    });
  });

  it("returns the out-of-time line with no settings link", () => {
    expect(judgeUnavailableHumanLine("auto: judge timed out")).toEqual({
      sentence: JUDGE_OUT_OF_TIME_HUMAN_LINE,
      fixInJudgeSettings: false,
    });
  });

  it("falls back to the couldn't-run sentence with the settings link for an unrecognised 'auto: ' string", () => {
    expect(judgeUnavailableHumanLine("auto: judge went fishing")).toEqual({
      sentence: "The judge couldn't run.",
      fixInJudgeSettings: true,
    });
  });

  it("falls back to the couldn't-run sentence for each recognised-but-uncategorised constant", () => {
    expect(judgeUnavailableHumanLine("auto: turn stopped")).toEqual({
      sentence: "The judge couldn't run.",
      fixInJudgeSettings: true,
    });
    expect(
      judgeUnavailableHumanLine("auto: judge preflight timed out"),
    ).toEqual({
      sentence: "The judge couldn't run.",
      fixInJudgeSettings: true,
    });
    expect(judgeUnavailableHumanLine("auto: judge tools unavailable")).toEqual({
      sentence: "The judge couldn't run.",
      fixInJudgeSettings: true,
    });
    expect(
      judgeUnavailableHumanLine("auto: account policy could not be read"),
    ).toEqual({
      sentence: "The judge couldn't run.",
      fixInJudgeSettings: true,
    });
  });
});

/**
 * Finding: the host builds a stage-2 failure reason as
 * `${machineReason} (${stageOneReason})` - e.g. `auto: judge unavailable (the
 * judge provider is not signed in) (This rewrites remote history.)`. The
 * cause must be the FIRST BALANCED parenthesised group after `auto: judge
 * unavailable `, keeping parentheses INSIDE that group, and leaving the
 * appended stage-one explanation out entirely.
 */
describe("judgeUnavailableCause with an appended stage-one explanation", () => {
  it("extracts only the first balanced group, leaving the appended stage-one explanation out", () => {
    expect(
      judgeUnavailableCause(
        "auto: judge unavailable (the judge provider is not signed in) (This rewrites remote history.)",
      ),
    ).toBe("the judge provider is not signed in");
  });

  it("keeps parentheses that are INSIDE the first balanced group (nested parens)", () => {
    expect(
      judgeUnavailableCause(
        "auto: judge unavailable (rate limited (429)) (Stage one said so.)",
      ),
    ).toBe("rate limited (429)");
    expect(
      judgeUnavailableCause("auto: judge unavailable (rate limited (429))"),
    ).toBe("rate limited (429)");
  });

  it("returns null for an unclosed group", () => {
    expect(judgeUnavailableCause("auto: judge unavailable (oops")).toBeNull();
  });
});

describe("judgeUnavailableHumanLine with an appended stage-one explanation", () => {
  it("names only the first balanced group as the cause, not the appended stage-one explanation", () => {
    expect(
      judgeUnavailableHumanLine(
        "auto: judge unavailable (the judge provider is not signed in) (This rewrites remote history.)",
      ),
    ).toEqual({
      sentence: "The judge couldn't run: the judge provider is not signed in.",
      fixInJudgeSettings: true,
    });
  });

  it("still resolves the out-of-time family through an appended stage-one explanation", () => {
    expect(judgeUnavailableHumanLine("auto: judge timed out (x)")).toEqual({
      sentence: JUDGE_OUT_OF_TIME_HUMAN_LINE,
      fixInJudgeSettings: false,
    });
  });

  it("still resolves the no-verdict family through an appended stage-one explanation", () => {
    expect(
      judgeUnavailableHumanLine("auto: judge returned no verdict (x)"),
    ).toEqual({
      sentence: JUDGE_NO_VERDICT_HUMAN_LINE,
      fixInJudgeSettings: false,
    });
  });
});

describe("judgeFailureFamily with an appended stage-one explanation", () => {
  it("classifies 'ran out of time' with the stage-one explanation appended", () => {
    expect(
      judgeFailureFamily(
        "auto: judge timed out (This rewrites remote history.)",
      ),
    ).toBe("out-of-time");
  });

  it("classifies 'ran without deciding' with the stage-one explanation appended", () => {
    expect(judgeFailureFamily("auto: judge returned no verdict (x)")).toBe(
      "no-verdict",
    );
    expect(judgeFailureFamily("auto: unparseable verdict (x)")).toBe(
      "no-verdict",
    );
  });
});
