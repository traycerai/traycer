import { describe, expect, it } from "vitest";
import {
  sandboxCardShowsCostView,
  sandboxCreatorLine,
  sandboxPodRoomLine,
  sandboxTeamFrozenLine,
  sandboxWakePayerLine,
} from "@/components/hosts/sandbox-card-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

/**
 * What a TEAM sandbox's card says about people.
 *
 * Every line names a member the way the viewer would: "you" for the viewer's
 * own user id, the member's display name otherwise, and a neutral phrase when
 * the control plane has no name to give. A personal card never reaches these
 * (its `createdBy` and `wakePayer` are `null`).
 */

const VIEWER = "user-viewer";

describe("sandboxCreatorLine", () => {
  it("is null for a sandbox with no recorded creator", () => {
    expect(
      sandboxCreatorLine(sandboxSummaryFixture({ createdBy: null }), VIEWER),
    ).toBeNull();
  });

  it("says 'Created by you' for the viewer", () => {
    expect(
      sandboxCreatorLine(
        sandboxSummaryFixture({
          createdBy: { userId: VIEWER, displayName: "Vera Viewer" },
        }),
        VIEWER,
      ),
    ).toBe("Created by you");
  });

  it("names another member", () => {
    expect(
      sandboxCreatorLine(
        sandboxSummaryFixture({
          createdBy: { userId: "user-ada", displayName: "Ada Lovelace" },
        }),
        VIEWER,
      ),
    ).toBe("Created by Ada Lovelace");
  });

  it("says 'a team member' when the member has no display name", () => {
    expect(
      sandboxCreatorLine(
        sandboxSummaryFixture({
          createdBy: { userId: "user-ada", displayName: null },
        }),
        VIEWER,
      ),
    ).toBe("Created by a team member");
  });

  it("never says 'you' when the viewer is unknown", () => {
    expect(
      sandboxCreatorLine(
        sandboxSummaryFixture({
          createdBy: { userId: "user-ada", displayName: "Ada Lovelace" },
        }),
        null,
      ),
    ).toBe("Created by Ada Lovelace");
  });
});

describe("sandboxWakePayerLine", () => {
  const payerIsViewer = sandboxSummaryFixture({
    wakePayer: { userId: VIEWER, displayName: "Vera Viewer" },
  });
  const payerIsAda = sandboxSummaryFixture({
    wakePayer: { userId: "user-ada", displayName: "Ada Lovelace" },
  });
  const payerHasNoName = sandboxSummaryFixture({
    wakePayer: { userId: "user-ada", displayName: null },
  });

  it("says the wake is on the viewer's bundle", () => {
    expect(sandboxWakePayerLine("awake", false, payerIsViewer, VIEWER)).toBe(
      "This wake is on your bundle",
    );
  });

  it("names another member's bundle", () => {
    expect(sandboxWakePayerLine("awake", false, payerIsAda, VIEWER)).toBe(
      "This wake is on Ada Lovelace's bundle",
    );
  });

  it("says 'a team member's bundle' when the payer has no display name", () => {
    expect(sandboxWakePayerLine("awake", false, payerHasNoName, VIEWER)).toBe(
      "This wake is on a team member's bundle",
    );
  });

  it("is silent unless the sandbox is awake", () => {
    expect(
      sandboxWakePayerLine("suspended", false, payerIsAda, VIEWER),
    ).toBeNull();
    expect(
      sandboxWakePayerLine("resuming", false, payerIsAda, VIEWER),
    ).toBeNull();
    expect(sandboxWakePayerLine(null, false, payerIsAda, VIEWER)).toBeNull();
  });

  it("is silent on a frozen sandbox", () => {
    expect(sandboxWakePayerLine("awake", true, payerIsAda, VIEWER)).toBeNull();
  });

  it("is silent when nobody is recorded as paying", () => {
    expect(
      sandboxWakePayerLine(
        "awake",
        false,
        sandboxSummaryFixture({ wakePayer: null }),
        VIEWER,
      ),
    ).toBeNull();
  });
});

describe("sandboxTeamFrozenLine", () => {
  it("says the viewer's own bundle is out", () => {
    expect(
      sandboxTeamFrozenLine(
        sandboxSummaryFixture({
          wakePayer: { userId: VIEWER, displayName: "Vera Viewer" },
        }),
        VIEWER,
      ),
    ).toBe("Frozen: your bundle is out.");
  });

  it("names another member's bundle", () => {
    expect(
      sandboxTeamFrozenLine(
        sandboxSummaryFixture({
          wakePayer: { userId: "user-ada", displayName: "Ada Lovelace" },
        }),
        VIEWER,
      ),
    ).toBe("Frozen: Ada Lovelace's bundle is out.");
  });

  it("says 'its payer's bundle' when no payer is recorded", () => {
    expect(
      sandboxTeamFrozenLine(sandboxSummaryFixture({ wakePayer: null }), VIEWER),
    ).toBe("Frozen: its payer's bundle is out.");
  });

  it("says 'its payer's bundle' when the payer has no display name", () => {
    expect(
      sandboxTeamFrozenLine(
        sandboxSummaryFixture({
          wakePayer: { userId: "user-ada", displayName: null },
        }),
        VIEWER,
      ),
    ).toBe("Frozen: its payer's bundle is out.");
  });
});

describe("sandboxPodRoomLine", () => {
  it("counts the room left and the live shells", () => {
    expect(sandboxPodRoomLine(3, 2)).toBe(
      "Room for 3 more shells · 2 live shells",
    );
  });

  it("uses singulars for one", () => {
    expect(sandboxPodRoomLine(1, 1)).toBe(
      "Room for 1 more shell · 1 live shell",
    );
  });

  it("says there is no room when the headroom is zero", () => {
    expect(sandboxPodRoomLine(0, 4)).toBe(
      "No room for another shell · 4 live shells",
    );
  });

  it("says there are no live shells when there are none", () => {
    expect(sandboxPodRoomLine(4, 0)).toBe(
      "Room for 4 more shells · no live shells",
    );
  });
});

describe("sandboxCardShowsCostView", () => {
  it("hides the cost view on a team-owned card, pods included", () => {
    expect(sandboxCardShowsCostView(true)).toBe(false);
  });

  it("shows the cost view on a personal card", () => {
    expect(sandboxCardShowsCostView(false)).toBe(true);
  });
});
