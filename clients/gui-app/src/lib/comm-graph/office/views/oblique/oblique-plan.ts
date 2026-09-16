/** Shared tile arithmetic for the two append-stable oblique offices. */
import type {
  OfficeHostPopulation,
  OfficePopulationMember,
} from "@/lib/comm-graph/office/office-population";
import {
  ARCHIVE_SIGN_WIDTH_TILES,
  civicCapacityFor,
} from "@/lib/comm-graph/office/office-layout";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import type {
  OfficeAgentInput,
  OfficeCivicKind,
  OfficeCivicRoom,
  OfficeDesk,
  OfficeErrandKind,
  OfficeErrandSpot,
  OfficeFacing,
  OfficeFloor,
  OfficeLayout,
  OfficeProp,
  OfficeRoad,
  OfficeRoom,
  OfficeSeat,
  OfficeSign,
  OfficeSignRungs,
  OfficeSize,
  OfficeSpriteName,
  OfficeTilePos,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import type { OfficePlanInput, OfficeView } from "../office-view";
import { OBLIQUE_FIXTURES, OBLIQUE_PAINTER } from "./oblique-painter";

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
interface IndexedObliqueProp {
  readonly prop: OfficeProp;
  readonly order: number;
}
/** No previous layout is retained: a fresh, private recipe is copied each run. */
class ObliquePacking {
  readonly mode: ObliqueMode;
  readonly propsByTile: Map<string, IndexedObliqueProp[]>;
  propMargin: OfficeSize;
  readonly buildings: Building[];
  readonly storeys: Storey[];
  readonly assignment: Map<string, string>;
  readonly cubby: Map<string, boolean>;
  shift: number;
  /**
   * Which seat speaks for each storey's empty desks, built on first ask.
   *
   * Derived from `assignment`, which is settled by the time anything can ask:
   * a packing is frozen into the layout it produced, and growth clones it into
   * a fresh one rather than editing this. Cached because the question is put
   * once per empty desk on screen and its answer is a fact about the storey.
   */
  reserveLabels: Map<number, string> | null;
  constructor(mode: ObliqueMode) {
    this.mode = mode;
    this.propsByTile = new Map();
    this.propMargin = { width: 0, height: 0 };
    this.buildings = [];
    this.storeys = [];
    this.assignment = new Map();
    this.cubby = new Map();
    this.shift = 0;
    this.reserveLabels = null;
  }
}

function indexProps(
  packing: ObliquePacking,
  props: ReadonlyArray<OfficeProp>,
): void {
  let width = 0;
  let height = 0;
  for (const [order, prop] of props.entries()) {
    const key = `${prop.tile.col}/${prop.tile.row}`;
    const indexed = { prop, order };
    const bucket = packing.propsByTile.get(key);
    if (bucket === undefined) packing.propsByTile.set(key, [indexed]);
    else bucket.push(indexed);
    const size = officeSpriteSize(prop.sprite);
    width = Math.max(width, size.width);
    height = Math.max(height, size.height);
  }
  packing.propMargin = {
    width: Math.ceil(width / OFFICE_TILE),
    height: Math.ceil(height / OFFICE_TILE),
  };
}
/** Read only the requested area, including sprites anchored before its edge. */
export function obliquePropsIn(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): ReadonlyArray<OfficeProp> {
  const packing = layout.frozen;
  if (
    !(packing instanceof ObliquePacking) ||
    tiles.cols <= 0 ||
    tiles.rows <= 0
  )
    return [];
  const found: IndexedObliqueProp[] = [];
  for (
    let row = Math.max(
      0,
      Math.floor(tiles.row) - packing.propMargin.height + 1,
    );
    row < Math.ceil(tiles.row + tiles.rows);
    row += 1
  ) {
    for (
      let col = Math.max(
        0,
        Math.floor(tiles.col) - packing.propMargin.width + 1,
      );
      col < Math.ceil(tiles.col + tiles.cols);
      col += 1
    ) {
      found.push(...(packing.propsByTile.get(`${col}/${row}`) ?? []));
    }
  }
  return found
    .filter(({ prop }) => {
      const size = officeSpriteSize(prop.sprite);
      return (
        prop.tile.col < tiles.col + tiles.cols &&
        prop.tile.col + size.width / OFFICE_TILE > tiles.col &&
        prop.tile.row < tiles.row + tiles.rows &&
        prop.tile.row + size.height / OFFICE_TILE > tiles.row
      );
    })
    .sort((left, right) => left.order - right.order)
    .map((item) => item.prop);
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
interface ArrivalSeat {
  readonly storey: Storey;
  readonly slotIndex: number;
  readonly slot: Slot;
  taken: boolean;
}

/** Queues retain packing order; removing a seat from another queue is lazy. */
class ArrivalSeatQueue {
  private readonly seats: ArrivalSeat[] = [];
  private cursor = 0;

  add(seat: ArrivalSeat): void {
    this.seats.push(seat);
  }

  take(): ArrivalSeat | undefined {
    while (this.cursor < this.seats.length) {
      const seat = this.seats[this.cursor];
      this.cursor += 1;
      if (!seat.taken) return seat;
    }
    return undefined;
  }
}

/** Transient batch indexes: nothing here is retained in the frozen recipe. */
class ArrivalSeats {
  private readonly packing: ObliquePacking;
  private readonly occupancy: ReadonlyMap<string, string>;
  private readonly buildingIndex: number;
  private readonly assigned: Set<string>;
  private readonly leadsByRoom = new Map<string, Set<string | null>>();
  private readonly byLead = new Map<string | null, ArrivalSeatQueue>();
  private readonly all = new ArrivalSeatQueue();
  private readonly plain = new ArrivalSeatQueue();
  private nextStorey = 0;
  private freeCount = 0;

  constructor(
    packing: ObliquePacking,
    input: OfficePlanInput,
    buildingIndex: number,
  ) {
    this.packing = packing;
    this.occupancy = input.occupancy;
    this.buildingIndex = buildingIndex;
    this.assigned = new Set(packing.assignment.values());
    for (const storey of packing.storeys) {
      for (const room of storey.rooms) this.indexRoom(room);
    }
    this.indexNewStoreys();
  }

  get availableCount(): number {
    return this.freeCount;
  }

  grow(): void {
    growLive(this.packing);
    this.indexNewStoreys();
  }

  assign(member: OfficePopulationMember): void {
    if (this.freeCount === 0) this.grow();
    const seat =
      this.byLead.get(member.teamId)?.take() ??
      this.plain.take() ??
      this.all.take();
    if (seat === undefined) return;
    seat.taken = true;
    this.freeCount -= 1;
    this.assigned.add(seat.slot.id);
    this.packing.assignment.set(member.agentId, seat.slot.id);
    if (seat.slot.room !== null) return;
    const room: RoomRun = {
      id: `${seat.slot.id}/arrival`,
      lead: member.teamId ?? member.agentId,
      solo: member.agentClass === "solo",
      agents: [member.agentId],
      capacity: 1,
    };
    seat.storey.rooms.push(room);
    seat.storey.slots[seat.slotIndex] = { ...seat.slot, room: room.id };
    // This new room contains only the seat just taken, so no free queue gains it.
    this.indexRoom(room);
  }

  private indexRoom(room: RoomRun): void {
    const leads = this.leadsByRoom.get(room.id);
    if (leads === undefined)
      this.leadsByRoom.set(room.id, new Set([room.lead]));
    else leads.add(room.lead);
  }

  private indexNewStoreys(): void {
    while (this.nextStorey < this.packing.storeys.length) {
      const storey = this.packing.storeys[this.nextStorey];
      this.nextStorey += 1;
      if (
        storey.building !== this.buildingIndex ||
        (storey.kind !== "live" && storey.kind !== "hq")
      )
        continue;
      for (const [slotIndex, slot] of storey.slots.entries()) {
        this.indexSlot(storey, slotIndex, slot);
      }
    }
  }

  private indexSlot(storey: Storey, slotIndex: number, slot: Slot): void {
    if (this.assigned.has(slot.id) || this.occupancy.has(slot.id)) return;
    const seat: ArrivalSeat = { storey, slotIndex, slot, taken: false };
    this.all.add(seat);
    this.freeCount += 1;
    if (slot.room === null) {
      this.plain.add(seat);
      return;
    }
    for (const lead of this.leadsByRoom.get(slot.room) ?? []) {
      let queue = this.byLead.get(lead);
      if (queue === undefined) {
        queue = new ArrivalSeatQueue();
        this.byLead.set(lead, queue);
      }
      queue.add(seat);
    }
  }
}

function growPacking(packing: ObliquePacking, input: OfficePlanInput): void {
  const present = new Set(input.agents.map((agent) => agent.id));
  for (const id of packing.assignment.keys()) {
    if (!present.has(id)) {
      packing.assignment.delete(id);
      packing.cubby.delete(id);
    }
  }
  const buildingIndexByHost = new Map(
    packing.buildings.map((building, index) => [building.hostId, index]),
  );
  for (const host of input.partition.hosts) {
    const index = buildingIndexByHost.get(host.hostId);
    if (index === undefined) {
      const addedIndex = packing.buildings.length;
      addBuilding(packing, host, input);
      buildingIndexByHost.set(host.hostId, addedIndex);
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
  const arrivals = new ArrivalSeats(packing, input, index);
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
    arrivals.assign(member);
  }
  const shortage = input.needsCapacity.filter(
    (id) => input.partition.members.get(id)?.hostId === host.hostId,
  ).length;
  while (arrivals.availableCount < shortage) arrivals.grow();
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
/**
 * Lettering that names a host, an area, a room plate or a board - everything
 * this view writes except a civic plate, which `civicSign` writes instead
 * because it is the one kind that carries a room id.
 */
type ObliqueSign = Omit<OfficeSign, "civicRoomId">;

function sign(geometry: Geometry, value: ObliqueSign): void {
  geometry.signs.push({ ...value, civicRoomId: null });
}
/**
 * A civic plate names its ROOM rather than an agent, so it is always drawn, and
 * it carries the room's id so that a counter can be read off the room under the
 * cursor instead of being baked into the text at plan time.
 *
 * Each of the four rooms hangs its plate at its own top-left corner and takes
 * its own width, which is what keeps the four off each other on the one storey
 * they share: the ward's is the only plate on the plaza's top row, and the
 * other three sit on the front walk, columns apart.
 *
 * THE ARCHIVE IS THE EXCEPTION, because it is a door and not a room: its span is
 * one tile, which holds no word. It takes `ARCHIVE_SIGN_WIDTH_TILES` and runs
 * RIGHTWARDS from the door along the wall row - rightwards because the door is in
 * the near outer wall at `building.col` and there is no wall to the left of it.
 */
function civicSign(geometry: Geometry, room: OfficeCivicRoom): void {
  geometry.signs.push({
    kind: "civic",
    tile: room.signTile,
    widthTiles:
      room.kind === "archive" ? ARCHIVE_SIGN_WIDTH_TILES : room.bounds.cols,
    text: room.name,
    ownerAgentId: null,
    hostId: room.hostId,
    agentIds: [],
    civicRoomId: room.civicRoomId,
  });
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
    // Nothing this view sets an errand at is also a seat; see `seatId`.
    seatId: null,
    audience: { kind: placement.kind === "whiteboard" ? "leads" : "floor" },
  };
}
function placeFixture(
  geometry: Geometry,
  kind: OfficeErrandKind,
  tile: OfficeTilePos,
): void {
  for (const part of OBLIQUE_FIXTURES[kind] ?? []) {
    prop(geometry, part.name, tile.col + part.col, tile.row + part.row);
  }
}
/**
 * The amenities along wing 0's plaza, in the order they are laid.
 *
 * Hoisted out of `plazaProps` because the civic bay is placed PAST them and has
 * to know where they stop without laying them a second time.
 */
const PLAZA_FIXTURES: ReadonlyArray<readonly [OfficeErrandKind, number]> = [
  ["cafe", 2],
  ["cafe", 2],
  ["coffee", 1],
  ["sofa", 2],
  ["pingpong", 2],
  ["nap", 1],
  ["nap", 1],
  ["read", 1],
  ["treadmill", 1],
  ["cooler", 1],
  ["water-plant", 1],
];
/** What every wing after the first adds: two tables and two nap spots. */
const PLAZA_WING_FIXTURES: ReadonlyArray<readonly [OfficeErrandKind, number]> =
  [
    ["cafe", 2],
    ["cafe", 2],
    ["nap", 1],
    ["nap", 1],
  ];
const PLAZA_FIXTURE_COL = 4;
const PLAZA_WING_STEP = 23;
const PLAZA_WING_PITCH = 3;
/** A team board letters its own single tile, the one its art stands on. */
const BOARD_PLATE_TILES = 1;
/**
 * The narrowest plate a NAME survives on. One tile is 25.6 px at close-up and a
 * six-character name measures 48.8, so the ladder answers with initials there -
 * a reading that looks like a different agent rather than like a short one.
 */
const PLATE_MIN_TILES = 2;
const RECEPTION_COL = 3;
const RECEPTION_WIDTH_TILES = 2;

function plazaProps(
  geometry: Geometry,
  building: Building,
  floorIndex: number,
): OfficeErrandSpot[] {
  const spots: OfficeErrandSpot[] = [];
  const row = building.plazaRow;
  const start = building.col + PLAZA_FIXTURE_COL;
  let col = start;
  for (const [i, [kind, width]] of PLAZA_FIXTURES.entries()) {
    const tile = { col, row: row + (kind === "pingpong" ? 3 : 1) };
    placeFixture(geometry, kind, tile);
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
    col += width;
  }
  // Every additional wing gets two tables and two nap spots, each a fixture.
  for (let wing = 1; wing < building.wings; wing += 1) {
    for (const [i, [kind, width]] of PLAZA_WING_FIXTURES.entries()) {
      const tile = {
        col: start + wing * PLAZA_WING_STEP + i * PLAZA_WING_PITCH,
        row: row + 1,
      };
      if (tile.col + 2 >= building.col + building.width) continue;
      placeFixture(geometry, kind, tile);
      for (let dx = 0; dx < width; dx += 1)
        geometry.walkable[tile.row][tile.col + dx] = false;
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
  prop(geometry, "reception", building.col + RECEPTION_COL, row + 3);
  for (let dx = 0; dx < RECEPTION_WIDTH_TILES; dx += 1)
    geometry.walkable[row + 3][building.col + RECEPTION_COL + dx] = false;
  return spots;
}

// ---- The plaza's civic rooms ------------------------------------------- //
//
// A HOST'S FOUR CIVIC ROOMS ARE PHYSICAL, so it has one of each, and they live
// on its PLAZA storey: the only storey with a way in from outside, and the only
// one a vehicle can reach. Every other storey carries `civic: []` and
// `road: null`. An agent that crashes on storey seven walks down to these beds
// the one way this view joins storeys at all, which is the stairwell.

/** How many of the plaza band's five rows the bay takes: all but the lane. */
const PLAZA_BAY_ROWS = 4;
/** Its screen's column apart, the narrowest ward that still holds two beds. */
const PLAZA_BAY_MIN_COLS = 3;
/** The bay's front walk, and so the row its door stands in. */
const PLAZA_BAY_DOOR_ROW = 3;
const BED_WIDTH_TILES = 2;
/** Beds on the bay's first and third rows, so each row has a clear one under it. */
const PLAZA_BED_ROWS: ReadonlyArray<number> = [0, 2];
/** Where the chair run starts: one clear tile past the pingpong's right spot. */
const PLAZA_LOUNGE_COL = 14;
/** The plaza's aisle row, which is also its street. */
const PLAZA_ROAD_ROW = 4;

/** The last column any plaza amenity occupies, every wing's counted. */
function plazaFixturesEnd(building: Building): number {
  const start = building.col + PLAZA_FIXTURE_COL;
  let end = start - 1;
  for (const [, width] of PLAZA_FIXTURES) end += width;
  for (let wing = 1; wing < building.wings; wing += 1) {
    for (const [i, [, width]] of PLAZA_WING_FIXTURES.entries()) {
      const col = start + wing * PLAZA_WING_STEP + i * PLAZA_WING_PITCH;
      // The wing loop's own clipping guard, so a fixture this building is too
      // narrow to hold does not push the bay off the end of the plaza.
      if (col + 2 >= building.col + building.width) continue;
      end = Math.max(end, col + width - 1);
    }
  }
  return end;
}

/**
 * The screened bay at the plaza's far end: everything past the last wing's
 * amenities, out to the inside face of the right-hand wall.
 *
 * PAST THE AMENITIES RATHER THAN AT A FIXED COLUMN, which is what makes this
 * ward a parameter instead of a fixed room: one wing leaves it six columns and
 * four beds, and every wing after that leaves it room for the formula's eight.
 * The clamp is an invariant rather than a branch - the guard above already
 * keeps three columns clear - but a ward with nowhere to put two beds is not a
 * ward, so it is written down instead of assumed.
 */
function plazaBay(building: Building): OfficeTileRect {
  const wall = building.col + building.width - 1;
  const col = Math.min(
    plazaFixturesEnd(building) + 1,
    wall - PLAZA_BAY_MIN_COLS,
  );
  return {
    col,
    row: building.plazaRow,
    cols: wall - col,
    rows: PLAZA_BAY_ROWS,
  };
}

/**
 * The lane along the plaza's front: the aisle row, wall to wall.
 *
 * This view's lobby row, used exactly as the Floor's is - the entrance stands
 * on it, the reception queue forms on it, and the stroll lane runs along it -
 * so it is the row a vehicle pulls up on. Drawn, never searched: the queue
 * standing on it is people to drive past, not a wall to route around.
 *
 * ONE ROAD PER BUILDING, entered from that building's own four-column gap
 * rather than from the world's left edge, so two hosts never share a kerb. It
 * runs one way across the plaza and out the other side: a vehicle passes every
 * kerb on it without ever turning back along its own tiles.
 */
function plazaRoad(building: Building): OfficeRoad {
  const row = building.plazaRow + PLAZA_ROAD_ROW;
  const tiles: OfficeTilePos[] = [];
  for (let col = building.col; col < building.col + building.width; col += 1)
    tiles.push({ col, row });
  return { entryTile: tiles[0], tiles, exitTile: tiles[tiles.length - 1] };
}

/**
 * The road tile a door in this column opens straight onto - the tile one step
 * out, because every civic door in this view stands on the row above the lane.
 *
 * The fallback cannot fire for a door inside the building, and it is deliberate
 * that it returns a tile the adjacency case will reject rather than a plausible
 * one: a kerb that stopped being next to its door should fail loudly.
 */
function kerbBelow(road: OfficeRoad, col: number): OfficeTilePos {
  return road.tiles.find((tile) => tile.col === col) ?? road.entryTile;
}

/**
 * `<host>/civic/<kind>`, for both storeyed views.
 *
 * THE STOREY ORDINAL IS GONE, and Towers and Building were the near miss that
 * shows why it had to go rather than be pinned: with a previous layout to carry,
 * a new host's storeys are appended and a known host keeps its band, so the ids
 * held - measured, 0 of 10 lost. Planned WITHOUT a previous - a fresh scene, the
 * first sync after a reload - the same arrival moved host-b's civic storey from
 * index 0 to 3 and lost all ten, in both views. So their stability was a
 * property of the carry, not of the id, and a session's first plan is exactly
 * the plan that has no carry.
 */
function civicRoomIdOf(hostId: string | null, kind: OfficeCivicKind): string {
  return [hostKey(hostId), "civic", kind].join("/");
}

interface CivicSeatRun {
  readonly civicRoomId: string;
  readonly kind: "bed" | "lounge";
  readonly tiles: ReadonlyArray<OfficeTilePos>;
  readonly floorIndex: number;
  readonly hostId: string | null;
}

/**
 * One seat per bed or chair, numbered in the order the furniture was laid.
 *
 * The ids are `"<roomId>/<i>"`, which makes them stable for the reason a desk's
 * id is: the room is a function of the host's agent count, and the n-th bed
 * keeps its number whatever else on the plaza moves.
 */
function civicSeatRun(run: CivicSeatRun): OfficeSeat[] {
  const { civicRoomId, kind, tiles, floorIndex, hostId } = run;
  return tiles.map((tile, index) => ({
    seatId: `${civicRoomId}/${index}`,
    kind,
    // A bed is LAIN ON and a chair is SAT IN, so the occupant's tile is the
    // furniture's own - there is no chair beside it to walk to.
    deskTile: tile,
    chairTile: tile,
    facing: "down",
    hitTiles: { width: kind === "bed" ? BED_WIDTH_TILES : 1, height: 1 },
    // Oblique paints a seat on its own tiles; the tiles box already fits.
    hitBox: null,
    floorIndex,
    // A civic seat belongs to no ROOM RUN: it is the bay's, and the bay is the
    // plaza's. `roomId` names a run of desks everywhere else in this view.
    roomId: null,
    hostId,
    manager: false,
    civicRoomId,
  }));
}

interface PlazaCivic {
  readonly rooms: ReadonlyArray<OfficeCivicRoom>;
  readonly seats: ReadonlyArray<OfficeSeat>;
  readonly road: OfficeRoad;
}

/**
 * The plaza's four civic rooms, their furniture and the street they face.
 *
 * Two of the four are places that were already standing here and are given
 * their record now: the help desk IS the reception (C7), and the archive is a
 * door in the outer wall. Only the ward and the chair run are new furniture.
 */
function buildPlazaCivic(
  geometry: Geometry,
  building: Building,
  floorIndex: number,
  agents: number,
): PlazaCivic {
  const road = plazaRoad(building);
  const bay = plazaBay(building);
  const capacity = civicCapacityFor(agents);
  const hostId = building.hostId;
  const walkRow = building.plazaRow + PLAZA_BAY_DOOR_ROW;

  // The ward is glazed down its left-hand column so the plaza can see in, with
  // the gap at the bottom for the way through. The screen is the only thing
  // here that blocks: a bed is a tile somebody lies down ON, so bed tiles stay
  // open, and the two clear rows between them mean every bed has a walkable
  // neighbour - all `findOfficePath` needs, since a goal tile always enters.
  for (let row = 0; row < PLAZA_BAY_DOOR_ROW; row += 1) {
    prop(geometry, "glass-partition", bay.col, bay.row + row);
    geometry.walkable[bay.row + row][bay.col] = false;
  }
  const perRow = Math.floor((bay.cols - 1) / BED_WIDTH_TILES);
  const bedCount = Math.min(capacity.beds, perRow * PLAZA_BED_ROWS.length);
  const bedTiles: OfficeTilePos[] = [];
  for (const row of PLAZA_BED_ROWS) {
    for (let i = 0; i < perRow && bedTiles.length < bedCount; i += 1) {
      bedTiles.push({
        col: bay.col + 1 + i * BED_WIDTH_TILES,
        row: bay.row + row,
      });
    }
  }
  const wardDoor: OfficeTilePos = { col: bay.col, row: walkRow };
  const wardId = civicRoomIdOf(hostId, "infirmary");
  // The cross goes ON the doorway rather than beside it. Beside it would be the
  // one tile the way in leads to, and a blocking prop there would seal the ward.
  prop(geometry, "cross-sign", wardDoor.col, wardDoor.row);
  const beds = civicSeatRun({
    civicRoomId: wardId,
    kind: "bed",
    tiles: bedTiles,
    floorIndex,
    hostId,
  });

  // The chair run waits along the plaza's front, between the pingpong and the
  // ward, facing the lane the way the reception queue does.
  const loungeCol = building.col + PLAZA_LOUNGE_COL;
  const loungeId = civicRoomIdOf(hostId, "waiting-room");
  const chairCount = Math.min(
    capacity.chairs,
    Math.max(0, bay.col - loungeCol),
  );
  const chairs = civicSeatRun({
    civicRoomId: loungeId,
    kind: "lounge",
    tiles: Array.from({ length: chairCount }, (_unused, i) => ({
      col: loungeCol + i,
      row: walkRow,
    })),
    floorIndex,
    hostId,
  });

  // The counter's own end, where the bell is and where the queue forms. NOT the
  // building's entrance, which stands on the lane itself: a door that is a road
  // tile is a door a vehicle drives through.
  const receptionTile: OfficeTilePos = {
    col: building.col + RECEPTION_COL,
    row: walkRow,
  };
  const deskDoor: OfficeTilePos = {
    col: receptionTile.col + RECEPTION_WIDTH_TILES,
    row: walkRow,
  };

  // The records door, in the near outer wall on the far side of the entrance
  // from the counter, so the way out and the way to the archive are never the
  // same walk. Punched walkable like the entrance beside it: an archived agent
  // walks INTO it, and the column outside is the gap between buildings, which
  // has no floor - so opening it joins nothing. A row up from the lane, because
  // nothing drives to the archive and its door is not a kerb.
  const archiveDoor: OfficeTilePos = { col: building.col, row: walkRow };
  geometry.walkable[archiveDoor.row][archiveDoor.col] = true;
  prop(geometry, "records-door", archiveDoor.col, archiveDoor.row);

  const rooms: ReadonlyArray<OfficeCivicRoom> = [
    {
      civicRoomId: wardId,
      kind: "infirmary",
      bounds: bay,
      doorTile: wardDoor,
      signTile: { col: bay.col, row: bay.row },
      name: "Dispensary",
      seatIds: beds.map((seat) => seat.seatId),
      floorIndex,
      hostId,
      // ONE PLAZA PER BUILDING. Towers and Building stack a storey per host, so
      // every room here serves the one whose plaza it stands on.
      hostScope: "host",
      // OPEN, like everything else on a plaza. The bay is an AREA of the plaza
      // floor, not a building on it: measured at 309 agents its top row is 1 of
      // 17 blocked. What IS blocked down its left is the run of GLASS
      // PARTITIONS laid above - a screen, stopping short of the door row - and
      // the beds start a column further in, on tiles that stay walkable because
      // a bed is lain on. Nothing here shells its civic rooms, which is why all
      // four say the same thing.
      enclosure: "open",
      kerbTile: kerbBelow(road, wardDoor.col),
    },
    {
      civicRoomId: loungeId,
      kind: "waiting-room",
      bounds: { col: loungeCol, row: walkRow, cols: chairCount, rows: 1 },
      // A one-row room's way in is its own first tile, the way the archive's is.
      doorTile: { col: loungeCol, row: walkRow },
      signTile: { col: loungeCol, row: walkRow },
      name: "Waiting room",
      seatIds: chairs.map((seat) => seat.seatId),
      floorIndex,
      hostId,
      hostScope: "host",
      // OPEN: a single row of chairs on the walk row, 0 of 16 blocked.
      enclosure: "open",
      // Nothing drives to the waiting room (C6), so it names no kerb.
      kerbTile: null,
    },
    {
      civicRoomId: civicRoomIdOf(hostId, "help-desk"),
      kind: "help-desk",
      // THE COUNTER'S OWN ROW AND NOTHING ABOVE IT. The row above is where the
      // plaza's amenities put the tiles they are used FROM, so a room that
      // reached up into it would be a room with a coffee queue inside it. The
      // Floor's front desk can take the row in front of its counter because
      // that floor's queue stands there; this plaza's queue stands on the lane.
      bounds: {
        col: receptionTile.col,
        row: walkRow,
        cols: RECEPTION_WIDTH_TILES + 1,
        rows: 1,
      },
      doorTile: deskDoor,
      signTile: receptionTile,
      name: "Front desk",
      // Standing at a counter is not sitting down, so it carries no seats.
      seatIds: [],
      floorIndex,
      hostId,
      hostScope: "host",
      // OPEN: the counter and the tile the queue stands on.
      enclosure: "open",
      kerbTile: kerbBelow(road, deskDoor.col),
    },
    {
      civicRoomId: civicRoomIdOf(hostId, "archive"),
      kind: "archive",
      bounds: { col: archiveDoor.col, row: archiveDoor.row, cols: 1, rows: 1 },
      doorTile: archiveDoor,
      // TWO ROWS ABOVE THE DOOR, and this is what `signTile` being its own field
      // is for. The plate is four tiles wide because one tile holds no word, and
      // the door stands at the plaza's left edge with the front desk's own plate
      // three columns to its right - so four tiles along the walk row would
      // print "Records" straight through "Front desk".
      //
      // ONE ROW UP IS NOT ENOUGH, and that is a SCREEN-space fact rather than a
      // tile one: a plate's backing is a fixed fourteen pixels tall whatever the
      // camera is doing, while a row is sixteen world pixels - 11.2 of them at
      // office zoom. So the row above the walk cleared the tiles and still
      // overlapped "Front desk" by 2.8 pixels of backing, with both complete
      // words mandatory at that band and their centres only 28 pixels apart.
      // Two rows is 22.4 and clears it. Row 18 above carries the Plaza sign and
      // the ward's, and neither reaches this far left: the nearer of them starts
      // 52 pixels past where this plate ends.
      signTile: { col: archiveDoor.col, row: archiveDoor.row - 2 },
      name: "Records",
      seatIds: [],
      floorIndex,
      hostId,
      hostScope: "host",
      // OPEN: one tile, and it is a door in the plaza's edge.
      enclosure: "open",
      // Nobody is collected from the archive (C6).
      kerbTile: null,
    },
  ];
  return { rooms, seats: [...beds, ...chairs], road };
}

interface FloorRequest {
  readonly building: Building;
  readonly bounds: OfficeTileRect;
  readonly corridorTiles: OfficeTilePos[];
  readonly errandSpots: OfficeErrandSpot[];
  /** The plaza storey's four rooms; every other storey's is empty (ruling 1b). */
  readonly civic: ReadonlyArray<OfficeCivicRoom>;
  readonly road: OfficeRoad | null;
}
function floorFor(request: FloorRequest): OfficeFloor {
  const { building, bounds, corridorTiles, errandSpots } = request;
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
    civic: request.civic,
    road: request.road,
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
  // The plaza's own name stops where the ward's bay starts. It used to run to
  // the far wall, which is now somebody else's plate.
  const areaCol = building.col + 3;
  sign(geometry, {
    kind: "area",
    tile: { col: areaCol, row: building.plazaRow },
    widthTiles: plazaBay(building).col - areaCol,
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
    placeFixture(geometry, "coffee", action);
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
      placeFixture(geometry, "whiteboard", { col: left + 10, row: storey.row });
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
  const { geometry, assigned, agents, packing, input } = context;
  const { building, quiet } = location;
  const teamRooms = new Set(
    storey.rooms
      .filter(
        (room) =>
          !room.solo &&
          room.lead !== null &&
          input.partition.hosts.some(
            (host) =>
              host.hostId === building.hostId &&
              host.teams.some((team) => team.teamId === room.lead),
          ),
      )
      .map((room) => room.id),
  );
  for (const slot of storey.slots) {
    const agentId = assigned.get(slot.id);
    const seat: OfficeSeat = {
      seatId: slot.id,
      kind: quiet ? "cubby" : "desk",
      deskTile: { col: slot.col, row: storey.row + (quiet ? 0 : 1) },
      chairTile: { col: slot.col, row: storey.row + (quiet ? 0 : 2) },
      facing: "down",
      hitTiles: { width: quiet ? 1 : 2, height: quiet ? 1 : 2 },
      // Oblique paints a desk on its own tile; the tiles box already fits.
      hitBox: null,
      floorIndex: storey.id,
      roomId: slot.room,
      hostId: building.hostId,
      manager: slot.manager,
      // Desks and cubbies only, until K2 plans this view's bays and lounge.
      civicRoomId: null,
      ...(packing.mode === "building" &&
      slot.room !== null &&
      teamRooms.has(slot.room)
        ? { idleAlpha: 0.55 }
        : {}),
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
/**
 * A SOLO FLOOR'S PLATE AT DECREASING LENGTHS, widest first.
 *
 * The count is the part a narrow plate loses LAST, not first. It used to be
 * cut mid-number - `BULLPEN · 9…` on a plate that had room for eleven
 * characters and a reading nineteen long - because the drawing step trims what
 * it is given and this plate was giving it a sentence. Said as a ladder, the
 * words go before the number does, and a plate that can only carry two
 * characters says `BP` rather than half a word.
 *
 * A room plate that names a LEAD needs no list: the renderer re-letters it
 * from whoever that agent is called at the cursor, so its ladder is derived
 * there from the current name (`OfficeSignRungs`'s `"name"`).
 */
function roomRungs(
  mode: ObliqueMode,
  solo: boolean,
  count: number,
): OfficeSignRungs {
  if (!solo) return "name";
  if (mode === "towers") return ["Solo desks", "Solos", "SD"];
  return [
    `Bullpen · ${count} live solos`,
    `Bullpen · ${count}`,
    "Bullpen",
    "BP",
  ];
}
/** Team summaries describe membership, even when capacity lends somebody a seat. */
function roomMembers(
  context: PlanContext,
  room: RoomRun,
  hostId: string | null,
): ReadonlyArray<string> {
  const partition = context.input.partition;
  if (room.solo)
    return room.agents.filter((id) => partition.classOf(id) === "solo");
  const host = partition.hosts.find((candidate) => candidate.hostId === hostId);
  if (host === undefined) return [];
  const team = host.teams.find((candidate) => candidate.teamId === room.lead);
  if (team !== undefined) return team.memberAgentIds;
  return host.hqAgentId !== null && room.lead === host.hqAgentId
    ? [host.hqAgentId]
    : [];
}
function materializeRooms(
  context: PlanContext,
  storey: Storey,
  location: StoreyLocation,
): void {
  const { packing, geometry, agents } = context;
  const { building, left, aisle } = location;
  for (const room of storey.rooms) {
    const slots = storey.slots.filter((slot) => slot.room === room.id);
    if (slots.length === 0) continue;
    const col = slots[0].col;
    const cols = slots[slots.length - 1].col + 2 - col;
    const owner =
      !room.solo && room.lead !== null && agents.has(room.lead)
        ? room.lead
        : null;
    const members = roomMembers(context, room, building.hostId);
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
    // A POD TOO NARROW TO LETTER BOTH ITS PLATE AND ITS BOARD CARRIES NO COUNT:
    // the plate keeps the tile.
    //
    // The board stands on the pod's LAST tile, inside the plate's own span, so
    // the two labels overlap horizontally in every pod whose name letters that
    // far - and the only thing that ever separated them is vertical, the eight
    // world pixels a `pod-plate` board hangs below a bare one. THAT CANNOT WORK
    // AT ANY ZOOM: the separation scales with the camera and a plate's backing
    // is a fixed fourteen pixels, so 8 world px is 12.8 at close-up and short by
    // 1.2. Measured: 13 pairs in Towers at 309 and at 1,000, 2 at 12, 1 in
    // Building - `TEAM-0-LEAD` printed 10.4 px into its own team's count.
    //
    // So the plate stops short of the tile its board letters, which is the rule
    // T3 fixup 6 already wrote - a plate is its own arc segment wide - with the
    // segment measured honestly: a board's tile is a FIXTURE's, like the
    // partition beside it, not the plate's to letter over.
    //
    // And where that leaves the plate less than two tiles, the BOARD gives way
    // instead: a two-desk pod cannot carry both readings, and a count on two
    // desks is the fact those two desks already show, while a name cut to fit
    // one tile comes out as manufactured initials (`A-ROOT` resolved to `AR`,
    // measured) - which reads as wrong rather than as short, and is the rung
    // T3 fixup 6 removed from the HQ board's ladder for that reason. The board
    // PROP stays either way: it is furniture, and only its lettering is what a
    // narrow pod has no room for.
    const boardLettered = cols - BOARD_PLATE_TILES >= PLATE_MIN_TILES;
    sign(geometry, {
      kind: "plate",
      tile: { col, row: storey.row },
      widthTiles: boardLettered ? cols - BOARD_PLATE_TILES : cols,
      text: text,
      ownerAgentId: owner,
      hostId: building.hostId,
      agentIds: members,
      // The pod's own width is the plate's budget, so a plate never reaches
      // into the pod beside it - `cols` above is that width, and this is what
      // makes the renderer honour it rather than centring whatever it is given.
      rungs: roomRungs(packing.mode, room.solo, members.length),
    });
    if (boardLettered) {
      sign(geometry, {
        kind: "board",
        tile: { col: col + cols - 1, row: storey.row },
        widthTiles: BOARD_PLATE_TILES,
        text: "",
        ownerAgentId: owner,
        hostId: building.hostId,
        agentIds: members,
      });
    }
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
  const { packing, geometry, input } = context;
  const location = storeyLocation(packing, storey);
  const { building, bounds, plaza } = location;
  const corridors = paintAisle(context, location);
  const spots = paintStoreySpots(context, storey, location);
  materializeSeats(context, storey, location);
  materializeRooms(context, storey, location);
  // The four rooms are the HOST's, sized from everyone it is running, and they
  // stand on its plaza alone. Every other storey reaches them by the stairwell.
  const civic = plaza
    ? buildPlazaCivic(
        geometry,
        building,
        storey.id,
        input.agents.filter((agent) => agent.hostId === building.hostId).length,
      )
    : null;
  if (civic !== null) {
    for (const seat of civic.seats) geometry.seats.set(seat.seatId, seat);
    for (const room of civic.rooms) civicSign(geometry, room);
  }
  const spotTiles = new Set(
    spots.map((item) => `${item.tile.col}/${item.tile.row}`),
  );
  geometry.floors.push(
    floorFor({
      building,
      bounds,
      corridorTiles: corridors.filter(
        (tile) => !spotTiles.has(`${tile.col}/${tile.row}`),
      ),
      errandSpots: spots,
      civic: civic?.rooms ?? [],
      road: civic?.road ?? null,
    }),
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
  indexProps(packing, geometry.props);

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

/**
 * ONE SEAT PER STOREY SAYS `reserve`, and this is the one - `null` where the
 * storey plans no empty desk at all.
 *
 * A vacant storey is fifteen empty desks, and fifteen copies of the same word
 * across one floor is not fifteen facts: it is one fact said fifteen times,
 * over the name tags that close-up exists to show. The storey says it once,
 * nearest its own centre, and the empty desks themselves - drawn dark, at less
 * than half alpha - carry the rest of the reading.
 *
 * The seat is chosen from the PLAN's own assignment rather than from who is
 * sitting there at the cursor, because a painter is asked about one seat at a
 * time and its answer is cached per seat: a choice that depended on the other
 * desks' occupants would have to be re-made for the whole storey every time
 * one of them lit up. The cost is a storey whose spokesman has since been
 * woken into saying nothing, which is a label fewer, never a label more.
 */
export function obliqueReserveLabelSeatId(
  layout: OfficeLayout,
  floorIndex: number,
): string | null {
  const packing = layout.frozen;
  if (!(packing instanceof ObliquePacking)) return null;
  if (packing.reserveLabels === null) {
    packing.reserveLabels = reserveLabelSeats(packing);
  }
  return packing.reserveLabels.get(floorIndex) ?? null;
}
function reserveLabelSeats(packing: ObliquePacking): Map<number, string> {
  const taken = new Set(packing.assignment.values());
  const out = new Map<number, string>();
  for (const storey of packing.storeys) {
    if (storey.slots.length === 0) continue;
    const centre =
      (storey.slots[0].col + storey.slots[storey.slots.length - 1].col) / 2;
    let chosen: Slot | null = null;
    for (const slot of storey.slots) {
      if (taken.has(slot.id)) continue;
      if (
        chosen === null ||
        Math.abs(slot.col - centre) < Math.abs(chosen.col - centre)
      ) {
        chosen = slot;
      }
    }
    if (chosen !== null) out.set(storey.id, chosen.id);
  }
  return out;
}
/** Storey identity comes from the recipe, independently of its painted bounds. */
export function obliqueIsPlaza(
  layout: OfficeLayout,
  floorIndex: number,
): boolean {
  const packing = layout.frozen;
  return (
    packing instanceof ObliquePacking &&
    packing.storeys.at(floorIndex)?.kind === "plaza"
  );
}
