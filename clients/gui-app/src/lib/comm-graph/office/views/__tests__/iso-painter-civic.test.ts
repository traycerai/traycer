/**
 * `civicGround` in `iso-painter.ts` - the isometric half of the civic ground
 * tint `floor-painter-civic.test.ts` pins for the Floor. One painter serves
 * both Campus and City (`ISO_PAINTER`), so this file drives both real plans
 * through it rather than duplicating the suite per view.
 *
 * The tint's position in the returned stream is load-bearing and was RECENTLY
 * INVERTED from "last" to "spliced between the ground diamonds and the
 * standing pieces" - `paintFloor`'s own comment on why: `ground: true` is what
 * lets a baking host keep the tint under a district's walls, doors and props,
 * and that only works if the tint is actually drawn there in the per-frame
 * stream too, ground first.
 */
import { describe, expect, it } from "vitest";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import {
  makeTestEpic,
  type OfficeTestEpic,
} from "@/lib/comm-graph/office/office-test-epic";
import {
  OFFICE_CIVIC_GROUND_ALPHA,
  type OfficeDrawable,
  type OfficeLayout,
  type OfficeSize,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import type { OfficePlanInput } from "@/lib/comm-graph/office/views/office-view";
import { planCampus } from "@/lib/comm-graph/office/views/isometric/campus-plan";
import { planCity } from "@/lib/comm-graph/office/views/isometric/city-plan";
import { ISO_PAINTER } from "@/lib/comm-graph/office/views/isometric/iso-painter";
import {
  isoCivicIn,
  isoGroundAt,
} from "@/lib/comm-graph/office/views/isometric/iso-plan-core";

const VIEWPORT: OfficeSize = { width: 1280, height: 700 };

function populationFor(epic: OfficeTestEpic): OfficePopulation {
  return partitionOfficePopulation({
    agents: epic.agents,
    statusById: epic.statusById,
    previous: null,
  });
}

function planInputFor(epic: OfficeTestEpic): OfficePlanInput {
  return {
    agents: epic.agents,
    partition: populationFor(epic),
    occupancy: new Map(),
    needsCapacity: [],
    activityById: new Map(epic.agents.map((agent) => [agent.id, 0])),
    viewport: VIEWPORT,
    previous: null,
  };
}

/**
 * The same fixture `floor-painter-civic.test.ts` packs its ward and lounge
 * from: big enough that both districted planners lay out a civic quarter too.
 */
const CIVIC_EPIC = makeTestEpic("triage", 309, 1);

function wholeWorldTiles(layout: OfficeLayout): OfficeTileRect {
  return { col: 0, row: 0, cols: layout.cols, rows: layout.rows };
}

/**
 * How many ground diamonds `paintFloor`'s own loop draws for this layout,
 * counted independently through the exported `isoGroundAt` - the same call
 * the painter's private `groundSpriteAt` makes - rather than by re-reading
 * the painter's output. A whole-world tile query makes the painter's own
 * clamping a no-op, so this walks the full `[0, cols) x [0, rows)` grid.
 */
function groundTileCount(layout: OfficeLayout): number {
  let count = 0;
  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      if (isoGroundAt(layout, { col, row }) !== null) count += 1;
    }
  }
  return count;
}

type QuadDrawable = Extract<OfficeDrawable, { kind: "quad" }>;

function civicQuadsIn(
  drawables: ReadonlyArray<OfficeDrawable>,
): ReadonlyArray<QuadDrawable> {
  return drawables.filter(
    (drawable): drawable is QuadDrawable =>
      drawable.kind === "quad" && drawable.fill === "civic",
  );
}

describe.each([["campus", planCampus] as const, ["city", planCity] as const])(
  "%s: ISO_PAINTER.floor civic ground tint (civicGround)",
  (_id, plan) => {
    const layout = plan(planInputFor(CIVIC_EPIC));
    const tiles = wholeWorldTiles(layout);
    const projector = ISO_PAINTER.projector(layout);
    const expectedRooms = isoCivicIn(layout, tiles);

    it("plans at least one civic room at this population, or every case below is vacuous", () => {
      expect(expectedRooms.length).toBeGreaterThan(0);
    });

    it.each([1, 2] as const)(
      "gives every visible civic room exactly one quad at lod %i, projected from the room's own tile rect, tinted and ground: true",
      (lod) => {
        const quads = civicQuadsIn(ISO_PAINTER.floor(layout, tiles, lod));
        expect(quads.length).toBe(expectedRooms.length);

        for (const room of expectedRooms) {
          const endCol = room.bounds.col + room.bounds.cols;
          const endRow = room.bounds.row + room.bounds.rows;
          // The exact corners `quadOf` itself projects from, read off the
          // SAME projector the painter uses - the code's own geometry, not a
          // re-typed pixel value.
          const expectedPoints = [
            projector.project(room.bounds.col, room.bounds.row),
            projector.project(endCol, room.bounds.row),
            projector.project(endCol, endRow),
            projector.project(room.bounds.col, endRow),
          ];
          const match = quads.find(
            (quad) =>
              quad.points[0].x === expectedPoints[0].x &&
              quad.points[0].y === expectedPoints[0].y &&
              quad.points[2].x === expectedPoints[2].x &&
              quad.points[2].y === expectedPoints[2].y,
          );
          expect(match, `no quad for ${room.civicRoomId}`).toBeDefined();
          expect(match?.points).toEqual(expectedPoints);
          expect(match?.alpha).toBe(OFFICE_CIVIC_GROUND_ALPHA);
          expect(match?.ground).toBe(true);
        }
      },
    );

    it.each([1, 2] as const)(
      "splices the tint between the ground diamonds and the standing pieces at lod %i - not before both and not after both",
      (lod) => {
        const drawables = ISO_PAINTER.floor(layout, tiles, lod);
        const groundCount = groundTileCount(layout);

        const before = drawables.slice(0, groundCount);
        const tint = drawables.slice(
          groundCount,
          groundCount + expectedRooms.length,
        );
        const after = drawables.slice(groundCount + expectedRooms.length);

        // Not vacuous: there really is a ground pass and a standing pass on
        // either side of the tint at this population and lod.
        expect(before.length).toBeGreaterThan(0);
        expect(after.length).toBeGreaterThan(0);

        expect(before.every((drawable) => drawable.kind === "sprite")).toBe(
          true,
        );
        expect(tint.every((drawable) => drawable.kind === "quad")).toBe(true);
        expect(after.every((drawable) => drawable.kind === "sprite")).toBe(
          true,
        );
      },
    );

    it("uses the lod-0 block map instead, whose civic quads carry neither the tint's alpha nor its ground marker", () => {
      const quads = civicQuadsIn(ISO_PAINTER.floor(layout, tiles, 0));

      // Not vacuous: the block map really does draw a civic quad per room.
      expect(quads.length).toBe(expectedRooms.length);
      // The discriminator: `blockMap` calls `quadOf` with `ground: false` for
      // every fill, civic included, so a civic quad here never carries the
      // tint's own alpha or its `ground` bake marker - only `civicGround`'s
      // lod >= 1 path does, which is what scopes the bake to the tint rather
      // than to the whole overview.
      for (const quad of quads) {
        expect(quad.alpha).toBeUndefined();
        expect(quad.ground).toBeUndefined();
      }
    });
  },
);
