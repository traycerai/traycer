/**
 * The invariants the view contract promises hold of EVERY layout, pinned here
 * against `layoutOffice` at the scales the fit estimates are quoted at. T2
 * folds this file into `views/__tests__/office-plans.test.ts` once other
 * views exist; until then it stands alone, which is why every check below is
 * spelled out rather than shared with `office-layout.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeFloor,
  OfficeLayout,
  OfficeTilePos,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";

function isWalkable(layout: OfficeLayout, tile: OfficeTilePos): boolean {
  return layout.walkable[tile.row]?.[tile.col];
}

function floorBandContains(floor: OfficeFloor, row: number): boolean {
  return row >= floor.bounds.row && row < floor.bounds.row + floor.bounds.rows;
}

function withinRect(bounds: OfficeTileRect, tile: OfficeTilePos): boolean {
  return (
    tile.col >= bounds.col &&
    tile.col < bounds.col + bounds.cols &&
    tile.row >= bounds.row &&
    tile.row < bounds.row + bounds.rows
  );
}

const TRIAGE_SCALES: ReadonlyArray<number> = [12, 309, 1000];

describe("layoutOffice contract", () => {
  describe.each(TRIAGE_SCALES)("triage at %i agents", (n) => {
    const epic = makeTestEpic("triage", n, 1);
    const layout = layoutOffice(epic.agents);
    const agentIds = new Set(epic.agents.map((agent) => agent.id));

    it("seats every agent exactly once, with every seat id unique", () => {
      expect(layout.desks.size).toBe(n);
      for (const agentId of agentIds)
        expect(layout.desks.has(agentId)).toBe(true);

      const seatIds = new Set<string>();
      for (const seat of layout.seats.values()) {
        expect(seatIds.has(seat.seatId)).toBe(false);
        seatIds.add(seat.seatId);
      }
      // No two seats share an id, and `seats` covers every desk under its own.
      for (const desk of layout.desks.values()) {
        expect(layout.seats.get(desk.seatId)).toEqual(desk);
      }
    });

    it("agrees each desk's floorIndex with the storey it physically sits in", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        expect(floor).toBeDefined();
        expect(floorBandContains(floor, desk.deskTile.row)).toBe(true);
        expect(desk.hostId).toBe(floor.hostId);
      }
    });

    it("resolves every desk's roomId to a cabin whose bounds hold its tile, or null", () => {
      for (const desk of layout.desks.values()) {
        if (desk.roomId === null) continue;
        const room = layout.rooms.find(
          (candidate) => candidate.rootAgentId === desk.roomId,
        );
        expect(room).toBeDefined();
        if (room === undefined) continue;
        expect(withinRect(room.bounds, desk.deskTile)).toBe(true);
      }
    });

    it("lets every chair reach its own floor's door", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        const path = findOfficePath(layout, desk.chairTile, floor.doorTile);
        expect(path).not.toBeNull();
      }
    });

    it("keeps every spot's approach tile, corridor tile and visit tile walkable", () => {
      for (const floor of layout.floors) {
        for (const spot of floor.errandSpots) {
          expect(isWalkable(layout, spot.approachTile)).toBe(true);
        }
        for (const corridorTile of floor.corridorTiles) {
          expect(isWalkable(layout, corridorTile)).toBe(true);
        }
      }
      for (const room of layout.rooms) {
        if (room.visitTile === null) continue;
        expect(isWalkable(layout, room.visitTile)).toBe(true);
      }
    });

    it("keeps every corridor tile inside its own storey and outside every room and amenity", () => {
      for (const floor of layout.floors) {
        for (const corridorTile of floor.corridorTiles) {
          expect(floorBandContains(floor, corridorTile.row)).toBe(true);
          for (const room of layout.rooms) {
            expect(withinRect(room.bounds, corridorTile)).toBe(false);
          }
          for (const amenity of floor.amenities) {
            expect(withinRect(amenity.bounds, corridorTile)).toBe(false);
          }
        }
      }
    });

    it("names an agent that exists for every sign with an owner", () => {
      for (const sign of layout.signs) {
        if (sign.ownerAgentId === null) continue;
        expect(agentIds.has(sign.ownerAgentId)).toBe(true);
      }
    });
  });

  it("carries each floor's own hostId on every seat that floor owns, on the two-host shape", () => {
    const epic = makeTestEpic("two-hosts", 60, 1);
    const layout = layoutOffice(epic.agents);
    expect(layout.floors.length).toBeGreaterThanOrEqual(2);

    for (const seat of layout.seats.values()) {
      const floor = layout.floors[seat.floorIndex];
      expect(floor).toBeDefined();
      expect(seat.hostId).toBe(floor.hostId);
    }
  });
});
