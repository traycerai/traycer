import { describe, expect, it } from "vitest";
import {
  layoutNameTags,
  NAME_TAG_LINE_HEIGHT,
  type OfficeNameTagCandidate,
} from "@/components/epic-canvas/comm-graph/office/office-name-tags";
import {
  createLabelSpace,
  OFFICE_LABEL_HALO_PX,
  type OfficeLabelBox,
  type OfficeLabelSpace,
} from "@/components/epic-canvas/comm-graph/office/office-label-space";

/**
 * An empty frame: no signage, no storey names, nothing else lettered yet.
 *
 * Every case below but the last one is about tags meeting tags, so each gets
 * its own empty space rather than sharing one - a space carried between cases
 * would make the second `expect` in a file depend on the first.
 */
function emptySpace(): OfficeLabelSpace {
  return createLabelSpace();
}

/** A frame that has already lettered `boxes` - a room plate, say. */
function spaceHolding(
  ...boxes: ReadonlyArray<OfficeLabelBox>
): OfficeLabelSpace {
  const space = createLabelSpace();
  for (const box of boxes) space.boxes.push(box);
  return space;
}

function tag(
  text: string,
  centerX: number,
  baselineY: number,
  width: number,
): OfficeNameTagCandidate {
  // The owner rides along so placement can be asked who it actually placed.
  // Derived from the text rather than passed, because every case here is
  // about geometry and none of them wants a second identifier to track.
  return {
    text,
    tone: "default",
    centerX,
    baselineY,
    width,
    ownerAgentId: `agent-${text}`,
  };
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
      emptySpace(),
    );

    expect(placed).toHaveLength(2);
    expect(placed.map((entry) => entry.baselineY)).toEqual([50, 50]);
  });

  it("drops a clashing tag one line rather than printing it on top", () => {
    const placed = layoutNameTags(
      [tag("Alpha", 100, 50, 60), tag("Beta", 110, 50, 60)],
      emptySpace(),
    );

    expect(placed).toHaveLength(2);
    expect(placed[0]).toEqual({
      text: "Alpha",
      tone: "default",
      centerX: 100,
      baselineY: 50,
      ownerAgentId: "agent-Alpha",
    });
    expect(placed[1].baselineY).toBe(50 + NAME_TAG_LINE_HEIGHT);
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
      emptySpace(),
    );

    expect(placed).toHaveLength(3);
    expect(placed.map((entry) => entry.baselineY)).toEqual([
      50,
      50 + NAME_TAG_LINE_HEIGHT,
      50 + NAME_TAG_LINE_HEIGHT * 2,
    ]);
  });

  it("places in a fixed order however the caller supplies them", () => {
    const candidates = [
      tag("Lower", 100, 80, 60),
      tag("Upper", 100, 50, 60),
      tag("UpperRight", 140, 50, 60),
    ];

    const forward = layoutNameTags(candidates, emptySpace());
    const reversed = layoutNameTags([...candidates].reverse(), emptySpace());

    // Same answer either way: a tie broken by emission order would make a name
    // flicker as the scene re-emits its drawables.
    expect(reversed).toEqual(forward);
    expect(forward[0].text).toBe("Upper");
  });

  it("separates two tags whose glyph runs are exactly flush", () => {
    // A tag reserves the box it PAINTS, and what it paints is the glyph run
    // inside a one-pixel outline. So two runs that merely touch - 80..120 and
    // 120..160 - are still two outlines printing into each other, and the
    // second one moves. This case read the other way round until the halo was
    // folded in, which is the whole of the finding.
    const placed = layoutNameTags(
      [tag("Alpha", 100, 50, 40), tag("Beta", 140, 50, 40)],
      emptySpace(),
    );

    expect(placed.map((entry) => entry.baselineY)).toEqual([
      50,
      50 + NAME_TAG_LINE_HEIGHT,
    ]);
  });

  it("leaves two tags alone once their outlines clear each other", () => {
    // THE CONTROL, and the reason the case above is about a halo rather than
    // about "tags near each other always move": push them apart by exactly the
    // two outlines and both keep their own line. One pixel less and they do
    // not - the boundary is the halo's, not a margin somebody liked.
    const placed = layoutNameTags(
      [
        tag("Alpha", 100, 50, 40),
        tag("Beta", 140 + OFFICE_LABEL_HALO_PX * 2, 50, 40),
      ],
      emptySpace(),
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
      emptySpace(),
    );

    expect(placed).toHaveLength(2);
    // Not on the same line: that is precisely the mush being fixed.
    expect(placed[0].baselineY).not.toBe(placed[1].baselineY);
  });
});

/**
 * THE OTHER HALF OF THE SAME COMPLAINT, and the half this module could not see
 * until the space was shared.
 *
 * The screenshot that opened round 2 has `#1158 — DEL…` - an agent's tag -
 * printed a dozen pixels off `TRAYCER ISS…`, a board sign. Both were "correct"
 * by their own channel's rules, because neither channel had ever been told the
 * other one existed. A tag now places into a space the signage has already
 * filled, so the two resolve against each other exactly as two tags do.
 */
describe("layoutNameTags against lettering it did not draw", () => {
  it("moves a tag off a sign plate that is already on the floor", () => {
    const plate: OfficeLabelBox = {
      left: 80,
      right: 220,
      top: 40,
      bottom: 54,
    };
    const placed = layoutNameTags(
      [tag("#1158 — DEL…", 150, 50, 90)],
      spaceHolding(plate),
    );

    expect(placed).toHaveLength(1);
    // Below the plate, not through it. The anchor at 50 put the tag's painted
    // box at 39..51 - halo included - which is straight through the plate's
    // 40..54.
    expect(placed[0].baselineY).toBeGreaterThanOrEqual(plate.bottom);
  });

  it("drops a tag boxed in by signage rather than printing it over the plate", () => {
    // A plate deep enough to swallow the anchor and both shifts.
    const placed = layoutNameTags(
      [tag("#1158 — DEL…", 150, 50, 90)],
      spaceHolding({ left: 80, right: 220, top: 30, bottom: 100 }),
    );

    expect(placed).toEqual([]);
  });

  it("still places a tag whose column the signage never reached", () => {
    // The control: a plate that is close in Y but nowhere near in X must not
    // displace anything, or "no overlaps" would be satisfied by a pass that
    // simply drops everything near a sign.
    const placed = layoutNameTags(
      [tag("#1158 — DEL…", 150, 50, 90)],
      spaceHolding({ left: 600, right: 740, top: 40, bottom: 54 }),
    );

    expect(placed).toHaveLength(1);
    expect(placed[0].baselineY).toBe(50);
  });
});
