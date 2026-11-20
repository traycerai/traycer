import { describe, expect, it } from "vitest";
import { commGraphNoticeReasonLabel } from "@/lib/comm-graph/comm-graph-labels";

describe("commGraphNoticeReasonLabel", () => {
  it.each([
    [null, "Notice"],
    ["turn-ended", "Turn ended"],
    ["awaiting-input", "Awaiting input"],
    ["from-a-newer-host", "from-a-newer-host"],
    ["constructor", "constructor"],
  ])("labels notice reason %s as %s", (reason, label) => {
    expect(commGraphNoticeReasonLabel(reason)).toBe(label);
  });
});
