/**
 * Mission control plan: amphitheatre packing, growth, hosts, and the shared
 * layout invariants at the scales the fit estimates are quoted at.
 */
import { describe, expect, it } from "vitest";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import {
  officeSpriteColors,
  officeSpriteMaps,
  rasterizeSpriteMap,
} from "@/lib/comm-graph/office/office-pixel-art";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import type { OfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import {
  OFFICE_SIGN_FONT_PX,
  OFFICE_SIGN_LETTER_SPACING_EM,
  OFFICE_SIGN_NARROW_PLATE_MAX_CHARS,
  OFFICE_SIGN_PADDING_X,
  OFFICE_SIGN_PLATE_MAX_CHARS,
  officePlateRungs,
  officeSignCenterX,
  officeSignsToDraw,
  type OfficeSignToDraw,
} from "@/lib/comm-graph/office/office-signs";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type { OfficeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  AISLE_EVERY,
  frozenOf,
  isMissionControlFrozen,
  TIER_BASE_SEATS,
  TIER_SEAT_GROWTH,
  tierSeatCount,
} from "@/lib/comm-graph/office/views/mission-control/mission-control-plan";
import type { MissionControlFrozen } from "@/lib/comm-graph/office/views/mission-control/mission-control-plan";
import { MISSION_CONTROL_VIEW } from "@/lib/comm-graph/office/views/mission-control/mission-control-view";
import type {
  OfficeDeskState,
  OfficePlanInput,
  OfficeProjector,
  OfficeView,
} from "@/lib/comm-graph/office/views/office-view";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeCharacterPose,
  type OfficeCivicRoom,
  type OfficeCivicTally,
  type OfficeDrawable,
  type OfficeErrandSpot,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeLayout,
  type OfficePoint,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeSize,
  type OfficeSpriteName,
  type OfficeTilePos,
} from "@/lib/comm-graph/office/office-types";

/**
 * NOTHING IN ANY WARD, AND NO ARCHIVE TALLY: what a case that is not about the
 * civic signs hands the resolver.
 *
 * The storeys passed beside it are the real plan's, so a civic sign that does
 * appear still resolves against its own room - it just counts nobody.
 */
const NO_CIVIC_COUNTS = {
  occupiedByRoom: new Map<string, number>(),
  archivedByHost: new Map<string | null, number>(),
};

/** A stopped clock with motion unreduced: no sign in these cases blinks. */
const STILL_SIGN_CLOCK = { nowMs: 0, reducedMotion: false };

const TRIAGE_SCALES: ReadonlyArray<number> = [12, 309, 1000];
const VIEWPORT_WIDE: OfficeSize = { width: 1280, height: 700 };
const VIEWPORT_NARROW: OfficeSize = { width: 680, height: 440 };
const EMPTY_OCCUPANCY: ReadonlyMap<string, string> = new Map();
const EMPTY_NEEDS: ReadonlyArray<string> = [];
const EMPTY_ACTIVITY: ReadonlyMap<string, number> = new Map();

/** Measured from `planMissionControl` on triage seed 1; not the ticket estimates. */
/**
 * Re-measured for the medbay's two rows: the hall is two rows taller than it was
 * before it had a ward, so every fit the HEIGHT binds moved. The 309-agent
 * narrow fit is unchanged because width binds there, which is the check that
 * these are measurements and not three numbers nudged until green.
 */
const PINNED_FIT = {
  agents309: {
    wide: 0.8101851851851852,
    narrow: 0.5059523809523809,
  },
  agents1000: {
    wide: 0.4557291666666667,
    narrow: 0.2864583333333333,
  },
} as const;

interface Planned {
  readonly input: OfficePlanInput;
  readonly partition: OfficePopulation;
  readonly layout: OfficeLayout;
}

function isWalkable(layout: OfficeLayout, tile: OfficeTilePos): boolean {
  return layout.walkable[tile.row]?.[tile.col];
}

function floorBandContains(floor: OfficeFloor, row: number): boolean {
  return row >= floor.bounds.row && row < floor.bounds.row + floor.bounds.rows;
}

function occupancyOf(layout: OfficeLayout): Map<string, string> {
  const occupancy = new Map<string, string>();
  for (const desk of layout.desks.values()) {
    occupancy.set(desk.seatId, desk.agentId);
  }
  return occupancy;
}

function nextCreatedAt(agents: ReadonlyArray<OfficeAgentInput>): number {
  let max = 0;
  for (const agent of agents) {
    if (agent.createdAt > max) max = agent.createdAt;
  }
  return max + 1;
}

function aisleIndexOf(layout: OfficeLayout, id: string): number {
  const lead = layout.desks.get(id);
  if (lead === undefined) throw new Error(`missing lead ${id}`);
  const seats = [...layout.seats.values()]
    .filter(
      (seat) =>
        seat.kind === "console" && seat.deskTile.row === lead.deskTile.row,
    )
    .sort((left, right) => left.deskTile.col - right.deskTile.col);
  const index = seats.findIndex((seat) => seat.seatId === lead.seatId);
  if (
    index === 0 ||
    index === seats.length - 1 ||
    index % AISLE_EVERY === 0 ||
    index % AISLE_EVERY === AISLE_EVERY - 1
  ) {
    return -1;
  }
  return index;
}

function teamSizedEpic(sizes: ReadonlyArray<number>): OfficeTestEpic {
  const sample = makeTestEpic("many-roots", 1, 1);
  const root = sample.agents[0];
  const agents: OfficeAgentInput[] = [root];
  for (let t = 0; t < sizes.length; t += 1) {
    const lead = childAgent(root, `team-${t}-lead`, agents.length);
    agents.push(lead);
    for (let m = 1; m < sizes[t]; m += 1) {
      agents.push(childAgent(lead, `team-${t}-member-${m}`, agents.length));
    }
  }
  return { agents, statusById: new Map() };
}

function childAgent(
  parent: OfficeAgentInput,
  id: string,
  createdAt: number,
): OfficeAgentInput {
  return {
    id,
    name: id,
    kind: parent.kind,
    hostId: parent.hostId,
    archivedAt: null,
    modelTier: parent.modelTier,
    harnessId: parent.harnessId,
    model: parent.model,
    parentId: parent.id,
    archived: false,
    createdAt,
    appearance: parent.appearance,
  };
}

function appendChildren(
  agents: ReadonlyArray<OfficeAgentInput>,
  parent: OfficeAgentInput,
  ids: ReadonlyArray<string>,
): ReadonlyArray<OfficeAgentInput> {
  const createdAt = nextCreatedAt(agents);
  const born: OfficeAgentInput[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    born.push(childAgent(parent, ids[i], createdAt + i));
  }
  return [...agents, ...born];
}

function withIdleStatuses(
  previous: ReadonlyMap<string, OfficeAgentStatus>,
  agentIds: ReadonlyArray<string>,
): Map<string, OfficeAgentStatus> {
  const next = new Map(previous);
  for (const agentId of agentIds) next.set(agentId, "idle");
  return next;
}

function agentById(
  agents: ReadonlyArray<OfficeAgentInput>,
  id: string,
): OfficeAgentInput {
  const found = agents.find((agent) => agent.id === id);
  if (found === undefined) {
    throw new Error(`no agent ${id}`);
  }
  return found;
}

function rootAgent(agents: ReadonlyArray<OfficeAgentInput>): OfficeAgentInput {
  const found = agents.find((agent) => agent.parentId === null);
  if (found === undefined) {
    throw new Error("test epic has no root agent");
  }
  return found;
}

function requireFrozen(layout: OfficeLayout): MissionControlFrozen {
  const frozen = frozenOf(layout);
  if (frozen === null) {
    throw new Error("mission-control layout missing frozen metadata");
  }
  return frozen;
}

function consoleIndexOf(seatId: string): number | null {
  const prefix = "-/0/hall/";
  if (!seatId.startsWith(prefix)) return null;
  const raw = seatId.slice(prefix.length);
  if (raw === "podium") return null;
  const index = Number.parseInt(raw, 10);
  if (!Number.isFinite(index)) return null;
  return index;
}

function lastTierStartIndex(counts: ReadonlyArray<number>): number {
  let start = 0;
  for (let i = 0; i < counts.length - 1; i += 1) start += counts[i];
  return start;
}

function consoleSeatId(index: number): string {
  return `-/0/hall/${index}`;
}

function emptyUnreservedLastTierCount(layout: OfficeLayout): number {
  const frozen = requireFrozen(layout);
  const start = lastTierStartIndex(frozen.tierSeatCounts);
  const lastCount = frozen.tierSeatCounts[frozen.tierSeatCounts.length - 1];
  const reserved = new Set(
    frozen.teamReserveSeatIds.map((entry) => entry.seatId),
  );
  const occupied = occupancyOf(layout);
  let empty = 0;
  for (let i = 0; i < lastCount; i += 1) {
    const seatId = consoleSeatId(start + i);
    if (occupied.has(seatId)) continue;
    if (reserved.has(seatId)) continue;
    empty += 1;
  }
  return empty;
}

/**
 * APPEND-STABILITY IS ABOUT SOMEBODY'S OWN PLACE. A console and the podium are
 * an agent's seat for as long as it is here, so appending a tier may not move
 * one; the hall's civic furniture is not, and the medbay is DEFINED as the band
 * under the last tier, so it moves down with the tier that was just added. That
 * is the definition working rather than a seat being reshuffled - nobody is
 * given a bed, the seat book lends one for a crash and takes it back.
 */
function expectSeatsUnmoved(previous: OfficeLayout, next: OfficeLayout): void {
  for (const seat of previous.seats.values()) {
    const grown = next.seats.get(seat.seatId);
    expect(grown).toBeDefined();
    if (grown === undefined) continue;
    if (seat.civicRoomId !== null) continue;
    expect(grown.deskTile).toEqual(seat.deskTile);
    expect(grown.chairTile).toEqual(seat.chairTile);
  }
}

function expectOccupantsHold(previous: OfficeLayout, next: OfficeLayout): void {
  for (const desk of previous.desks.values()) {
    expect(next.desks.get(desk.agentId)?.seatId).toBe(desk.seatId);
  }
}

/** The hall's one ward. */
function infirmaryOf(layout: OfficeLayout): OfficeCivicRoom {
  const room = layout.floors[0].civic.find(
    (candidate) => candidate.kind === "infirmary",
  );
  if (room === undefined) throw new Error("the hall plans no infirmary");
  return room;
}

/** Its beds, in the order the ward names them. */
function bedsOf(layout: OfficeLayout): ReadonlyArray<OfficeSeat> {
  const beds: OfficeSeat[] = [];
  for (const seatId of infirmaryOf(layout).seatIds) {
    const seat = layout.seats.get(seatId);
    if (seat === undefined) throw new Error(`the ward lost ${seatId}`);
    beds.push(seat);
  }
  return beds;
}

/**
 * WHERE THE CHARACTER IS, from the frame's own hit regions.
 *
 * Not `scene.locate`, which is the camera's target and answers with the SEAT's
 * rect for a seated agent and the character's own box for a walking one - two
 * different rulers, so a before-and-after comparison through it would measure
 * the change of ruler rather than the walk. The character height is what picks
 * the person's region out of the furniture's.
 */
function characterRect(frame: OfficeFrame, agentId: string): OfficeRect {
  const region = frame.hitRegions.find(
    (candidate) =>
      candidate.agentId === agentId &&
      candidate.rect.height === OFFICE_CHARACTER_HEIGHT,
  );
  if (region === undefined) throw new Error(`no character for ${agentId}`);
  return region.rect;
}

/** The pose of the character drawn at exactly this rect, or `null` for none. */
function characterPoseAt(
  frame: OfficeFrame,
  rect: OfficeRect,
): OfficeCharacterPose | null {
  for (const drawable of frameDrawables(frame)) {
    if (drawable.kind !== "sprite") continue;
    if (drawable.sprite.name !== "character") continue;
    if (drawable.x !== rect.x || drawable.y !== rect.y) continue;
    return drawable.sprite.pose ?? null;
  }
  return null;
}

/** Generous: this bounds a walk across the hall, it does not describe one. */
const WALK_TICK_LIMIT = 400;

/**
 * Tick until this agent's character is standing on one of these seats, and
 * answer with the seat and the rect it got there at.
 *
 * WHICH seat is READ rather than picked, because the seat book hands out the
 * first free one and the pose would not tell us: an agent holding a bed is drawn
 * `sit` from the moment it is given, while its body is still in its own chair on
 * the other side of the hall.
 */
function tickOntoASeat(args: {
  readonly scene: OfficeScene;
  readonly agentId: string;
  readonly seats: ReadonlyArray<OfficeSeat>;
  readonly rectAt: (tile: OfficeTilePos) => OfficeRect;
}): { readonly seat: OfficeSeat; readonly rect: OfficeRect } {
  for (let tick = 0; tick < WALK_TICK_LIMIT; tick += 1) {
    const now = characterRect(args.scene.frame(2, WHOLE_WORLD), args.agentId);
    const seat = args.seats.find((candidate) => {
      const seatRect = args.rectAt(candidate.chairTile);
      return seatRect.x === now.x && seatRect.y === now.y;
    });
    if (seat !== undefined) return { seat, rect: now };
    args.scene.tick(100);
  }
  throw new Error(`${args.agentId} never reached one of these seats`);
}

/**
 * The one step every seat in a band moved by between two plans.
 *
 * ONE step, asserted: a band defined relative to something that moved moves as a
 * unit, which is the definition working rather than the room being reshuffled.
 * Also fails if the band starts sliding sideways. A seat missing from `next` is
 * THE FALSIFIER - a bed that came back under a new id is, to the seat book, the
 * old one vanishing with somebody in it.
 */
function bandStep(
  before: ReadonlyArray<OfficeSeat>,
  next: OfficeLayout,
  projector: OfficeProjector,
): OfficePoint {
  let step: OfficePoint | null = null;
  for (const seat of before) {
    const after = next.seats.get(seat.seatId);
    if (after === undefined) {
      throw new Error(`the band renamed ${seat.seatId}`);
    }
    const from = projector.project(seat.chairTile.col, seat.chairTile.row);
    const to = projector.project(after.chairTile.col, after.chairTile.row);
    const moved: OfficePoint = { x: to.x - from.x, y: to.y - from.y };
    if (step === null) step = moved;
    else expect(moved).toEqual(step);
  }
  if (step === null) throw new Error("the band has no seats");
  return step;
}

function fitInViewport(layout: OfficeLayout, viewport: OfficeSize): number {
  return Math.min(
    viewport.width / (layout.cols * OFFICE_TILE),
    viewport.height / (layout.rows * OFFICE_TILE),
  );
}

function planOffice(args: {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly occupancy: ReadonlyMap<string, string>;
  readonly needsCapacity: ReadonlyArray<string>;
  readonly viewport: OfficeSize;
  readonly previousLayout: OfficeLayout | null;
  readonly previousPartition: OfficePopulation | null;
}): Planned {
  const partition = partitionOfficePopulation({
    agents: args.agents,
    statusById: args.statusById,
    previous: args.previousPartition,
  });
  const input: OfficePlanInput = {
    agents: args.agents,
    partition,
    occupancy: args.occupancy,
    needsCapacity: args.needsCapacity,
    activityById: EMPTY_ACTIVITY,
    viewport: args.viewport,
    previous: args.previousLayout,
  };
  return {
    input,
    partition,
    layout: MISSION_CONTROL_VIEW.plan(input),
  };
}

function planFresh(epic: OfficeTestEpic, viewport: OfficeSize): Planned {
  return planOffice({
    agents: epic.agents,
    statusById: epic.statusById,
    occupancy: EMPTY_OCCUPANCY,
    needsCapacity: EMPTY_NEEDS,
    viewport,
    previousLayout: null,
    previousPartition: null,
  });
}

function growPlan(request: {
  readonly previous: Planned;
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly arrivals: ReadonlyArray<string>;
  readonly viewport: OfficeSize;
}): Planned {
  return planOffice({
    agents: request.agents,
    statusById: request.statusById,
    occupancy: occupancyOf(request.previous.layout),
    needsCapacity: request.arrivals,
    viewport: request.viewport,
    previousLayout: request.previous.layout,
    previousPartition: request.previous.partition,
  });
}

describe("planMissionControl", () => {
  it("grows tier widths by two", () => {
    const epic = makeTestEpic("triage", 309, 1);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const frozen = requireFrozen(planned.layout);
    expect(frozen.tierSeatCounts.length).toBeGreaterThan(0);
    for (let r = 0; r < frozen.tierSeatCounts.length; r += 1) {
      expect(frozen.tierSeatCounts[r]).toBe(
        TIER_BASE_SEATS + TIER_SEAT_GROWTH * r,
      );
      expect(frozen.tierSeatCounts[r]).toBe(tierSeatCount(r));
    }
  });

  it("seats a child joining an earlier team on that team's free reserve", () => {
    const epic = makeTestEpic("triage", 40, 1);
    const prior = planFresh(epic, VIEWPORT_WIDE);
    const frozen = requireFrozen(prior.layout);
    expect(frozen.teamReserveSeatIds.length).toBeGreaterThan(0);
    const reserve = frozen.teamReserveSeatIds[0];
    expect(occupancyOf(prior.layout).has(reserve.seatId)).toBe(false);

    const lead = agentById(epic.agents, reserve.teamId);
    const childId = "join-reserve-child";
    const agents = appendChildren(epic.agents, lead, [childId]);
    const grown = growPlan({
      previous: prior,
      agents,
      statusById: withIdleStatuses(epic.statusById, [childId]),
      arrivals: [childId],
      viewport: VIEWPORT_WIDE,
    });

    expect(grown.layout.desks.get(childId)?.seatId).toBe(reserve.seatId);
    expectOccupantsHold(prior.layout, grown.layout);
    expectSeatsUnmoved(prior.layout, grown.layout);
  });

  it("seats a later team child at the last-tier tail once the reserve is taken", () => {
    const epic = makeTestEpic("triage", 40, 1);
    const prior = planFresh(epic, VIEWPORT_WIDE);
    const frozen = requireFrozen(prior.layout);
    expect(frozen.teamReserveSeatIds.length).toBeGreaterThan(0);
    const reserve = frozen.teamReserveSeatIds[0];
    const lead = agentById(epic.agents, reserve.teamId);
    const firstId = "join-reserve-first";
    const overflowId = "join-reserve-overflow";

    const afterFirstAgents = appendChildren(epic.agents, lead, [firstId]);
    const afterFirst = growPlan({
      previous: prior,
      agents: afterFirstAgents,
      statusById: withIdleStatuses(epic.statusById, [firstId]),
      arrivals: [firstId],
      viewport: VIEWPORT_WIDE,
    });
    expect(afterFirst.layout.desks.get(firstId)?.seatId).toBe(reserve.seatId);

    const afterOverflowAgents = appendChildren(afterFirstAgents, lead, [
      overflowId,
    ]);
    const grown = growPlan({
      previous: afterFirst,
      agents: afterOverflowAgents,
      statusById: withIdleStatuses(epic.statusById, [firstId, overflowId]),
      arrivals: [overflowId],
      viewport: VIEWPORT_WIDE,
    });

    const overflowDesk = grown.layout.desks.get(overflowId);
    expect(overflowDesk).toBeDefined();
    if (overflowDesk === undefined) return;
    expect(overflowDesk.seatId).not.toBe(reserve.seatId);
    const index = consoleIndexOf(overflowDesk.seatId);
    expect(index).not.toBeNull();
    if (index === null) return;
    const lastStart = lastTierStartIndex(
      requireFrozen(grown.layout).tierSeatCounts,
    );
    expect(index).toBeGreaterThanOrEqual(lastStart);

    expectOccupantsHold(afterFirst.layout, grown.layout);
    expectSeatsUnmoved(afterFirst.layout, grown.layout);
  });

  it("appends a tier when the last tier is full and moves no existing seat", () => {
    const epic = makeTestEpic("triage", 40, 1);
    const prior = planFresh(epic, VIEWPORT_WIDE);
    const empty = emptyUnreservedLastTierCount(prior.layout);
    const root = rootAgent(epic.agents);
    const ids: string[] = [];
    for (let i = 0; i < empty + 1; i += 1) {
      ids.push(`last-tier-fill-${i}`);
    }
    const agents = appendChildren(epic.agents, root, ids);
    const grown = growPlan({
      previous: prior,
      agents,
      statusById: withIdleStatuses(epic.statusById, ids),
      arrivals: ids,
      viewport: VIEWPORT_WIDE,
    });

    expect(grown.layout.shiftFromPrevious).toBeNull();
    expect(requireFrozen(grown.layout).tierSeatCounts.length).toBe(
      requireFrozen(prior.layout).tierSeatCounts.length + 1,
    );
    expectOccupantsHold(prior.layout, grown.layout);
    expectSeatsUnmoved(prior.layout, grown.layout);
    for (const id of ids) {
      expect(grown.layout.desks.has(id)).toBe(true);
    }
  });

  /**
   * RULING 7'S COST, PAID IN A WALK. The medbay is the band under the LAST tier,
   * so appending a tier moves it down a tier's worth of rows, and an agent lying
   * in a bed when that happens is the only thing that costs anything. This pins
   * what it costs: the bed keeps its id, the agent keeps its claim, and it WALKS
   * to where the bed went.
   *
   * A bed is LENT, not owned, which is why the band may move at all where moving
   * somebody's own console may not - `expectSeatsUnmoved` skips civic seats for
   * exactly that reason. But "lent" does not license a jump cut: a character
   * that blinked across the hall is the scene DROPPING somebody into a room,
   * which is the one thing the civic walk must never do, so the pin is that the
   * character is still at the old tile the instant the plan changes and takes
   * more than one tick to reach the new one.
   *
   * THE FALSIFIER IS A PLAN THAT RENAMES THE BED on append. A new `seatId` for
   * the same bed reads to the seat book as the old one vanishing with somebody
   * in it: the claim ends, the agent goes home to its desk, and the pose at the
   * ward would be nothing at all.
   *
   * Measured through the BAND's common step rather than by naming the bed the
   * patient took. Every bed moves by the same amount because the ward is defined
   * relative to the tier, and asserting that is what makes the one step below
   * sound - it also fails if the ward starts sliding sideways with tier width.
   */
  it("walks an agent lying in a bed to the bed's new tile when a tier appends", () => {
    const epic = makeTestEpic("triage", 40, 1);
    const prior = planFresh(epic, VIEWPORT_WIDE);
    const root = rootAgent(epic.agents);
    const patient = epic.agents.find((agent) => agent.id !== root.id);
    if (patient === undefined) throw new Error("no agent to put in a bed");
    const ward = infirmaryOf(prior.layout);
    const bedsBefore = bedsOf(prior.layout);
    expect(bedsBefore.length).toBeGreaterThan(0);
    const desk = prior.layout.desks.get(patient.id);
    if (desk === undefined) throw new Error(`${patient.id} has no desk`);

    const failing = (
      statuses: ReadonlyMap<string, OfficeAgentStatus>,
    ): Map<string, OfficeAgentStatus> => {
      const next = new Map(statuses);
      next.set(patient.id, "failure");
      return next;
    };

    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    const priorInput = sceneInputFor(prior.input);
    scene.sync({ ...priorInput, reducedMotion: true });

    // THE FOOT OFFSET IS MEASURED, NOT ASSUMED. A character's rect is its tile
    // projected plus however far the painter lifts a body off the floor, and
    // that is the painter's business - so it is read off a tile the character is
    // provably at (its own desk, before anything has happened to it) and then
    // used to say where a bed's tile would draw one.
    const priorProjector = MISSION_CONTROL_VIEW.painter.projector(prior.layout);
    const deskRect = characterRect(scene.frame(2, WHOLE_WORLD), patient.id);
    const deskPoint = priorProjector.project(
      desk.chairTile.col,
      desk.chairTile.row,
    );
    const foot: OfficePoint = {
      x: deskRect.x - deskPoint.x,
      y: deskRect.y - deskPoint.y,
    };
    const rectAt = (
      tile: OfficeTilePos,
      projector: OfficeProjector,
    ): OfficeRect => {
      const point = projector.project(tile.col, tile.row);
      return {
        x: point.x + foot.x,
        y: point.y + foot.y,
        width: deskRect.width,
        height: deskRect.height,
      };
    };

    // THE CRASH IS ITS OWN SYNC. A status the office has never seen anything
    // else for is not an agent that CRASHED, and the walk has to start from the
    // desk it was sitting at.
    scene.sync({
      ...priorInput,
      statusById: failing(priorInput.statusById),
      reducedMotion: false,
    });

    const arrival = tickOntoASeat({
      scene,
      agentId: patient.id,
      seats: bedsBefore,
      rectAt: (tile) => rectAt(tile, priorProjector),
    });
    const bed = arrival.seat;
    const restRect = arrival.rect;
    expect(scene.whereabouts(patient.id)).toBe(ward.name);
    expect(characterPoseAt(scene.frame(2, WHOLE_WORLD), restRect)).toBe("sit");

    const empty = emptyUnreservedLastTierCount(prior.layout);
    const ids: string[] = [];
    for (let i = 0; i < empty + 1; i += 1) ids.push(`last-tier-fill-${i}`);
    const grown = growPlan({
      previous: prior,
      agents: appendChildren(epic.agents, root, ids),
      statusById: withIdleStatuses(epic.statusById, ids),
      arrivals: ids,
      viewport: VIEWPORT_WIDE,
    });
    expect(requireFrozen(grown.layout).tierSeatCounts.length).toBe(
      requireFrozen(prior.layout).tierSeatCounts.length + 1,
    );
    // No uniform shift, so a rect changing below is the BED having moved and not
    // the whole hall sliding under a re-origined projector - which is also what
    // lets the offset measured above stay good across the two plans.
    expect(grown.layout.shiftFromPrevious).toBeNull();

    const grownProjector = MISSION_CONTROL_VIEW.painter.projector(grown.layout);
    const step = bandStep(bedsBefore, grown.layout, grownProjector);
    expect(step).not.toEqual({ x: 0, y: 0 });

    const movedBed = grown.layout.seats.get(bed.seatId);
    if (movedBed === undefined) throw new Error("the ward renamed the bed");
    const target = rectAt(movedBed.chairTile, grownProjector);

    const grownInput = sceneInputFor(grown.input);
    scene.sync({
      ...grownInput,
      statusById: failing(grownInput.statusById),
      reducedMotion: false,
    });

    // STILL WHERE IT WAS. The plan has moved the bed; the character has not
    // moved, because it is about to walk there.
    //
    // Its `whereabouts` is deliberately NOT asserted here: a walking agent is
    // named by the tile it stands on, and that tile is the bed's OLD one, which
    // this very append turned into tier floor. "Medbay" comes back below.
    expect(characterRect(scene.frame(2, WHOLE_WORLD), patient.id)).toEqual(
      restRect,
    );

    let ticks = 0;
    let arrived = 0;
    while (ticks < WALK_TICK_LIMIT) {
      scene.tick(100);
      ticks += 1;
      const now = characterRect(scene.frame(2, WHOLE_WORLD), patient.id);
      if (now.x !== target.x || now.y !== target.y) continue;
      arrived = ticks;
      break;
    }
    expect(characterRect(scene.frame(2, WHOLE_WORLD), patient.id)).toEqual(
      target,
    );
    // IT WALKED. A teleport is there on the first tick.
    expect(arrived).toBeGreaterThan(1);

    // AND IT IS IN THE BED, still claiming it. A crashed agent in a ward is
    // drawn the way the nap room draws a sleeper - `sit`, the pose the seated
    // errands already use - rather than `crash`, which is the DESK pose and
    // would mean its claim had ended and it had gone home to the monitor.
    expect(characterPoseAt(scene.frame(2, WHOLE_WORLD), target)).toBe("sit");
    expect(scene.whereabouts(patient.id)).toBe(ward.name);
  });

  it("gives two hosts two host signs and two host bands on one floor", () => {
    const epic = makeTestEpic("two-hosts", 60, 1);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const layout = planned.layout;

    expect(layout.floors).toHaveLength(1);
    const floor = layout.floors[0];
    // One mixed hall: the floor is not a host storey, so its hostId is null
    // while seats keep the agent host the colour bands are drawn from.
    expect(floor.hostId).toBeNull();

    const hostSigns = layout.signs.filter((sign) => sign.kind === "host");
    expect(hostSigns).toHaveLength(2);
    expect(new Set(hostSigns.map((sign) => sign.hostId))).toEqual(
      new Set(["host-a", "host-b"]),
    );

    const consoleHostIds = new Set<string>();
    for (const seat of layout.seats.values()) {
      expect(seat.floorIndex).toBe(0);
      // Hosted seats keep the agent host; the floor does not. Unassigned
      // general reserves may be hostless, matching the mixed floor.
      if (seat.hostId !== null) {
        expect(seat.hostId).not.toBe(floor.hostId);
      }
      if (seat.kind !== "console") continue;
      if (seat.hostId === null) continue;
      consoleHostIds.add(seat.hostId);
    }
    expect(consoleHostIds.has("host-a")).toBe(true);
    expect(consoleHostIds.has("host-b")).toBe(true);
    expect(consoleHostIds.size).toBe(2);
  });

  describe.each([
    {
      n: 309,
      viewport: VIEWPORT_WIDE,
      pinned: PINNED_FIT.agents309.wide,
      label: "1280×700",
    },
    {
      n: 309,
      viewport: VIEWPORT_NARROW,
      pinned: PINNED_FIT.agents309.narrow,
      label: "680×440",
    },
    {
      n: 1000,
      viewport: VIEWPORT_WIDE,
      pinned: PINNED_FIT.agents1000.wide,
      label: "1280×700",
    },
    {
      n: 1000,
      viewport: VIEWPORT_NARROW,
      pinned: PINNED_FIT.agents1000.narrow,
      label: "680×440",
    },
  ])("fit at $n agents in $label", ({ n, viewport, pinned }) => {
    it("pins the measured fit", () => {
      const epic = makeTestEpic("triage", n, 1);
      const planned = planFresh(epic, viewport);
      const fit = fitInViewport(planned.layout, viewport);
      expect(fit).toBeCloseTo(pinned, 2);
    });
  });
});

describe("planMissionControl contract", () => {
  describe.each(TRIAGE_SCALES)("triage at %i agents", (n) => {
    const epic = makeTestEpic("triage", n, 1);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const layout = planned.layout;
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
      for (const desk of layout.desks.values()) {
        expect(layout.seats.get(desk.seatId)).toEqual(desk);
      }
    });

    it("lets every chair reach its own floor's door", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        const path = findOfficePath(layout, desk.chairTile, floor.doorTile);
        expect(path).not.toBeNull();
      }
    });

    it("keeps every spot approach tile, corridor tile and visit tile walkable", () => {
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

    it("names an agent that exists for every sign with an owner", () => {
      for (const sign of layout.signs) {
        if (sign.ownerAgentId === null) continue;
        expect(agentIds.has(sign.ownerAgentId)).toBe(true);
      }
    });

    it("resolves every seat.roomId to the single hall room", () => {
      expect(layout.rooms).toHaveLength(1);
      expect(layout.rooms[0].rootAgentId).toBe("hall");
      for (const seat of layout.seats.values()) {
        const room = layout.rooms.find(
          (candidate) => candidate.rootAgentId === seat.roomId,
        );
        expect(room).toBeDefined();
      }
    });

    it("is one stable mission-control floor", () => {
      expect(layout.floors).toHaveLength(1);
      expect(layout.stable).toBe(true);
      expect(layout.view).toBe("mission-control");
      expect(layout.view).toBe(MISSION_CONTROL_VIEW.id);
      expect(isMissionControlFrozen(layout.frozen)).toBe(true);
      for (const desk of layout.desks.values()) {
        expect(desk.floorIndex).toBe(0);
        expect(floorBandContains(layout.floors[0], desk.deskTile.row)).toBe(
          true,
        );
      }
    });

    it("uses console seats facing up and a podium desk facing down", () => {
      let consoleCount = 0;
      for (const seat of layout.seats.values()) {
        if (seat.kind !== "console") continue;
        expect(seat.hitTiles).toEqual({ width: 2, height: 1 });
        expect(seat.facing).toBe("up");
        consoleCount += 1;
      }
      expect(consoleCount).toBeGreaterThan(0);

      const podium = [...layout.seats.values()].find(
        (seat) => seat.kind === "desk",
      );
      expect(podium).toBeDefined();
      if (podium === undefined) return;
      expect(podium.facing).toBe("down");
      expect(podium.seatId).toBe("-/0/hall/podium");
    });

    it("matches measureMissionControl to cols×OFFICE_TILE by rows×OFFICE_TILE", () => {
      const measured = MISSION_CONTROL_VIEW.measure(planned.input);
      expect(measured).toEqual({
        width: layout.cols * OFFICE_TILE,
        height: layout.rows * OFFICE_TILE,
      });
    });

    it("gives cafe tables distinct fixture ids and the pingpong pair one id", () => {
      const spots: ReadonlyArray<OfficeErrandSpot> =
        layout.floors[0].errandSpots;
      const cafe = spots.filter((spot) => spot.kind === "cafe");
      expect(cafe.length).toBeGreaterThanOrEqual(2);
      const cafeRows = new Set(cafe.map((spot) => spot.tile.row));
      for (const row of cafeRows) {
        const ids = new Set(
          cafe
            .filter((spot) => spot.tile.row === row)
            .map((spot) => spot.fixtureId),
        );
        expect(ids.size).toBeGreaterThan(1);
      }

      const pingpong = spots.filter((spot) => spot.kind === "pingpong");
      expect(pingpong).toHaveLength(2);
      expect(pingpong[0].fixtureId).toBe(pingpong[1].fixtureId);
    });
  });
});

const WHOLE_WORLD = { x: 0, y: 0, width: 10000, height: 10000 };
const DESK_STATE: OfficeDeskState = {
  agentId: "probe",
  name: "probe",
  status: "working",
  sheeted: false,
  openRequests: 3,
  screenFrame: 0,
  harnessId: null,
  modelTier: "medium",
  accentId: null,
};

function sceneInputFor(input: OfficePlanInput): OfficeSceneInput {
  return {
    agents: input.agents,
    partition: input.partition,
    activityById: input.activityById,
    viewport: input.viewport,
    visibleAgentIds: new Set(input.agents.map((agent) => agent.id)),
    statusById: new Map(input.agents.map((agent) => [agent.id, "working"])),
    openRequestsByReceiver: new Map(),
    pulse: null,
    pulseKey: null,
    stepMs: 800,
    cursorMs: null,
    clockMs: 0,
    playing: false,
    reducedMotion: false,
    feedSettled: false,
  };
}

function sceneOf(epic: OfficeTestEpic): OfficeScene {
  const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
  scene.sync(sceneInputFor(planFresh(epic, VIEWPORT_WIDE).input));
  return scene;
}

function requireLayout(scene: OfficeScene): OfficeLayout {
  const layout = scene.layout();
  if (layout === null) throw new Error("scene has no layout");
  return layout;
}

function frameDrawables(frame: OfficeFrame): ReadonlyArray<OfficeDrawable> {
  const world =
    frame.world === null ? [] : frame.world.map((entry) => entry.drawable);
  return [...frame.floor, ...frame.props, ...frame.actors, ...world];
}

/**
 * A drawable narrowed to the one kind that is anchored at a top-left corner.
 *
 * Only some of the vocabulary carries `x` and `y` - the lod-0 `quad` carries
 * four corners instead - so a `find` or a `filter` whose result is read for a
 * position has to narrow rather than test, which a plain boolean predicate
 * does not do.
 */
type SpriteDrawable = Extract<OfficeDrawable, { kind: "sprite" }>;

function isSpriteNamed(
  drawable: OfficeDrawable,
  name: OfficeSpriteName,
): drawable is SpriteDrawable {
  return drawable.kind === "sprite" && drawable.sprite.name === name;
}

function spriteCount(
  draws: ReadonlyArray<OfficeDrawable>,
  name: OfficeSpriteName,
): number {
  return draws.filter(
    (drawable) => drawable.kind === "sprite" && drawable.sprite.name === name,
  ).length;
}

function floorSpriteAtTile(
  draws: ReadonlyArray<OfficeDrawable>,
  tile: OfficeTilePos,
): OfficeSpriteName | null {
  const sprites = draws.filter(
    (drawable) =>
      drawable.kind === "sprite" &&
      drawable.x === tile.col * OFFICE_TILE &&
      drawable.y === tile.row * OFFICE_TILE,
  );
  const last = sprites.at(-1);
  if (last === undefined || last.kind !== "sprite") return null;
  return last.sprite.name;
}

function firstConsole(layout: OfficeLayout): OfficeSeat {
  for (const seat of layout.seats.values()) {
    if (seat.kind === "console") return seat;
  }
  throw new Error("no console seat");
}

function grownFrom(
  input: OfficePlanInput,
  previous: OfficeLayout,
  arrivals: ReadonlyArray<OfficeAgentInput>,
): OfficePlanInput {
  const agents = [...input.agents, ...arrivals];
  const statuses = new Map<string, OfficeAgentStatus>(
    agents.map((agent) => [agent.id, "working"]),
  );
  const occupancy = new Map<string, string>();
  for (const desk of previous.desks.values()) {
    occupancy.set(desk.seatId, desk.agentId);
  }
  return {
    agents,
    partition: partitionOfficePopulation({
      agents,
      statusById: statuses,
      previous: input.partition,
    }),
    occupancy,
    needsCapacity: [],
    activityById: input.activityById,
    viewport: input.viewport,
    previous,
  };
}

function rasterColors(name: OfficeSpriteName): string[] {
  const entry = officeSpriteMaps().find((item) => item.name === name);
  if (entry === undefined) return [];
  const paint = rasterizeSpriteMap(
    entry.map,
    officeSpriteColors({ name }, "dark"),
    false,
  );
  const colors = new Set<string>();
  for (let i = 0; i < paint.pixels.length; i += 4) {
    colors.add(Array.from(paint.pixels.slice(i, i + 4)).join(","));
  }
  return [...colors].sort();
}

function consoleCoversPixel(request: {
  readonly draws: ReadonlyArray<OfficeDrawable>;
  readonly afterIndex: number;
  readonly px: number;
  readonly py: number;
  readonly consoleMap: ReadonlyArray<string>;
}): boolean {
  for (let i = request.afterIndex; i < request.draws.length; i += 1) {
    const later = request.draws[i];
    if (later.kind !== "sprite") continue;
    if (later.sprite.name !== "console") continue;
    const lx = request.px - later.x;
    const ly = request.py - later.y;
    if (lx < 0 || ly < 0 || ly >= request.consoleMap.length) continue;
    const row = request.consoleMap[ly];
    if (lx >= row.length) continue;
    if (row[lx] !== ".") return true;
  }
  return false;
}

function exposedStepPixels(
  draws: ReadonlyArray<OfficeDrawable>,
  steps: ReadonlyArray<OfficeDrawable>,
): number {
  const maps = new Map(
    officeSpriteMaps().map((entry) => [entry.name, entry.map]),
  );
  const consoleMap = maps.get("console");
  if (consoleMap === undefined) throw new Error("no console map");
  let exposed = 0;
  for (const step of steps) {
    if (step.kind !== "sprite") continue;
    const map = maps.get(step.sprite.name);
    if (map === undefined) throw new Error("no step map");
    const raster = rasterizeSpriteMap(
      map,
      officeSpriteColors(step.sprite, "dark"),
      false,
    );
    const afterIndex = draws.indexOf(step) + 1;
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        if (raster.pixels[(y * raster.width + x) * 4 + 3] === 0) continue;
        if (
          !consoleCoversPixel({
            draws,
            afterIndex,
            px: step.x + x,
            py: step.y + y,
            consoleMap,
          })
        ) {
          exposed += 1;
        }
      }
    }
  }
  return exposed;
}

function countingElementReads<T>(
  items: ReadonlyArray<T>,
  onIndex: (index: number) => void,
): ReadonlyArray<T> {
  return new Proxy(items, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        onIndex(Number.parseInt(property, 10));
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
}

function countingReads<T>(
  items: ReadonlyArray<T>,
  onRead: () => void,
): ReadonlyArray<T> {
  return countingElementReads(items, () => {
    onRead();
  });
}

function countingIndexReads<T>(
  items: ReadonlyArray<T>,
  seen: number[],
): ReadonlyArray<T> {
  return countingElementReads(items, (index) => {
    seen.push(index);
  });
}

function sceneAdvance(
  input: OfficePlanInput,
  scene: OfficeScene,
  agents: ReadonlyArray<OfficeAgentInput>,
): OfficePlanInput {
  const previous = requireLayout(scene);
  const statuses = new Map<string, OfficeAgentStatus>(
    agents.map((agent) => [agent.id, "working"]),
  );
  const next: OfficePlanInput = {
    ...input,
    agents,
    partition: partitionOfficePopulation({
      agents,
      statusById: statuses,
      previous: input.partition,
    }),
    occupancy: occupancyOf(previous),
    previous,
  };
  scene.sync({ ...sceneInputFor(next), reducedMotion: true });
  return next;
}

class CountingSeatMap extends Map<string, OfficeSeat> {
  constructor(
    entries: Iterable<readonly [string, OfficeSeat]>,
    private readonly onVisit: () => void,
  ) {
    super(entries);
  }

  override *values(): MapIterator<OfficeSeat> {
    for (const seat of super.values()) {
      this.onVisit();
      yield seat;
    }
  }

  override *entries(): MapIterator<[string, OfficeSeat]> {
    for (const entry of super.entries()) {
      this.onVisit();
      yield entry;
    }
  }

  override *keys(): MapIterator<string> {
    for (const key of super.keys()) {
      this.onVisit();
      yield key;
    }
  }

  override [Symbol.iterator](): MapIterator<[string, OfficeSeat]> {
    return this.entries();
  }

  override forEach(
    callback: Parameters<Map<string, OfficeSeat>["forEach"]>[0],
    thisArg: Parameters<Map<string, OfficeSeat>["forEach"]>[1],
  ): void {
    for (const [key, seat] of this.entries()) {
      callback.call(thisArg, seat, key, this);
    }
  }
}

describe("mission-control cold-review findings", () => {
  it("keeps the incumbent on the podium when an earlier HQ arrives from another host", () => {
    const fixture = makeTestEpic("many-roots", 2, 1);
    const agents = fixture.agents.map((agent, index) => ({
      ...agent,
      hostId: "host-a",
      createdAt: 100 + index,
    }));
    const epic: OfficeTestEpic = { ...fixture, agents };
    const input = planFresh(epic, VIEWPORT_WIDE).input;
    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    scene.sync(sceneInputFor(input));
    const prior = requireLayout(scene);
    const incumbent = input.agents[0];
    const arrival: OfficeAgentInput = {
      ...input.agents[0],
      id: "older-remote-hq",
      name: "Older remote HQ",
      hostId: "host-b",
      createdAt: 50,
    };
    const next = grownFrom(input, prior, [arrival]);
    scene.sync({ ...sceneInputFor(next), reducedMotion: true });
    const layout = requireLayout(scene);
    expect(layout.desks.size).toBe(3);
    expect(layout.desks.get(incumbent.id)?.seatId).toBe(
      prior.desks.get(incumbent.id)?.seatId,
    );
    expect(layout.desks.get(arrival.id)?.seatId).not.toBe("-/0/hall/podium");
    expect(scene.locate(incumbent.id)).not.toEqual(scene.locate(arrival.id));
    expect(scene.locate(arrival.id)).not.toBeNull();
  });

  it("paints every declared whiteboard, the reception and the bookcase", () => {
    const scene = sceneOf(makeTestEpic("triage", 40, 1));
    const layout = requireLayout(scene);
    const draws = frameDrawables(scene.frame(2, WHOLE_WORLD));
    const plannedBoard = layout.props.filter(
      (prop) => prop.sprite.name === "whiteboard",
    );
    expect(spriteCount(draws, "whiteboard")).toBe(plannedBoard.length);
    expect(spriteCount(draws, "whiteboard")).toBe(48);
    expect(spriteCount(draws, "reception")).toBe(1);
    expect(spriteCount(draws, "bookcase")).toBe(1);
  });

  it("tints only a team's own seats when that team overflows to the tail", () => {
    const input = planFresh(
      makeTestEpic("triage", 309, 1),
      VIEWPORT_WIDE,
    ).input;
    const prior = MISSION_CONTROL_VIEW.plan(input);
    const reserve = frozenOf(prior)?.teamReserveSeatIds[0];
    if (reserve === undefined) throw new Error("no reserve");
    const parent = input.agents.find((agent) => agent.id === reserve.teamId);
    if (parent === undefined) throw new Error("no lead");
    const first = grownFrom(input, prior, [
      childAgent(parent, "new-child-1", nextCreatedAt(input.agents)),
    ]);
    const one = MISSION_CONTROL_VIEW.plan(first);
    const second = grownFrom(first, one, [
      childAgent(parent, "new-child-2", nextCreatedAt(first.agents)),
    ]);
    const two = MISSION_CONTROL_VIEW.plan(second);
    const oldFloor = MISSION_CONTROL_VIEW.painter.floor(
      prior,
      { col: 0, row: 0, cols: prior.cols, rows: prior.rows },
      1,
    );
    const newFloor = MISSION_CONTROL_VIEW.painter.floor(
      two,
      { col: 0, row: 0, cols: two.cols, rows: two.rows },
      1,
    );
    const changed: string[] = [];
    for (const [id, desk] of prior.desks) {
      if (input.partition.members.get(id)?.teamId !== null) continue;
      const probe = { col: desk.chairTile.col + 1, row: desk.chairTile.row };
      if (
        floorSpriteAtTile(oldFloor, probe) !==
        floorSpriteAtTile(newFloor, probe)
      ) {
        changed.push(id);
      }
    }
    expect(changed).toEqual([]);
  });

  it("sits every team lead at an aisle end on triage 309 and 1000", () => {
    for (const n of [309, 1000]) {
      const planned = planFresh(makeTestEpic("triage", n, 1), VIEWPORT_WIDE);
      const bad: string[] = [];
      for (const host of planned.input.partition.hosts) {
        for (const team of host.teams) {
          const lead = planned.layout.desks.get(team.teamId);
          if (lead === undefined) throw new Error(`no lead ${team.teamId}`);
          const rowSeats = [...planned.layout.seats.values()]
            .filter(
              (seat) =>
                seat.kind === "console" &&
                seat.deskTile.row === lead.deskTile.row,
            )
            .sort((left, right) => left.deskTile.col - right.deskTile.col);
          const index = rowSeats.findIndex(
            (seat) => seat.seatId === lead.seatId,
          );
          const inGroup = index % AISLE_EVERY;
          if (
            index !== 0 &&
            index !== rowSeats.length - 1 &&
            inGroup !== 0 &&
            inGroup !== AISLE_EVERY - 1
          ) {
            bad.push(`${n}:${team.teamId}:${index}`);
          }
        }
      }
      expect(bad).toEqual([]);
    }
  });

  it("allocates a reserve for a team that arrives after the first plan", () => {
    const input = planFresh(makeTestEpic("triage", 12, 1), VIEWPORT_WIDE).input;
    const prior = MISSION_CONTROL_VIEW.plan(input);
    const root = rootAgent(input.agents);
    const lead = childAgent(root, "arriving-lead", nextCreatedAt(input.agents));
    const member = childAgent(lead, "arriving-member", lead.createdAt + 1);
    const next = grownFrom(input, prior, [lead, member]);
    expect(
      next.partition.hosts.some((host) =>
        host.teams.some((team) => team.teamId === lead.id),
      ),
    ).toBe(true);
    const layout = MISSION_CONTROL_VIEW.plan(next);
    const reserves = frozenOf(layout)?.teamReserveSeatIds;
    expect(reserves?.some((entry) => entry.teamId === lead.id)).toBe(true);
  });

  it("paints distinct host-band palettes for two hosts", () => {
    const scene = sceneOf(makeTestEpic("two-hosts", 60, 1));
    const layout = requireLayout(scene);
    const frame = scene.frame(1, WHOLE_WORLD);
    const palettes: string[][] = [];
    for (const host of ["host-a", "host-b"]) {
      const seats = [...layout.seats.values()]
        .filter((seat) => seat.kind === "console" && seat.hostId === host)
        .sort(
          (left, right) =>
            left.deskTile.row - right.deskTile.row ||
            left.deskTile.col - right.deskTile.col,
        );
      const seat = seats[0];
      const tile = { col: seat.deskTile.col - 1, row: seat.deskTile.row };
      const sprite = frame.floor.find(
        (drawable) =>
          drawable.kind === "sprite" &&
          drawable.x === tile.col * OFFICE_TILE &&
          drawable.y === tile.row * OFFICE_TILE,
      );
      if (sprite === undefined || sprite.kind !== "sprite") {
        throw new Error(`no band sprite for ${host}`);
      }
      palettes.push(rasterColors(sprite.sprite.name));
    }
    expect(palettes[0]).not.toEqual(palettes[1]);
  });

  it("paints the reading chair on the tile the reader sits on", () => {
    const scene = sceneOf(makeTestEpic("triage", 40, 1));
    const layout = requireLayout(scene);
    const spot = layout.floors[0].errandSpots.find(
      (entry) => entry.kind === "read",
    );
    if (spot === undefined) throw new Error("no read spot");
    const chair = frameDrawables(scene.frame(2, WHOLE_WORLD)).find(
      (drawable): drawable is SpriteDrawable =>
        isSpriteNamed(drawable, "armchair"),
    );
    expect(chair?.x).toBe(spot.tile.col * OFFICE_TILE);
    expect(chair?.y).toBe(spot.tile.row * OFFICE_TILE);
  });

  it("leaves opaque tier-step pixels uncovered by the console", () => {
    const scene = sceneOf(makeTestEpic("triage", 40, 1));
    const layout = requireLayout(scene);
    const seat = firstConsole(layout);
    const draws = frameDrawables(scene.frame(1, WHOLE_WORLD));
    const steps = draws.filter(
      (drawable) =>
        drawable.kind === "sprite" &&
        drawable.sprite.name === "tier-step" &&
        (drawable.x === seat.deskTile.col * OFFICE_TILE ||
          drawable.x === (seat.deskTile.col + 1) * OFFICE_TILE),
    );
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(exposedStepPixels(draws, steps)).toBeGreaterThan(0);
  });

  it("keeps every host foot sign inside the projected world", () => {
    const fixture = makeTestEpic("many-roots", 20, 1);
    const epic: OfficeTestEpic = {
      ...fixture,
      agents: fixture.agents.map((agent, index) => ({
        ...agent,
        hostId: `host-${String(index).padStart(2, "0")}`,
      })),
    };
    const scene = sceneOf(epic);
    const layout = requireLayout(scene);
    const width = scene.worldSize().width;
    const out = layout.signs.filter(
      (sign) =>
        sign.kind === "host" &&
        (sign.tile.col + sign.widthTiles) * OFFICE_TILE > width,
    );
    expect(out).toEqual([]);
  });

  it("keeps an arriving character inside the projector bounds", () => {
    const input = planFresh(makeTestEpic("triage", 12, 1), VIEWPORT_WIDE).input;
    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    const base = sceneInputFor(input);
    const newcomer = input.agents.at(-1);
    if (newcomer === undefined) throw new Error("no newcomer");
    scene.sync({
      ...base,
      visibleAgentIds: new Set(
        input.agents.slice(0, -1).map((agent) => agent.id),
      ),
    });
    scene.sync({
      ...base,
      pulse: {
        kind: "edge",
        edgeId: "root-newcomer",
        pulseKind: "created",
        fromAgentId: input.agents[0].id,
        toAgentId: newcomer.id,
      },
      pulseKey: "new-agent",
    });
    const chars = scene
      .frame(2, WHOLE_WORLD)
      .actors.filter((drawable): drawable is SpriteDrawable =>
        isSpriteNamed(drawable, "character"),
      );
    const projector = MISSION_CONTROL_VIEW.painter.projector(
      requireLayout(scene),
    );
    const out = chars.filter(
      (drawable) =>
        drawable.y < projector.bounds.y ||
        drawable.x < projector.bounds.x ||
        drawable.y + 20 > projector.bounds.y + projector.bounds.height,
    );
    expect(out).toEqual([]);
  });

  it("does not enumerate seats while panning a 1×1 empty viewport", () => {
    let visits = 0;
    const tracked: OfficeView = {
      ...MISSION_CONTROL_VIEW,
      plan: (input) => {
        const layout = MISSION_CONTROL_VIEW.plan(input);
        const seats = new CountingSeatMap(layout.seats, () => {
          visits += 1;
        });
        return { ...layout, seats };
      },
    };
    const scene = new OfficeScene(tracked, null);
    scene.sync(
      sceneInputFor(
        planFresh(makeTestEpic("triage", 1000, 1), VIEWPORT_WIDE).input,
      ),
    );
    scene.frame(1, { x: 0, y: 0, width: 1, height: 1 });
    visits = 0;
    scene.frame(1, { x: 16, y: 0, width: 1, height: 1 });
    expect(visits).toBe(0);
  });

  it("counts seat-map enumerations through values, entries, keys, forEach and iteration", () => {
    const layout = planFresh(
      makeTestEpic("one-team", 12, 1),
      VIEWPORT_WIDE,
    ).layout;
    let visits = 0;
    const seats: Map<string, OfficeSeat> = new CountingSeatMap(
      layout.seats,
      () => {
        visits += 1;
      },
    );
    const expected = layout.seats.size;

    visits = 0;
    for (const seat of seats.values()) {
      void seat;
    }
    expect(visits).toBe(expected);

    visits = 0;
    for (const entry of seats.entries()) {
      void entry;
    }
    expect(visits).toBe(expected);

    visits = 0;
    for (const key of seats.keys()) {
      void key;
    }
    expect(visits).toBe(expected);

    visits = 0;
    seats.forEach((seat) => {
      void seat;
    });
    expect(visits).toBe(expected);

    visits = 0;
    for (const pair of seats) {
      void pair;
    }
    expect(visits).toBe(expected);
  });

  it("binds forEach callbacks to the supplied thisArg", () => {
    const layout = planFresh(
      makeTestEpic("one-team", 12, 1),
      VIEWPORT_WIDE,
    ).layout;
    const countingMap: Map<string, OfficeSeat> = new CountingSeatMap(
      layout.seats,
      () => undefined,
    );
    const receiver = { seats: countingMap };
    let visits = 0;
    countingMap.forEach(function (this: typeof receiver) {
      expect(this.seats).toBe(countingMap);
      expect(this).toBe(receiver);
      visits += 1;
    }, receiver);
    // A podium, twelve consoles, and the hall's own civic furniture: two medbay
    // beds and the formula's four gallery seats at this population.
    expect(visits).toBe(19);
    expect(visits).toBe(layout.seats.size);
  });

  it("keeps a single-host floor hostless", () => {
    const epic = makeTestEpic("triage", 12, 1);
    const hosted: OfficeTestEpic = {
      ...epic,
      agents: epic.agents.map((agent) => ({ ...agent, hostId: "host-a" })),
    };
    expect(sceneOf(hosted).layout()?.floors[0].hostId).toBeNull();
  });

  it("returns no seat or spot props at lod 0", () => {
    const layout = planFresh(
      makeTestEpic("triage", 40, 1),
      VIEWPORT_WIDE,
    ).layout;
    expect(
      MISSION_CONTROL_VIEW.painter.seatProps(
        layout,
        firstConsole(layout),
        DESK_STATE,
        0,
      ),
    ).toEqual([]);
    expect(
      MISSION_CONTROL_VIEW.painter.spotProps(
        layout,
        layout.floors[0].errandSpots[0],
        0,
      ),
    ).toEqual([]);
  });

  it("seats every agent when aisle alignment fragments a row", () => {
    const epic = teamSizedEpic([2, 2, 14]);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const scene = sceneOf(epic);
    const layout = requireLayout(scene);
    expect(planned.layout.desks.size).toBe(epic.agents.length);
    expect(layout.desks.size).toBe(epic.agents.length);
    expect(
      spriteCount(frameDrawables(scene.frame(2, WHOLE_WORLD)), "character"),
    ).toBe(epic.agents.length);
    expect(scene.locate("team-2-lead")).not.toBeNull();
  });

  it("seats every agent across team-size mixes of 1 to 16", () => {
    const mixes: ReadonlyArray<ReadonlyArray<number>> = [
      [2, 2, 14],
      [14, 2, 2],
      [1, 16, 3],
      [8, 8, 8],
      [16, 1, 1, 1],
      [3, 3, 3, 3, 3],
      [1, 2, 3, 4, 5, 6],
    ];
    for (const sizes of mixes) {
      const epic = teamSizedEpic(sizes);
      const scene = sceneOf(epic);
      const layout = requireLayout(scene);
      expect(layout.desks.size).toBe(epic.agents.length);
      for (const agent of epic.agents) {
        expect(scene.locate(agent.id)).not.toBeNull();
      }
    }
  });

  it("keeps seats identical after a status-only replan that follows a consumed reserve", () => {
    const input = planFresh(
      makeTestEpic("one-team", 12, 1),
      VIEWPORT_WIDE,
    ).input;
    const before = MISSION_CONTROL_VIEW.plan(input);
    const lead = input.agents.find((agent) => agent.id === "team-lead");
    if (lead === undefined) throw new Error("no lead");
    const next = grownFrom(input, before, [
      childAgent(lead, "reserve-consumer", nextCreatedAt(input.agents)),
    ]);
    const consumed = MISSION_CONTROL_VIEW.plan(next);
    const statuses = new Map<string, OfficeAgentStatus>(
      next.agents.map((agent) => [agent.id, "working"]),
    );
    statuses.set(lead.id, "awaiting");
    const statusOnly = MISSION_CONTROL_VIEW.plan({
      ...next,
      previous: consumed,
      occupancy: new Map(),
      partition: partitionOfficePopulation({
        agents: next.agents,
        statusById: statuses,
        previous: next.partition,
      }),
    });
    expect(statusOnly.seats.size).toBe(consumed.seats.size);
    expect(statusOnly.seats).toEqual(consumed.seats);
  });

  it("sits every lead at an aisle end on a fresh three-team office", () => {
    const layout = planFresh(teamSizedEpic([2, 2, 2]), VIEWPORT_WIDE).layout;
    const interior = ["team-0-lead", "team-1-lead", "team-2-lead"].filter(
      (id) => aisleIndexOf(layout, id) >= 0,
    );
    expect(interior).toEqual([]);
  });

  it("sits an arriving team lead at an aisle end", () => {
    const input = planFresh(
      makeTestEpic("many-roots", 2, 1),
      VIEWPORT_WIDE,
    ).input;
    const before = MISSION_CONTROL_VIEW.plan(input);
    const parent = input.agents[0];
    const lead = childAgent(
      parent,
      "arriving-lead",
      nextCreatedAt(input.agents),
    );
    const member = childAgent(lead, "arriving-member", lead.createdAt + 1);
    const after = MISSION_CONTROL_VIEW.plan(
      grownFrom(input, before, [lead, member]),
    );
    expect(aisleIndexOf(after, lead.id)).toBe(-1);
  });

  it("does not grow band or pod reads with population on an empty pan", () => {
    const counts: Array<{ bandReads: number; podReads: number }> = [];
    for (const n of [12, 1000]) {
      let bandReads = 0;
      let podReads = 0;
      const tracked: OfficeView = {
        ...MISSION_CONTROL_VIEW,
        plan: (input) => {
          const layout = MISSION_CONTROL_VIEW.plan(input);
          const frozen = frozenOf(layout);
          if (frozen === null) throw new Error("no frozen");
          const hostBands = countingReads(frozen.hostBands, () => {
            bandReads += 1;
          });
          const rooms = layout.rooms.map((room) => ({
            ...room,
            pods: countingReads(room.pods, () => {
              podReads += 1;
            }),
          }));
          return { ...layout, rooms, frozen: { ...frozen, hostBands } };
        },
      };
      const epic = makeTestEpic("triage", n, 1);
      const hosted: OfficeTestEpic = {
        ...epic,
        agents: epic.agents.map((agent) => ({ ...agent, hostId: "host-a" })),
      };
      const scene = new OfficeScene(tracked, null);
      scene.sync(sceneInputFor(planFresh(hosted, VIEWPORT_WIDE).input));
      scene.frame(1, { x: 0, y: 0, width: 1, height: 1 });
      bandReads = 0;
      podReads = 0;
      scene.frame(1, { x: 16, y: 0, width: 1, height: 1 });
      counts.push({ bandReads, podReads });
    }
    expect(counts[1].bandReads).toBeLessThanOrEqual(counts[0].bandReads);
    expect(counts[1].podReads).toBeLessThanOrEqual(counts[0].podReads);
  });

  it("puts the partition lead at an aisle end for every arrival permutation", () => {
    const input = planFresh(
      makeTestEpic("many-roots", 2, 1),
      VIEWPORT_WIDE,
    ).input;
    const parent = input.agents[0];
    const lead = childAgent(parent, "late-list-lead", 10_000);
    const firstChild = childAgent(lead, "early-list-member", 10_001);
    const secondChild = childAgent(lead, "other-member", 10_002);
    const permutations: ReadonlyArray<ReadonlyArray<OfficeAgentInput>> = [
      [lead, firstChild, secondChild],
      [firstChild, lead, secondChild],
      [secondChild, firstChild, lead],
    ];
    const tiles: Array<{ col: number; row: number }> = [];
    for (const arrivals of permutations) {
      const after = MISSION_CONTROL_VIEW.plan(
        grownFrom(input, MISSION_CONTROL_VIEW.plan(input), arrivals),
      );
      expect(aisleIndexOf(after, lead.id)).toBe(-1);
      const desk = after.desks.get(lead.id);
      if (desk === undefined) throw new Error("lead unseated");
      tiles.push(desk.deskTile);
    }
    expect(tiles[0]).toEqual(tiles[1]);
    expect(tiles[1]).toEqual(tiles[2]);
  });

  it("does not scan hostBands on an empty lod-0 pan at 12 or 1000 agents", () => {
    let bandReads = 0;
    const tracked: OfficeView = {
      ...MISSION_CONTROL_VIEW,
      plan: (input) => {
        const layout = MISSION_CONTROL_VIEW.plan(input);
        const frozen = frozenOf(layout);
        if (frozen === null) throw new Error("no frozen");
        return {
          ...layout,
          frozen: {
            ...frozen,
            hostBands: countingReads(frozen.hostBands, () => {
              bandReads += 1;
            }),
          },
        };
      },
    };
    const full = makeTestEpic("triage", 1000, 1).agents.map((agent) => ({
      ...agent,
      hostId: "host-a",
    }));
    const counts: number[] = [];
    for (const n of [12, 1000, 12]) {
      const hosted: OfficeTestEpic = {
        agents: full.slice(0, n),
        statusById: new Map(),
      };
      const scene = new OfficeScene(tracked, null);
      scene.sync(sceneInputFor(planFresh(hosted, VIEWPORT_WIDE).input));
      scene.frame(0, { x: 0, y: 0, width: 1, height: 1 });
      bandReads = 0;
      const frame = scene.frame(0, { x: 16, y: 0, width: 1, height: 1 });
      expect(frame.floor.length).toBe(0);
      expect(frame.actors.length).toBe(0);
      counts.push(bandReads);
    }
    expect(counts[1]).toBeLessThanOrEqual(counts[0]);
    expect(counts[2]).toBeLessThanOrEqual(counts[0]);
  });

  it("reads no non-overlapping tier counts on an empty lod-0 pan through growth and shrink", () => {
    let tierReads = 0;
    let bandReads = 0;
    let reserveReads = 0;
    const tracked: OfficeView = {
      ...MISSION_CONTROL_VIEW,
      plan: (input) => {
        const layout = MISSION_CONTROL_VIEW.plan(input);
        const frozen = frozenOf(layout);
        if (frozen === null) throw new Error("no frozen");
        return {
          ...layout,
          frozen: {
            ...frozen,
            tierSeatCounts: countingReads(frozen.tierSeatCounts, () => {
              tierReads += 1;
            }),
            hostBands: countingReads(frozen.hostBands, () => {
              bandReads += 1;
            }),
            teamReserveSeatIds: countingReads(frozen.teamReserveSeatIds, () => {
              reserveReads += 1;
            }),
          },
        };
      },
    };
    const full = makeTestEpic("one-team", 1000, 1).agents.map((agent) => ({
      ...agent,
      hostId: "host-a",
      archived: false,
      archivedAt: null,
    }));
    let input = planFresh(
      { agents: full.slice(0, 12), statusById: new Map() },
      VIEWPORT_WIDE,
    ).input;
    const scene = new OfficeScene(tracked, null);
    scene.sync(sceneInputFor(input));
    const tierReadsByN: number[] = [];
    for (const n of [12, 1000, 12]) {
      input = sceneAdvance(input, scene, full.slice(0, n));
      scene.frame(0, { x: 0, y: 0, width: 1, height: 1 });
      tierReads = 0;
      bandReads = 0;
      reserveReads = 0;
      const frame = scene.frame(0, { x: 16, y: 0, width: 1, height: 1 });
      expect(frame.floor.length).toBe(0);
      expect(frame.actors.length).toBe(0);
      expect(bandReads).toBe(0);
      expect(reserveReads).toBe(0);
      tierReadsByN.push(tierReads);
    }
    expect(tierReadsByN).toEqual([0, 0, 0]);
  });

  it("paints only overlapping lod-0 tier geometry for a three-row query", () => {
    for (const n of [12, 1000]) {
      const layout = planFresh(
        makeTestEpic("one-team", n, 1),
        VIEWPORT_WIDE,
      ).layout;
      const frozen = frozenOf(layout);
      if (frozen === null) throw new Error("no frozen");
      const seen: number[] = [];
      const observed = {
        ...layout,
        frozen: {
          ...frozen,
          tierSeatCounts: countingIndexReads(frozen.tierSeatCounts, seen),
        },
      };
      const frame = MISSION_CONTROL_VIEW.painter.floor(
        observed,
        { col: 0, row: 8, cols: layout.cols, rows: 3 },
        0,
      );
      // Tier 0 and the gallery, which begins on the first tier's own top row -
      // named by fill rather than counted, so the tier half of the claim stays
      // exactly as strong as it was and the second block cannot be a tier.
      // Narrowed before reading `fill`: a floor drawable is a union, and only
      // the block arm carries one - anything else here is a tier drawn as
      // something other than a block, which this would rather name than skip.
      const fills = frame.map((drawable) =>
        drawable.kind === "block" ? drawable.fill : drawable.kind,
      );
      expect(fills).toEqual(["storey", "civic"]);
      expect(seen).toEqual([0]);
    }
  });
});

/**
 * Fixup 5 (finding M3, amphitheatre half): a lead's plate used to be
 * `widthTiles: 1` at a single tile beside the lead's console, drawn at a
 * fixed face and centred on that one tile - so a twelve-character
 * `team-26-lead` reached several consoles either side and the next opaque
 * plate painted over it (`TEAM-3-LE│TEAM-4-LE…`, the live screenshot's own
 * `team-3-lead` vs `team-4-lead` pair). The fix (`tierRunAt` in
 * `mission-control-plan.ts`) hands each lead plate the team's own
 * contiguous run of consoles on its tier and declares `rungs: "name"`, so
 * `officeSignsToDraw` walks `officePlateRungs`'s ladder - the same ladder
 * the oblique views' pod plates already use - and drops the plate rather
 * than drawing it over the run next door.
 *
 * Case 1 pins the general property - no two resolved plates on one tier's
 * row overlap, and every plate stays inside its own run - on the
 * 309-agent triage population the live finding came from. Case 2 walks the
 * ladder itself on a synthetic tier of two-seat teams. The last case guards
 * the fix against leaking into the HQ board, the Lounge area sign and the
 * host signs, which this fixup does not touch.
 */
describe("mission control plates: fixup 5 - plates fit their own arc segment and never overlap", () => {
  /**
   * A plate's width in the face it is ACTUALLY DRAWN IN, derived the same
   * way `oblique-plan.test.ts`'s fixup 6 rule 2 block derives it, rather
   * than hard-coded: `ctx.letterSpacing` counts towards `measureText` as
   * well as the painted glyphs, so leaving the tracking out under-reports
   * every plate by the exact margin that separates a rung that fits from
   * one that overflows the run it names.
   */
  const MONOSPACE_ADVANCE_EM = 0.6;
  const CHAR_PX =
    OFFICE_SIGN_FONT_PX *
    (MONOSPACE_ADVANCE_EM + OFFICE_SIGN_LETTER_SPACING_EM);
  const PLATE_PADDING_PX = OFFICE_SIGN_PADDING_X * 2;
  function measure(text: string): number {
    return text.length * CHAR_PX + PLATE_PADDING_PX;
  }
  /** Float slack for the tile-space arithmetic below, not a real tolerance. */
  const EPS = 0.01;

  it("keeps every resolved plate inside its own run and never overlapping its neighbour on the same tier, on the 309-agent triage population", () => {
    const epic = makeTestEpic("triage", 309, 1);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const layout = planned.layout;
    // EVERY plate the view draws, not only the ones a filter on `rungs`
    // would find - "the plates this view draws all fit" is the property,
    // and filtering on the field the fix added would pass on a plan that
    // had stopped declaring one.
    const plates = layout.signs.filter((sign) => sign.kind === "plate");
    expect(plates.length).toBeGreaterThan(0);

    const statusById = new Map(epic.statusById);
    const nameById = new Map(
      epic.agents.map((agent) => [agent.id, agent.name]),
    );
    const visibleAgentIds = new Set(epic.agents.map((agent) => agent.id));
    const projector = MISSION_CONTROL_VIEW.painter.projector(layout);
    // The three fit-estimate zooms this suite already pins for 309 agents:
    // the lowest and highest supported zoom, and the wide-viewport fit
    // itself (`PINNED_FIT.agents309.wide`).
    const zooms = [0.7, PINNED_FIT.agents309.wide, 1.6];

    const offenders: string[] = [];
    for (const zoom of zooms) {
      const drawn = officeSignsToDraw({
        floors: layout.floors,
        civicTally: NO_CIVIC_COUNTS,
        clock: STILL_SIGN_CLOCK,
        signs: plates,
        visibleAgentIds,
        statusById,
        nameById,
        hostNameById: new Map(),
        roleClaims: {},
        zoom,
        measure,
        projector,
        lod: 1,
      });
      const byRow = new Map<number, OfficeSignToDraw[]>();
      for (const entry of drawn) {
        const maxChars =
          entry.sign.widthTiles >= 2
            ? OFFICE_SIGN_PLATE_MAX_CHARS
            : OFFICE_SIGN_NARROW_PLATE_MAX_CHARS;
        if (entry.text.length > maxChars) {
          offenders.push(
            `zoom=${zoom}: "${entry.text}" is ${entry.text.length} chars, over its ${maxChars}-char budget`,
          );
        }
        const bucket = byRow.get(entry.sign.tile.row);
        if (bucket === undefined) byRow.set(entry.sign.tile.row, [entry]);
        else bucket.push(entry);
      }
      for (const bucket of byRow.values()) {
        // THE BOX IN TILE SPACE: `measure(text)` px wide, centred at
        // `officeSignCenterX(entry) * zoom`, converted back to tiles so the
        // comparison below is against the run the plan actually handed the
        // sign rather than against pixels a future zoom change would shift.
        const boxes = bucket
          .map((entry) => {
            const width = measure(entry.text);
            const centerPx = officeSignCenterX(entry) * zoom;
            return {
              left: (centerPx - width / 2) / (OFFICE_TILE * zoom),
              right: (centerPx + width / 2) / (OFFICE_TILE * zoom),
              text: entry.text,
              sign: entry.sign,
            };
          })
          .sort((a, b) => a.left - b.left);
        for (const box of boxes) {
          if (box.left < box.sign.tile.col - EPS) {
            offenders.push(
              `zoom=${zoom}: "${box.text}" starts at tile ${box.left.toFixed(2)}, left of its own run starting at ${box.sign.tile.col}`,
            );
          }
          if (box.right > box.sign.tile.col + box.sign.widthTiles + EPS) {
            offenders.push(
              `zoom=${zoom}: "${box.text}" ends at tile ${box.right.toFixed(2)}, right of its own run ending at ${box.sign.tile.col + box.sign.widthTiles}`,
            );
          }
        }
        // NO TWO PLATES ON ONE TIER'S ROW OVERLAP.
        for (let i = 1; i < boxes.length; i += 1) {
          if (boxes[i].left < boxes[i - 1].right - EPS) {
            offenders.push(
              `zoom=${zoom} row=${boxes[i].sign.tile.row}: "${boxes[i - 1].text}" overlaps "${boxes[i].text}"`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("walks a lead's own rung ladder on a synthetic tier of two-seat teams", () => {
    // 12 two-seat teams: a lead, one member and the team's reserve seat is
    // three consoles - `consoleWidthTiles` tiles apiece, read off a real
    // console seat below rather than assumed.
    //
    // Which of them land whole on one tier is the PACKING's answer and not
    // this case's premise, so nothing here counts them: a run is only ever
    // opened at one of its aisle group's own edges, so two three-console
    // teams fit per twelve-slot group with the middle left for walking, and
    // a team whose turn comes with both edges taken runs on past the end of
    // its tier. Both outcomes get the SAME assertion below - a plate spans
    // its team's consoles ON THE LEAD'S TIER - which is the whole of the
    // run for a team that landed whole and the clipped part of it for one
    // that straddles, and is what `tierRunAt` is for either way.
    const epic = teamSizedEpic(Array.from({ length: 12 }, () => 2));
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const layout = planned.layout;
    const frozen = requireFrozen(layout);
    const consoleWidthTiles = firstConsole(layout).hitTiles.width;
    const teamConsoles = 3;

    interface TeamRunCheck {
      readonly sign: OfficeSignToDraw["sign"];
      /** The team's console cols on the lead's own tier, left to right. */
      readonly onLeadTier: ReadonlyArray<number>;
      /** How many of its consoles the packing left on another tier. */
      readonly offLeadTier: number;
    }

    const teamChecks: TeamRunCheck[] = [];
    for (const host of planned.input.partition.hosts) {
      for (const team of host.teams) {
        const sign = layout.signs.find(
          (candidate) =>
            candidate.kind === "plate" &&
            candidate.ownerAgentId === team.teamId,
        );
        if (sign === undefined) {
          throw new Error(`no plate for ${team.teamId}`);
        }
        const leadDesk = layout.desks.get(team.teamId);
        if (leadDesk === undefined) {
          throw new Error(`no desk for ${team.teamId}`);
        }
        const memberId = `${team.teamId.slice(0, -"-lead".length)}-member-1`;
        const memberDesk = layout.desks.get(memberId);
        if (memberDesk === undefined) {
          throw new Error(`no desk for ${memberId}`);
        }
        const reserve = frozen.teamReserveSeatIds.find(
          (entry) => entry.teamId === team.teamId,
        );
        if (reserve === undefined) {
          throw new Error(`no reserve for ${team.teamId}`);
        }
        const reserveSeat = layout.seats.get(reserve.seatId);
        if (reserveSeat === undefined) {
          throw new Error(`no seat ${reserve.seatId}`);
        }
        const consoles = [
          leadDesk.deskTile,
          memberDesk.deskTile,
          reserveSeat.deskTile,
        ];
        const onLeadTier = consoles
          .filter((tile) => tile.row === leadDesk.deskTile.row)
          .map((tile) => tile.col)
          .sort((left, right) => left - right);
        teamChecks.push({
          sign,
          onLeadTier,
          offLeadTier: consoles.length - onLeadTier.length,
        });
      }
    }
    expect(teamChecks.length).toBe(12);

    // THE PLATE IS ITS TEAM'S CONSOLES ON THE LEAD'S TIER, exactly: it
    // starts at the leftmost of them and ends at the right edge of the
    // rightmost, so it covers the arc segment it names and no tile more.
    for (const check of teamChecks) {
      const first = check.onLeadTier[0];
      const last = check.onLeadTier[check.onLeadTier.length - 1];
      expect(check.sign.tile.col).toBe(first);
      expect(check.sign.tile.col + check.sign.widthTiles).toBe(
        last + consoleWidthTiles,
      );
    }

    // A TEAM THAT STRADDLES TWO TIERS IS CLIPPED TO THE LEAD'S, and the
    // consoles it has on the other one are not counted into the plate -
    // that plate is narrower than the team's own three consoles, and its
    // width is the lead's tier's share of them. The fixture is chosen to
    // produce at least one, because clipping is the half of `tierRunAt`
    // nothing else here exercises; a packing change that stopped producing
    // one would say so rather than quietly dropping the coverage.
    const split = teamChecks.filter((check) => check.offLeadTier > 0);
    expect(split.length).toBeGreaterThan(0);
    for (const check of split) {
      expect(check.sign.widthTiles).toBe(
        check.onLeadTier.length * consoleWidthTiles,
      );
      expect(check.sign.widthTiles).toBeLessThan(
        teamConsoles * consoleWidthTiles,
      );
    }

    // A team the packing left whole keeps its entire run: all three
    // consoles under one plate.
    const wholeRun = teamChecks.filter((check) => check.offLeadTier === 0);
    // Two, so the ladder below is walked on a plate this case knows the
    // width of and there is a second one behind it if the first is ever
    // the odd one out.
    expect(wholeRun.length).toBeGreaterThanOrEqual(2);
    for (const check of wholeRun) {
      expect(check.sign.widthTiles).toBe(teamConsoles * consoleWidthTiles);
    }

    // ANY whole-run team's lead name comes down its ladder in the same
    // order - full, then `team-N`, then `t-N` - so the first one is as
    // good a probe as any; only the boundary BETWEEN `t-N` and its
    // initials can tie for a single-digit team number (`t-3` and `t3l` are
    // both 3 characters), and this case never needs that boundary.
    const candidate = wholeRun[0];
    const rungs = officePlateRungs(candidate.sign.text);
    expect(rungs).toHaveLength(4);
    const widthPx = candidate.sign.widthTiles * OFFICE_TILE;
    // The zoom at which a rung's measured width exactly fills the plate's
    // own pixels: `measure(rung)` grows with the reading, `widthPx` with
    // the camera, and this is the boundary between them.
    const thresholds = rungs.map((rung) => measure(rung) / widthPx);
    // The first three thresholds must strictly decrease, or the zoom bands
    // picked below collapse into each other. The fourth (the initials) can
    // tie with the third for a single-digit team number - `t-0` and `t0l`
    // are both three characters - which is why the zoom bands below never
    // need a boundary between them.
    for (let i = 1; i < 3; i += 1) {
      expect(thresholds[i]).toBeLessThan(thresholds[i - 1]);
    }

    const statusById = new Map(epic.statusById);
    const nameById = new Map(
      epic.agents.map((agent) => [agent.id, agent.name]),
    );
    const visibleAgentIds = new Set(epic.agents.map((agent) => agent.id));
    const projector = MISSION_CONTROL_VIEW.painter.projector(layout);
    function resolvedAt(zoom: number): OfficeSignToDraw | undefined {
      return officeSignsToDraw({
        floors: layout.floors,
        civicTally: NO_CIVIC_COUNTS,
        clock: STILL_SIGN_CLOCK,
        signs: [candidate.sign],
        visibleAgentIds,
        statusById,
        nameById,
        hostNameById: new Map(),
        roleClaims: {},
        zoom,
        measure,
        projector,
        lod: 1,
      })[0];
    }

    // 1. Comfortably above the full name's own threshold - 10% of headroom,
    //    since the next rung down is always narrower and cannot fit first.
    expect(resolvedAt(thresholds[0] * 1.1)?.text).toBe(rungs[0]);
    // 2. Midway between the full name's threshold and `team-N`'s: below the
    //    first, at or above the second, so only `team-N` fits.
    expect(resolvedAt((thresholds[0] + thresholds[1]) / 2)?.text).toBe(
      rungs[1],
    );
    // 3. Midway between `team-N`'s threshold and `t-N`'s: below the first,
    //    at or above the second, so only `t-N` fits.
    expect(resolvedAt((thresholds[1] + thresholds[2]) / 2)?.text).toBe(
      rungs[2],
    );
    // 4. Half of the narrowest rung's own threshold: nothing on the ladder
    //    fits any more, so the plate is dropped rather than drawn over the
    //    run next door - the ticket's "team keeps only its hover name".
    expect(resolvedAt(thresholds[3] * 0.5)).toBeUndefined();
  });

  it("leaves the HQ board, the Lounge area sign and the host signs as this fixup found them", () => {
    const epic = makeTestEpic("triage", 309, 1);
    const layout = planFresh(epic, VIEWPORT_WIDE).layout;

    const board = layout.signs.find((sign) => sign.kind === "hq-board");
    if (board === undefined) throw new Error("no hq-board sign");
    expect(board.widthTiles).toBe(8);
    expect(board.tile.row).toBe(0);
    expect(board.rungs).toBeUndefined();

    const area = layout.signs.find((sign) => sign.kind === "area");
    if (area === undefined) throw new Error("no area sign");
    expect(area.text).toBe("Lounge");
    expect(area.widthTiles).toBe(2);
    expect(area.tile.row).toBe(0);
    // The Lounge sits to the right of the board with a one-tile gap, per
    // `finishPacking`'s `loungeOriginCol = boardOriginCol + BOARD_COLS + 1`
    // - checked relationally since `BOARD_COLS` is not exported, rather
    // than repeating its value here.
    expect(area.tile.col).toBeGreaterThan(board.tile.col + board.widthTiles);
    expect(area.rungs).toBeUndefined();

    const hostSigns = layout.signs.filter((sign) => sign.kind === "host");
    expect(hostSigns.length).toBeGreaterThan(0);
    for (const sign of hostSigns) {
      expect(sign.widthTiles).toBe(2);
      expect(sign.tile.row).toBe(layout.rows - 1);
      expect(sign.rungs).toBeUndefined();
    }
  });
});

/**
 * COLD REVIEW, FINDINGS 1-3: ONE HALL FOR EVERY HOST, and three things that
 * assumed otherwise.
 *
 * This view is the only one whose single storey serves the whole epic, and every
 * seat and room on it carries `hostId: null` because no host owns them. Three
 * separate pieces of code read that `null` as a host rather than as an absence:
 *
 * - the seat book's pool filtered every candidate on `seat.hostId !==
 *   owner.hostId`, so an agent at an attributed console could never be given a
 *   bed or a gallery chair - only unattributed agents could use the rooms, which
 *   is why the triage fixtures never caught it;
 * - the Records counter read `archivedByHost.get(room.hostId)`, which on a hall
 *   is the UNATTRIBUTED host's count - not a miss but a plausible wrong number;
 * - and the plates were a flat two tiles, so the ward's counter had 51 pixels of
 *   a frontage that spans up to sixteen tiles.
 *
 * The fix for the first is the ORDER of the rule rather than the rule: a civic
 * want reads its own storey before its building, so the hall's seats serve
 * whoever is standing in the hall. The fix for the second is that scope is
 * STATED (`hostScope`) and never inferred from `null`.
 */
describe("mission-control cold review: one hall for every host", () => {
  const HOST_A = "host-a";
  const HOST_B = "host-b";

  /** Every agent bound to one host, which is what the triage epics never are. */
  function boundTo(epic: OfficeTestEpic, hostId: string): OfficeTestEpic {
    return {
      ...epic,
      agents: epic.agents.map((agent) => ({ ...agent, hostId })),
    };
  }

  function crashing(
    base: ReadonlyMap<string, OfficeAgentStatus>,
    ids: ReadonlyArray<string>,
  ): Map<string, OfficeAgentStatus> {
    const next = new Map(base);
    for (const id of ids) next.set(id, "failure");
    return next;
  }

  it("gives a host-bound agent one of the hall's beds, and walks it there", () => {
    const epic = boundTo(makeTestEpic("one-team", 40, 1), HOST_A);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const ward = infirmaryOf(planned.layout);
    const beds = bedsOf(planned.layout);
    expect(beds.length).toBeGreaterThan(0);
    // THE SEATS ARE THE HALL'S AND THE AGENT IS HOST-A'S, which is the whole
    // finding: under a host filter these two never meet.
    for (const bed of beds) expect(bed.hostId).toBeNull();
    expect(ward.hostId).toBeNull();

    const root = rootAgent(epic.agents);
    const patients = epic.agents
      .filter((agent) => agent.id !== root.id)
      .slice(0, 2);
    expect(patients.length).toBe(2);
    for (const patient of patients) expect(patient.hostId).toBe(HOST_A);

    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    const base = sceneInputFor(planned.input);
    scene.sync(base);
    const projector = MISSION_CONTROL_VIEW.painter.projector(planned.layout);
    const desk = planned.layout.desks.get(patients[0].id);
    if (desk === undefined) throw new Error("the patient has no console");
    const deskRect = characterRect(scene.frame(2, WHOLE_WORLD), patients[0].id);
    const deskPoint = projector.project(desk.chairTile.col, desk.chairTile.row);
    const foot: OfficePoint = {
      x: deskRect.x - deskPoint.x,
      y: deskRect.y - deskPoint.y,
    };
    const rectAt = (tile: OfficeTilePos): OfficeRect => {
      const point = projector.project(tile.col, tile.row);
      return {
        x: point.x + foot.x,
        y: point.y + foot.y,
        width: deskRect.width,
        height: deskRect.height,
      };
    };

    scene.sync({
      ...base,
      statusById: crashing(
        base.statusById,
        patients.map((agent) => agent.id),
      ),
    });

    // A CLAIM AND AN ARRIVAL, not one or the other. The claim alone would pass
    // on a book that hands out a seat nobody can reach, and the pose alone says
    // nothing - an agent holding a bed is drawn `sit` while still in its own
    // chair across the hall.
    const landed = new Set<string>();
    for (const patient of patients) {
      // Mid-walk the whereabouts is the WALK's ("Walking to the Medbay"), which
      // is already a claim in hand - but the room's own word is what arrival
      // means, so it is read after the character is standing on the bed.
      const arrival = tickOntoASeat({
        scene,
        agentId: patient.id,
        seats: beds,
        rectAt,
      });
      expect(scene.whereabouts(patient.id)).toBe(ward.name);
      expect(characterPoseAt(scene.frame(2, WHOLE_WORLD), arrival.rect)).toBe(
        "sit",
      );
      landed.add(arrival.seat.seatId);
    }
    // Two patients, two different beds: the pool is shared, not a single seat
    // handed out twice.
    expect(landed.size).toBe(2);
  });

  it("serves two hosts from the hall's one ward in arrival order", () => {
    const epic = makeTestEpic("two-hosts", 60, 3);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const beds = bedsOf(planned.layout);
    expect(beds.length).toBeGreaterThan(1);
    const onA = epic.agents.filter((agent) => agent.hostId === HOST_A);
    const onB = epic.agents.filter((agent) => agent.hostId === HOST_B);
    expect(onA.length).toBeGreaterThanOrEqual(beds.length);
    expect(onB.length).toBeGreaterThanOrEqual(beds.length);

    const first = onA.slice(0, beds.length).map((agent) => agent.id);
    const second = onB.slice(0, beds.length).map((agent) => agent.id);

    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    // REDUCED MOTION, on purpose: what this case is about is WHO HOLDS a bed
    // across three syncs, and a claim is settled the moment it is granted here
    // instead of after a walk. The walk is the case above's, which runs with
    // motion on for exactly that reason.
    const base = { ...sceneInputFor(planned.input), reducedMotion: true };
    scene.sync(base);
    // HOST A ASKS FIRST and fills the ward.
    scene.sync({ ...base, statusById: crashing(base.statusById, first) });
    const ward = infirmaryOf(planned.layout);
    for (const id of first) expect(scene.whereabouts(id)).toBe(ward.name);

    // HOST B ASKS SECOND, into a ward with nothing left. C2: capacity is the
    // cap, and an agent that finds it full keeps its console.
    scene.sync({
      ...base,
      statusById: crashing(base.statusById, [...first, ...second]),
    });
    for (const id of first) expect(scene.whereabouts(id)).toBe(ward.name);
    for (const id of second) expect(scene.whereabouts(id)).not.toBe(ward.name);

    // HOST A RECOVERS and host B inherits the beds it was queued for - which is
    // the queue and the pool naming the same set. `civicOrderKey` is the
    // FLOOR's host, so this hall keeps ONE order for every host on it, and that
    // is the shape a shared pool needs: were it the agent's own host, two hosts
    // would keep two orders and the interleaving between them would be lost.
    scene.sync({ ...base, statusById: crashing(base.statusById, second) });
    for (const id of second) expect(scene.whereabouts(id)).toBe(ward.name);
    for (const id of first) expect(scene.whereabouts(id)).not.toBe(ward.name);
  });

  /**
   * THE DISCRIMINATING ARRIVAL CASE: four waiters, two hosts, interleaved, and
   * TWO freed beds.
   *
   * The case above fills the ward with host A and queues only host B, so at
   * release only B competes and a book that kept a queue PER AGENT'S HOST would
   * hand B the bed too - it passes on both readings and proves nothing about the
   * key. Nor is one freed bed enough: with two waiters the winner under per-host
   * queues depends on which key `needyByKey` happens to reach first, which is a
   * fact about the fixture's creation order rather than about the rule, and
   * measured both ways it agreed with the fix by accident.
   *
   * TWO BEDS AND AN INTERLEAVED ARRIVAL settles it without depending on that at
   * all. Arrivals are B1, A1, B2, A2; two beds free. One shared queue serves
   * them in arrival order, so the winners are B1 and A1 - ONE FROM EACH HOST.
   * Per-host queues serve one key's whole list and then the other's, so the
   * winners are B1 and B2 or A1 and A2 - BOTH FROM ONE HOST - whichever key is
   * reached first. "One from each" is therefore false under either ordering of
   * the mutant, and the case cannot agree with it by accident.
   */
  it("serves a freed pair of hall beds in arrival order across hosts, one to each", () => {
    const epic = makeTestEpic("two-hosts", 120, 13);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const ward = infirmaryOf(planned.layout);
    const beds = bedsOf(planned.layout);
    expect(beds.length).toBeGreaterThan(1);

    // AT A DESK, NOT ARCHIVED, NOT IN A CUBBY - three ways an agent can be on
    // this floor and never ask for a bed. The civic pass serves agents that have
    // a CHARACTER, and an archived one has walked out (measured: the root of this
    // fixture is archived, so a filler set that included it left a bed free and
    // the ward one short).
    const deskAgentsOn = (hostId: string): ReadonlyArray<OfficeAgentInput> =>
      epic.agents
        .filter((agent) => agent.hostId === hostId && !agent.archived)
        .filter((agent) => {
          const desk = planned.layout.desks.get(agent.id);
          return desk !== undefined && desk.kind !== "cubby";
        });
    const onA = deskAgentsOn(HOST_A);
    const onB = deskAgentsOn(HOST_B);
    expect(onA.length).toBeGreaterThan(beds.length + 1);
    expect(onB.length).toBeGreaterThan(1);

    // The fillers hold every bed; the two waiters per host are disjoint from
    // them and from each other.
    const fillers = onA.slice(0, beds.length);
    const waitersA = onA.slice(beds.length, beds.length + 2);
    const waitersB = onB.slice(0, 2);
    expect(waitersA.length).toBe(2);
    expect(waitersB.length).toBe(2);

    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    const base = { ...sceneInputFor(planned.input), reducedMotion: true };
    scene.sync(base);
    const crashed: string[] = fillers.map((agent) => agent.id);
    const syncWith = (...ids: ReadonlyArray<string>): void => {
      crashed.push(...ids);
      scene.sync({ ...base, statusById: crashing(base.statusById, crashed) });
    };
    scene.sync({ ...base, statusById: crashing(base.statusById, crashed) });
    for (const filler of fillers) {
      expect(scene.whereabouts(filler.id)).toBe(ward.name);
    }

    // FOUR ARRIVALS, ONE PER SYNC, alternating hosts. Each one finds the ward
    // full and keeps its console, which is the queue forming (C2, C3).
    const order = [waitersB[0], waitersA[0], waitersB[1], waitersA[1]];
    for (const waiter of order) {
      syncWith(waiter.id);
      expect(scene.whereabouts(waiter.id)).not.toBe(ward.name);
    }

    // TWO BEDS FREE on one sync: the first two fillers recover.
    const recovered = new Set([fillers[0].id, fillers[1].id]);
    scene.sync({
      ...base,
      statusById: crashing(
        base.statusById,
        crashed.filter((id) => !recovered.has(id)),
      ),
    });
    const taken = scene.civicTally().occupiedByRoom.get(ward.civicRoomId) ?? 0;
    expect(taken).toBe(beds.length);

    const inWard = order.filter(
      (waiter) => scene.whereabouts(waiter.id) === ward.name,
    );
    // The two who asked first, which is one from each host.
    expect(inWard.map((waiter) => waiter.id)).toEqual([
      waitersB[0].id,
      waitersA[0].id,
    ]);
    expect(new Set(inWard.map((waiter) => waiter.hostId)).size).toBe(2);
  });

  /**
   * The plate face this suite already derives for the lead plates, reused: the
   * tracking counts towards `measureText`, so leaving it out under-reports every
   * plate by the exact margin that separates a counter that survives from one
   * the ladder drops.
   */
  const CHAR_PX = OFFICE_SIGN_FONT_PX * (0.6 + OFFICE_SIGN_LETTER_SPACING_EM);
  function plateMeasure(text: string): number {
    return text.length * CHAR_PX + OFFICE_SIGN_PADDING_X * 2;
  }

  /** The number a civic plate ends in, or `null` if it is naming a room only. */
  function counterOn(text: string): number | null {
    const match = /(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  }

  function drawnCivic(args: {
    readonly layout: OfficeLayout;
    readonly epic: OfficeTestEpic;
    readonly tally: OfficeCivicTally;
    readonly zoom: number;
    readonly widthOverride: number | null;
  }): ReadonlyArray<OfficeSignToDraw> {
    const signs = args.layout.signs
      .filter((sign) => sign.kind === "civic")
      .map((sign) =>
        args.widthOverride === null
          ? sign
          : { ...sign, widthTiles: args.widthOverride },
      );
    expect(signs.length).toBeGreaterThan(0);
    return officeSignsToDraw({
      signs,
      floors: args.layout.floors,
      visibleAgentIds: new Set(args.epic.agents.map((agent) => agent.id)),
      statusById: args.epic.statusById,
      nameById: new Map(
        args.epic.agents.map((agent) => [agent.id, agent.name]),
      ),
      hostNameById: new Map(),
      roleClaims: {},
      civicTally: args.tally,
      projector: MISSION_CONTROL_VIEW.painter.projector(args.layout),
      // The counter's own band. At lod 1 a civic plate is the room's word alone,
      // so a counter case read there would pass on any arithmetic at all.
      lod: 2,
      zoom: args.zoom,
      clock: STILL_SIGN_CLOCK,
      measure: plateMeasure,
    });
  }

  function textFor(
    drawn: ReadonlyArray<OfficeSignToDraw>,
    civicRoomId: string,
  ): string {
    const entry = drawn.find(
      (candidate) => candidate.sign.civicRoomId === civicRoomId,
    );
    if (entry === undefined) throw new Error(`no plate for ${civicRoomId}`);
    return entry.text;
  }

  it("sums every host's records on the hall's one Records door", () => {
    const epic = makeTestEpic("two-hosts", 120, 5);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    // THE EPIC'S OWN STATUSES, not this suite's all-`working` default: the
    // archive counts agents whose status IS `"archived"`, so a sync that
    // flattens every status reports an empty archive however many records the
    // population holds.
    scene.sync({
      ...sceneInputFor(planned.input),
      statusById: epic.statusById,
    });
    const tally = scene.civicTally();

    // THE FIXTURE IS THE CASE. Records archived on BOTH hosts and the room
    // itself unattributed: that is the shape where reading `room.hostId` gives
    // a plausible wrong number rather than a miss, because `null` is a key in
    // this map like any other host.
    const onA = tally.archivedByHost.get("host-a") ?? 0;
    const onB = tally.archivedByHost.get("host-b") ?? 0;
    expect(onA).toBeGreaterThan(0);
    expect(onB).toBeGreaterThan(0);
    const total = onA + onB;
    expect(total).toBeGreaterThan(Math.max(onA, onB));

    const archive = planned.layout.floors[0].civic.find(
      (room) => room.kind === "archive",
    );
    if (archive === undefined) throw new Error("the hall plans no archive");
    expect(archive.hostId).toBeNull();
    expect(archive.hostScope).toBe("every-host");

    const drawn = drawnCivic({
      layout: planned.layout,
      epic,
      tally,
      // Wide enough for the counter rung on a four-tile plate; the word floor
      // means a plate that cannot fit it says the room's name alone, and this
      // case is about the number.
      zoom: 1.6,
      widthOverride: null,
    });
    expect(counterOn(textFor(drawn, archive.civicRoomId))).toBe(total);
  });

  it("counts an unattributed host's records as one more host, not as all of them", () => {
    const fixture = makeTestEpic("two-hosts", 120, 5);
    // A THIRD, UNATTRIBUTED HOST alongside the two named ones - records that
    // predate host binding. `null` has to be summed WITH the others: read as
    // "everybody" it would report this slice alone, and excluded it would lose
    // it. Both readings are wrong by a different amount, which is why the case
    // asserts the total rather than that it is nonzero.
    const firstArchived = fixture.agents.find((agent) => agent.archived);
    if (firstArchived === undefined) throw new Error("no archived agent");
    const agents = fixture.agents.map((agent) =>
      agent.id === firstArchived.id ? { ...agent, hostId: null } : agent,
    );
    const epic: OfficeTestEpic = { ...fixture, agents };
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    scene.sync({
      ...sceneInputFor(planned.input),
      statusById: epic.statusById,
    });
    const tally = scene.civicTally();
    const unattributed = tally.archivedByHost.get(null) ?? 0;
    let total = 0;
    let named = 0;
    for (const [hostId, count] of tally.archivedByHost) {
      total += count;
      if (hostId !== null) named += count;
    }
    // BOTH SLICES NON-EMPTY, which is what makes the two wrong readings
    // distinguishable from the right one: reading `null` as "everybody" would
    // report `unattributed`, dropping it would report `named`, and neither
    // equals the total while both of these are positive.
    expect(unattributed).toBeGreaterThan(0);
    expect(named).toBeGreaterThan(0);
    expect(total).toBe(unattributed + named);

    const archive = planned.layout.floors[0].civic.find(
      (room) => room.kind === "archive",
    );
    if (archive === undefined) throw new Error("the hall plans no archive");
    const drawn = drawnCivic({
      layout: planned.layout,
      epic,
      tally,
      zoom: 1.6,
      widthOverride: null,
    });
    expect(counterOn(textFor(drawn, archive.civicRoomId))).toBe(total);
  });

  it("plates the ward as wide as the ward, so its counter survives at close-up", () => {
    const epic = boundTo(makeTestEpic("one-team", 309, 2), HOST_A);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const ward = infirmaryOf(planned.layout);
    const plate = planned.layout.signs.find(
      (sign) => sign.kind === "civic" && sign.civicRoomId === ward.civicRoomId,
    );
    if (plate === undefined) throw new Error("the ward has no plate");
    // A PLATE IS AS WIDE AS THE ROOM IT NAMES. Asserted against the room's own
    // frontage rather than a number, so a ward that grows carries a plate that
    // grows with it.
    expect(plate.widthTiles).toBe(ward.bounds.cols);
    expect(ward.bounds.cols).toBeGreaterThan(2);

    // AN OCCUPIED WARD, because `0 of 8` and `3 of 8` are the same length and a
    // case that never fills a bed would not notice a counter that cannot count.
    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    const base = { ...sceneInputFor(planned.input), reducedMotion: true };
    scene.sync(base);
    const root = rootAgent(epic.agents);
    const patient = epic.agents.find((agent) => agent.id !== root.id);
    if (patient === undefined) throw new Error("no agent to crash");
    scene.sync({
      ...base,
      statusById: crashing(base.statusById, [patient.id]),
    });
    const tally = scene.civicTally();
    expect(tally.occupiedByRoom.get(ward.civicRoomId)).toBe(1);

    const atFrontage = textFor(
      drawnCivic({
        layout: planned.layout,
        epic,
        tally,
        zoom: 1.6,
        widthOverride: null,
      }),
      ward.civicRoomId,
    );
    // The counter, whole: how many beds are taken AND how many there are.
    expect(counterOn(atFrontage)).toBe(ward.seatIds.length);
    expect(atFrontage.length).toBeGreaterThan(ward.name.length);

    // THE FALSIFIER, and the reason the width is the fix: the same ward, the
    // same tally, the same zoom, plated the two tiles this view used to give
    // every room - 51 pixels, which the word alone fills. The ladder is working
    // in both readings; what changed is how much room it was given to work in.
    const atTwoTiles = textFor(
      drawnCivic({
        layout: planned.layout,
        epic,
        tally,
        zoom: 1.6,
        widthOverride: 2,
      }),
      ward.civicRoomId,
    );
    expect(atTwoTiles).toBe(ward.name);
    expect(counterOn(atTwoTiles)).toBeNull();
  });
});
