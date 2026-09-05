import { describe, expect, it } from "vitest";
import {
  layoutNameTags,
  type OfficeNameTagCandidate,
} from "@/components/epic-canvas/comm-graph/office/office-name-tags";

const LINE = 10;

function tag(
  text: string,
  centerX: number,
  baselineY: number,
  width: number,
): OfficeNameTagCandidate {
  return { text, tone: "default", centerX, baselineY, width };
}

/**
 * The failure this exists to prevent is two names printed on top of each other
 * - which is worse than one name missing, because it costs BOTH. So the rules
 * under test are: move a clashing tag down if there is room, drop it if there
 * is not, and never let the order the scene happened to emit them in decide
 * which one survives.
 */
describe("layoutNameTags", () => {
  it("leaves tags that do not touch exactly where they were", () => {
    const placed = layoutNameTags(
      [tag("Alpha", 100, 50, 40), tag("Beta", 300, 50, 40)],
      LINE,
    );

    expect(placed).toHaveLength(2);
    expect(placed.map((entry) => entry.baselineY)).toEqual([50, 50]);
  });

  it("drops a clashing tag one line rather than printing it on top", () => {
    const placed = layoutNameTags(
      [tag("Alpha", 100, 50, 60), tag("Beta", 110, 50, 60)],
      LINE,
    );

    expect(placed).toHaveLength(2);
    expect(placed[0]).toEqual({
      text: "Alpha",
      tone: "default",
      centerX: 100,
      baselineY: 50,
    });
    expect(placed[1].baselineY).toBe(60);
  });

  it("skips a tag with nowhere free rather than overlapping one", () => {
    // Four tags stacked on one anchor: the first takes its slot, the next two
    // take the two shifts, and the fourth has run out of room.
    const placed = layoutNameTags(
      [
        tag("One", 100, 50, 60),
        tag("Two", 100, 50, 60),
        tag("Three", 100, 50, 60),
        tag("Four", 100, 50, 60),
      ],
      LINE,
    );

    expect(placed).toHaveLength(3);
    expect(placed.map((entry) => entry.baselineY)).toEqual([50, 60, 70]);
  });

  it("places in a fixed order however the caller supplies them", () => {
    const candidates = [
      tag("Lower", 100, 80, 60),
      tag("Upper", 100, 50, 60),
      tag("UpperRight", 140, 50, 60),
    ];

    const forward = layoutNameTags(candidates, LINE);
    const reversed = layoutNameTags([...candidates].reverse(), LINE);

    // Same answer either way: a tie broken by emission order would make a name
    // flicker as the scene re-emits its drawables.
    expect(reversed).toEqual(forward);
    expect(forward[0].text).toBe("Upper");
  });

  it("treats a tag that only touches at the edge as clear", () => {
    // Boxes that share a boundary do not overlap - a strict test, so two tags
    // sitting exactly side by side both survive.
    const placed = layoutNameTags(
      [tag("Alpha", 100, 50, 40), tag("Beta", 140, 50, 40)],
      LINE,
    );

    expect(placed.map((entry) => entry.baselineY)).toEqual([50, 50]);
  });
});

/**
 * A cluster is the case this exists for: the user's screenshot had
 * "Serendipity" printed through "The Multi Agent C…" at adjacent cafeteria
 * seats. Two agents side by side, both seated, both tags anchored a few pixels
 * apart.
 */
describe("layoutNameTags on a cluster", () => {
  it("keeps both names readable when two agents sit side by side", () => {
    const placed = layoutNameTags(
      [
        tag("Serendipity", 120, 200, 70),
        tag("The Multi Agent C…", 140, 200, 110),
      ],
      LINE,
    );

    expect(placed).toHaveLength(2);
    // Not on the same line: that is precisely the mush being fixed.
    expect(placed[0].baselineY).not.toBe(placed[1].baselineY);
  });
});
