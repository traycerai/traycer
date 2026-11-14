import { describe, expect, it } from "vitest";
import {
  sandboxCardShowsCostView,
  sandboxCreatorName,
  sandboxPodRoomLine,
} from "@/components/hosts/sandbox-card-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

/**
 * What a TEAM sandbox's card says about people.
 *
 * Every line names a member the way the viewer would: "you" for the viewer's
 * own user id, the member's display name otherwise, and a neutral phrase when
 * the control plane has no name to give. A personal card never reaches these
 * (its `createdBy` is `null`).
 */

const VIEWER = "user-viewer";

describe("sandboxCreatorName", () => {
  it("says 'a team member' when the member has no display name", () => {
    expect(
      sandboxCreatorName(
        sandboxSummaryFixture({
          createdBy: { userId: "user-ada", displayName: null },
        }),
        VIEWER,
      ),
    ).toBe("a team member");
  });

  it("never says 'you' when the viewer is unknown", () => {
    expect(
      sandboxCreatorName(
        sandboxSummaryFixture({
          createdBy: { userId: "user-ada", displayName: "Ada Lovelace" },
        }),
        null,
      ),
    ).toBe("Ada Lovelace");
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
