import { describe, expect, it } from "vitest";
import { formatEvidenceDate } from "@/components/settings/move/format-evidence-date";
import { heldItemsLineText } from "@/components/settings/move/held-items-line-copy";
import {
  RETURNED_FROM_TEAM_LINE,
  SHARED_BY_EARLIER_VERSION_LINE,
  overviewDatedCopy,
  stoppedSharingLine,
} from "@/components/settings/move/overview-dated-lines";
import {
  LOCAL_ROW_NOT_MOVED,
  LOCAL_ROW_NOT_SHARING,
  LOCAL_ROW_SHARED_UNRECORDED,
} from "@/components/settings/move/cohort-rows";
import {
  INCLUDING_MAIL_PASSWORD,
  RETROSPECTIVE_DISCLOSURE,
  RETROSPECTIVE_RECORD_LINE,
  retrospectiveEvidenceLine,
  retrospectiveTitle,
} from "@/components/settings/move/retrospective-copy";
import { stopSharingDescription } from "@/components/settings/move/stop-sharing-copy";

const OCT_20 = Date.UTC(2026, 9, 20, 12, 0, 0);

describe("Overview dated lines", () => {
  it("returns from a team in one sentence", () => {
    expect(RETURNED_FROM_TEAM_LINE).toBe(
      "This computer went back to your own settings.",
    );
  });

  it("names an earlier version's share, with Details as the verb", () => {
    expect(SHARED_BY_EARLIER_VERSION_LINE).toBe("Shared by an earlier version");
  });

  it("dates an explicit stop", () => {
    expect(formatEvidenceDate(OCT_20)).toBe("20 Oct");
    expect(stoppedSharingLine(OCT_20)).toBe(
      "This computer stopped sharing on 20 Oct",
    );
  });

  it("counts held items from the computer that held them", () => {
    expect(heldItemsLineText(3, "MacBook Pro")).toBe(
      "3 items from MacBook Pro are not in use · Review them",
    );
    expect(heldItemsLineText(1, "dev-box")).toBe(
      "1 item from dev-box is not in use · Review them",
    );
  });

  it("orders shared, stopped, then returned from a team", () => {
    expect(
      overviewDatedCopy({
        returnedFromTeamAt: OCT_20,
        sharedUnrecorded: true,
        stoppedAt: OCT_20,
      }),
    ).toEqual([
      SHARED_BY_EARLIER_VERSION_LINE,
      stoppedSharingLine(OCT_20),
      RETURNED_FROM_TEAM_LINE,
    ]);
    expect(
      overviewDatedCopy({
        returnedFromTeamAt: null,
        sharedUnrecorded: false,
        stoppedAt: null,
      }),
    ).toEqual([]);
  });
});

describe("copy a person reads", () => {
  it("never writes machine", () => {
    const copy = [
      LOCAL_ROW_NOT_MOVED,
      LOCAL_ROW_NOT_SHARING,
      LOCAL_ROW_SHARED_UNRECORDED,
      RETURNED_FROM_TEAM_LINE,
      SHARED_BY_EARLIER_VERSION_LINE,
      stoppedSharingLine(OCT_20),
      heldItemsLineText(3, "MacBook Pro"),
      INCLUDING_MAIL_PASSWORD,
      RETROSPECTIVE_DISCLOSURE,
      RETROSPECTIVE_RECORD_LINE,
      retrospectiveTitle("MacBook Pro"),
      retrospectiveEvidenceLine({
        version: "1.5.2",
        at: OCT_20,
      }),
      stopSharingDescription("MacBook Pro"),
    ].join("\n");
    expect(copy).not.toMatch(/machine/i);
  });
});
