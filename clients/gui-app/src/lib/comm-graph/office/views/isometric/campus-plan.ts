/**
 * CAMPUS: low buildings on grass, one room per family, seen from the corner.
 *
 * A room holds a root agent's whole subtree, sized by that subtree exactly as
 * the Floor sizes a cabin - but on a FLAT near-square grid of slots rather than
 * the Floor's nested one. That difference is the view: the Floor's hierarchical
 * packing turns the recording's 309-agent epic into a 100 x 362 tile corridor,
 * and a corridor projected isometrically is a diagonal nothing can frame. The
 * same subtree on a near-square grid is 55 x 55, which is the 60 x 60 the spec
 * quotes and the 1,920 x 960 projection it quotes with it.
 *
 * Campus re-packs, like the Floor: a fifth child arriving moves the chairs
 * around it and the scene walks whoever moved. `stable: false` says so, and
 * that is the whole of its growth rule - there is no frozen packing to carry,
 * which is why `frozen` is `null` here and rich on City.
 *
 * Rooms have back walls on their top-left and top-right edges and nothing at
 * the front, so the room is open to the viewer and the desks inside it are
 * visible. The plate hangs on the back wall.
 */
import { compareByCreation } from "@/lib/comm-graph/office/office-layout";
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
  ISO_HALF_HEIGHT,
  ISO_HALF_WIDTH,
} from "@/lib/comm-graph/office/views/isometric/iso-projector";
import { ISO_PAINTER } from "@/lib/comm-graph/office/views/isometric/iso-painter";
import {
  buildIsoCafe,
  buildIsoCourtyard,
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

/** A room, planned before it is placed. */
interface CampusRoomPlan extends IsoBlockSpec {
  readonly root: OfficeAgentInput;
  readonly occupants: ReadonlyArray<OfficeAgentInput>;
  readonly perRow: number;
}

interface Forest {
  readonly roots: ReadonlyArray<OfficeAgentInput>;
  readonly childrenByParent: ReadonlyMap<
    string,
    ReadonlyArray<OfficeAgentInput>
  >;
}

/**
 * An agent whose parent is not on this host is a root HERE. A district is one
 * host's campus, and a family that straddles two machines is two families as
 * far as the ground is concerned.
 */
function buildForest(agents: ReadonlyArray<OfficeAgentInput>): Forest {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenByParent = new Map<string, OfficeAgentInput[]>();
  const roots: OfficeAgentInput[] = [];
  const ordered = [...agents].sort(compareByCreation);
  for (const agent of ordered) {
    const parentId = agent.parentId;
    if (parentId === null || parentId === agent.id || !byId.has(parentId)) {
      roots.push(agent);
      continue;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) childrenByParent.set(parentId, [agent]);
    else siblings.push(agent);
  }
  return { roots, childrenByParent };
}

/** The root, then its subtree depth-first in creation order. */
function subtreeOf(
  forest: Forest,
  root: OfficeAgentInput,
  claimed: Set<string>,
): ReadonlyArray<OfficeAgentInput> {
  const occupants: OfficeAgentInput[] = [];
  const visit = (agent: OfficeAgentInput): void => {
    // A reparenting cycle can name a child that is already somebody's; it keeps
    // the first room it was given rather than being seated twice.
    if (claimed.has(agent.id)) return;
    claimed.add(agent.id);
    occupants.push(agent);
    for (const child of forest.childrenByParent.get(agent.id) ?? []) {
      visit(child);
    }
  };
  visit(root);
  return occupants;
}

function roomPlanFor(
  root: OfficeAgentInput,
  occupants: ReadonlyArray<OfficeAgentInput>,
): CampusRoomPlan {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(occupants.length)));
  const slotRows = Math.max(1, Math.ceil(occupants.length / perRow));
  return {
    blockId: root.id,
    root,
    occupants,
    perRow,
    cols: WALL_COLS + perRow * SLOT_COLS,
    rows: WALL_ROWS + slotRows * SLOT_ROWS,
  };
}

function roomPlansFor(
  agents: ReadonlyArray<OfficeAgentInput>,
): ReadonlyArray<CampusRoomPlan> {
  const forest = buildForest(agents);
  const claimed = new Set<string>();
  const plans: CampusRoomPlan[] = [];
  const collect = (root: OfficeAgentInput): void => {
    if (claimed.has(root.id)) return;
    plans.push(roomPlanFor(root, subtreeOf(forest, root, claimed)));
  };
  for (const root of forest.roots) collect(root);
  // Whoever a cycle left unreachable opens a room of their own: an odd campus
  // beats a missing desk.
  for (const agent of [...agents].sort(compareByCreation)) collect(agent);
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
  hostId: string | null,
  agents: ReadonlyArray<OfficeAgentInput>,
): CampusDistrictPlan {
  const rooms = roomPlansFor(agents);
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
    hostId,
    rooms,
    widthBudget,
    cols: contentCols + ISO_DISTRICT_RING * 2,
    rows: contentRows + ISO_DISTRICT_RING * 2,
  };
}

function agentsByHost(input: OfficePlanInput): ReadonlyArray<{
  readonly hostId: string | null;
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
    hostId: string | null;
    agents: ReadonlyArray<OfficeAgentInput>;
  }> = [];
  for (const host of input.partition.hosts) {
    ordered.push({
      hostId: host.hostId,
      agents: groups.get(isoHostKey(host.hostId)) ?? [],
    });
  }
  // An empty epic still gets one district: every consumer of `floors` assumes
  // there is at least one, and a campus with nobody on it is still a campus.
  if (ordered.length === 0) ordered.push({ hostId: null, agents: [] });
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
    const plan = districtPlanFor(group.hostId, group.agents);
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
function buildRoom(
  plan: CampusRoomPlan,
  placed: IsoPlacedBlock,
  floorIndex: number,
  hostId: string | null,
): RoomBuild {
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

  const seatGroup = [hostId ?? ISO_SEAT_ID_NONE, floorIndex, plan.root.id].join(
    "/",
  );
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
      floorIndex,
      roomId: plan.root.id,
      hostId,
      manager: agent.id === plan.root.id,
      agentId: agent.id,
    });
    for (let offset = 0; offset < DESK_WIDTH_TILES; offset += 1) {
      blocked.push({ col: deskTile.col + offset, row: deskTile.row });
    }
    blocked.push(chairTile);
  }

  // Every room has a lead - it is built around one - but a room whose lead has
  // no desk yet has nothing to stand a plant beside.
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
        floorIndex,
        owns: true,
        facing: "up",
        // This one stands INSIDE a room, so it is that room's own - the same
        // rule the Floor's cabin plants get, said as data rather than read
        // back off the kind. `roomId` is the room's root agent, which is what
        // a seat's own `roomId` carries.
        audience: { kind: "room", roomId: plan.root.id },
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
      rootAgentId: plan.root.id,
      name: plan.root.name,
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
      text: plan.root.name,
      ownerAgentId: plan.root.id,
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
    const built = buildRoom(roomPlan, placed, floorIndex, plan.hostId);
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
 * seat to honour - a seat id here is `<host>/<district>/<room>/<n>`, which the
 * same agent in the same room keeps across a re-pack anyway, exactly as the
 * Floor's does.
 */
export function planCampus(input: OfficePlanInput): OfficeLayout {
  const world = planWorld(input);
  const grid: IsoGrid = isoBlankGrid(world.cols, world.rows);
  const builds: DistrictBuilt[] = [];
  for (const [floorIndex, district] of world.districts.entries()) {
    builds.push(buildDistrict(district, floorIndex));
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
    frozen: null,
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
    "Rooms sized by their subtree, shelf-packed into a near-square so the projected diamond fills the viewport.",
  plan: planCampus,
  measure: measureCampus,
  painter: ISO_PAINTER,
};
