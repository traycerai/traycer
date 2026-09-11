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
  measureCampus,
  planCampus,
} from "@/lib/comm-graph/office/views/isometric/campus-plan";
import { ISO_PAINTER } from "@/lib/comm-graph/office/views/isometric/iso-painter";
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
  // Vary activity so the same fixture doubles for City's height tests too, and
  // so nothing about Campus's own plan accidentally depends on it being zero.
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
 * The view contract's invariants (`view-contract/index.md` "Invariants"),
 * spelled out against one layout. `office-layout-contract.test.ts` pins the
 * same list against `layoutOffice`; this is that list again against a plan
 * this ticket owns, which is why it is not shared.
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

describe("planCampus", () => {
  describe.each([12, 309, 1000])(
    "the shared layout invariants at %i agents",
    (n) => {
      const input = inputFor("triage", n, VIEWPORT_1280);
      const layout = planCampus(input);
      const agentIds = new Set(input.agents.map((agent) => agent.id));

      it("holds", () => {
        expect(checkContract(layout, agentIds)).toEqual([]);
      });

      it("seats every agent exactly once", () => {
        expect(layout.desks.size).toBe(n);
        for (const agentId of agentIds)
          expect(layout.desks.has(agentId)).toBe(true);
      });
    },
  );

  it("re-packs every plan: stable is false, frozen is null, and there is no shift", () => {
    const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
    expect(layout.stable).toBe(false);
    expect(layout.frozen).toBeNull();
    expect(layout.shiftFromPrevious).toBeNull();
  });

  it("re-packs on growth, reports a non-empty moved set, and reseats everybody", () => {
    // The Floor's rule, restated for Campus: growth may move any seat, and the
    // scene walks exactly whoever moved. 64 -> 65 crosses a shelf boundary
    // (27x34 -> 30x34 tiles), which is why it is the case that was measured
    // rather than an arbitrary one: a boundary that happened to leave every
    // desk untouched would prove nothing about the moved set.
    const first = inputFor("triage", 64, VIEWPORT_1280);
    const a = planCampus(first);
    const epic = makeTestEpic("triage", 65, 1);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: first.partition,
    });
    const secondInput: OfficePlanInput = {
      ...first,
      agents: epic.agents,
      partition,
      previous: a,
    };
    const b = planCampus(secondInput);

    let moved = 0;
    for (const [agentId, desk] of a.desks) {
      const after = b.desks.get(agentId);
      expect(after).toBeDefined();
      if (after === undefined) continue;
      if (
        after.deskTile.col !== desk.deskTile.col ||
        after.deskTile.row !== desk.deskTile.row
      ) {
        moved += 1;
      }
    }
    // Measured: 56 of the 64 pre-existing agents move. The epic shape drives
    // the exact count, so only "more than none" is pinned here.
    expect(moved).toBeGreaterThan(0);
    expect(b.desks.size).toBe(65);
    for (const agentId of epic.agents.map((agent) => agent.id)) {
      expect(b.desks.has(agentId)).toBe(true);
    }

    // Determinism: re-running the same input produces byte-identical tiles.
    const bAgain = planCampus(secondInput);
    for (const [agentId, desk] of b.desks) {
      const again = bAgain.desks.get(agentId);
      expect(again?.deskTile).toEqual(desk.deskTile);
      expect(again?.seatId).toBe(desk.seatId);
    }
  });

  it("gives two hosts two districts, two host signs, and no walkable path between them", () => {
    const input = inputFor("two-hosts", 120, VIEWPORT_1280);
    const layout = planCampus(input);
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
    // Measured directly against `measureCampus` and the projector's own
    // bounds: 99 x 106 tiles, 3,280 x 1,684 projected px. Campus reads no
    // aspect, so the fit is viewport-independent of shape but not of the
    // viewport itself - each viewport gets its own pinned fit.
    const input1280 = inputFor("triage", 1000, VIEWPORT_1280);
    const layout1280 = planCampus(input1280);
    const size1280 = measureCampus(input1280);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout1280.cols, rows: layout1280.rows }).toEqual({
        cols: 99,
        rows: 106,
      });
      expect(size1280).toEqual({ width: 3280, height: 1684 });
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
      expect(fit).toBeCloseTo(0.39, 2);
    });

    it("pins the fit at 680x440", () => {
      const input680 = inputFor("triage", 1000, VIEWPORT_680);
      const size680 = measureCampus(input680);
      const fit = Math.min(
        VIEWPORT_680.width / size680.width,
        VIEWPORT_680.height / size680.height,
      );
      expect(fit).toBeCloseTo(0.21, 2);
    });
  });

  describe("projected bounds at 309 agents", () => {
    // Measured: 57 x 64 tiles, 1,936 x 1,012 px.
    const input = inputFor("triage", 309, VIEWPORT_1280);
    const layout = planCampus(input);
    const size = measureCampus(input);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout.cols, rows: layout.rows }).toEqual({
        cols: 57,
        rows: 64,
      });
      expect(size).toEqual({ width: 1936, height: 1012 });
    });

    it("pins the fit at both viewports", () => {
      const fit1280 = Math.min(
        VIEWPORT_1280.width / size.width,
        VIEWPORT_1280.height / size.height,
      );
      expect(fit1280).toBeCloseTo(0.66, 2);
      const input680 = inputFor("triage", 309, VIEWPORT_680);
      const size680 = measureCampus(input680);
      const fit680 = Math.min(
        VIEWPORT_680.width / size680.width,
        VIEWPORT_680.height / size680.height,
      );
      expect(fit680).toBeCloseTo(0.35, 2);
    });
  });

  it("moves every projected point by exactly the origin delta when rows grow", () => {
    const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
    const before = ISO_PAINTER.projector(layout);
    const k = 3;
    const after = ISO_PAINTER.projector({ ...layout, rows: layout.rows + k });
    const deltas = new Set<string>();
    for (let col = 0; col <= layout.cols; col += 7) {
      for (let row = 0; row <= layout.rows; row += 5) {
        const p = before.project(col, row);
        const q = after.project(col, row);
        deltas.add(`${q.x - p.x},${q.y - p.y}`);
      }
    }
    expect([...deltas]).toEqual([`${16 * k},0`]);
  });

  it("keeps the projector's bounds a superset of every drawable's sprite box", () => {
    const layout = planCampus(inputFor("triage", 200, VIEWPORT_1280));
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

    // Every seat's props, at the state most likely to reach for the corners:
    // an occupied desk with a full envelope stack, at close-up LOD.
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

    // Every chunk of floor, at office LOD - lod 0 draws nothing, so this is
    // the LOD that actually exercises walls, doors and props.
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
    const layout = planCampus(inputFor("triage", 200, VIEWPORT_1280));
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
