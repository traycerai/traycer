/** Shared tile arithmetic for the two append-stable oblique offices. */
import type {
  OfficeHostPopulation,
  OfficePopulationMember,
} from "@/lib/comm-graph/office/office-population";
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import type {
  OfficeAgentInput,
  OfficeDesk,
  OfficeErrandKind,
  OfficeErrandSpot,
  OfficeFacing,
  OfficeFloor,
  OfficeLayout,
  OfficeProp,
  OfficeRoom,
  OfficeSeat,
  OfficeSign,
  OfficeSize,
  OfficeSpriteName,
  OfficeTilePos,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import type { OfficePlanInput, OfficeView } from "../office-view";
import { OBLIQUE_PAINTER } from "./oblique-painter";

type ObliqueMode = "towers" | "building";
type StoreyKind = "hq" | "live" | "quiet" | "plaza";
interface RoomRun {
  readonly id: string;
  readonly lead: string | null;
  readonly solo: boolean;
  readonly agents: ReadonlyArray<string>;
  readonly capacity: number;
}
interface Slot {
  readonly id: string;
  readonly col: number;
  readonly room: string | null;
  readonly manager: boolean;
}
interface Storey {
  readonly id: number;
  readonly building: number;
  readonly wing: number;
  readonly kind: StoreyKind;
  row: number;
  readonly slots: Slot[];
  readonly rooms: RoomRun[];
}
interface Building {
  readonly hostId: string | null;
  readonly col: number;
  readonly wings: number;
  readonly width: number;
  plazaRow: number;
  quietRows: number;
}
/** No previous layout is retained: a fresh, private recipe is copied each run. */
class ObliquePacking {
  readonly mode: ObliqueMode;
  readonly buildings: Building[];
  readonly storeys: Storey[];
  readonly assignment: Map<string, string>;
  readonly cubby: Map<string, boolean>;
  shift: number;
  constructor(mode: ObliqueMode) {
    this.mode = mode;
    this.buildings = [];
    this.storeys = [];
    this.assignment = new Map();
    this.cubby = new Map();
    this.shift = 0;
  }
}

function wingStep(mode: ObliqueMode): number {
  return mode === "towers" ? 26 : 23;
}
function buildingWidth(mode: ObliqueMode, wings: number): number {
  return mode === "towers" ? 26 * wings : 23 * wings + 3;
}
function wingCol(
  packing: ObliquePacking,
  building: Building,
  wing: number,
): number {
  return building.col + 3 + wing * wingStep(packing.mode);
}
function chunks(ids: ReadonlyArray<string>, size: number): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < ids.length; i += size)
    result.push(ids.slice(i, i + size));
  return result;
}
function initialRooms(
  host: OfficeHostPopulation,
  mode: ObliqueMode,
): RoomRun[] {
  const rooms: RoomRun[] = [];
  for (const team of host.teams) {
    if (mode === "building" && !team.live) continue;
    for (const [i, ids] of chunks(
      team.memberAgentIds,
      mode === "building" ? 8 : 9,
    ).entries()) {
      rooms.push({
        id: `${team.teamId}/room/${i}`,
        lead: team.leadAgentId,
        solo: false,
        agents: ids,
        capacity: ids.length + (mode === "building" ? 1 : 0),
      });
    }
  }
  const solos = host.solos.filter(
    (member) => mode === "towers" || member.hotAtArrival,
  );
  for (const [i, ids] of chunks(
    solos.map((member) => member.agentId),
    9,
  ).entries()) {
    rooms.push({
      id: `${hostKey(host.hostId)}/bullpen/${i}`,
      lead: ids[0] ?? null,
      solo: true,
      agents: ids,
      capacity: ids.length,
    });
  }
  return rooms;
}
function packRooms(rooms: ReadonlyArray<RoomRun>): RoomRun[][] {
  const bins: RoomRun[][] = [];
  for (const room of rooms) {
    // Three internal dividers leave the last tile for the coffee corner.
    const available = bins.find(
      (bin) =>
        bin.length < 4 &&
        bin.reduce((sum, item) => sum + item.capacity, 0) + room.capacity <= 9,
    );
    if (available === undefined) bins.push([room]);
    else available.push(room);
  }
  return bins;
}
function hostKey(hostId: string | null): string {
  return hostId === null
    ? "unattributed"
    : `host:${encodeURIComponent(hostId)}`;
}
function quietIds(host: OfficeHostPopulation, mode: ObliqueMode): string[] {
  if (mode === "towers") return [];
  return [
    ...host.teams
      .filter((team) => !team.live)
      .flatMap((team) => team.memberAgentIds),
    ...host.solos
      .filter((member) => !member.hotAtArrival)
      .map((member) => member.agentId),
  ];
}
interface WingSizing {
  readonly bins: number;
  readonly quiet: number;
  readonly viewport: OfficeSize;
  readonly maxWings: number;
}
function chooseWings(mode: ObliqueMode, sizing: WingSizing): number {
  const { bins, quiet, viewport, maxWings } = sizing;
  let best = 1;
  let bestFit = 0;
  for (let wings = 1; wings <= maxWings; wings += 1) {
    const rows =
      12 +
      4 * (Math.ceil(bins / wings) + 1) +
      2 * Math.ceil(quiet / (22 * wings));
    const fit = Math.min(
      viewport.width / buildingWidth(mode, wings),
      viewport.height / rows,
    );
    if (fit > bestFit) {
      best = wings;
      bestFit = fit;
    }
  }
  return best;
}
interface StoreyPlacement {
  readonly wing: number;
  readonly row: number;
  readonly kind: StoreyKind;
  readonly rooms: ReadonlyArray<RoomRun>;
}
function addStorey(
  packing: ObliquePacking,
  buildingIndex: number,
  placement: StoreyPlacement,
): Storey {
  const { wing, row, kind, rooms } = placement;
  const building = packing.buildings[buildingIndex];
  const storey: Storey = {
    id: packing.storeys.length,
    building: buildingIndex,
    wing,
    row,
    kind,
    slots: [],
    rooms: [...rooms],
  };
  packing.storeys.push(storey);
  if (kind === "plaza" || kind === "quiet") return storey;
  let slotIndex = 0;
  let col = wingCol(packing, building, wing);
  for (const room of rooms) {
    for (let i = 0; i < room.capacity; i += 1) {
      const id = `${hostKey(building.hostId)}/${storey.id}/seat/${slotIndex}`;
      storey.slots.push({
        id,
        col,
        room: room.id,
        manager: kind === "hq" && i === 0,
      });
      const agentId = room.agents.at(i);
      if (agentId !== undefined) packing.assignment.set(agentId, id);
      slotIndex += 1;
      col += 2;
    }
    col += 1;
  }
  // Unused seats keep their original coordinates when later assigned.
  if (rooms.length > 0) col -= 1;
  while (slotIndex < 9) {
    const id = `${hostKey(building.hostId)}/${storey.id}/seat/${slotIndex}`;
    storey.slots.push({ id, col, room: null, manager: false });
    col += 2;
    slotIndex += 1;
  }
  return storey;
}
function addQuietAgent(
  packing: ObliquePacking,
  buildingIndex: number,
  agentId: string,
): void {
  const building = packing.buildings[buildingIndex];
  const capacity = 22 * building.wings;
  let storey = packing.storeys
    .filter((item) => item.building === buildingIndex && item.kind === "quiet")
    .at(-1);
  if (storey === undefined || storey.slots.length >= capacity) {
    storey = addStorey(packing, buildingIndex, {
      wing: 0,
      row: building.plazaRow + 5 + building.quietRows * 2,
      kind: "quiet",
      rooms: [],
    });
    building.quietRows += 1;
  }
  const index = storey.slots.length;
  const wing = Math.floor(index / 22);
  const col = wingCol(packing, building, wing) + (index % 22);
  const id = `${hostKey(building.hostId)}/${storey.id}/cubby/${index}`;
  storey.slots.push({ id, col, room: null, manager: false });
  packing.assignment.set(agentId, id);
}
function addBuilding(
  packing: ObliquePacking,
  host: OfficeHostPopulation,
  input: OfficePlanInput,
): void {
  const bins = packRooms(initialRooms(host, packing.mode));
  const quiet = quietIds(host, packing.mode);
  const previousBuilding = packing.buildings.at(-1);
  const maxWings =
    packing.mode === "towers"
      ? Math.max(1, Math.ceil(Math.sqrt(bins.length + 1)))
      : 4;
  const wings = chooseWings(packing.mode, {
    bins: bins.length,
    quiet: quiet.length,
    viewport: input.viewport,
    maxWings:
      previousBuilding === undefined
        ? maxWings
        : Math.min(maxWings, previousBuilding.wings),
  });
  const levels = Math.ceil(bins.length / wings) + 1;
  const topOffset =
    (packing.storeys.find((storey) => storey.kind === "hq")?.row ?? 2) - 2;
  const building: Building = {
    hostId: host.hostId,
    col:
      previousBuilding === undefined
        ? 0
        : previousBuilding.col + previousBuilding.width + 4,
    wings,
    width: buildingWidth(packing.mode, wings),
    plazaRow: topOffset + 6 + 4 * levels,
    quietRows: 0,
  };
  const buildingIndex = packing.buildings.length;
  packing.buildings.push(building);
  // Canonical plaza spots precede aliases in the scene's tile-deduplicated index.
  addStorey(packing, buildingIndex, {
    wing: 0,
    row: building.plazaRow,
    kind: "plaza",
    rooms: [],
  });
  fillInitialStoreys(packing, buildingIndex, { host, bins, levels, topOffset });
  for (const id of quiet) addQuietAgent(packing, buildingIndex, id);
  const quietSet = new Set(quiet);
  for (const member of input.partition.members.values()) {
    if (member.hostId !== host.hostId) continue;
    packing.cubby.set(member.agentId, quietSet.has(member.agentId));
  }
}
interface InitialStoreys {
  readonly host: OfficeHostPopulation;
  readonly bins: ReadonlyArray<ReadonlyArray<RoomRun>>;
  readonly levels: number;
  readonly topOffset: number;
}
function fillInitialStoreys(
  packing: ObliquePacking,
  buildingIndex: number,
  initial: InitialStoreys,
): void {
  const { host, bins, levels, topOffset } = initial;
  const wings = packing.buildings[buildingIndex].wings;
  for (let wing = 0; wing < wings; wing += 1) {
    const hqRooms: RoomRun[] =
      host.hqAgentId !== null && wing === 0
        ? [
            {
              id: `${host.hqAgentId}/hq`,
              lead: host.hqAgentId,
              solo: false,
              agents: [host.hqAgentId],
              capacity: 1,
            },
          ]
        : [];
    addStorey(packing, buildingIndex, {
      wing: wing,
      row: topOffset + 2,
      kind: "hq",
      rooms: hqRooms,
    });
  }
  for (let level = 0; level < levels; level += 1) {
    for (let wing = 0; wing < wings; wing += 1) {
      const bin = bins.at(level * wings + wing);
      if (bin !== undefined || level === levels - 1) {
        addStorey(packing, buildingIndex, {
          wing: wing,
          row: topOffset + 6 + level * 4,
          kind: "live",
          rooms: bin ?? [],
        });
      }
    }
  }
}
function copyPacking(previous: ObliquePacking): ObliquePacking {
  const next = new ObliquePacking(previous.mode);
  next.buildings.push(
    ...previous.buildings.map((building) => ({ ...building })),
  );
  next.storeys.push(
    ...previous.storeys.map((storey) => ({
      ...storey,
      slots: [...storey.slots],
      rooms: [...storey.rooms],
    })),
  );
  for (const [id, seat] of previous.assignment) next.assignment.set(id, seat);
  for (const [id, cubby] of previous.cubby) next.cubby.set(id, cubby);
  return next;
}
function growLive(packing: ObliquePacking): void {
  for (const storey of packing.storeys) storey.row += 4;
  for (const building of packing.buildings) building.plazaRow += 4;
  for (const [index, building] of packing.buildings.entries()) {
    for (let wing = 0; wing < building.wings; wing += 1) {
      addStorey(packing, index, {
        wing: wing,
        row: 2,
        kind: "live",
        rooms: [],
      });
    }
  }
  packing.shift += 4;
}
function availableSeats(
  packing: ObliquePacking,
  input: OfficePlanInput,
  buildingIndex: number,
): Slot[] {
  const assigned = new Set(packing.assignment.values());
  return packing.storeys
    .filter(
      (storey) =>
        storey.building === buildingIndex &&
        (storey.kind === "live" || storey.kind === "hq"),
    )
    .flatMap((storey) => storey.slots)
    .filter((slot) => !assigned.has(slot.id) && !input.occupancy.has(slot.id));
}
function seatArrival(
  packing: ObliquePacking,
  input: OfficePlanInput,
  buildingIndex: number,
  member: OfficePopulationMember,
): void {
  let free = availableSeats(packing, input, buildingIndex);
  if (free.length === 0) {
    growLive(packing);
    free = availableSeats(packing, input, buildingIndex);
  }
  const matchingRooms = new Set(
    packing.storeys
      .flatMap((storey) => storey.rooms)
      .filter((room) => room.lead === member.teamId)
      .map((room) => room.id),
  );
  const seat =
    free.find((slot) => slot.room !== null && matchingRooms.has(slot.room)) ??
    free.find((slot) => slot.room === null) ??
    free.at(0);
  if (seat !== undefined) assignArrival(packing, member, seat);
}
function assignArrival(
  packing: ObliquePacking,
  member: OfficePopulationMember,
  seat: Slot,
): void {
  packing.assignment.set(member.agentId, seat.id);
  if (seat.room !== null) return;
  const storey = packing.storeys.find((item) =>
    item.slots.some((slot) => slot.id === seat.id),
  );
  if (storey === undefined) return;
  const room: RoomRun = {
    id: `${seat.id}/arrival`,
    lead: member.teamId ?? member.agentId,
    solo: member.agentClass === "solo",
    agents: [member.agentId],
    capacity: 1,
  };
  storey.rooms.push(room);
  const slotIndex = storey.slots.findIndex((slot) => slot.id === seat.id);
  storey.slots[slotIndex] = { ...seat, room: room.id };
}
function growPacking(packing: ObliquePacking, input: OfficePlanInput): void {
  const present = new Set(input.agents.map((agent) => agent.id));
  for (const id of packing.assignment.keys()) {
    if (!present.has(id)) {
      packing.assignment.delete(id);
      packing.cubby.delete(id);
    }
  }
  for (const host of input.partition.hosts) {
    const index = packing.buildings.findIndex(
      (building) => building.hostId === host.hostId,
    );
    if (index < 0) {
      addBuilding(packing, host, input);
      continue;
    }
    growHost(packing, input, index, host);
  }
}
function arrivalIsCubby(
  mode: ObliqueMode,
  member: OfficePopulationMember,
  teamLive: ReadonlyMap<string, boolean>,
): boolean {
  if (mode !== "building" || member.agentClass === "hq" || member.hotAtArrival)
    return false;
  if (member.agentClass === "team") return !teamLive.get(member.teamId ?? "");
  return true;
}
function growHost(
  packing: ObliquePacking,
  input: OfficePlanInput,
  index: number,
  host: OfficeHostPopulation,
): void {
  const teamLive = new Map(
    host.teams.map((team) => [
      team.teamId,
      team.memberAgentIds.some((id) => packing.cubby.get(id) === false) ||
        (!team.memberAgentIds.some((id) => packing.cubby.has(id)) && team.live),
    ]),
  );
  const ordered = [
    host.hqAgentId,
    ...host.teams.flatMap((team) => team.memberAgentIds),
    ...host.solos.map((member) => member.agentId),
  ];
  for (const id of ordered) {
    if (id === null || packing.assignment.has(id)) continue;
    const member = input.partition.members.get(id);
    if (member === undefined) continue;
    const cubby = arrivalIsCubby(packing.mode, member, teamLive);
    packing.cubby.set(id, cubby);
    if (cubby) {
      addQuietAgent(packing, index, id);
      continue;
    }
    seatArrival(packing, input, index, member);
  }
  const shortage = input.needsCapacity.filter(
    (id) => input.partition.members.get(id)?.hostId === host.hostId,
  ).length;
  while (availableSeats(packing, input, index).length < shortage)
    growLive(packing);
}
function recipe(input: OfficePlanInput, mode: ObliqueMode): ObliquePacking {
  const previous = input.previous?.frozen;
  if (previous instanceof ObliquePacking && previous.mode === mode) {
    const packing = copyPacking(previous);
    growPacking(packing, input);
    return packing;
  }
  const packing = new ObliquePacking(mode);
  const hosts =
    input.partition.hosts.length > 0
      ? input.partition.hosts
      : [{ hostId: null, hqAgentId: null, teams: [], solos: [] }];
  for (const host of hosts) addBuilding(packing, host, input);
  return packing;
}
function dimensions(packing: ObliquePacking): OfficeSize {
  return {
    width: Math.max(
      1,
      ...packing.buildings.map((building) => building.col + building.width),
    ),
    height: Math.max(
      1,
      ...packing.buildings.map(
        (building) => building.plazaRow + 6 + building.quietRows * 2,
      ),
    ),
  };
}

interface Geometry {
  readonly floors: OfficeFloor[];
  readonly seats: Map<string, OfficeSeat>;
  readonly desks: Map<string, OfficeDesk>;
  readonly rooms: OfficeRoom[];
  readonly signs: OfficeSign[];
  readonly props: OfficeProp[];
  readonly walkable: boolean[][];
}
function prop(
  geometry: Geometry,
  name: OfficeSpriteName,
  col: number,
  row: number,
): void {
  geometry.props.push({ sprite: { name }, tile: { col, row } });
}
function walk(geometry: Geometry, col: number, row: number): void {
  geometry.walkable[row][col] = true;
}
function sign(geometry: Geometry, value: OfficeSign): void {
  geometry.signs.push(value);
}
interface SpotPlacement {
  readonly kind: OfficeErrandKind;
  readonly fixtureId: string;
  readonly tile: OfficeTilePos;
  readonly actionTile: OfficeTilePos;
  readonly facing: OfficeFacing;
  readonly floorIndex: number;
}
function spot(placement: SpotPlacement): OfficeErrandSpot {
  return {
    ...placement,
    approachTile: placement.tile,
    audience: { kind: placement.kind === "whiteboard" ? "leads" : "floor" },
  };
}
function plazaProps(
  geometry: Geometry,
  building: Building,
  floorIndex: number,
): OfficeErrandSpot[] {
  const spots: OfficeErrandSpot[] = [];
  const row = building.plazaRow;
  const start = building.col + 4;
  const fixtures: ReadonlyArray<
    readonly [OfficeSpriteName, OfficeErrandKind, number]
  > = [
    ["cafe-table", "cafe", 2],
    ["cafe-table", "cafe", 2],
    ["coffee-machine", "coffee", 1],
    ["sofa", "sofa", 2],
    ["pingpong-table", "pingpong", 2],
    ["sleep-bag", "nap", 1],
    ["sleep-bag", "nap", 1],
    ["armchair", "read", 1],
    ["treadmill", "treadmill", 1],
    ["water-cooler", "cooler", 1],
    ["plant", "water-plant", 1],
  ];
  let col = start;
  for (const [i, [name, kind, width]] of fixtures.entries()) {
    const tile = { col, row: row + (kind === "pingpong" ? 3 : 1) };
    prop(geometry, name, tile.col, tile.row);
    for (let dx = 0; dx < width; dx += 1)
      geometry.walkable[tile.row][tile.col + dx] = false;
    const id = `${hostKey(building.hostId)}/plaza/${i}`;
    if (kind === "pingpong") {
      spots.push(
        spot({
          kind: kind,
          fixtureId: id,
          tile: { col: col - 1, row: tile.row },
          actionTile: tile,
          facing: "right",
          floorIndex: floorIndex,
        }),
        spot({
          kind: kind,
          fixtureId: id,
          tile: { col: col + width, row: tile.row },
          actionTile: tile,
          facing: "left",
          floorIndex: floorIndex,
        }),
      );
    } else {
      spots.push(
        spot({
          kind: kind,
          fixtureId: id,
          tile: { col: col, row: row + 2 },
          actionTile: tile,
          facing: "up",
          floorIndex: floorIndex,
        }),
      );
      if (kind === "cafe")
        spots.push(
          spot({
            kind: kind,
            fixtureId: id,
            tile: { col: col + 1, row: row + 2 },
            actionTile: tile,
            facing: "up",
            floorIndex: floorIndex,
          }),
        );
    }
    if (kind === "read") prop(geometry, "bookcase", col, row);
    col += width;
  }
  // Every additional wing gets two tables and two nap spots, each a fixture.
  for (let wing = 1; wing < building.wings; wing += 1) {
    for (let i = 0; i < 4; i += 1) {
      const tile = { col: start + wing * 23 + i * 3, row: row + 1 };
      if (tile.col + 2 >= building.col + building.width) continue;
      const kind = i < 2 ? "cafe" : "nap";
      prop(
        geometry,
        kind === "cafe" ? "cafe-table" : "sleep-bag",
        tile.col,
        tile.row,
      );
      geometry.walkable[tile.row][tile.col] = false;
      if (kind === "cafe") geometry.walkable[tile.row][tile.col + 1] = false;
      spots.push(
        spot({
          kind: kind,
          fixtureId: `${hostKey(building.hostId)}/plaza/wing-${wing}/${i}`,
          tile: { col: tile.col, row: row + 2 },
          actionTile: tile,
          facing: "up",
          floorIndex: floorIndex,
        }),
      );
    }
  }
  prop(geometry, "reception", building.col + 3, row + 3);
  geometry.walkable[row + 3][building.col + 3] = false;
  geometry.walkable[row + 3][building.col + 4] = false;
  return spots;
}
function floorFor(
  building: Building,
  bounds: OfficeTileRect,
  corridorTiles: OfficeTilePos[],
  errandSpots: OfficeErrandSpot[],
): OfficeFloor {
  return {
    hostId: building.hostId,
    bounds,
    doorTile: { col: building.col + 1, row: building.plazaRow + 4 },
    lobbyTile: { col: building.col + 2, row: building.plazaRow + 3 },
    receptionTile: { col: building.col + 3, row: building.plazaRow + 3 },
    receptionQueueTiles: [0, 1, 2].map((i) => ({
      col: building.col + 6 + i,
      row: building.plazaRow + 4,
    })),
    queueFacing: "down",
    corridorTiles,
    clockTile: { col: building.col + 2, row: bounds.row },
    stairsTile: { col: building.col + 1, row: bounds.row },
    errandSpots,
    cafeteria: null,
    gameRoom: null,
    areaSigns: [],
    amenities: [],
  };
}
function paintStairs(
  packing: ObliquePacking,
  geometry: Geometry,
  building: Building,
  bottom: number,
): void {
  // The stairwell alone links storeys. Tower stairwells join on their plaza.
  for (let wing = 0; wing < building.wings; wing += 1) {
    if (packing.mode === "building" && wing > 0) continue;
    const col = building.col + wing * wingStep(packing.mode) + 1;
    for (let row = 2; row < bottom; row += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        walk(geometry, col + dx, row);
        prop(geometry, "stairs-side", col + dx, row);
      }
    }
  }
}
function paintBuilding(
  packing: ObliquePacking,
  geometry: Geometry,
  building: Building,
): void {
  const bottom = building.plazaRow + 5 + building.quietRows * 2;
  for (let row = 0; row <= bottom; row += 1) {
    for (
      let col = building.col;
      col < building.col + building.width;
      col += 1
    ) {
      let name: OfficeSpriteName = "face";
      if (row < 2) name = "roof-edge";
      else if (row === bottom) name = "slab";
      else if (row >= building.plazaRow && row < building.plazaRow + 5) {
        name = "floor-a";
        if (col > building.col && col < building.col + building.width - 1)
          walk(geometry, col, row);
      }
      prop(geometry, name, col, row);
    }
  }
  paintStairs(packing, geometry, building, bottom);
  prop(geometry, "door", building.col + 1, building.plazaRow + 4);
  sign(geometry, {
    kind: "host",
    tile: { col: building.col, row: bottom },
    widthTiles: building.width,
    text: "",
    ownerAgentId: null,
    hostId: building.hostId,
    agentIds: [],
  });
  sign(geometry, {
    kind: "area",
    tile: { col: building.col + 3, row: building.plazaRow },
    widthTiles: building.width - 4,
    text: "Plaza",
    ownerAgentId: null,
    hostId: building.hostId,
    agentIds: [],
  });
}
function paintStructure(packing: ObliquePacking, geometry: Geometry): void {
  for (const building of packing.buildings) {
    paintBuilding(packing, geometry, building);
  }
  if (packing.mode !== "building") return;
  for (let i = 1; i < packing.buildings.length; i += 1) {
    const left = packing.buildings[i - 1];
    const right = packing.buildings[i];
    const hq = packing.storeys.find(
      (storey) => storey.building === i - 1 && storey.kind === "hq",
    );
    const row = (hq?.row ?? 2) + 3;
    for (let col = left.col + left.width - 1; col <= right.col + 1; col += 1) {
      walk(geometry, col, row);
      prop(geometry, "skybridge", col, row);
    }
  }
}
interface StoreyLocation {
  readonly building: Building;
  readonly left: number;
  readonly quiet: boolean;
  readonly plaza: boolean;
  readonly bounds: OfficeTileRect;
  readonly aisle: number;
}
interface PlanContext {
  readonly packing: ObliquePacking;
  readonly input: OfficePlanInput;
  readonly geometry: Geometry;
  readonly agents: ReadonlyMap<string, OfficeAgentInput>;
  readonly assigned: ReadonlyMap<string, string>;
  readonly plazas: ReadonlyMap<number, ReadonlyArray<OfficeErrandSpot>>;
}
function storeyLocation(
  packing: ObliquePacking,
  storey: Storey,
): StoreyLocation {
  const building = packing.buildings[storey.building];
  const left = wingCol(packing, building, storey.wing);
  const quiet = storey.kind === "quiet";
  const plaza = storey.kind === "plaza";
  let rows = 4;
  if (plaza) rows = 5;
  else if (quiet) rows = 2;
  const bounds = {
    col: plaza || quiet ? building.col : left - 2,
    row: storey.row,
    cols: plaza || quiet ? building.width : 24,
    rows,
  };
  return { building, left, quiet, plaza, bounds, aisle: storey.row + rows - 1 };
}
function paintAisle(
  context: PlanContext,
  location: StoreyLocation,
): OfficeTilePos[] {
  const { packing, geometry } = context;
  const { building, left, quiet, plaza, bounds, aisle } = location;
  const corridors: OfficeTilePos[] = [];
  if (plaza) {
    // Beyond the door and reception queue, the plaza has its own stroll lane.
    for (
      let col = building.col + 10;
      col < building.col + building.width - 1;
      col += 1
    ) {
      corridors.push({ col, row: aisle });
    }
  }
  if (!plaza) {
    const start =
      packing.mode === "building" || quiet ? building.col + 1 : left - 2;
    const end = quiet ? building.col + building.width - 1 : left + 22;
    for (let col = start; col < end; col += 1) {
      walk(geometry, col, aisle);
      prop(geometry, "slab", col, aisle);
      if (col >= bounds.col) corridors.push({ col, row: aisle });
    }
  }
  return corridors;
}
function paintStoreySpots(
  context: PlanContext,
  storey: Storey,
  location: StoreyLocation,
): OfficeErrandSpot[] {
  const { geometry, input, plazas } = context;
  const { building, left, quiet, plaza, aisle } = location;
  const canonicalSpots = plazas.get(storey.building) ?? [];
  const spots = quiet
    ? []
    : canonicalSpots.map((item) => ({ ...item, floorIndex: storey.id }));
  if (!quiet && !plaza) {
    const action = { col: left + 21, row: storey.row + 1 };
    prop(geometry, "coffee-machine", action.col, action.row);
    spots.push(
      spot({
        kind: "coffee",
        fixtureId: `${hostKey(building.hostId)}/${storey.id}/coffee`,
        tile: { col: left + 21, row: aisle },
        actionTile: action,
        facing: "up",
        floorIndex: storey.id,
      }),
    );
    for (let col = left; col < left + 22; col += 4)
      prop(geometry, "window", col, storey.row);
    if (storey.kind === "hq" && storey.wing === 0) {
      const owner = storey.rooms[0]?.lead ?? null;
      const ids = input.agents
        .filter((agent) => agent.hostId === building.hostId)
        .map((agent) => agent.id);
      sign(geometry, {
        kind: "hq-board",
        tile: { col: left + 10, row: storey.row },
        widthTiles: 8,
        text: "HQ",
        ownerAgentId: owner,
        hostId: building.hostId,
        agentIds: ids,
      });
      prop(geometry, "whiteboard", left + 10, storey.row);
      for (let i = 0; i < 3; i += 1)
        spots.push(
          spot({
            kind: "whiteboard",
            fixtureId: `${hostKey(building.hostId)}/hq-board`,
            tile: { col: left + 10 + i, row: aisle },
            actionTile: { col: left + 10, row: storey.row },
            facing: "up",
            floorIndex: storey.id,
          }),
        );
    }
  }
  return spots;
}
function materializeSeats(
  context: PlanContext,
  storey: Storey,
  location: StoreyLocation,
): void {
  const { geometry, assigned, agents } = context;
  const { building, quiet } = location;
  for (const slot of storey.slots) {
    const agentId = assigned.get(slot.id);
    const seat: OfficeSeat = {
      seatId: slot.id,
      kind: quiet ? "cubby" : "desk",
      deskTile: { col: slot.col, row: storey.row + (quiet ? 0 : 1) },
      chairTile: { col: slot.col, row: storey.row + (quiet ? 0 : 2) },
      facing: "down",
      hitTiles: { width: quiet ? 1 : 2, height: quiet ? 1 : 2 },
      floorIndex: storey.id,
      roomId: slot.room,
      hostId: building.hostId,
      manager: slot.manager,
    };
    if (agentId !== undefined && agents.has(agentId)) {
      const desk = { ...seat, agentId };
      geometry.seats.set(slot.id, desk);
      geometry.desks.set(agentId, desk);
    } else geometry.seats.set(slot.id, seat);
  }
}
function roomText(
  mode: ObliqueMode,
  solo: boolean,
  count: number,
  name: string,
): string {
  if (!solo) return name;
  return mode === "towers" ? "Solo desks" : `Bullpen · ${count} live solos`;
}
function materializeRooms(
  context: PlanContext,
  storey: Storey,
  location: StoreyLocation,
): void {
  const { packing, geometry, agents, assigned } = context;
  const { building, left, aisle } = location;
  for (const room of storey.rooms) {
    const slots = storey.slots.filter((slot) => slot.room === room.id);
    if (slots.length === 0) continue;
    const col = slots[0].col;
    const cols = slots[slots.length - 1].col + 2 - col;
    const owner =
      room.lead !== null && agents.has(room.lead) ? room.lead : null;
    const members = slots.flatMap((slot) => {
      const id = assigned.get(slot.id);
      return id === undefined ? [] : [id];
    });
    const text = roomText(
      packing.mode,
      room.solo,
      members.length,
      agents.get(owner ?? "")?.name ?? "Team",
    );
    geometry.rooms.push({
      rootAgentId: room.id,
      name: text,
      bounds: { col, row: storey.row, cols, rows: 3 },
      doorTile: { col, row: aisle },
      signTile: { col, row: storey.row },
      pods: [],
      visitTile: { col, row: aisle },
    });
    sign(geometry, {
      kind: "plate",
      tile: { col, row: storey.row },
      widthTiles: cols,
      text: text,
      ownerAgentId: owner,
      hostId: building.hostId,
      agentIds: members,
    });
    sign(geometry, {
      kind: "board",
      tile: { col: col + cols - 1, row: storey.row },
      widthTiles: 1,
      text: "",
      ownerAgentId: owner,
      hostId: building.hostId,
      agentIds: members,
    });
    prop(geometry, "board", col + cols - 1, storey.row);
    if (
      col + cols < left + 21 &&
      !storey.slots.some((slot) => slot.col === col + cols)
    ) {
      prop(geometry, "partition", col + cols, storey.row + 1);
    }
  }
}
function materializeStorey(context: PlanContext, storey: Storey): void {
  const { packing, geometry } = context;
  const location = storeyLocation(packing, storey);
  const { building, bounds } = location;
  const corridors = paintAisle(context, location);
  const spots = paintStoreySpots(context, storey, location);
  materializeSeats(context, storey, location);
  materializeRooms(context, storey, location);
  const spotTiles = new Set(
    spots.map((item) => `${item.tile.col}/${item.tile.row}`),
  );
  geometry.floors.push(
    floorFor(
      building,
      bounds,
      corridors.filter((tile) => !spotTiles.has(`${tile.col}/${tile.row}`)),
      spots,
    ),
  );
}
function aliasHqBoards(packing: ObliquePacking, geometry: Geometry): void {
  for (const storey of packing.storeys) {
    if (storey.kind !== "live") continue;
    const hq = packing.storeys.find(
      (candidate) =>
        candidate.building === storey.building &&
        candidate.kind === "hq" &&
        candidate.wing === 0,
    );
    if (hq === undefined) continue;
    const aliases = geometry.floors[hq.id].errandSpots
      .filter((item) => item.kind === "whiteboard")
      .map((item) => ({ ...item, floorIndex: storey.id }));
    const floor = geometry.floors[storey.id];
    geometry.floors[storey.id] = {
      ...floor,
      errandSpots: [...floor.errandSpots, ...aliases],
    };
  }
}
function materialize(
  packing: ObliquePacking,
  input: OfficePlanInput,
): OfficeLayout {
  const size = dimensions(packing);
  const geometry: Geometry = {
    floors: [],
    seats: new Map(),
    desks: new Map(),
    rooms: [],
    signs: [],
    props: [],
    walkable: Array.from({ length: size.height }, () =>
      Array<boolean>(size.width).fill(false),
    ),
  };
  const agents = new Map(input.agents.map((agent) => [agent.id, agent]));
  const assigned = new Map(
    Array.from(packing.assignment, ([agentId, seatId]) => [seatId, agentId]),
  );
  paintStructure(packing, geometry);
  const plazas = new Map<number, OfficeErrandSpot[]>();
  for (const storey of packing.storeys) {
    if (storey.kind === "plaza")
      plazas.set(
        storey.building,
        plazaProps(geometry, packing.buildings[storey.building], storey.id),
      );
  }
  const context: PlanContext = {
    packing,
    input,
    geometry,
    agents,
    assigned,
    plazas,
  };
  for (const storey of packing.storeys) materializeStorey(context, storey);
  aliasHqBoards(packing, geometry);

  return {
    view: packing.mode,
    cols: size.width,
    rows: size.height,
    desks: geometry.desks,
    seats: geometry.seats,
    signs: geometry.signs,
    rooms: geometry.rooms,
    floors: geometry.floors,
    doorTile: geometry.floors[0].doorTile,
    lobbyTile: geometry.floors[0].lobbyTile,
    props: geometry.props,
    walkable: geometry.walkable,
    frozen: packing,
    shiftFromPrevious:
      packing.shift === 0 ? null : { col: 0, row: packing.shift },
    stable: true,
  };
}
export function planTowers(input: OfficePlanInput): OfficeLayout {
  return materialize(recipe(input, "towers"), input);
}
export function planBuilding(input: OfficePlanInput): OfficeLayout {
  return materialize(recipe(input, "building"), input);
}
function measure(input: OfficePlanInput, mode: ObliqueMode): OfficeSize {
  // Auto measures fresh inputs: count room runs and cubby rows, without
  // allocating seats, signs, props, a walkability mask or a layout.
  if (input.previous !== null) {
    const size = dimensions(recipe(input, mode));
    return {
      width: size.width * OFFICE_TILE,
      height: size.height * OFFICE_TILE,
    };
  }
  let width = 0;
  let height = 0;
  let previousWings: number | null = null;
  const hosts =
    input.partition.hosts.length > 0
      ? input.partition.hosts
      : [{ hostId: null, hqAgentId: null, teams: [], solos: [] }];
  for (const host of hosts) {
    const bins = packRooms(initialRooms(host, mode)).length;
    const quiet = quietIds(host, mode).length;
    const maximum =
      mode === "towers" ? Math.max(1, Math.ceil(Math.sqrt(bins + 1))) : 4;
    const wings = chooseWings(mode, {
      bins: bins,
      quiet: quiet,
      viewport: input.viewport,
      maxWings:
        previousWings === null ? maximum : Math.min(maximum, previousWings),
    });
    width += buildingWidth(mode, wings) + (previousWings === null ? 0 : 4);
    height = Math.max(
      height,
      12 +
        4 * (Math.ceil(bins / wings) + 1) +
        2 * Math.ceil(quiet / (22 * wings)),
    );
    previousWings = wings;
  }
  return { width: width * OFFICE_TILE, height: height * OFFICE_TILE };
}
export function measureTowers(input: OfficePlanInput): OfficeSize {
  return measure(input, "towers");
}
export function measureBuilding(input: OfficePlanInput): OfficeSize {
  return measure(input, "building");
}
export const TOWERS_VIEW: OfficeView = {
  id: "towers",
  label: "Towers",
  description: "Every agent at a desk, in teams across compact towers.",
  plan: planTowers,
  measure: measureTowers,
  painter: OBLIQUE_PAINTER,
};
export const BUILDING_VIEW: OfficeView = {
  id: "building",
  label: "Building",
  description: "Live teams at desks, quiet agents in a compact cubby stack.",
  plan: planBuilding,
  measure: measureBuilding,
  painter: OBLIQUE_PAINTER,
};
