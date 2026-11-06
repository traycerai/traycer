import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  RETROSPECTIVE_DISCLOSURE,
  RETROSPECTIVE_RECORD_LINE,
  retrospectiveEvidenceLine,
  retrospectiveTitle,
} from "@/components/settings/move/retrospective-copy";
import { stopSharingDescription } from "@/components/settings/move/stop-sharing-copy";

const OCT_20 = Date.UTC(2026, 9, 20, 12, 0, 0);

describe("Overview dated lines", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 25, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns from a team in one sentence", () => {
    expect(RETURNED_FROM_TEAM_LINE).toBe(
      "This computer went back to your own settings.",
    );
  });

  it("names an earlier version's share, with Details as the verb", () => {
    expect(SHARED_BY_EARLIER_VERSION_LINE).toBe("Shared by an earlier version");
  });

  it("dates an explicit stop", () => {
    expect(stoppedSharingLine(OCT_20)).toBe(
      "This computer stopped using Personal on 20 Oct",
    );
  });

  it("counts the held commands, one or many", () => {
    expect(heldItemsLineText(1, "dev-box")).toBe(
      "1 command from dev-box is on hold until you choose · Review it",
    );
    expect(heldItemsLineText(2, "MacBook Pro")).toBe(
      "2 commands from MacBook Pro are on hold until you choose · Review them",
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
      heldItemsLineText(2, "MacBook Pro"),
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
