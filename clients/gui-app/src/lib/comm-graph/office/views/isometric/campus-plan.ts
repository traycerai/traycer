/**
 * CAMPUS: low buildings on grass, one room per TEAM, seen from the corner.
 *
 * A room is a team of the partition (D38): one cabin per lead-and-members
 * team, the host's HQ in a cabin of its own, and one bullpen per district for
 * everybody the partition calls a solo. It is not a lineage subtree, and that
 * distinction is the whole view. The recording's 309-agent epic is one root
 * with thirty teams under it, so "a room per subtree" built ONE 55 x 55 room
 * holding all 309 desks: geometry the spec's numbers liked and a picture that
 * showed the user no team at all.
 *
 * Sizing still belongs to the room rather than to the Floor's packer. A team's
 * members go on a FLAT near-square grid of slots, and the rooms themselves
 * shelf-pack into a near-square district, because the Floor's hierarchical
 * packing turns that same epic into a 100 x 362 tile corridor and a corridor
 * projected isometrically is a diagonal nothing can frame.
 *
 * A team of nine or more splits into a second cabin exactly as the oblique
 * views split one, so no room is a corridor either. The solos do NOT split:
 * chopping a district's leaves into nines would invent thirty bullpens nobody
 * belongs to, which is the same failure as one room holding everybody, seen
 * from the other end.
 *
 * Campus re-packs, like the Floor: a fifth child arriving moves the chairs
 * around it and the scene walks whoever moved. `stable: false` says so, and
 * that is the whole of its growth rule - there is no packing to carry, and
 * `previous` is never read. What Campus does put in `frozen` is the painter's
 * index and nothing else, which is a fact about the layout in hand rather
 * than anything carried forward from the last one.
 *
 * Rooms have back walls on their top-left and top-right edges and nothing at
 * the front, so the room is open to the viewer and the desks inside it are
 * visible. The plate hangs on the back wall.
 */
import type { OfficeHostPopulation } from "@/lib/comm-graph/office/office-population";
import {
  ARCHIVE_SIGN_WIDTH_TILES,
  civicCapacityFor,
} from "@/lib/comm-graph/office/office-layout";
import {
  OFFICE_CHARACTER_HEIGHT,
  type OfficeAgentInput,
  type OfficeCivicRoom,
  type OfficeDesk,
  type OfficeErrandSpot,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeProp,
  type OfficeRoad,
  type OfficeRoom,
  type OfficeSeat,
  type OfficeSign,
  type OfficeSize,
  type OfficeTilePos,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import {
  isoProjectAt,
  ISO_HALF_HEIGHT,
  ISO_HALF_WIDTH,
  type IsoOrigin,
} from "@/lib/comm-graph/office/views/isometric/iso-projector";
import {
  isoCampusSeatBox,
  ISO_PAINTER,
} from "@/lib/comm-graph/office/views/isometric/iso-painter";
import {
  buildIsoCafe,
  buildIsoCourtyard,
  buildIsoIndex,
  civicRoomIdOf,
  civicSeat,
  districtLane,
  isoBlankGrid,
  isoFixtureProps,
  isoFloorOf,
  isoHostKey,
  isoHostSign,
  isoNearSquareWidth,
  isoPaintDistrict,
  isoShelfPack,
  isoCourtyardCols,
  isoShelfStart,
  isoSpotAt,
  ISO_BLOCK_GAP,
  ISO_CAFE_COLS,
  ISO_CAFE_ROWS,
  ISO_COURTYARD_ROWS,
  ISO_DISTRICT_GAP,
  ISO_DISTRICT_RING,
  ISO_CAMPUS_STACK_HEIGHT,
  ISO_SEAT_ID_NONE,
  ISO_SIGN_WIDTH_TILES,
  type IsoBlockSpec,
  type IsoCourtyardBuild,
  type IsoDistrictBuild,
  type IsoGrid,
  type IsoPlacedBlock,
  type IsoPlanIndex,
} from "@/lib/comm-graph/office/views/isometric/iso-plan-core";
import type {
  OfficePlanInput,
  OfficeView,
} from "@/lib/comm-graph/office/views/office-view";

/**
 * One desk slot: two tiles for the desk, one to walk past it; one row for the
 * desk, one for the chair, one for the aisle under it. The aisle row is what
 * makes every chair in a room reachable without threading a maze - it runs the
 * full width of the room and meets the lane outside.
 */
const SLOT_COLS = 3;
const SLOT_ROWS = 3;
const DESK_WIDTH_TILES = 2;
const SEAT_HIT_ROWS = 2;
/** The back walls: one row along the top, one column down the left. */
const WALL_ROWS = 1;
const WALL_COLS = 1;
/** The plant beside a room lead's desk, in that slot's spare column. */
const PLANT_COL_OFFSET = 2;

/** How many members share one cabin before a team takes a second one. */
const ROOM_SPLIT = 9;

// ---- The civic quarter ------------------------------------------------- //
//
// Four rooms, and only two of them are new furniture. C7 makes the HELP DESK the
// reception the courtyard already has, and Campus's WAITING ROOM is the
// courtyard's bench row - the campus's public room is its courtyard, so the
// bench somebody strolls to is the bench somebody waits on. That leaves a SICK
// BAY of beds and a RECORDS HUT to build.
//
// The sick bay is the one block that is NOT shelf-packed. Its kerb has to be a
// lane tile one step from its door, and the lane is the district's left ring
// column, so its door has to be in its own left wall AT the first content
// column - which a packer that puts blocks where they fit cannot promise. So it
// is laid as a band under the packed shelves at that column, which is the same
// shape as Mission control's medbay band under the last tier, and for the same
// reason: a room whose position is part of a promise is positioned, not packed.

/** A wall row, the row of beds, and the walk in front of them. */
const SICKBAY_ROWS = 3;
/** `bed-iso` is two tiles across, exactly as `desk-iso` is. */
const BED_WIDTH_TILES = 2;
/**
 * The records hut, as wide as its OWN PLATE. C5's archive is a door, so its
 * plate is `ARCHIVE_SIGN_WIDTH_TILES` rather than the room's span - and a hut
 * narrower than its own label would hang that label over its neighbour.
 */
const RECORDS_COLS = ARCHIVE_SIGN_WIDTH_TILES;
const RECORDS_ROWS = 3;

/** The sick bay's width: its wall column, then two tiles per bed. */
function sickbayCols(beds: number): number {
  return WALL_COLS + beds * BED_WIDTH_TILES;
}

/**
 * The blocks a district packs, courtyard FIRST.
 *
 * First is load-bearing twice over: the district's door hangs on the ring beside
 * the courtyard, and the help desk's kerb is that door - so the courtyard has to
 * land at the first content column, which is what being first in the shelf gives
 * it. The sick bay is absent on purpose; see the note above.
 */
function amenityBlocksFor(chairs: number): ReadonlyArray<IsoBlockSpec> {
  return [
    {
      blockId: "courtyard",
      cols: isoCourtyardCols(chairs),
      rows: ISO_COURTYARD_ROWS,
    },
    { blockId: "cafe", cols: ISO_CAFE_COLS, rows: ISO_CAFE_ROWS },
    { blockId: "records", cols: RECORDS_COLS, rows: RECORDS_ROWS },
  ];
}

/**
 * What Campus puts in `frozen`, which is only ever the painter's index.
 *
 * A `kind` because `frozen` is `unknown` by contract and every reader of it
 * has to prove what it is holding before it reads one.
 */
interface CampusFrozen {
  readonly kind: "campus";
  readonly index: IsoPlanIndex;
}

/** A room, planned before it is placed. */
interface CampusRoomPlan extends IsoBlockSpec {
  /**
   * The room's identity, and the `roomId` every desk in it carries.
   *
   * SYNTHETIC on purpose (D16). A team is named by its lead, so a room keyed
   * on the lead's bare agent id is a room that changes identity the day the
   * lead is archived and the second member takes over - and a room whose
   * second cabin would have no id at all. `<teamId>/room/<n>`, `<hq>/hq` and
   * `<host>/bullpen` name the ROOM; whoever leads it is on the plate.
   */
  readonly roomId: string;
  /** The plate's text: the lead's name, or what a bullpen holds. */
  readonly name: string;
  /**
   * The lead this room is named FOR, or `null` in a bullpen, which has none.
   * This is the real agent; `roomId` is not, and the two must not be confused.
   */
  readonly leadAgentId: string | null;
  readonly occupants: ReadonlyArray<OfficeAgentInput>;
  readonly perRow: number;
}

function chunks<T>(
  items: ReadonlyArray<T>,
  size: number,
): ReadonlyArray<ReadonlyArray<T>> {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push([...items.slice(index, index + size)]);
  }
  return out;
}

function roomPlanFor(
  roomId: string,
  name: string,
  leadAgentId: string | null,
  occupants: ReadonlyArray<OfficeAgentInput>,
): CampusRoomPlan {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(occupants.length)));
  const slotRows = Math.max(1, Math.ceil(occupants.length / perRow));
  return {
    blockId: roomId,
    roomId,
    name,
    leadAgentId,
    occupants,
    perRow,
    cols: WALL_COLS + perRow * SLOT_COLS,
    rows: WALL_ROWS + slotRows * SLOT_ROWS,
  };
}

/**
 * One district's rooms, read off the partition rather than off the lineage.
 *
 * The partition is the ONE answer six geometries agree on, so a campus that
 * derived its own families from `parentId` would draw a different office from
 * the boards beside it. Order is the partition's: HQ, then the teams as it
 * lists them, then the bullpen.
 */
function roomPlansFor(
  host: OfficeHostPopulation,
  present: ReadonlyArray<OfficeAgentInput>,
): ReadonlyArray<CampusRoomPlan> {
  const byId = new Map(present.map((agent) => [agent.id, agent]));
  const seated = new Set<string>();
  // A team roster names only its own host's members, but nothing stops two
  // rosters from naming the same id, and nobody may be seated twice.
  const take = (ids: ReadonlyArray<string>): OfficeAgentInput[] => {
    const kept: OfficeAgentInput[] = [];
    for (const id of ids) {
      const agent = byId.get(id);
      if (agent === undefined || seated.has(id)) continue;
      seated.add(id);
      kept.push(agent);
    }
    return kept;
  };

  const plans: CampusRoomPlan[] = [];
  const hqId = host.hqAgentId;
  if (hqId !== null) {
    const hq = take([hqId]);
    if (hq.length > 0) {
      plans.push(roomPlanFor(`${hqId}/hq`, hq[0].name, hqId, hq));
    }
  }
  for (const team of host.teams) {
    const members = take(team.memberAgentIds);
    const leadName = byId.get(team.leadAgentId)?.name ?? "Team";
    for (const [index, occupants] of chunks(members, ROOM_SPLIT).entries()) {
      plans.push(
        roomPlanFor(
          `${team.teamId}/room/${index}`,
          leadName,
          team.leadAgentId,
          occupants,
        ),
      );
    }
  }
  // The solos, plus anybody the partition left unclassified: an odd campus
  // beats a missing desk, and a leaf with no room is a leaf with no chair.
  const bullpen = [
    ...take(host.solos.map((member) => member.agentId)),
    ...take(present.map((agent) => agent.id)),
  ];
  if (bullpen.length > 0) {
    plans.push(
      roomPlanFor(
        `${isoHostKey(host.hostId)}/bullpen`,
        `Bullpen · ${bullpen.length} solos`,
        null,
        bullpen,
      ),
    );
  }
  return plans;
}

interface CampusDistrictPlan {
  readonly hostId: string | null;
  readonly rooms: ReadonlyArray<CampusRoomPlan>;
  readonly widthBudget: number;
  readonly cols: number;
  readonly rows: number;
  /** The contract's own numbers for this host, from the one exported formula. */
  readonly beds: number;
  readonly chairs: number;
  /**
   * Content-relative row where the sick bay's band starts - below every packed
   * shelf. Carried rather than recomputed so `measure` and `plan` cannot drift:
   * a measure that guessed would pick a view the plan then contradicts.
   */
  readonly sickbayRow: number;
}

/**
 * How big one district comes to, without building it.
 *
 * `measure` runs exactly this and stops, which is the contract: Auto compares
 * views by geometry, and a measure that guessed would pick a view the plan then
 * contradicts.
 */
function districtPlanFor(
  host: OfficeHostPopulation,
  agents: ReadonlyArray<OfficeAgentInput>,
): CampusDistrictPlan {
  const rooms = roomPlansFor(host, agents);
  const { beds, chairs } = civicCapacityFor(agents.length);
  const blocks = [...amenityBlocksFor(chairs), ...rooms];
  const widthBudget = isoNearSquareWidth(blocks);
  const packed = isoShelfPack(blocks, widthBudget, 0, isoShelfStart(0, 0));
  let contentCols = 0;
  let contentRows = 0;
  for (const block of packed.placed) {
    contentCols = Math.max(contentCols, block.col + block.cols);
    contentRows = Math.max(contentRows, block.row + block.rows);
  }
  // The sick bay's band, under everything the packer laid and at the first
  // content column, so its left wall faces the lane.
  const sickbayRow = contentRows + ISO_BLOCK_GAP;
  return {
    hostId: host.hostId,
    rooms,
    widthBudget,
    beds,
    chairs,
    sickbayRow,
    cols: Math.max(contentCols, sickbayCols(beds)) + ISO_DISTRICT_RING * 2,
    rows: sickbayRow + SICKBAY_ROWS + ISO_DISTRICT_RING * 2,
  };
}

/** The district an epic with nobody in it still gets. */
const EMPTY_HOST: OfficeHostPopulation = {
  hostId: null,
  hqAgentId: null,
  teams: [],
  solos: [],
};

function agentsByHost(input: OfficePlanInput): ReadonlyArray<{
  readonly host: OfficeHostPopulation;
  readonly agents: ReadonlyArray<OfficeAgentInput>;
}> {
  const groups = new Map<string, OfficeAgentInput[]>();
  for (const agent of input.agents) {
    const key = isoHostKey(agent.hostId);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [agent]);
    else bucket.push(agent);
  }
  const ordered: Array<{
    host: OfficeHostPopulation;
    agents: ReadonlyArray<OfficeAgentInput>;
  }> = [];
  for (const host of input.partition.hosts) {
    ordered.push({
      host,
      agents: groups.get(isoHostKey(host.hostId)) ?? [],
    });
  }
  // An empty epic still gets one district: every consumer of `floors` assumes
  // there is at least one, and a campus with nobody on it is still a campus.
  if (ordered.length === 0) ordered.push({ host: EMPTY_HOST, agents: [] });
  return ordered;
}

interface CampusWorld {
  readonly cols: number;
  readonly rows: number;
  readonly districts: ReadonlyArray<
    CampusDistrictPlan & { readonly col: number }
  >;
}

/** Districts take column bands in the partition's own host order. */
function planWorld(input: OfficePlanInput): CampusWorld {
  const districts: Array<CampusDistrictPlan & { col: number }> = [];
  let col = 0;
  let rows = 0;
  for (const group of agentsByHost(input)) {
    const plan = districtPlanFor(group.host, group.agents);
    districts.push({ ...plan, col });
    col += plan.cols + ISO_DISTRICT_GAP;
    rows = Math.max(rows, plan.rows);
  }
  return {
    cols: Math.max(1, col - ISO_DISTRICT_GAP),
    rows: Math.max(1, rows),
    districts,
  };
}

interface RoomBuild {
  readonly room: OfficeRoom;
  readonly desks: ReadonlyArray<OfficeDesk>;
  readonly blocked: ReadonlyArray<OfficeTilePos>;
  readonly spots: ReadonlyArray<OfficeErrandSpot>;
  readonly props: ReadonlyArray<OfficeProp>;
  readonly sign: OfficeSign;
}

/**
 * One room's interior: desks in slot order, the two back walls, the lead's
 * plant, and the plate that names it.
 *
 * The chair is blocked in the general grid exactly as the Floor blocks one - a
 * chair belongs to one agent, and the path finder grants the exception for its
 * own goal - and the aisle row under it is what the chair reaches out to.
 */
interface RoomBuildArgs {
  readonly plan: CampusRoomPlan;
  readonly placed: IsoPlacedBlock;
  readonly floorIndex: number;
  readonly hostId: string | null;
  /** The world's own origin, so a desk can say where it is painted (D53). */
  readonly origin: IsoOrigin;
}

function buildRoom(args: RoomBuildArgs): RoomBuild {
  const { plan, placed, floorIndex, hostId, origin } = args;
  const bounds: OfficeTileRect = {
    col: placed.col,
    row: placed.row,
    cols: plan.cols,
    rows: plan.rows,
  };
  const blocked: OfficeTilePos[] = [];
  for (let col = bounds.col; col < bounds.col + bounds.cols; col += 1) {
    blocked.push({ col, row: bounds.row });
  }
  for (let row = bounds.row + 1; row < bounds.row + bounds.rows; row += 1) {
    blocked.push({ col: bounds.col, row });
  }

  // The district's own id, NOT its index: a host arriving ahead of this one in
  // the partition's order renumbers every index after it, and a seat named by
  // one is a seat that changes name because somebody else showed up. Campus
  // re-packs, so it has no seat book to invalidate - but the name is free to
  // get right, and the same defect on City was this fixup's F1.
  const seatGroup = [hostId ?? ISO_SEAT_ID_NONE, plan.roomId].join("/");
  const desks: OfficeDesk[] = [];
  for (const [index, agent] of plan.occupants.entries()) {
    const slotCol = index % plan.perRow;
    const slotRow = Math.floor(index / plan.perRow);
    const deskTile: OfficeTilePos = {
      col: bounds.col + WALL_COLS + slotCol * SLOT_COLS,
      row: bounds.row + WALL_ROWS + slotRow * SLOT_ROWS,
    };
    const chairTile: OfficeTilePos = {
      col: deskTile.col,
      row: deskTile.row + 1,
    };
    desks.push({
      seatId: `${seatGroup}/${index}`,
      kind: "desk",
      deskTile,
      chairTile,
      facing: "up",
      hitTiles: { width: DESK_WIDTH_TILES, height: SEAT_HIT_ROWS },
      hitBox: isoCampusSeatBox(
        isoProjectAt(origin, deskTile.col, deskTile.row),
      ),
      floorIndex,
      roomId: plan.roomId,
      hostId,
      manager: agent.id === plan.leadAgentId,
      civicRoomId: null,
      agentId: agent.id,
    });
    for (let offset = 0; offset < DESK_WIDTH_TILES; offset += 1) {
      blocked.push({ col: deskTile.col + offset, row: deskTile.row });
    }
    blocked.push(chairTile);
  }

  // The plant stands beside the FIRST desk, which is the lead's wherever there
  // is one - a team lists its lead first - and just the first solo's in a
  // bullpen. An empty room has nothing to stand it beside.
  const spots: OfficeErrandSpot[] = [];
  if (desks.length > 0) {
    const plantTile: OfficeTilePos = {
      col: desks[0].deskTile.col + PLANT_COL_OFFSET,
      row: desks[0].deskTile.row,
    };
    blocked.push(plantTile);
    spots.push(
      isoSpotAt({
        kind: "water-plant",
        stand: { col: plantTile.col, row: plantTile.row + 1 },
        fixture: plantTile,
        action: plantTile,
        floorIndex,
        facing: "up",
        // This one stands INSIDE a room, so it is that room's own - the same
        // rule the Floor's cabin plants get, said as data rather than read
        // back off the kind. `roomId` is the room's synthetic id, which is
        // what a seat's own `roomId` carries.
        audience: { kind: "room", roomId: plan.roomId },
        seatId: null,
      }),
    );
  }

  const doorTile: OfficeTilePos = {
    col: bounds.col + WALL_COLS,
    row: bounds.row + bounds.rows - 1,
  };
  const visitTile: OfficeTilePos =
    desks.length === 0
      ? doorTile
      : { col: desks[0].chairTile.col, row: desks[0].chairTile.row + 1 };
  const signTile: OfficeTilePos = {
    col: bounds.col + WALL_COLS,
    row: bounds.row,
  };
  return {
    room: {
      // A room id, not an agent id (D16): every desk's `roomId` resolves here.
      rootAgentId: plan.roomId,
      name: plan.name,
      bounds,
      doorTile,
      signTile,
      pods: [],
      visitTile,
    },
    desks,
    blocked,
    spots,
    props: isoFixtureProps(spots),
    sign: {
      kind: "plate",
      tile: signTile,
      widthTiles: ISO_SIGN_WIDTH_TILES,
      text: plan.name,
      // The REAL lead, which `rootAgentId` deliberately is not. A bullpen has
      // none, and says so rather than promoting its first solo.
      ownerAgentId: plan.leadAgentId,
      hostId,
      // A plate names its lead; `agentIds` is for the BOARDS that summarise a
      // room's statuses, and carrying a thousand ids on a nameplate is a
      // thousand ids the renderer would never read.
      agentIds: [],
      civicRoomId: null,
    },
  };
}

// ---- The civic quarter, built ------------------------------------------ //

/**
 * A bed or a bench, with CAMPUS'S OWN box.
 *
 * The shared `civicSeat` builds everything a civic seat is except its hit box,
 * which is a fact about how this view stacks sprites and not about seats. This
 * is the one line Campus keeps.
 */
function campusCivicSeat(args: {
  readonly seatId: string;
  readonly civicRoomId: string;
  readonly kind: "bed" | "lounge";
  readonly tile: OfficeTilePos;
  readonly widthTiles: number;
  readonly floorIndex: number;
  readonly hostId: string | null;
  readonly origin: IsoOrigin;
}): OfficeSeat {
  const { origin, ...seat } = args;
  return civicSeat({
    ...seat,
    hitBox: isoCampusSeatBox(
      isoProjectAt(origin, seat.tile.col, seat.tile.row),
    ),
  });
}

/**
 * HOW WIDE A ROOM'S PLATE IS: the room's frontage, read from where the plate
 * hangs.
 *
 * ANCHORED INSIDE the room, that is the run from the plate's own tile to the
 * room's right edge, and the plate must not letter PAST that edge. Sizing by
 * `bounds.cols` alone did exactly that for the one room whose plate was inset -
 * the sick bay's hung a column in, past the wall, and measured 5 tiles over a
 * 4-tile frontage at 12 agents and 17 over 16 at a thousand. Every other room
 * starts its plate at its own first column, where the two readings agree, which
 * is why sizing by the room survived until an inset plate arrived.
 *
 * ANCHORED OUTSIDE the room, the frontage has no meaning at the anchor and the
 * plate carries the ROOM'S OWN width there instead. The front desk's plate hangs
 * at the district's gate, columns away from the counter it names, and the run
 * from the gate to the counter's right edge is not a frontage - it is five tiles
 * of open courtyard with a rule's name on it.
 *
 * EXPORTED FOR ITS OWN CASE, the way `officeCivicSignText` is. After the sick
 * bay's plate moved to its wall's corner, no room this view ships hangs a plate
 * inset from its own bounds - so the inset reading has no witness among the four
 * rooms, and the case that holds it plants one directly. A rule whose only
 * evidence is a layout that no longer exercises it is a rule nothing is testing.
 */
export function civicPlateWidth(room: OfficeCivicRoom): number {
  const { col, cols } = room.bounds;
  const anchor = room.signTile.col;
  if (anchor < col || anchor >= col + cols) return cols;
  return col + cols - anchor;
}

interface CampusCivicArgs {
  readonly hostId: string | null;
  readonly floorIndex: number;
  readonly origin: IsoOrigin;
  readonly bounds: OfficeTileRect;
  readonly beds: number;
  readonly chairs: number;
  readonly sickbay: OfficeTileRect;
  readonly records: OfficeTileRect;
  readonly courtyard: IsoCourtyardBuild;
}

interface CampusCivic {
  readonly rooms: ReadonlyArray<OfficeCivicRoom>;
  readonly seats: ReadonlyArray<OfficeSeat>;
  readonly props: ReadonlyArray<OfficeProp>;
  readonly blocked: ReadonlyArray<OfficeTilePos>;
  readonly signs: ReadonlyArray<OfficeSign>;
  readonly road: OfficeRoad;
}

/**
 * The district's four rooms, in the campus's own words.
 *
 * `Sick bay` is a cabin of beds, `Records` a hut with a door, `Benches` the
 * courtyard's bench row, and `Front desk` the counter that was already there -
 * C7, which makes the help desk the reception rather than a second counter
 * beside it.
 */
function buildCampusCivic(args: CampusCivicArgs): CampusCivic {
  const { hostId, floorIndex, origin, courtyard } = args;
  const road = districtLane(args.bounds);
  const blocked: OfficeTilePos[] = [];
  const props: OfficeProp[] = [];
  const seats: OfficeSeat[] = [];

  // ---- Sick bay: a wall along the top, an aisle down the left ---------- //
  const wardId = civicRoomIdOf(hostId, "infirmary");
  const ward = args.sickbay;
  for (let col = ward.col; col < ward.col + ward.cols; col += 1) {
    blocked.push({ col, row: ward.row });
  }
  // The aisle column stays OPEN, top to bottom: the door is in it, and a wall
  // there would leave whoever came through facing a bed with nowhere to step.
  const wardDoor: OfficeTilePos = { col: ward.col, row: ward.row + 1 };
  const bedRow = ward.row + 1;
  for (let index = 0; index < args.beds; index += 1) {
    const tile: OfficeTilePos = {
      col: ward.col + WALL_COLS + index * BED_WIDTH_TILES,
      row: bedRow,
    };
    for (let offset = 0; offset < BED_WIDTH_TILES; offset += 1) {
      blocked.push({ col: tile.col + offset, row: tile.row });
    }
    props.push({ sprite: { name: "bed-iso" }, tile });
    seats.push(
      campusCivicSeat({
        seatId: `${wardId}/${index}`,
        civicRoomId: wardId,
        kind: "bed",
        tile,
        widthTiles: BED_WIDTH_TILES,
        floorIndex,
        hostId,
        origin,
      }),
    );
  }

  // ---- Records: a hut whose door is the whole room (C5) ---------------- //
  const recordsId = civicRoomIdOf(hostId, "archive");
  const hut = args.records;
  for (let col = hut.col; col < hut.col + hut.cols; col += 1) {
    blocked.push({ col, row: hut.row });
  }
  for (let row = hut.row + 1; row < hut.row + hut.rows - 1; row += 1) {
    blocked.push({ col: hut.col, row });
  }
  const recordsDoor: OfficeTilePos = {
    col: hut.col + WALL_COLS,
    row: hut.row + hut.rows - 1,
  };
  props.push({ sprite: { name: "records-door" }, tile: recordsDoor });

  // ---- Benches: the courtyard's bench row IS the waiting room ---------- //
  //
  // A SEAT IS THE TILE IN FRONT OF THE BENCH, not the bench's own. That is the
  // bench sprite's own contract - "two tiles wide; seats are the tiles in front" -
  // and the bench tile itself is blocked furniture nobody stands on. So the tile a
  // waiting agent sits on is exactly the tile a stroll stands on to use the same
  // bench, and the two are one place two systems can put somebody. That is what
  // `OfficeErrandSpot.seatId` is for, and why the courtyard is handed these ids.
  const benchesId = civicRoomIdOf(hostId, "waiting-room");
  const benchRow = courtyard.rect.row + 2;
  const seatRow = benchRow + 1;
  const benchCol = courtyard.rect.col + 1;
  for (let index = 0; index < args.chairs; index += 1) {
    const tile: OfficeTilePos = { col: benchCol + index, row: seatRow };
    // NO PROP OF ITS OWN. The bench is already there - `isoFixtureProps` stands
    // one up per garden fixture tile - and drawing a second seat on it would be
    // paying twice for the one thing the reuse is for.
    seats.push(
      campusCivicSeat({
        seatId: `${benchesId}/${index}`,
        civicRoomId: benchesId,
        kind: "lounge",
        tile,
        widthTiles: 1,
        floorIndex,
        hostId,
        origin,
      }),
    );
  }

  // ---- Front desk: the reception, re-read as a civic room (C7) --------- //
  const deskId = civicRoomIdOf(hostId, "help-desk");
  const counter = courtyard.receptionTile;
  // THE DOOR IS ONE STEP OFF THE ENTRANCE, not the entrance itself. The
  // district's own entrance stands ON the lane, and no civic door may be a road
  // tile, so the door is the lobby tile inside it and the entrance is the kerb -
  // the Towers precedent, where the archive's door moved off the lane for the
  // same reason.
  const deskDoor = courtyard.lobbyTile;
  const deskKerb: OfficeTilePos = { col: args.bounds.col, row: deskDoor.row };

  const rooms: ReadonlyArray<OfficeCivicRoom> = [
    {
      civicRoomId: wardId,
      kind: "infirmary",
      bounds: ward,
      doorTile: wardDoor,
      // THE WALL'S CORNER, not the first bed. One column left of where it read
      // more naturally, and the reason is screen space: the district's host sign
      // hangs at the bottom-left corner, and `col + row` - which is what an
      // isometric view separates plates by - differs by a CONSTANT 2 between the
      // two, at every population. A plate over the first bed therefore collides
      // with the host sign in every epic whose ward is the minimum two beds
      // wide; the wide wards above ~176 agents escape only because the plate's
      // own width carries its centre clear, which is a coincidence and not a
      // rule. At the corner the difference is 3, which clears the 14px backing
      // at 0.7 zoom with the row to spare.
      signTile: { col: ward.col, row: ward.row },
      name: "Sick bay",
      seatIds: seats
        .filter((seat) => seat.civicRoomId === wardId)
        .map((seat) => seat.seatId),
      floorIndex,
      hostId,
      // ONE DISTRICT PER HOST. The campus lays a district per host and this
      // quarter stands inside one of them, so every room here counts that
      // host's things - the Towers reading, not the hall's.
      hostScope: "host",
      // WALLED: the ward is a building. Its top row is its back wall at every
      // population - 17 of 17 blocked at 309 - and the aisle down its first
      // column is the way in, which is why the walls it gets are filtered by
      // walkability rather than taken from the bounds.
      enclosure: "walled",
      kerbTile: { col: args.bounds.col, row: wardDoor.row },
    },
    {
      civicRoomId: benchesId,
      kind: "waiting-room",
      bounds: {
        col: benchCol,
        row: seatRow,
        cols: Math.max(args.chairs, 1),
        rows: 1,
      },
      // The lawn below the row: a walkable tile beside the seats, and not one of
      // them, so the way in is somewhere to step rather than somewhere to sit.
      doorTile: { col: benchCol, row: seatRow + 1 },
      // Over the bench art itself, which is what the room looks like.
      signTile: { col: benchCol, row: benchRow },
      name: "Benches",
      seatIds: seats
        .filter((seat) => seat.civicRoomId === benchesId)
        .map((seat) => seat.seatId),
      floorIndex,
      hostId,
      hostScope: "host",
      // OPEN: a row of benches on the courtyard lawn. Every tile of these
      // bounds is walkable - 0 of 16 blocked at 309 - and there is no structure
      // here to draw. Not the same claim as the desk's below: this one is open
      // AND unblocked, which is why blockedness looked like an answer.
      enclosure: "open",
      // Nobody is collected from a bench (C6).
      kerbTile: null,
    },
    {
      civicRoomId: deskId,
      kind: "help-desk",
      bounds: { col: counter.col, row: counter.row, cols: 2, rows: 1 },
      doorTile: deskDoor,
      // AT THE GATE, not over the counter. See the placement note above
      // `buildCampusCivic`: three plates cannot share the courtyard's rows.
      signTile: deskKerb,
      name: "Front desk",
      // Standing at a counter is not sitting down, so it carries no seats.
      seatIds: [],
      floorIndex,
      hostId,
      hostScope: "host",
      // OPEN, AND THIS IS THE ONE THE PAINTER GOT WRONG. These bounds ARE the
      // existing reception counter (C7): two tiles of solid furniture, blocked
      // exactly as a wall is blocked, in the middle of an open gate. Reading
      // blockedness alone put two wall pieces along the counter's top and one
      // down its side, round a desk you are meant to walk up to.
      enclosure: "open",
      kerbTile: deskKerb,
    },
    {
      civicRoomId: recordsId,
      kind: "archive",
      bounds: hut,
      doorTile: recordsDoor,
      // Its plate is four tiles and the hut is four wide, so the label sits
      // over the room it names and reaches nothing else.
      signTile: { col: hut.col, row: hut.row },
      name: "Records",
      seatIds: [],
      floorIndex,
      hostId,
      hostScope: "host",
      // WALLED: the records hut is a building, four by three, with its door on
      // its last row. Top row 4 of 4 blocked; its first column is blocked for
      // the rows BETWEEN the corners and open at the last one, which is the
      // hut's own corner tile and not its door - `recordsDoor` sits WALL_COLS
      // in from that column, on the same row. The opening in the first column
      // is what keeps the wall from running into the way out.
      enclosure: "walled",
      // Nothing drives to the archive (C6).
      kerbTile: null,
    },
  ];

  const signs: ReadonlyArray<OfficeSign> = rooms.map((room) => ({
    kind: "civic",
    tile: room.signTile,
    widthTiles:
      room.kind === "archive"
        ? ARCHIVE_SIGN_WIDTH_TILES
        : civicPlateWidth(room),
    text: room.name,
    ownerAgentId: null,
    hostId,
    agentIds: [],
    civicRoomId: room.civicRoomId,
  }));

  return { rooms, seats, props, blocked, signs, road };
}

interface DistrictBuilt {
  readonly build: IsoDistrictBuild;
  readonly desks: ReadonlyArray<OfficeDesk>;
  /** The civic seats: beds and benches, which belong to no agent. */
  readonly seats: ReadonlyArray<OfficeSeat>;
}

function buildDistrict(
  plan: CampusDistrictPlan & { readonly col: number },
  floorIndex: number,
  origin: IsoOrigin,
): DistrictBuilt {
  const originCol = plan.col + ISO_DISTRICT_RING;
  const originRow = ISO_DISTRICT_RING;
  const blocks = [...amenityBlocksFor(plan.chairs), ...plan.rooms];
  const packed = isoShelfPack(
    blocks,
    plan.widthBudget,
    originCol,
    isoShelfStart(originCol, originRow),
  );
  const byId = new Map(packed.placed.map((block) => [block.blockId, block]));
  const courtyardAt = byId.get("courtyard");
  const cafeAt = byId.get("cafe");
  const recordsAt = byId.get("records");
  if (
    courtyardAt === undefined ||
    cafeAt === undefined ||
    recordsAt === undefined
  ) {
    throw new Error("campus district lost its amenities");
  }
  // THE BENCH ROW IS THE WAITING ROOM, so the courtyard is as long as the
  // contract's chair count and each bench tile answers with the lounge seat laid
  // on it. The seat ids are the room's, computed the same way twice rather than
  // threaded back out of the build - a bench and its seat have to agree, and the
  // shared formula is what makes them.
  const benchesId = civicRoomIdOf(plan.hostId, "waiting-room");
  const courtyard = buildIsoCourtyard({
    col: courtyardAt.col,
    row: courtyardAt.row,
    floorIndex,
    name: "Courtyard",
    benches: plan.chairs,
    seatIdAt: (index) => `${benchesId}/${index}`,
  });
  const cafe = buildIsoCafe({
    col: cafeAt.col,
    row: cafeAt.row,
    floorIndex,
    name: "Cafeteria",
  });

  const rooms: OfficeRoom[] = [];
  const desks: OfficeDesk[] = [];
  const props: OfficeProp[] = [...courtyard.props, ...cafe.props];
  const blocked: OfficeTilePos[] = [];
  const spots: OfficeErrandSpot[] = [];
  const signs: OfficeSign[] = [];
  for (const roomPlan of plan.rooms) {
    const placed = byId.get(roomPlan.blockId);
    if (placed === undefined) continue;
    const built = buildRoom({
      plan: roomPlan,
      placed,
      floorIndex,
      hostId: plan.hostId,
      origin,
    });
    rooms.push(built.room);
    desks.push(...built.desks);
    blocked.push(...built.blocked);
    spots.push(...built.spots);
    props.push(...built.props);
    signs.push(built.sign);
  }

  // A district is as tall as its own content. The rows below a short one are
  // nobody's floor, which is exactly what keeps two hosts unreachable from
  // each other without a second mechanism.
  const bounds: OfficeTileRect = {
    col: plan.col,
    row: 0,
    cols: plan.cols,
    rows: plan.rows,
  };
  const civic = buildCampusCivic({
    hostId: plan.hostId,
    floorIndex,
    origin,
    bounds,
    beds: plan.beds,
    chairs: plan.chairs,
    // The band under the packed shelves, at the first content column so its
    // aisle wall faces the lane; `sickbayRow` is content-relative.
    sickbay: {
      col: originCol,
      row: originRow + plan.sickbayRow,
      cols: sickbayCols(plan.beds),
      rows: SICKBAY_ROWS,
    },
    records: {
      col: recordsAt.col,
      row: recordsAt.row,
      cols: recordsAt.cols,
      rows: recordsAt.rows,
    },
    courtyard,
  });
  const build: IsoDistrictBuild = {
    hostId: plan.hostId,
    bounds,
    courtyard,
    cafe,
    rooms,
    props: [...props, ...civic.props],
    blocked: [...blocked, ...civic.blocked],
    spots,
    signs: [...signs, ...civic.signs],
    civic: civic.rooms,
    road: civic.road,
  };
  return { build, desks, seats: civic.seats };
}

/**
 * The campus, whole.
 *
 * `occupancy` is deliberately not consulted: this plan re-packs, so there is no
 * seat to honour - a seat id here is `<host>/<room>/<n>`, which the same agent
 * in the same room keeps across a re-pack anyway, exactly as the Floor's does.
 */
export function planCampus(input: OfficePlanInput): OfficeLayout {
  const world = planWorld(input);
  const grid: IsoGrid = isoBlankGrid(world.cols, world.rows);
  // The whole world is measured before a desk is placed, which is what lets a
  // seat carry the projected box it is painted in (D53) rather than a
  // rectangle of tiles the painter never draws to.
  const origin: IsoOrigin = {
    rows: world.rows,
    stackHeight: ISO_CAMPUS_STACK_HEIGHT,
  };
  const builds: DistrictBuilt[] = [];
  for (const [floorIndex, district] of world.districts.entries()) {
    builds.push(buildDistrict(district, floorIndex, origin));
  }
  for (const built of builds) isoPaintDistrict(grid, built.build);

  const desks = new Map<string, OfficeDesk>();
  const seats = new Map<string, OfficeSeat>();
  const rooms: OfficeRoom[] = [];
  const props: OfficeProp[] = [];
  const signs: OfficeSign[] = [];
  const floors: OfficeFloor[] = [];
  for (const [floorIndex, built] of builds.entries()) {
    for (const desk of built.desks) {
      desks.set(desk.agentId, desk);
      seats.set(desk.seatId, desk);
    }
    // Civic seats are seats with no occupant: registered so the seat book can
    // lend one, absent from `desks` because nobody lives there.
    for (const seat of built.seats) seats.set(seat.seatId, seat);
    rooms.push(...built.build.rooms);
    props.push(...built.build.props);
    signs.push(...built.build.signs, isoHostSign(built.build));
    floors.push(isoFloorOf({ build: built.build, floorIndex, grid }));
  }
  for (const [floorIndex, floor] of floors.entries()) {
    // THE COURTYARD IS NOT LETTERED TWICE. Campus's waiting room IS this
    // courtyard's bench row, and the civic plate already names the place and
    // carries the live count - so the amenity's own "Courtyard" label is a
    // second name for one place, and it is the one that gives way. C7's economy
    // applied to labels rather than to counters. City keeps its park's label,
    // because there the waiting room is the shelter at the kerb and the park is
    // only a park.
    const annexed = builds[floorIndex].build.courtyard.areaSign.signTile;
    for (const sign of floor.areaSigns) {
      if (
        sign.signTile.col === annexed.col &&
        sign.signTile.row === annexed.row
      ) {
        continue;
      }
      signs.push({
        kind: "area",
        tile: sign.signTile,
        widthTiles: ISO_SIGN_WIDTH_TILES,
        text: sign.name,
        ownerAgentId: null,
        hostId: floor.hostId,
        agentIds: [],
        civicRoomId: null,
      });
    }
  }

  return {
    view: "campus",
    cols: world.cols,
    rows: world.rows,
    desks,
    seats,
    signs,
    rooms,
    floors,
    doorTile: floors[0].doorTile,
    lobbyTile: floors[0].lobbyTile,
    props,
    walkable: grid.walkable,
    // NOT a packing: Campus carries nothing from one plan to the next, and
    // never reads its own `frozen` back. What is in there is the painter's
    // lookup, built from the layout this call just finished.
    frozen: {
      kind: "campus",
      index: buildIsoIndex({
        props,
        rooms,
        floors,
        spots: floors.flatMap((floor) => floor.errandSpots),
      }),
    } satisfies CampusFrozen,
    shiftFromPrevious: null,
    stable: false,
  };
}

export function measureCampus(input: OfficePlanInput): OfficeSize {
  const world = planWorld(input);
  return {
    width: (world.cols + world.rows) * ISO_HALF_WIDTH,
    height:
      (world.cols + world.rows) * ISO_HALF_HEIGHT +
      ISO_CAMPUS_STACK_HEIGHT +
      OFFICE_CHARACTER_HEIGHT,
  };
}

export const CAMPUS_VIEW: OfficeView = {
  id: "campus",
  label: "Campus",
  // WHAT A READER SEES, like the other five. This used to describe the PACKER
  // - "shelf-packed into a near-square so the projected diamond fills the
  // viewport" - which is the reason the cabins are laid out the way they are
  // and not a thing anybody can look at. The picker shows this line precisely
  // because the label alone tells a first-time reader nothing, so a sentence
  // only the planner's author can parse spends that slot on nobody.
  description:
    "A cabin per team, low on grass and seen from the corner; the desks inside are drawn, and a team too big for one cabin takes a second.",
  plan: planCampus,
  measure: measureCampus,
  painter: ISO_PAINTER,
};
