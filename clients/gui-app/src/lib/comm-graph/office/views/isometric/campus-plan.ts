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
  OFFICE_CHARACTER_HEIGHT,
  type OfficeAgentInput,
  type OfficeDesk,
  type OfficeErrandSpot,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeProp,
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
  isoBlankGrid,
  isoFixtureProps,
  isoFloorOf,
  isoHostKey,
  isoHostSign,
  isoNearSquareWidth,
  isoPaintDistrict,
  isoShelfPack,
  isoShelfStart,
  isoSpotAt,
  ISO_CAFE_COLS,
  ISO_CAFE_ROWS,
  ISO_COURTYARD_COLS,
  ISO_COURTYARD_ROWS,
  ISO_DISTRICT_GAP,
  ISO_DISTRICT_RING,
  ISO_CAMPUS_STACK_HEIGHT,
  ISO_SEAT_ID_NONE,
  ISO_SIGN_WIDTH_TILES,
  type IsoBlockSpec,
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
}

const AMENITY_BLOCKS: ReadonlyArray<IsoBlockSpec> = [
  { blockId: "courtyard", cols: ISO_COURTYARD_COLS, rows: ISO_COURTYARD_ROWS },
  { blockId: "cafe", cols: ISO_CAFE_COLS, rows: ISO_CAFE_ROWS },
];

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
  const blocks = [...AMENITY_BLOCKS, ...rooms];
  const widthBudget = isoNearSquareWidth(blocks);
  const packed = isoShelfPack(blocks, widthBudget, 0, isoShelfStart(0, 0));
  let contentCols = 0;
  let contentRows = 0;
  for (const block of packed.placed) {
    contentCols = Math.max(contentCols, block.col + block.cols);
    contentRows = Math.max(contentRows, block.row + block.rows);
  }
  return {
    hostId: host.hostId,
    rooms,
    widthBudget,
    cols: contentCols + ISO_DISTRICT_RING * 2,
    rows: contentRows + ISO_DISTRICT_RING * 2,
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
    },
  };
}

interface DistrictBuilt {
  readonly build: IsoDistrictBuild;
  readonly desks: ReadonlyArray<OfficeDesk>;
}

function buildDistrict(
  plan: CampusDistrictPlan & { readonly col: number },
  floorIndex: number,
  origin: IsoOrigin,
): DistrictBuilt {
  const originCol = plan.col + ISO_DISTRICT_RING;
  const originRow = ISO_DISTRICT_RING;
  const blocks = [...AMENITY_BLOCKS, ...plan.rooms];
  const packed = isoShelfPack(
    blocks,
    plan.widthBudget,
    originCol,
    isoShelfStart(originCol, originRow),
  );
  const byId = new Map(packed.placed.map((block) => [block.blockId, block]));
  const courtyardAt = byId.get("courtyard");
  const cafeAt = byId.get("cafe");
  if (courtyardAt === undefined || cafeAt === undefined) {
    throw new Error("campus district lost its amenities");
  }
  const courtyard = buildIsoCourtyard({
    col: courtyardAt.col,
    row: courtyardAt.row,
    floorIndex,
    name: "Courtyard",
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
  const build: IsoDistrictBuild = {
    hostId: plan.hostId,
    bounds,
    courtyard,
    cafe,
    rooms,
    props,
    blocked,
    spots,
    signs,
  };
  return { build, desks };
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
    rooms.push(...built.build.rooms);
    props.push(...built.build.props);
    signs.push(...built.build.signs, isoHostSign(built.build));
    floors.push(isoFloorOf({ build: built.build, floorIndex, grid }));
  }
  for (const floor of floors) {
    for (const sign of floor.areaSigns) {
      signs.push({
        kind: "area",
        tile: sign.signTile,
        widthTiles: ISO_SIGN_WIDTH_TILES,
        text: sign.name,
        ownerAgentId: null,
        hostId: floor.hostId,
        agentIds: [],
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
  description:
    "A cabin per team, sized by its members and shelf-packed into a near-square so the projected diamond fills the viewport.",
  plan: planCampus,
  measure: measureCampus,
  painter: ISO_PAINTER,
};
