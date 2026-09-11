import { describe, expect, it } from "vitest";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeRect,
  type OfficeSize,
  type OfficeTilePos,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import {
  measureCity,
  planCity,
} from "@/lib/comm-graph/office/views/isometric/city-plan";
import { ISO_PAINTER } from "@/lib/comm-graph/office/views/isometric/iso-painter";
import { readCityFrozen } from "@/lib/comm-graph/office/views/isometric/iso-plan-core";
import {
  isoDepth,
  ISO_STOREY_HEIGHT,
} from "@/lib/comm-graph/office/views/isometric/iso-projector";
import type { OfficePlanInput } from "@/lib/comm-graph/office/views/office-view";

type Shape = "triage" | "two-hosts";

function inputFor(
  shape: Shape,
  n: number,
  viewport: OfficeSize,
): OfficePlanInput {
  const epic = makeTestEpic(shape, n, 1);
  const partition = partitionOfficePopulation({
    agents: epic.agents,
    statusById: epic.statusById,
    previous: null,
  });
  const activityById = new Map<string, number>();
  for (const [index, agent] of epic.agents.entries()) {
    activityById.set(agent.id, index % 37);
  }
  return {
    agents: epic.agents,
    partition,
    occupancy: new Map<string, string>(),
    needsCapacity: [],
    activityById,
    viewport,
    previous: null,
  };
}

const VIEWPORT_1280: OfficeSize = { width: 1280, height: 700 };
const VIEWPORT_680: OfficeSize = { width: 680, height: 440 };

function within(rect: OfficeTileRect, tile: OfficeTilePos): boolean {
  return (
    tile.col >= rect.col &&
    tile.col < rect.col + rect.cols &&
    tile.row >= rect.row &&
    tile.row < rect.row + rect.rows
  );
}

/**
 * The view contract's invariants against one City layout. Restated rather
 * than shared with `campus-plan.test.ts` because these two files must stand
 * alone (see the ticket).
 */
function checkContract(
  layout: OfficeLayout,
  agentIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const seatIds = new Set<string>();
  for (const seat of layout.seats.values()) {
    if (seatIds.has(seat.seatId))
      problems.push(`duplicate seat ${seat.seatId}`);
    seatIds.add(seat.seatId);
  }
  problems.push(...deskProblems(layout));
  problems.push(...floorProblems(layout));
  problems.push(...roomProblems(layout));
  problems.push(...signProblems(layout, agentIds));
  return [...new Set(problems)];
}

/** Every desk resolves to a seat, a room and a floor it can walk out of. */
function deskProblems(layout: OfficeLayout): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const desk of layout.desks.values()) {
    if (layout.seats.get(desk.seatId) !== desk) {
      problems.push(
        `desk not registered under its own seat id: ${desk.seatId}`,
      );
    }
    if (desk.roomId !== null) {
      const room = layout.rooms.find(
        (candidate) => candidate.rootAgentId === desk.roomId,
      );
      if (room === undefined) problems.push(`roomId unresolved ${desk.roomId}`);
      else if (!within(room.bounds, desk.deskTile)) {
        problems.push(`desk tile outside its own room ${desk.seatId}`);
      }
    }
    if (desk.floorIndex < 0 || desk.floorIndex >= layout.floors.length) {
      problems.push(`no floor at index ${desk.floorIndex}`);
      continue;
    }
    const floor = layout.floors[desk.floorIndex];
    if (findOfficePath(layout, desk.chairTile, floor.doorTile) === null) {
      problems.push(`chair unreachable from its floor's door ${desk.seatId}`);
    }
  }
  return problems;
}

/** Somewhere to stand at every errand, and corridors that are only corridors. */
function floorProblems(layout: OfficeLayout): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const floor of layout.floors) {
    for (const spot of floor.errandSpots) {
      if (!layout.walkable[spot.approachTile.row]?.[spot.approachTile.col]) {
        problems.push(`spot approach tile blocked ${spot.kind}`);
      }
      if (findOfficePath(layout, spot.approachTile, floor.doorTile) === null) {
        problems.push(`spot approach unreachable from its door ${spot.kind}`);
      }
    }
    for (const tile of floor.corridorTiles) {
      problems.push(...corridorProblems(layout, floor, tile));
    }
  }
  return problems;
}

function corridorProblems(
  layout: OfficeLayout,
  floor: OfficeFloor,
  tile: OfficeTilePos,
): ReadonlyArray<string> {
  const problems: string[] = [];
  if (!layout.walkable[tile.row]?.[tile.col]) {
    problems.push(`corridor tile blocked ${tile.col},${tile.row}`);
  }
  if (!within(floor.bounds, tile)) {
    problems.push(`corridor tile outside its own floor`);
  }
  if (layout.rooms.some((room) => within(room.bounds, tile))) {
    problems.push(`corridor tile inside a room`);
  }
  if (floor.amenities.some((amenity) => within(amenity.bounds, tile))) {
    problems.push(`corridor tile inside an amenity`);
  }
  return problems;
}

function roomProblems(layout: OfficeLayout): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const room of layout.rooms) {
    if (room.visitTile === null) continue;
    if (!layout.walkable[room.visitTile.row]?.[room.visitTile.col]) {
      problems.push(`visit tile blocked ${room.rootAgentId}`);
    }
  }
  return problems;
}

/** A sign that names somebody must name somebody who exists. */
function signProblems(
  layout: OfficeLayout,
  agentIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const sign of layout.signs) {
    if (sign.ownerAgentId === null) continue;
    if (!agentIds.has(sign.ownerAgentId)) {
      problems.push(`sign owner does not exist ${sign.ownerAgentId}`);
    }
  }
  return problems;
}

describe("planCity", () => {
  describe.each([12, 309, 1000])(
    "the shared layout invariants at %i agents",
    (n) => {
      const input = inputFor("triage", n, VIEWPORT_1280);
      const layout = planCity(input);
      const agentIds = new Set(input.agents.map((agent) => agent.id));

      it("holds", () => {
        expect(checkContract(layout, agentIds)).toEqual([]);
      });

      it("seats every agent exactly once, with reserve lots on top", () => {
        // City packs reserve lots into every team block, so `seats` outgrows
        // `desks` - the reserve seats are real seats with no occupant yet.
        expect(layout.desks.size).toBe(n);
        expect(layout.seats.size).toBeGreaterThan(layout.desks.size);
        for (const desk of layout.desks.values()) {
          expect(layout.seats.has(desk.seatId)).toBe(true);
        }
        for (const agentId of agentIds)
          expect(layout.desks.has(agentId)).toBe(true);
      });
    },
  );

  it("caps every building's storeys at seven, however busy the agent", () => {
    const input = inputFor("triage", 60, VIEWPORT_1280);
    const busy = new Map<string, number>();
    for (const agent of input.agents) busy.set(agent.id, 400);
    const layout = planCity({ ...input, activityById: busy });
    const projector = ISO_PAINTER.projector(layout);
    let maxStoreys = 0;
    for (const seat of layout.seats.values()) {
      maxStoreys = Math.max(
        maxStoreys,
        projector.seatLift(seat) / ISO_STOREY_HEIGHT,
      );
    }
    expect(maxStoreys).toBeLessThanOrEqual(7);
    // Every occupied seat is busy enough to hit the cap, so the cap is what
    // actually bites here rather than an accident of low activity.
    expect(maxStoreys).toBe(7);
  });

  it("freezes heights across a status flip and an activity drop", () => {
    const input = inputFor("triage", 60, VIEWPORT_1280);
    const busy = new Map<string, number>();
    for (const agent of input.agents) busy.set(agent.id, 400);
    const a = planCity({ ...input, activityById: busy });
    const before = ISO_PAINTER.projector(a);

    const quiet = new Map<string, number>();
    const flipped = new Map(
      input.agents.map((agent) => [agent.id, "idle" as const]),
    );
    for (const agent of input.agents) quiet.set(agent.id, 0);
    const partition = partitionOfficePopulation({
      agents: input.agents,
      statusById: flipped,
      previous: input.partition,
    });
    const b = planCity({
      ...input,
      activityById: quiet,
      partition,
      previous: a,
    });
    const after = ISO_PAINTER.projector(b);

    expect(a.desks.size).toBeGreaterThan(0);
    for (const desk of a.desks.values()) {
      const seat = b.seats.get(desk.seatId);
      expect(seat).toBeDefined();
      if (seat === undefined) continue;
      expect(after.seatLift(seat)).toBe(before.seatLift(desk));
    }
  });

  it("makes the HQ building the tallest, and the only one with a spire", () => {
    const input = inputFor("triage", 60, VIEWPORT_1280);
    const layout = planCity(input);
    const frozen = readCityFrozen(layout);
    expect(frozen).not.toBeNull();
    if (frozen === null) return;
    expect(frozen.spireSeatIds.size).toBe(1);
    const [spireSeatId] = [...frozen.spireSeatIds];
    const spireStoreys = frozen.storeysBySeatId.get(spireSeatId);
    expect(spireStoreys).toBe(7);
    for (const [seatId, storeys] of frozen.storeysBySeatId) {
      if (seatId === spireSeatId) continue;
      expect(storeys).toBeLessThanOrEqual(spireStoreys ?? 0);
    }
  });

  it("is append-stable: every pre-existing agent keeps its tile and seat", () => {
    const first = inputFor("triage", 309, VIEWPORT_1280);
    const a = planCity(first);
    const epic = makeTestEpic("triage", 310, 1);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: first.partition,
    });
    const b = planCity({
      ...first,
      agents: epic.agents,
      partition,
      previous: a,
    });

    expect(b.stable).toBe(true);
    expect(b.shiftFromPrevious).toBeNull();
    for (const [agentId, desk] of a.desks) {
      const after = b.desks.get(agentId);
      expect(after).toBeDefined();
      if (after === undefined) continue;
      expect(after.deskTile).toEqual(desk.deskTile);
      expect(after.seatId).toBe(desk.seatId);
    }
    const newAgentId = epic.agents[epic.agents.length - 1].id;
    expect(a.desks.has(newAgentId)).toBe(false);
    expect(b.desks.has(newAgentId)).toBe(true);
  });

  it("gives two hosts two districts, two host signs, and no walkable path between them", () => {
    const input = inputFor("two-hosts", 120, VIEWPORT_1280);
    const layout = planCity(input);
    expect(layout.floors.length).toBe(2);
    expect(layout.signs.filter((sign) => sign.kind === "host")).toHaveLength(2);
    expect(
      findOfficePath(
        layout,
        layout.floors[0].doorTile,
        layout.floors[1].doorTile,
      ),
    ).toBeNull();
  });

  describe("projected bounds at 1,000 agents", () => {
    // Measured directly against `measureCity` and the projector's own bounds:
    // 70 x 81 tiles, 2,416 x 1,300 projected px (includes the tallest
    // building's stack height, `H`).
    const input1280 = inputFor("triage", 1000, VIEWPORT_1280);
    const layout1280 = planCity(input1280);
    const size1280 = measureCity(input1280);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout1280.cols, rows: layout1280.rows }).toEqual({
        cols: 70,
        rows: 81,
      });
      expect(size1280).toEqual({ width: 2416, height: 1300 });
    });

    it("agrees with the projector's own bounds", () => {
      const bounds = ISO_PAINTER.projector(layout1280).bounds;
      expect({ width: bounds.width, height: bounds.height }).toEqual(size1280);
    });

    it("pins the fit at 1280x700", () => {
      const fit = Math.min(
        VIEWPORT_1280.width / size1280.width,
        VIEWPORT_1280.height / size1280.height,
      );
      expect(fit).toBeCloseTo(0.53, 2);
    });

    it("pins the fit at 680x440", () => {
      const input680 = inputFor("triage", 1000, VIEWPORT_680);
      const size680 = measureCity(input680);
      const fit = Math.min(
        VIEWPORT_680.width / size680.width,
        VIEWPORT_680.height / size680.height,
      );
      expect(fit).toBeCloseTo(0.28, 2);
    });
  });

  describe("projected bounds at 309 agents", () => {
    // Measured: 44 x 48 tiles, 1,472 x 828 px.
    const input = inputFor("triage", 309, VIEWPORT_1280);
    const layout = planCity(input);
    const size = measureCity(input);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout.cols, rows: layout.rows }).toEqual({
        cols: 44,
        rows: 48,
      });
      expect(size).toEqual({ width: 1472, height: 828 });
    });

    it("pins the fit at both viewports", () => {
      const fit1280 = Math.min(
        VIEWPORT_1280.width / size.width,
        VIEWPORT_1280.height / size.height,
      );
      expect(fit1280).toBeCloseTo(0.85, 2);
      const input680 = inputFor("triage", 309, VIEWPORT_680);
      const size680 = measureCity(input680);
      const fit680 = Math.min(
        VIEWPORT_680.width / size680.width,
        VIEWPORT_680.height / size680.height,
      );
      expect(fit680).toBeCloseTo(0.46, 2);
    });
  });

  it("draws and hits overlapping tall blocks front-most first", () => {
    const layout = planCity(inputFor("triage", 60, VIEWPORT_1280));
    // The origin corner (col + row === 0) is degenerate for a monotonicity
    // check - every other tile's diagonal distance is compared against it.
    const seats = [...layout.seats.values()].filter(
      (seat) => seat.deskTile.col + seat.deskTile.row > 0,
    );
    expect(seats.length).toBeGreaterThan(0);
    const byDepth = seats
      .map((seat) => ({
        colRow: seat.deskTile.col + seat.deskTile.row,
        depth: Math.max(
          ...ISO_PAINTER.seatProps(
            layout,
            seat,
            {
              agentId: "agent-root",
              name: "Root",
              status: "working",
              sheeted: false,
              openRequests: 0,
              screenFrame: 0,
              harnessId: null,
              modelTier: "medium",
              accentId: null,
            },
            1,
          ).map((entry) => entry.depth),
        ),
      }))
      .sort((left, right) => left.depth - right.depth);
    // Draw and hit order both walk this array front-to-back / back-to-front
    // by depth, so a nearer footprint (larger col+row) must never sort before
    // a farther one.
    for (let index = 1; index < byDepth.length; index += 1) {
      expect(byDepth[index].colRow).toBeGreaterThanOrEqual(
        byDepth[index - 1].colRow,
      );
    }
  });

  it("orders isoDepth by foot y first, then col+row, then kind", () => {
    const lowFoot = isoDepth(10, 500, "character");
    const highFoot = isoDepth(11, 0, "floor");
    expect(highFoot).toBeGreaterThan(lowFoot);

    const nearer = isoDepth(10, 5, "floor");
    const farther = isoDepth(10, 2, "floor");
    expect(nearer).toBeGreaterThan(farther);

    const floor = isoDepth(10, 5, "floor");
    const prop = isoDepth(10, 5, "prop");
    const character = isoDepth(10, 5, "character");
    expect(prop).toBeGreaterThan(floor);
    expect(character).toBeGreaterThan(prop);
  });

  it("keeps the projector's bounds a superset of every drawable's sprite box", () => {
    const layout = planCity(inputFor("triage", 200, VIEWPORT_1280));
    const projector = ISO_PAINTER.projector(layout);
    const { bounds } = projector;
    const problems: string[] = [];

    const checkBox = (label: string, box: OfficeRect): void => {
      if (box.x < bounds.x) problems.push(`${label} x below bounds`);
      if (box.y < bounds.y) problems.push(`${label} y below bounds`);
      if (box.x + box.width > bounds.x + bounds.width) {
        problems.push(`${label} x+width exceeds bounds`);
      }
      if (box.y + box.height > bounds.y + bounds.height) {
        problems.push(`${label} y+height exceeds bounds`);
      }
    };

    for (const seat of layout.seats.values()) {
      const drawables = ISO_PAINTER.seatProps(
        layout,
        seat,
        {
          agentId: "agent-root",
          name: "Root",
          status: "working",
          sheeted: false,
          openRequests: 3,
          screenFrame: 0,
          harnessId: null,
          modelTier: "large",
          accentId: null,
        },
        2,
      );
      for (const entry of drawables) {
        if (entry.drawable.kind !== "sprite") continue;
        const size = officeSpriteSize(entry.drawable.sprite);
        checkBox(`seatProps ${seat.seatId}`, {
          x: entry.drawable.x,
          y: entry.drawable.y,
          width: size.width,
          height: size.height,
        });
      }
    }

    const tiles: OfficeTileRect = {
      col: 0,
      row: 0,
      cols: layout.cols,
      rows: layout.rows,
    };
    for (const drawable of ISO_PAINTER.floor(layout, tiles, 1)) {
      if (drawable.kind !== "sprite") continue;
      const size = officeSpriteSize(drawable.sprite);
      checkBox("floor", {
        x: drawable.x,
        y: drawable.y,
        width: size.width,
        height: size.height,
      });
    }

    expect([...new Set(problems)]).toEqual([]);
  });

  it("holds a character, a lod-0 block and every fixture inside those bounds", () => {
    const layout = planCity(inputFor("triage", 200, VIEWPORT_1280));
    const projector = ISO_PAINTER.projector(layout);
    const { bounds } = projector;
    const problems: string[] = [];

    const checkBox = (label: string, box: OfficeRect): void => {
      if (box.x < bounds.x) problems.push(`${label} x below bounds`);
      if (box.y < bounds.y) problems.push(`${label} y below bounds`);
      if (box.x + box.width > bounds.x + bounds.width) {
        problems.push(`${label} x+width exceeds bounds`);
      }
      if (box.y + box.height > bounds.y + bounds.height) {
        problems.push(`${label} y+height exceeds bounds`);
      }
    };

    // The anchor every view now shares: a character's foot is the projected
    // bottom-centre of its tile and its sprite hangs the character's height
    // above it. `H` is what buys the top row's character its headroom, so
    // this is the case that would fail if `H` were sized off the props alone.
    const characterBox = (tile: OfficeTilePos): OfficeRect => {
      const foot = projector.project(tile.col + 0.5, tile.row + 1);
      return {
        x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
        y: foot.y - OFFICE_CHARACTER_HEIGHT,
        width: OFFICE_CHARACTER_WIDTH,
        height: OFFICE_CHARACTER_HEIGHT,
      };
    };
    const extremes: ReadonlyArray<OfficeTilePos> = [
      { col: 0, row: 0 },
      { col: layout.cols - 1, row: 0 },
      { col: 0, row: layout.rows - 1 },
      { col: layout.cols - 1, row: layout.rows - 1 },
    ];
    for (const tile of extremes) {
      checkBox(`character at ${tile.col},${tile.row}`, characterBox(tile));
    }
    for (const seat of layout.seats.values()) {
      checkBox(`character in ${seat.seatId}`, characterBox(seat.chairTile));
    }

    // The overview block map, which is world pixels rather than a sprite box.
    const tiles: OfficeTileRect = {
      col: 0,
      row: 0,
      cols: layout.cols,
      rows: layout.rows,
    };
    const blocks = ISO_PAINTER.floor(layout, tiles, 0);
    expect(blocks.length).toBeGreaterThan(0);
    for (const drawable of blocks) {
      expect(drawable.kind).toBe("block");
      if (drawable.kind !== "block") continue;
      checkBox("block", {
        x: drawable.x,
        y: drawable.y,
        width: drawable.width,
        height: drawable.height,
      });
    }

    // And every fixture an errand spot stands up.
    for (const floor of layout.floors) {
      for (const spot of floor.errandSpots) {
        for (const entry of ISO_PAINTER.spotProps(layout, spot, 2)) {
          if (entry.drawable.kind !== "sprite") continue;
          const size = officeSpriteSize(entry.drawable.sprite);
          checkBox(`spot ${spot.kind}`, {
            x: entry.drawable.x,
            y: entry.drawable.y,
            width: size.width,
            height: size.height,
          });
        }
      }
    }

    expect([...new Set(problems)]).toEqual([]);
  });
});
