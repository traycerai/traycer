/**
 * CITY: one building per agent, a block per team, a skyline of activity.
 *
 * A lot is two tiles - the building, and the doorway under it - and lots pair
 * up with a walkable aisle beside every PAIR, so a door always has a street to
 * open onto without spending a whole column on each one. The character's seat
 * IS the doorway: `deskTile` is the building, `chairTile` is the door, and it
 * faces down, which is why a City agent reads as standing in its own doorway
 * rather than sitting behind a desk.
 *
 * HEIGHT IS FROZEN. A building's storeys come from `activityById` the first
 * time the agent is planned, `1 + min(6, floor(activity / 4))`, and never move
 * again: a skyline that re-shuffled itself every time a message landed would be
 * unreadable, and re-planning on activity is explicitly not a plan trigger. An
 * agent that arrives later is measured by its activity at arrival. Re-picking
 * Auto or reopening the tile rebuilds from scratch, which is the only way a
 * height ever changes.
 *
 * CITY IS APPEND-STABLE. Every block's rectangle, every lot index and every
 * height ride in `frozen`, and a later plan only ever ADDS: an arrival takes a
 * free lot in its own team's block, then any free lot in its district, and only
 * then an annex appended after everything already placed. Districts take column
 * bands, so a district that grows downward never displaces the one beside it
 * and no seat ever needs a `shiftFromPrevious`.
 */
import {
  OFFICE_CHARACTER_HEIGHT,
  type OfficeAgentInput,
  type OfficeDesk,
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
import type { OfficeHostPopulation } from "@/lib/comm-graph/office/office-population";
import { ISO_PAINTER } from "@/lib/comm-graph/office/views/isometric/iso-painter";
import {
  buildIsoCafe,
  buildIsoCourtyard,
  buildIsoIndex,
  isoBlankGrid,
  isoFloorOf,
  isoHostKey,
  isoHostSign,
  isoNearSquareWidth,
  isoPaintDistrict,
  isoShelfPack,
  isoShelfStart,
  readCityFrozen,
  ISO_CAFE_COLS,
  ISO_CAFE_ROWS,
  ISO_COURTYARD_COLS,
  ISO_COURTYARD_ROWS,
  ISO_DISTRICT_GAP,
  ISO_DISTRICT_RING,
  ISO_SEAT_ID_NONE,
  ISO_SIGN_WIDTH_TILES,
  type CityFrozen,
  type CityFrozenBlock,
  type CityFrozenDistrict,
  type IsoBlockSpec,
  type IsoDistrictBuild,
  type IsoGrid,
  type IsoShelfCursor,
} from "@/lib/comm-graph/office/views/isometric/iso-plan-core";
import {
  ISO_HALF_HEIGHT,
  ISO_HALF_WIDTH,
  ISO_SPIRE_LIFT,
  ISO_STOREY_HEIGHT,
} from "@/lib/comm-graph/office/views/isometric/iso-projector";
import type {
  OfficePlanInput,
  OfficeView,
} from "@/lib/comm-graph/office/views/office-view";

/** A lot: the building's tile, and the doorway under it. */
const LOT_ROWS = 2;
/** Two lots share one aisle: three columns buy two front doors. */
const LOTS_PER_GROUP = 2;
const GROUP_COLS = 3;

/** `1 + min(6, floor(activity / 4))`: one storey, then one per four messages. */
const STOREYS_PER_ACTIVITY = 4;
const CITY_MAX_STOREYS = 7;
const CITY_MIN_STOREYS = 1;

/**
 * Spare lots a block is built with. One per team, because a team block is
 * small and a spare lot in every one of thirty of them is thirty empty
 * buildings; the district's other blocks and, past those, an annex are what
 * catch an arrival when that one is taken.
 */
const TEAM_RESERVE_LOTS = 1;
/** Solos are split into neighbourhoods, so no single block dwarfs the shelf. */
const SOLO_CHUNK_MEMBERS = 32;
const SOLO_CHUNK_RESERVE = 4;

/** `H` is never shorter than the tallest tree in the district's own park. */
const MIN_STACK_HEIGHT = 24;

const PARK_BLOCK: IsoBlockSpec = {
  blockId: "park",
  cols: ISO_COURTYARD_COLS,
  rows: ISO_COURTYARD_ROWS,
};
const CAFE_BLOCK: IsoBlockSpec = {
  blockId: "cafe",
  cols: ISO_CAFE_COLS,
  rows: ISO_CAFE_ROWS,
};

/** Columns a row of `perRow` lots costs, aisles included. */
function colsForLots(perRow: number): number {
  return Math.ceil(perRow / LOTS_PER_GROUP) * GROUP_COLS;
}

/**
 * Where lot `index` stands: its building, and the doorway under it.
 *
 * Derived rather than stored. A block's rectangle and its `perRow` are what the
 * freezing has to carry; the lots inside follow from those two, so a lot cannot
 * drift out of step with the block that holds it.
 */
export function cityLotTiles(
  block: CityFrozenBlock,
  index: number,
): { readonly building: OfficeTilePos; readonly door: OfficeTilePos } {
  const lotCol = index % block.perRow;
  const lotRow = Math.floor(index / block.perRow);
  const group = Math.floor(lotCol / LOTS_PER_GROUP);
  const building: OfficeTilePos = {
    col: block.rect.col + group * GROUP_COLS + (lotCol % LOTS_PER_GROUP),
    row: block.rect.row + lotRow * LOT_ROWS,
  };
  return { building, door: { col: building.col, row: building.row + 1 } };
}

/**
 * The walkable street a lot's door opens onto: the aisle its PAIR shares.
 *
 * The neighbouring lot is a door too, and a door is a chair - blocked to
 * everyone but its own occupant. So "one to the right" is the wrong answer for
 * the left lot of a pair, and the aisle column is the right one for both.
 */
export function cityLotAisle(
  block: CityFrozenBlock,
  index: number,
): OfficeTilePos {
  const lotCol = index % block.perRow;
  const group = Math.floor(lotCol / LOTS_PER_GROUP);
  return {
    col: block.rect.col + group * GROUP_COLS + LOTS_PER_GROUP,
    row: block.rect.row + Math.floor(index / block.perRow) * LOT_ROWS + 1,
  };
}

/** What a block is FOR, before it has a rectangle. */
interface CityBlockNeed {
  readonly localId: string;
  readonly kind: CityFrozenBlock["kind"];
  readonly ownerAgentId: string | null;
  readonly memberAgentIds: ReadonlyArray<string>;
  readonly reserve: number;
}

interface CityDistrictWork {
  readonly hostKey: string;
  readonly hostId: string | null;
  readonly hqAgentId: string | null;
  readonly needs: ReadonlyArray<CityBlockNeed>;
}

interface CityPlacedBlock extends CityFrozenBlock {
  readonly districtIndex: number;
  readonly hostId: string | null;
}

interface LotGrid {
  readonly perRow: number;
  readonly lotRows: number;
}

function lotGridFor(
  members: number,
  reserve: number,
  widthBudget: number,
): LotGrid {
  const lots = Math.max(1, members + reserve);
  const maxPerRow = Math.max(
    1,
    Math.floor(widthBudget / GROUP_COLS) * LOTS_PER_GROUP,
  );
  const perRow = Math.min(maxPerRow, Math.max(1, Math.ceil(Math.sqrt(lots))));
  return { perRow, lotRows: Math.max(1, Math.ceil(lots / perRow)) };
}

function specFor(need: CityBlockNeed, widthBudget: number): IsoBlockSpec {
  const grid = lotGridFor(
    need.memberAgentIds.length,
    need.reserve,
    widthBudget,
  );
  return {
    blockId: need.localId,
    cols: colsForLots(grid.perRow),
    rows: grid.lotRows * LOT_ROWS,
  };
}

function needsFor(host: OfficeHostPopulation): ReadonlyArray<CityBlockNeed> {
  const needs: CityBlockNeed[] = [];
  if (host.hqAgentId !== null) {
    needs.push({
      localId: `hq/${host.hqAgentId}`,
      kind: "hq",
      ownerAgentId: host.hqAgentId,
      memberAgentIds: [host.hqAgentId],
      reserve: 0,
    });
  }
  for (const team of host.teams) {
    needs.push({
      localId: `team/${team.teamId}`,
      kind: "team",
      ownerAgentId: team.leadAgentId,
      memberAgentIds: team.memberAgentIds,
      reserve: TEAM_RESERVE_LOTS,
    });
  }
  const solos = host.solos.map((member) => member.agentId);
  const chunks = Math.max(1, Math.ceil(solos.length / SOLO_CHUNK_MEMBERS));
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    needs.push({
      localId: `solos/${chunk}`,
      kind: "solos",
      ownerAgentId: null,
      memberAgentIds: solos.slice(
        chunk * SOLO_CHUNK_MEMBERS,
        (chunk + 1) * SOLO_CHUNK_MEMBERS,
      ),
      reserve: SOLO_CHUNK_RESERVE,
    });
  }
  return needs;
}

function districtWork(input: OfficePlanInput): ReadonlyArray<CityDistrictWork> {
  const work: CityDistrictWork[] = input.partition.hosts.map((host) => ({
    hostKey: isoHostKey(host.hostId),
    hostId: host.hostId,
    hqAgentId: host.hqAgentId,
    needs: needsFor(host),
  }));
  if (work.length === 0) {
    work.push({
      hostKey: isoHostKey(null),
      hostId: null,
      hqAgentId: null,
      needs: [
        {
          localId: "solos/0",
          kind: "solos",
          ownerAgentId: null,
          memberAgentIds: [],
          reserve: SOLO_CHUNK_RESERVE,
        },
      ],
    });
  }
  return work;
}

interface PlacedDistrict {
  readonly frozen: CityFrozenDistrict;
  readonly blocks: ReadonlyArray<CityPlacedBlock>;
  readonly work: CityDistrictWork;
  readonly districtIndex: number;
}

function widthBudgetFor(work: CityDistrictWork): number {
  const loose = Number.MAX_SAFE_INTEGER;
  return isoNearSquareWidth([
    PARK_BLOCK,
    CAFE_BLOCK,
    ...work.needs.map((need) => specFor(need, loose)),
  ]);
}

interface PendingBlock {
  readonly spec: IsoBlockSpec;
  readonly kind: CityFrozenBlock["kind"];
  readonly ownerAgentId: string | null;
  readonly perRow: number;
}

/**
 * Places whatever this district does not already have, after whatever it does.
 *
 * The shelf cursor is the frozen part that matters: blocks already placed keep
 * their rectangles for ever, and the next one starts where the last plan
 * stopped. That is the whole of City's append-stability.
 *
 * New blocks go on tallest-first, which is the standard shelf heuristic and
 * costs nothing here: within one call every block is new, so ordering them
 * cannot move a block that already exists.
 */
interface PlaceDistrictArgs {
  readonly work: CityDistrictWork;
  /** What the last plan froze about this district, or `null` for a new one. */
  readonly known: CityFrozenDistrict | null;
  readonly knownBlocks: ReadonlyArray<CityFrozenBlock>;
  readonly districtIndex: number;
  /** Where a district with nothing frozen starts: right of the last one. */
  readonly fallbackCol: number;
}

function placeDistrict(args: PlaceDistrictArgs): PlacedDistrict {
  const { work, known, knownBlocks, districtIndex } = args;
  const widthBudget = known?.widthBudget ?? widthBudgetFor(work);
  const col = known?.col ?? args.fallbackCol;
  const originCol = col + ISO_DISTRICT_RING;
  const placed = new Map<string, CityPlacedBlock>();
  for (const block of knownBlocks) {
    placed.set(block.blockId, { ...block, districtIndex, hostId: work.hostId });
  }

  const pending: PendingBlock[] = [];
  const addPending = (
    spec: IsoBlockSpec,
    kind: CityFrozenBlock["kind"],
    ownerAgentId: string | null,
    perRow: number,
  ): void => {
    const blockId = `${work.hostKey}/${spec.blockId}`;
    if (placed.has(blockId)) return;
    pending.push({ spec: { ...spec, blockId }, kind, ownerAgentId, perRow });
  };
  addPending(PARK_BLOCK, "park", null, 0);
  addPending(CAFE_BLOCK, "cafe", null, 0);
  for (const need of work.needs) {
    const grid = lotGridFor(
      need.memberAgentIds.length,
      need.reserve,
      widthBudget,
    );
    addPending(
      specFor(need, widthBudget),
      need.kind,
      need.ownerAgentId,
      grid.perRow,
    );
  }
  pending.sort((left, right) => {
    if (left.spec.rows !== right.spec.rows) {
      return right.spec.rows - left.spec.rows;
    }
    if (left.spec.cols !== right.spec.cols) {
      return right.spec.cols - left.spec.cols;
    }
    return left.spec.blockId < right.spec.blockId ? -1 : 1;
  });

  const packed = isoShelfPack(
    pending.map((entry) => entry.spec),
    widthBudget,
    originCol,
    known?.cursor ?? isoShelfStart(originCol, ISO_DISTRICT_RING),
  );
  for (const [index, rect] of packed.placed.entries()) {
    const entry = pending[index];
    placed.set(rect.blockId, {
      blockId: rect.blockId,
      hostKey: work.hostKey,
      kind: entry.kind,
      ownerAgentId: entry.ownerAgentId,
      rect: { col: rect.col, row: rect.row, cols: rect.cols, rows: rect.rows },
      perRow: entry.perRow,
      capacity: entry.perRow === 0 ? 0 : (rect.rows / LOT_ROWS) * entry.perRow,
      districtIndex,
      hostId: work.hostId,
    });
  }

  return {
    frozen: {
      hostKey: work.hostKey,
      hostId: work.hostId,
      col,
      widthBudget,
      cursor: packed.cursor,
    },
    blocks: [...placed.values()],
    work,
    districtIndex,
  };
}

/** Where an arrival goes when every block in its district is full. */
function annexFor(
  district: PlacedDistrict,
  count: number,
  index: number,
): { readonly block: CityPlacedBlock; readonly cursor: IsoShelfCursor } {
  const widthBudget = district.frozen.widthBudget;
  const grid = lotGridFor(count, TEAM_RESERVE_LOTS, widthBudget);
  const packed = isoShelfPack(
    [
      {
        blockId: `${district.frozen.hostKey}/annex/${index}`,
        cols: colsForLots(grid.perRow),
        rows: grid.lotRows * LOT_ROWS,
      },
    ],
    widthBudget,
    district.frozen.col + ISO_DISTRICT_RING,
    district.frozen.cursor,
  );
  const rect = packed.placed[0];
  return {
    block: {
      blockId: rect.blockId,
      hostKey: district.frozen.hostKey,
      kind: "solos",
      ownerAgentId: null,
      rect: { col: rect.col, row: rect.row, cols: rect.cols, rows: rect.rows },
      perRow: grid.perRow,
      capacity: grid.perRow * grid.lotRows,
      districtIndex: district.districtIndex,
      hostId: district.frozen.hostId,
    },
    cursor: packed.cursor,
  };
}

/**
 * A seat's name, from identities that OUTLIVE the current plan.
 *
 * The host, the block (a team id, an HQ occupant, a solo chunk) and the lot
 * index are all facts about who works where; the district's position in this
 * plan's host ordering is not. Naming a seat after that ordering meant a host
 * arriving earlier in the alphabet renamed every seat in every later district,
 * which threw away the seat book's claims and the frozen lot assignments and
 * moved people who had not moved.
 */
function seatIdOf(block: CityPlacedBlock, index: number): string {
  return [block.hostId ?? ISO_SEAT_ID_NONE, block.blockId, index].join("/");
}

/** A free-lot cursor per block, so seating a thousand agents stays linear. */
class LotLedger {
  private readonly owners = new Map<string, string>();
  private readonly seats = new Map<string, string>();
  private readonly cursors = new Map<string, number>();

  take(agentId: string, seatId: string): boolean {
    if (this.owners.has(seatId) || this.seats.has(agentId)) return false;
    this.owners.set(seatId, agentId);
    this.seats.set(agentId, seatId);
    return true;
  }

  hasSeat(agentId: string): boolean {
    return this.seats.has(agentId);
  }

  firstFree(block: CityPlacedBlock): string | null {
    let cursor = this.cursors.get(block.blockId) ?? 0;
    while (cursor < block.capacity) {
      const seatId = seatIdOf(block, cursor);
      if (!this.owners.has(seatId)) {
        this.cursors.set(block.blockId, cursor);
        return seatId;
      }
      cursor += 1;
    }
    this.cursors.set(block.blockId, cursor);
    return null;
  }

  assignments(): ReadonlyMap<string, string> {
    return this.seats;
  }

  ownerOf(seatId: string): string | null {
    return this.owners.get(seatId) ?? null;
  }
}

interface CityPack {
  readonly districts: ReadonlyArray<PlacedDistrict>;
  readonly ledger: LotLedger;
  readonly storeysBySeatId: ReadonlyMap<string, number>;
  readonly spireSeatIds: ReadonlySet<string>;
  readonly cols: number;
  readonly rows: number;
  readonly stackHeight: number;
}

function storeysFor(
  agentId: string,
  isHq: boolean,
  input: OfficePlanInput,
  previous: CityFrozen | null,
): number {
  // The corner office is the tallest thing on the skyline whatever it has been
  // doing; the spire on it is what says which one it is.
  if (isHq) return CITY_MAX_STOREYS;
  const known = previous?.storeysByAgentId.get(agentId);
  if (known !== undefined) return known;
  const activity = input.activityById.get(agentId) ?? 0;
  return (
    CITY_MIN_STOREYS +
    Math.min(
      CITY_MAX_STOREYS - CITY_MIN_STOREYS,
      Math.floor(activity / STOREYS_PER_ACTIVITY),
    )
  );
}

/**
 * The whole packing: districts, lots, who is in which, and how tall each
 * building stands. `plan` dresses this; `measure` reads its size and stops.
 *
 * Seating is three passes, in this order and for this reason: a seat the book
 * says is SPOKEN FOR is never handed to anybody else; an agent that was planned
 * before keeps the lot it had, or the whole point of freezing is lost; and only
 * then does an arrival get the first free lot in the block it belongs to.
 */
function placeAllDistricts(
  input: OfficePlanInput,
  previous: CityFrozen | null,
): ReadonlyArray<PlacedDistrict> {
  const knownByHost = new Map<string, CityFrozenDistrict>(
    (previous?.districts ?? []).map((district) => [district.hostKey, district]),
  );
  const knownBlocks = new Map<string, CityFrozenBlock[]>();
  for (const block of previous?.blocks ?? []) {
    const bucket = knownBlocks.get(block.hostKey);
    if (bucket === undefined) knownBlocks.set(block.hostKey, [block]);
    else bucket.push(block);
  }
  // A district whose band is not frozen yet opens to the right of every band
  // that is, which is what lets a NEW host appear without moving an old one.
  let fallbackCol = 0;
  for (const district of previous?.districts ?? []) {
    fallbackCol = Math.max(fallbackCol, rightEdgeOf(district));
  }
  const districts: PlacedDistrict[] = [];
  for (const [districtIndex, work] of districtWork(input).entries()) {
    const known = knownByHost.get(work.hostKey) ?? null;
    const district = placeDistrict({
      work,
      known,
      knownBlocks: knownBlocks.get(work.hostKey) ?? [],
      districtIndex,
      fallbackCol,
    });
    districts.push(district);
    if (known === null) fallbackCol = rightEdgeOf(district.frozen);
  }
  return districts;
}

/** Where the next district may start: past this band and its dead columns. */
function rightEdgeOf(district: CityFrozenDistrict): number {
  return (
    district.col +
    district.widthBudget +
    ISO_DISTRICT_RING * 2 +
    ISO_DISTRICT_GAP
  );
}

/** Seats the book has already spoken for, and the lots the last plan froze. */
function honourExistingSeats(
  input: OfficePlanInput,
  districts: ReadonlyArray<PlacedDistrict>,
  previous: CityFrozen | null,
  ledger: LotLedger,
): void {
  const present = new Set(input.agents.map((agent) => agent.id));
  const seatExists = new Set<string>();
  for (const district of districts) {
    for (const block of district.blocks) {
      for (let index = 0; index < block.capacity; index += 1) {
        seatExists.add(seatIdOf(block, index));
      }
    }
  }
  const claim = (agentId: string, seatId: string): void => {
    if (!present.has(agentId) || !seatExists.has(seatId)) return;
    ledger.take(agentId, seatId);
  };
  for (const [seatId, agentId] of input.occupancy) claim(agentId, seatId);
  for (const [agentId, seatId] of previous?.seatIdByAgentId ?? []) {
    claim(agentId, seatId);
  }
}

/** The first free lot anywhere in this district, in block order. */
function anyFreeLotIn(
  district: PlacedDistrict,
  ledger: LotLedger,
): string | null {
  for (const block of district.blocks) {
    if (block.capacity === 0) continue;
    const spare = ledger.firstFree(block);
    if (spare !== null) return spare;
  }
  return null;
}

/**
 * Everyone still standing, after the frozen lots have been handed back.
 *
 * An arrival tries its own team's block first, then anywhere in its district,
 * and is only reported as unseated when the district is genuinely full.
 */
function seatArrivals(
  input: OfficePlanInput,
  districts: ReadonlyArray<PlacedDistrict>,
  ledger: LotLedger,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const unseatedByHost = new Map<string, string[]>();
  const noted = new Set<string>();
  const noteUnseated = (hostKey: string, agentId: string): void => {
    if (noted.has(agentId)) return;
    noted.add(agentId);
    const bucket = unseatedByHost.get(hostKey);
    if (bucket === undefined) unseatedByHost.set(hostKey, [agentId]);
    else bucket.push(agentId);
  };
  const present = new Set(input.agents.map((agent) => agent.id));
  for (const district of districts) {
    const byBlockId = new Map(
      district.blocks.map((block) => [block.blockId, block]),
    );
    for (const need of district.work.needs) {
      const own = byBlockId.get(`${district.frozen.hostKey}/${need.localId}`);
      for (const agentId of need.memberAgentIds) {
        if (!present.has(agentId) || ledger.hasSeat(agentId)) continue;
        const mine = own === undefined ? null : ledger.firstFree(own);
        if (mine !== null && ledger.take(agentId, mine)) continue;
        const spare = anyFreeLotIn(district, ledger);
        if (spare !== null && ledger.take(agentId, spare)) continue;
        noteUnseated(district.frozen.hostKey, agentId);
      }
    }
  }
  // The partition is built from the same agent set, so anybody still missing
  // here is the reparenting-cycle case rather than an expected one.
  for (const agent of input.agents) {
    if (ledger.hasSeat(agent.id)) continue;
    noteUnseated(isoHostKey(agent.hostId), agent.id);
  }
  return unseatedByHost;
}

/** An annex per district that still has people standing, appended at the end. */
function growForOverflow(
  districts: ReadonlyArray<PlacedDistrict>,
  unseatedByHost: ReadonlyMap<string, ReadonlyArray<string>>,
  ledger: LotLedger,
): ReadonlyArray<PlacedDistrict> {
  if (unseatedByHost.size === 0) return districts;
  return districts.map((district) => {
    const mine = unseatedByHost.get(district.frozen.hostKey) ?? [];
    if (mine.length === 0) return district;
    const annexIndex = district.blocks.filter((block) =>
      block.blockId.includes("/annex/"),
    ).length;
    const annex = annexFor(district, mine.length, annexIndex);
    for (const agentId of mine) {
      const seatId = ledger.firstFree(annex.block);
      if (seatId === null) break;
      ledger.take(agentId, seatId);
    }
    return {
      ...district,
      blocks: [...district.blocks, annex.block],
      frozen: { ...district.frozen, cursor: annex.cursor },
    };
  });
}

interface Skyline {
  readonly storeysBySeatId: ReadonlyMap<string, number>;
  readonly spireSeatIds: ReadonlySet<string>;
  readonly cols: number;
  readonly rows: number;
  readonly stackHeight: number;
}

/** How tall every building stands, and how much world that needs. */
function raiseSkyline(
  input: OfficePlanInput,
  districts: ReadonlyArray<PlacedDistrict>,
  ledger: LotLedger,
  previous: CityFrozen | null,
): Skyline {
  const storeysBySeatId = new Map<string, number>();
  const spireSeatIds = new Set<string>();
  let cols = 1;
  let rows = 1;
  let stackHeight = MIN_STACK_HEIGHT;
  for (const district of districts) {
    let bottom = 0;
    for (const block of district.blocks) {
      bottom = Math.max(bottom, block.rect.row + block.rect.rows);
      for (let index = 0; index < block.capacity; index += 1) {
        const seatId = seatIdOf(block, index);
        const agentId = ledger.ownerOf(seatId);
        const isHq = agentId !== null && agentId === district.work.hqAgentId;
        const storeys =
          agentId === null
            ? CITY_MIN_STOREYS
            : storeysFor(agentId, isHq, input, previous);
        storeysBySeatId.set(seatId, storeys);
        if (isHq) spireSeatIds.add(seatId);
        stackHeight = Math.max(
          stackHeight,
          storeys * ISO_STOREY_HEIGHT + (isHq ? ISO_SPIRE_LIFT : 0),
        );
      }
    }
    cols = Math.max(
      cols,
      district.frozen.col + district.frozen.widthBudget + ISO_DISTRICT_RING * 2,
    );
    rows = Math.max(rows, bottom + ISO_DISTRICT_RING);
  }
  return { storeysBySeatId, spireSeatIds, cols, rows, stackHeight };
}

function packCity(input: OfficePlanInput): CityPack {
  const previous = readCityFrozen(input.previous);
  const placed = placeAllDistricts(input, previous);
  const ledger = new LotLedger();
  honourExistingSeats(input, placed, previous, ledger);
  const districts = growForOverflow(
    placed,
    seatArrivals(input, placed, ledger),
    ledger,
  );
  const skyline = raiseSkyline(input, districts, ledger, previous);
  return {
    districts,
    ledger,
    storeysBySeatId: skyline.storeysBySeatId,
    spireSeatIds: skyline.spireSeatIds,
    cols: skyline.cols,
    rows: skyline.rows,
    stackHeight: skyline.stackHeight,
  };
}

interface CityBuild {
  readonly build: IsoDistrictBuild;
  readonly desks: ReadonlyArray<OfficeDesk>;
  readonly seats: ReadonlyArray<OfficeSeat>;
}

function buildDistrict(
  district: PlacedDistrict,
  pack: CityPack,
  agentById: ReadonlyMap<string, OfficeAgentInput>,
): CityBuild {
  const floorIndex = district.districtIndex;
  const park = district.blocks.find((block) => block.kind === "park");
  const cafeBlock = district.blocks.find((block) => block.kind === "cafe");
  if (park === undefined || cafeBlock === undefined) {
    throw new Error("city district lost its amenities");
  }
  const courtyard = buildIsoCourtyard({
    col: park.rect.col,
    row: park.rect.row,
    floorIndex,
    name: "Park",
  });
  const cafe = buildIsoCafe({
    col: cafeBlock.rect.col,
    row: cafeBlock.rect.row,
    floorIndex,
    name: "Cafe",
  });

  const rooms: OfficeRoom[] = [];
  const desks: OfficeDesk[] = [];
  const seats: OfficeSeat[] = [];
  const blocked: OfficeTilePos[] = [];
  const signs: OfficeSign[] = [];
  let bottom = 0;
  for (const block of district.blocks) {
    bottom = Math.max(bottom, block.rect.row + block.rect.rows);
    if (block.capacity === 0) continue;
    let visitTile: OfficeTilePos | null = null;
    for (let index = 0; index < block.capacity; index += 1) {
      const tiles = cityLotTiles(block, index);
      blocked.push(tiles.building, tiles.door);
      const seatId = seatIdOf(block, index);
      const seat: OfficeSeat = {
        seatId,
        kind: "desk",
        deskTile: tiles.building,
        chairTile: tiles.door,
        facing: "down",
        hitTiles: { width: 1, height: LOT_ROWS },
        hitBox: null,
        floorIndex,
        roomId: block.blockId,
        hostId: block.hostId,
        manager: block.kind === "hq",
      };
      seats.push(seat);
      const agentId = pack.ledger.ownerOf(seatId);
      if (agentId !== null) desks.push({ ...seat, agentId });
      // The street beside the block's first door: a visit is a call on the
      // block, and the pavement outside it is where you wait.
      if (visitTile === null) visitTile = cityLotAisle(block, index);
    }
    const ownerAgent =
      block.ownerAgentId === null
        ? undefined
        : agentById.get(block.ownerAgentId);
    const signTile: OfficeTilePos = {
      col: block.rect.col,
      row: block.rect.row,
    };
    rooms.push({
      // A block is named by its own id rather than by a lead: a solos block and
      // an annex have no lead, and `roomId` still has to resolve to a room.
      rootAgentId: block.blockId,
      name: ownerAgent?.name ?? "Solo lots",
      bounds: block.rect,
      doorTile: cityLotAisle(block, 0),
      signTile,
      pods: [],
      visitTile,
    });
    if (ownerAgent !== undefined) {
      signs.push({
        kind: "plate",
        tile: signTile,
        widthTiles: ISO_SIGN_WIDTH_TILES,
        text: ownerAgent.name,
        ownerAgentId: ownerAgent.id,
        hostId: block.hostId,
        // A plate names its lead. `agentIds` belongs to the BOARDS that
        // summarise a block's statuses, which this ticket does not hang.
        agentIds: [],
      });
    }
  }

  const bounds: OfficeTileRect = {
    col: district.frozen.col,
    row: 0,
    cols: district.frozen.widthBudget + ISO_DISTRICT_RING * 2,
    rows: bottom + ISO_DISTRICT_RING,
  };
  const build: IsoDistrictBuild = {
    hostId: district.frozen.hostId,
    bounds,
    courtyard,
    cafe,
    rooms,
    props: [...courtyard.props, ...cafe.props],
    blocked,
    spots: [],
    signs,
  };
  return { build, desks, seats };
}

export function planCity(input: OfficePlanInput): OfficeLayout {
  const pack = packCity(input);
  const agentById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const builds = pack.districts.map((district) =>
    buildDistrict(district, pack, agentById),
  );
  const grid: IsoGrid = isoBlankGrid(pack.cols, pack.rows);
  for (const built of builds) isoPaintDistrict(grid, built.build);

  const desks = new Map<string, OfficeDesk>();
  const seats = new Map<string, OfficeSeat>();
  const rooms: OfficeRoom[] = [];
  const props: OfficeProp[] = [];
  const signs: OfficeSign[] = [];
  const floors: OfficeFloor[] = [];
  for (const [floorIndex, built] of builds.entries()) {
    for (const seat of built.seats) seats.set(seat.seatId, seat);
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

  const storeysByAgentId = new Map<string, number>();
  for (const [agentId, seatId] of pack.ledger.assignments()) {
    const storeys = pack.storeysBySeatId.get(seatId);
    if (storeys !== undefined) storeysByAgentId.set(agentId, storeys);
  }
  const frozen: CityFrozen = {
    kind: "city",
    index: buildIsoIndex({
      props,
      rooms,
      spots: floors.flatMap((floor) => floor.errandSpots),
    }),
    districts: pack.districts.map((district) => district.frozen),
    blocks: pack.districts.flatMap((district) => district.blocks),
    seatIdByAgentId: pack.ledger.assignments(),
    storeysBySeatId: pack.storeysBySeatId,
    storeysByAgentId,
    spireSeatIds: pack.spireSeatIds,
    stackHeight: pack.stackHeight,
  };

  return {
    view: "city",
    cols: pack.cols,
    rows: pack.rows,
    desks,
    seats,
    signs,
    rooms,
    floors,
    doorTile: floors[0].doorTile,
    lobbyTile: floors[0].lobbyTile,
    props,
    walkable: grid.walkable,
    frozen,
    // Lots are frozen and blocks append, so nothing ever moves: growth adds
    // rows to the world, and rows move the projected ORIGIN, not a tile.
    shiftFromPrevious: null,
    stable: true,
  };
}

export function measureCity(input: OfficePlanInput): OfficeSize {
  const pack = packCity(input);
  return {
    width: (pack.cols + pack.rows) * ISO_HALF_WIDTH,
    height:
      (pack.cols + pack.rows) * ISO_HALF_HEIGHT +
      pack.stackHeight +
      OFFICE_CHARACTER_HEIGHT,
  };
}

export const CITY_VIEW: OfficeView = {
  id: "city",
  label: "City",
  description:
    "A team is a city block and an agent is a building; height is how busy it has been, and lit windows are status.",
  plan: planCity,
  measure: measureCity,
  painter: ISO_PAINTER,
};
