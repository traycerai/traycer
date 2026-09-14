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
  type OfficeCivicRoom,
  type OfficeDesk,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeProp,
  type OfficeRect,
  type OfficeRoad,
  type OfficeRoom,
  type OfficeSeat,
  type OfficeSign,
  type OfficeSize,
  type OfficeSpriteName,
  type OfficeTilePos,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeHostPopulation } from "@/lib/comm-graph/office/office-population";
import {
  ARCHIVE_SIGN_WIDTH_TILES,
  civicCapacityFor,
} from "@/lib/comm-graph/office/office-layout";
import {
  isoCityBuildingBox,
  isoFurnitureBox,
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
  ISO_COURTYARD_BENCHES,
  ISO_COURTYARD_COLS,
  ISO_COURTYARD_ROWS,
  ISO_BLOCK_GAP,
  ISO_DISTRICT_GAP,
  ISO_DISTRICT_RING,
  ISO_SEAT_ID_NONE,
  ISO_SIGN_WIDTH_TILES,
  type CityFrozen,
  type CityFrozenBlock,
  type CityFrozenDistrict,
  type IsoBlockSpec,
  type IsoCourtyardBuild,
  type IsoDistrictBuild,
  type IsoGrid,
  type IsoShelfCursor,
} from "@/lib/comm-graph/office/views/isometric/iso-plan-core";
import {
  isoProjectAt,
  ISO_HALF_HEIGHT,
  ISO_HALF_WIDTH,
  ISO_SPIRE_LIFT,
  ISO_STOREY_HEIGHT,
  type IsoOrigin,
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

/**
 * THE DISTRICT'S FOOT, three rows deep where its sides keep one.
 *
 * The host plate hangs on the last row of the district (`isoHostSign`), and a
 * plate's backing is a fixed fourteen screen pixels tall however far out the
 * camera is. Two plates `d` apart in `col + row` clear each other by
 * `(d * 8 + overhang(lower) - overhang(upper)) * zoom` pixels; the host plate
 * hangs off two-tile art with no overhang and a lot's plate off one-tile art
 * with eight, so the pair clears by `(d * 8 - 8) * zoom` and needs 14. That is
 * `d >= 4` at office zoom and `d >= 3` at close-up, so FOUR is the number, and
 * plate widths never enter it.
 *
 * With a one-row foot the last lot row ends one row above the plate, and a
 * two-row lot puts its own plate exactly two rows above it: `d = 2`, which
 * overprints by 8.4 px at 0.7 and 1.2 px at 1.6. Measured across populations
 * 8-140 plus eight larger ones, that happens at TWENTY-TWO of them - 15-17,
 * 50-52, 85-91, 99-105, 112, 160 - every one with the same signature, a lot
 * plate two rows above the host plate in its own column. Three rows here makes
 * the smallest `d` four, and the sweep finds nothing at any population.
 *
 * THREE RATHER THAN FOUR because the lot's own body pays for one row: a two-row
 * lot ending at the last content row has its plate one row above that, so a
 * three-row foot puts four rows between the two plates. A one-row lot would need
 * four, and City has none - the smallest lot is a two-row door pair.
 *
 * ITS OWN WITNESS, now that the civic quarter is planned. When this constant
 * arrived, the 22 populations it was measured on were all outside the three the
 * plate case runs, so nothing in the suite reddened when it was wrong - a gap
 * stated plainly at the time. The quarter closes it: the WAREHOUSE band is the
 * lowest thing in the district, so its plate is the one nearest the host's.
 * Measured by putting this back to 1 with the quarter in place - the shared plate
 * case reds at all three populations, `civic "WAREHOUSE" at 1,24 overlaps host
 * "UNATTRIBUTED" at 1,26 by 2.8 px` and the same at 1,56 and 1,83.
 *
 * IT IS CITY'S OWN, NOT `ISO_DISTRICT_RING`. Raising the shared ring to 3 was
 * measured and fails three ways: it does not fix City at all, because the ring
 * grows on every side and content and plate shift down together leaving `d` at
 * 2 and all 22 populations still overprinting; it breaks Campus, whose walk to
 * its civic seats and kerbs reds at 12 and 309 agents; and it costs four rows
 * and four columns in both views instead of two rows in one. This costs +2 rows
 * and no columns: 18x16 -> 18x18, 44x48 -> 44x50, 70x81 -> 70x83. (Those figures
 * are from before the civic quarter, which moved every City row count again; the
 * +2 this constant is responsible for is unchanged.)
 */
const CITY_FOOT_RING_ROWS = 3;

/**
 * THE CIVIC QUARTER'S OWN GEOMETRY, in City's words.
 *
 * `Hospital` is a BAND, not a packed block, for the reason the Mission-control
 * medbay and Campus's sick bay are: its position is part of a promise. It has to
 * stand at the district's first content column so its door faces the lane and
 * its kerb is a lane tile one step away, and a shelf packer decides positions by
 * size. So it is laid under everything the packer placed, at that column - a wall
 * row with a cross on it, and a row of beds behind it.
 *
 * `Bus stop` and `Warehouse` are bands for a weaker reason than the hospital's -
 * nothing is promised about either position - and one strong one, the plates.
 *
 * `Warehouse` IS A BAND TOO, and it started out packed. C5 makes it a door with
 * a counter, nothing drives to it, and nothing about its position is promised -
 * so the shelf looked like the right place for it, and the plan said so. What
 * the shelf cannot promise is the ROW its plate hangs on. Measured at a thousand
 * agents with the warehouse packed: its plate landed one row from the hospital's
 * and the two overprinted by 8.4 px at office zoom, and a shelf placement is not
 * something a population can be chosen to avoid - it is wherever that district's
 * blocks happen to leave a gap. As a band its row is known, which is what makes
 * the plate clearances below a construction rather than a hope. It is as wide as
 * its own plate, which is what `ARCHIVE_SIGN_WIDTH_TILES` says.
 *
 * `Bus stop` is a shelter of its own at the lane - two tiles of shelter, and the
 * seats on the pavement row in front of them, the same reading Campus's benches
 * have: the shelter is furniture nobody stands on, and the tile a waiting agent
 * sits on is a tile of pavement.
 *
 * IT IS AT THE STREET BUT CARRIES NO KERB. `kerbTile` is where a vehicle stops
 * FOR THAT ROOM - the ambulance at the ward, the van at the counter - and no view
 * gives its waiting room one (C6): nobody is collected from a waiting room. The
 * band standing beside the lane is the plan's "road side", not a promise that
 * something pulls up.
 *
 * `Police station` is the district's RECEPTION, re-signed (C7). Not a second
 * counter beside it - the help desk is the counter that was already there.
 */
const HOSPITAL_ROWS = 2;
const HOSPITAL_WALL_COLS = 1;
const BED_WIDTH_TILES = 2;
const WAREHOUSE_COLS = ARCHIVE_SIGN_WIDTH_TILES;
const WAREHOUSE_ROWS = 2;
/** The shelter itself; its seats stand on the row in front of it. */
const SHELTER_ROWS = 2;
/** Two tiles of shelter, which is what the `bus-shelter` sprite spans. */
const SHELTER_COLS = 2;

/** How many agents this district houses, which sets its civic capacity. */
function cityDistrictAgents(work: CityDistrictWork): number {
  let total = 0;
  for (const need of work.needs) total += need.memberAgentIds.length;
  return total;
}

/**
 * TWO ROWS BETWEEN THE LAST LOT AND THE FIRST BAND, and the two is measured.
 *
 * A civic plate's backing must clear every other plate's by 14 screen px, and
 * what separates two plates stacked in an isometric view is
 * `(d * 8 + overhang(lower) - overhang(upper)) * zoom` where `d` is the
 * difference in `col + row`. A civic plate's art is a 32x16 sign, overhang 0; a
 * lot's is a `pod-plate`, overhang 8. So a lot plate ABOVE a civic one needs
 * `(d * 8 - 8) * 0.7 >= 14`, which is `d >= 3.5`, which is `d >= 4`.
 *
 * A lot block's plate hangs on its own first row and the smallest block is the
 * two-row door pair, so the nearest plate above the bands sits at
 * `contentBottom - 2`. One gap row puts the hospital's plate at `d = 3`, and two
 * make it `d = 4`, which clears at 16.8 px whatever the columns do.
 *
 * FOUR MEASUREMENTS, and which plate rule was in force matters to each - so they
 * are attributed rather than pooled, because the first two were taken while the
 * plates were still sized by their rooms' frontage:
 *
 *   frontage plates, one gap row: the suite's own populations red - `AGENT-ROOT`
 *   over `HOSPITAL` by 2.8 px at 12 agents, `TEAM-5-LEAD` over it by a whole 14
 *   at 309.
 *
 *   frontage plates, two gap rows: still red at the pinned populations -
 *   `TEAM-5-LEAD` at 309 and `TEAM-19-LEAD` at 1,000, both by 8.4 px. This is
 *   what makes `CITY_CIVIC_PLATE_TILES` load-bearing and not a second belt.
 *
 *   six-tile plates, one gap row: 26 overprints across the sweep, every one the
 *   same-column pair at 2.8 px - and NONE of them at 12, 309 or 1,000. The shared
 *   plate suite samples 15 agents (`office-plans.test.ts`'s `TRIAGE_SCALES`) for
 *   exactly this reason: that case reds under the one-gap-row mutant while City's
 *   own structural clearance case asserts the two rows against the rooms the
 *   packer placed - two guards now, not one.
 *
 *   six-tile plates, two gap rows - as shipped: zero overprints, in both
 *   isometric views, across every population in the sweep.
 *
 * Between the bands themselves ONE gap is enough, because both plates are civic
 * and the overhangs cancel: `d = 3` gives `24 * 0.7 = 16.8`.
 */
const CITY_CIVIC_CLEARANCE_ROWS = 2;

/**
 * THE THREE BANDS, and the rows a district owes them.
 *
 * All three stand at the first content column, because the first of them is
 * promised to the lane - the hospital's kerb is a lane tile one step from its own
 * door - and a column is the only line in a shelf-packed district whose position
 * is known before the packing. The lane runs the district's whole height, so
 * "beside the lane" costs a row band rather than a place in the shelf, and once
 * one band is paid for the other two ride the same decision.
 *
 * Laid UNDER everything the packer placed, hospital first, then the bus stop,
 * then the warehouse, each separated by the walkable gap two blocks keep.
 */
interface CityCivicBands {
  readonly hospitalRow: number;
  readonly shelterRow: number;
  readonly shedRow: number;
  /** Rows the district comes to, foot band included. */
  readonly rows: number;
}

function cityCivicBands(contentBottom: number): CityCivicBands {
  const hospitalRow = contentBottom + CITY_CIVIC_CLEARANCE_ROWS;
  const shelterRow = hospitalRow + HOSPITAL_ROWS + ISO_BLOCK_GAP;
  const shedRow = shelterRow + SHELTER_ROWS + ISO_BLOCK_GAP;
  return {
    hospitalRow,
    shelterRow,
    shedRow,
    rows: shedRow + WAREHOUSE_ROWS + CITY_FOOT_RING_ROWS,
  };
}

/** The row the packer's own blocks come down to, gaps and all. */
function cityContentBottom(district: PlacedDistrict): number {
  let bottom = 0;
  for (const block of district.blocks) {
    bottom = Math.max(bottom, block.rect.row + block.rect.rows);
  }
  return bottom;
}

/**
 * ONE READING of a district's bands, for the two callers that need it.
 *
 * `raiseSkyline` sizes the world and `buildDistrict` lays the furniture out, and
 * the second inside the first is the whole point: a world one row short of its
 * own hospital would put a bed off the grid. Both read it here so neither can
 * drift - the defect that shape invites is not a wrong formula, it is two right
 * ones that stop agreeing.
 */
function cityCivicBandsOf(district: PlacedDistrict): CityCivicBands {
  return cityCivicBands(cityContentBottom(district));
}

/** What this district's population is owed, from the shared rates. */
function cityCivicCapacity(district: PlacedDistrict): {
  readonly beds: number;
  readonly chairs: number;
} {
  return civicCapacityFor(cityDistrictAgents(district.work));
}

/**
 * EVERY CIVIC PLATE IN CITY IS SIX TILES, and never the room's frontage.
 *
 * WHY NOT THE FRONTAGE. A plate is centred over the tiles it spans, so a plate as
 * wide as an eight-bed ward hangs its lettering EIGHT TILES into the district -
 * and the district is where the lot plates are. Measured with the ward plated by
 * its own frontage, sweeping every population from 8 to 140 and then 160, 200,
 * 250, 309, 400, 500, 700 and 1,000: 48 overprints, every one the same structural
 * pair - a lot plate four columns right and six rows above the hospital's sign,
 * `col + row` two apart, 1.2 to 8.4 px deep at office zoom. Campus takes none in
 * the same sweep; its bench row widens its whole shelf, so its ward's plate
 * centres over its own band rather than under someone else's lots.
 *
 * WHY SIX AND NOT FOUR. Four is the archive's width and would have been the
 * tidier borrowing, but a plate's width is what the sign resolver measures its
 * COUNTER against, and `OFFICE_TILE` is 16: four tiles are 102 px at close-up,
 * and `Hospital · 8 of 8` measures 124. Four would therefore have cost this view
 * a counter it can afford - the one rung the ladder gives up - on a room seventeen
 * columns wide. Six tiles are 154 px against City's longest rung at 137
 * (`Police station · 12`, `Bus stop · 16 of 16`), so every room here keeps its
 * count, and the same sweep at six is still clean in both views.
 *
 * Anchored at the room's own first column, the lettering sits over the way in -
 * the ward's aisle corner, the shelter, the shed's door - which is where a
 * building's name belongs anyway.
 */
const CITY_CIVIC_PLATE_TILES = 6;

/** The bus stop's width: the shelter, or its seat row if that is wider. */
function shelterCols(chairs: number): number {
  return Math.max(SHELTER_COLS, chairs);
}

/** How wide the hospital's band comes to at this bed count. */
function hospitalCols(beds: number): number {
  return HOSPITAL_WALL_COLS + beds * BED_WIDTH_TILES;
}

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

/**
 * THE WIDEST THE BANDS CAN EVER BE, which is what the budget has to clear.
 *
 * Read from `civicCapacityFor` at an impossible population rather than written
 * down, because the cap is that function's to own: `office-layout` says two to
 * eight beds and four to sixteen chairs, and a second copy of the eight here is
 * a number that goes stale silently the first time the rates move.
 *
 * IT IS THE CAP AND NOT THIS DISTRICT'S COUNT, and that is the point. A width
 * budget is FROZEN at the first plan, so a district sized for the twelve agents
 * it opened with would have no room for the eight-bed ward it owes at three
 * hundred - and its band would run out of its own column band into the district
 * beside it. Paying the cap once, up front, is what makes the bands safe under
 * append: the band's rows follow the population, its ceiling never does.
 */
const CITY_CIVIC_BAND_COLS = ((): number => {
  const cap = civicCapacityFor(Number.MAX_SAFE_INTEGER);
  return Math.max(
    hospitalCols(cap.beds),
    shelterCols(cap.chairs),
    WAREHOUSE_COLS,
  );
})();

function widthBudgetFor(work: CityDistrictWork): number {
  const loose = Number.MAX_SAFE_INTEGER;
  return Math.max(
    CITY_CIVIC_BAND_COLS,
    isoNearSquareWidth([
      PARK_BLOCK,
      CAFE_BLOCK,
      ...work.needs.map((need) => specFor(need, loose)),
    ]),
  );
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
    // THE PARK FIRST, whatever its size, and this is a promise rather than a
    // preference. The district's entrance hangs on the courtyard's lobby tile,
    // `districtLane` promises that entrance stands ON the lane, and the kerb
    // contract asks for a road tile ONE STEP from the help desk's own door -
    // which IS that lobby tile, because C7 makes the police station the
    // reception that was already there.
    //
    // Measured before this line existed: the tallest-first order below put the
    // park wherever its height fell, and at a thousand agents the lobby landed
    // 59 columns from the lane, where `expectKerbPromise` wants 1. The comment
    // at `addPending` above already said the park went first; the sort was
    // quietly undoing it.
    if (left.kind !== right.kind) {
      if (left.kind === "park") return -1;
      if (right.kind === "park") return 1;
    }
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
    for (const block of district.blocks) {
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
    // THE BANDS, not the packer's bottom: the civic quarter is laid under
    // everything placed, so the world has to come down to IT.
    rows = Math.max(rows, cityCivicBandsOf(district).rows);
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

interface CityCivicArgs {
  readonly hostId: string | null;
  readonly floorIndex: number;
  readonly origin: IsoOrigin;
  readonly bounds: OfficeTileRect;
  readonly bands: CityCivicBands;
  readonly beds: number;
  readonly chairs: number;
  readonly courtyard: IsoCourtyardBuild;
}

interface CityCivic {
  readonly rooms: ReadonlyArray<OfficeCivicRoom>;
  readonly seats: ReadonlyArray<OfficeSeat>;
  readonly props: ReadonlyArray<OfficeProp>;
  readonly blocked: ReadonlyArray<OfficeTilePos>;
  readonly signs: ReadonlyArray<OfficeSign>;
  readonly road: OfficeRoad;
}

/**
 * The district's four rooms, in the city's own words.
 *
 * `Hospital` is a ward with a cross over every bed, `Bus stop` a shelter with its
 * seats on the pavement, `Warehouse` the archive's door, and `Police station` the
 * reception that was already there - C7, which makes the help desk the counter
 * rather than a second one beside it. The first three are bands at the district's
 * foot, in that order; the fourth is up in the park. See the geometry block above
 * for why each is where it is.
 */
function buildCityCivic(args: CityCivicArgs): CityCivic {
  const { hostId, floorIndex, origin, bands } = args;
  const firstCol = args.bounds.col + ISO_DISTRICT_RING;
  const road = districtLane(args.bounds);
  const blocked: OfficeTilePos[] = [];
  const props: OfficeProp[] = [];
  const seats: OfficeSeat[] = [];
  const boxAt = (tile: OfficeTilePos, sprite: OfficeSpriteName): OfficeRect =>
    isoFurnitureBox(isoProjectAt(origin, tile.col, tile.row), { name: sprite });

  // ---- Hospital: a wall with a cross on it, beds behind, aisle open ----- //
  const wardId = civicRoomIdOf(hostId, "infirmary");
  const wardCols = hospitalCols(args.beds);
  const wardRow = bands.hospitalRow;
  for (let col = firstCol; col < firstCol + wardCols; col += 1) {
    blocked.push({ col, row: wardRow });
  }
  // The aisle column stays OPEN below the corner, as Campus's does: the door is
  // in it, and a wall there would leave whoever came through facing a bed with
  // nowhere to step.
  const wardDoor: OfficeTilePos = { col: firstCol, row: wardRow + 1 };
  for (let index = 0; index < args.beds; index += 1) {
    const tile: OfficeTilePos = {
      col: firstCol + HOSPITAL_WALL_COLS + index * BED_WIDTH_TILES,
      row: wardRow + 1,
    };
    // ONE CROSS PER BED, on the wall tile directly above it, and drawn OVER the
    // wall piece there - both stand in `standing`, sorted by y, and a cross
    // hangs sixteen px lower than a wall. So a ward reads as a wall with as many
    // crosses on it as it has beds. Never on the aisle column: that corner is
    // where the plate hangs, and a plate over a cross is two things in one
    // fourteen-px band.
    props.push({
      sprite: { name: "hospital-roof-cross" },
      tile: { col: tile.col, row: wardRow },
    });
    for (let offset = 0; offset < BED_WIDTH_TILES; offset += 1) {
      blocked.push({ col: tile.col + offset, row: tile.row });
    }
    props.push({ sprite: { name: "bed-iso" }, tile });
    seats.push(
      civicSeat({
        seatId: `${wardId}/${String(index)}`,
        civicRoomId: wardId,
        kind: "bed",
        tile,
        widthTiles: BED_WIDTH_TILES,
        floorIndex,
        hostId,
        hitBox: boxAt(tile, "bed-iso"),
      }),
    );
  }

  // ---- Bus stop: a shelter at the lane, its seats in front of it ------- //
  const stopId = civicRoomIdOf(hostId, "waiting-room");
  const shelterRow = bands.shelterRow;
  for (let col = firstCol; col < firstCol + SHELTER_COLS; col += 1) {
    blocked.push({ col, row: shelterRow });
  }
  props.push({
    sprite: { name: "bus-shelter" },
    tile: { col: firstCol, row: shelterRow },
  });
  for (let index = 0; index < args.chairs; index += 1) {
    // IN FRONT OF THE SHELTER, on the pavement: the shelter's own tiles are
    // furniture nobody stands on, and a seat is somewhere a body goes.
    const tile: OfficeTilePos = { col: firstCol + index, row: shelterRow + 1 };
    props.push({ sprite: { name: "lounge-chair-iso" }, tile });
    seats.push(
      civicSeat({
        seatId: `${stopId}/${String(index)}`,
        civicRoomId: stopId,
        kind: "lounge",
        tile,
        widthTiles: 1,
        floorIndex,
        hostId,
        hitBox: boxAt(tile, "lounge-chair-iso"),
      }),
    );
  }

  // ---- Warehouse: the archive's door, at the quarter's foot ------------- //
  const recordsId = civicRoomIdOf(hostId, "archive");
  const shed: OfficeTileRect = {
    col: firstCol,
    row: bands.shedRow,
    cols: WAREHOUSE_COLS,
    rows: WAREHOUSE_ROWS,
  };
  for (let col = shed.col; col < shed.col + shed.cols; col += 1) {
    blocked.push({ col, row: shed.row });
  }
  const recordsDoor: OfficeTilePos = {
    col: shed.col,
    row: shed.row + shed.rows - 1,
  };
  props.push({ sprite: { name: "warehouse-door-iso" }, tile: recordsDoor });

  // ---- Police station: the reception, re-read as a civic room (C7) ------ //
  const deskId = civicRoomIdOf(hostId, "help-desk");
  const counter = args.courtyard.receptionTile;
  // ONE STEP OFF THE ENTRANCE, the way Campus's is: the district's entrance
  // stands ON the lane and no civic door may be a road tile, so the door is the
  // lobby tile inside it and the entrance is the kerb.
  const deskDoor = args.courtyard.lobbyTile;
  const deskKerb: OfficeTilePos = { col: args.bounds.col, row: deskDoor.row };

  const rooms: ReadonlyArray<OfficeCivicRoom> = [
    {
      civicRoomId: wardId,
      kind: "infirmary",
      bounds: {
        col: firstCol,
        row: wardRow,
        cols: wardCols,
        rows: HOSPITAL_ROWS,
      },
      doorTile: wardDoor,
      signTile: { col: firstCol, row: wardRow },
      name: "Hospital",
      seatIds: seats
        .filter((seat) => seat.civicRoomId === wardId)
        .map((seat) => seat.seatId),
      floorIndex,
      hostId,
      // ONE DISTRICT PER HOST, as Campus's quarter is: a City district is one
      // host's city, so its rooms count that host's things.
      hostScope: "host",
      enclosure: "walled",
      // The lane tile beside the ward's own door, one step from it.
      kerbTile: { col: args.bounds.col, row: wardDoor.row },
    },
    {
      civicRoomId: stopId,
      kind: "waiting-room",
      bounds: {
        col: firstCol,
        row: shelterRow,
        cols: shelterCols(args.chairs),
        rows: SHELTER_ROWS,
      },
      // The pavement in front of the shelter, which is where a queue stands.
      doorTile: { col: firstCol, row: shelterRow + 1 },
      signTile: { col: firstCol, row: shelterRow },
      name: "Bus stop",
      seatIds: seats
        .filter((seat) => seat.civicRoomId === stopId)
        .map((seat) => seat.seatId),
      floorIndex,
      hostId,
      hostScope: "host",
      // OPEN: a shelter and a row of chairs on a pavement. Nothing here is a
      // building, and the tiles the seats stand on are walkable street.
      enclosure: "open",
      // Nobody is collected from a bus stop (C6).
      kerbTile: null,
    },
    {
      civicRoomId: deskId,
      kind: "help-desk",
      bounds: { col: counter.col, row: counter.row, cols: 2, rows: 1 },
      doorTile: deskDoor,
      signTile: deskKerb,
      name: "Police station",
      // Standing at a counter is not sitting down, so it carries no seats.
      seatIds: [],
      floorIndex,
      hostId,
      hostScope: "host",
      // OPEN: these bounds ARE the reception counter, two tiles of furniture in
      // the middle of an open park.
      enclosure: "open",
      kerbTile: deskKerb,
    },
    {
      civicRoomId: recordsId,
      kind: "archive",
      bounds: shed,
      doorTile: recordsDoor,
      signTile: { col: shed.col, row: shed.row },
      name: "Warehouse",
      seatIds: [],
      floorIndex,
      hostId,
      hostScope: "host",
      // WALLED: a shed is a building, and its bounds carry its own back wall.
      enclosure: "walled",
      // Nothing drives to the archive (C6).
      kerbTile: null,
    },
  ];

  const signs: ReadonlyArray<OfficeSign> = rooms.map((room) => ({
    kind: "civic",
    tile: room.signTile,
    widthTiles: CITY_CIVIC_PLATE_TILES,
    text: room.name,
    ownerAgentId: null,
    hostId,
    agentIds: [],
    civicRoomId: room.civicRoomId,
  }));

  return { rooms, seats, props, blocked, signs, road };
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
    // THE PARK IS UNCHANGED. City's waiting room is the bus shelter at the
    // kerb, because a city is where a vehicle pulls up and a citizen waits at
    // the street - so these benches stay furniture, and stay two.
    benches: ISO_COURTYARD_BENCHES,
    seatIdAt: () => null,
  });
  const cafe = buildIsoCafe({
    col: cafeBlock.rect.col,
    row: cafeBlock.rect.row,
    floorIndex,
    name: "Cafe",
  });

  // The skyline is raised before a single building is built, so the plan can
  // say where each one is PAINTED (D53) while it is still laying them out.
  const origin: IsoOrigin = { rows: pack.rows, stackHeight: pack.stackHeight };

  const rooms: OfficeRoom[] = [];
  const desks: OfficeDesk[] = [];
  const seats: OfficeSeat[] = [];
  const blocked: OfficeTilePos[] = [];
  const signs: OfficeSign[] = [];
  for (const block of district.blocks) {
    if (block.capacity === 0) continue;
    let visitTile: OfficeTilePos | null = null;
    for (let index = 0; index < block.capacity; index += 1) {
      const tiles = cityLotTiles(block, index);
      blocked.push(tiles.building, tiles.door);
      const seatId = seatIdOf(block, index);
      // A building is centred on its occupant's own anchor - the door tile's
      // foot, which is where the scene stands the character - and rises from
      // its lot's corner, so its clickable box is neither the lot nor the
      // door but the column the painter draws between them.
      const storeys = pack.storeysBySeatId.get(seatId) ?? CITY_MIN_STOREYS;
      const seat: OfficeSeat = {
        seatId,
        kind: "desk",
        deskTile: tiles.building,
        chairTile: tiles.door,
        facing: "down",
        hitTiles: { width: 1, height: LOT_ROWS },
        hitBox: isoCityBuildingBox(
          isoProjectAt(origin, tiles.building.col, tiles.building.row),
          isoProjectAt(origin, tiles.door.col + 0.5, tiles.door.row + 1).x,
          storeys,
        ),
        floorIndex,
        roomId: block.blockId,
        hostId: block.hostId,
        manager: block.kind === "hq",
        civicRoomId: null,
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
        civicRoomId: null,
      });
    }
  }

  const bands = cityCivicBandsOf(district);
  const bounds: OfficeTileRect = {
    col: district.frozen.col,
    row: 0,
    cols: district.frozen.widthBudget + ISO_DISTRICT_RING * 2,
    rows: bands.rows,
  };
  const capacity = cityCivicCapacity(district);
  const civic = buildCityCivic({
    hostId: district.frozen.hostId,
    floorIndex,
    origin,
    bounds,
    bands,
    beds: capacity.beds,
    chairs: capacity.chairs,
    courtyard,
  });
  const build: IsoDistrictBuild = {
    hostId: district.frozen.hostId,
    bounds,
    courtyard,
    cafe,
    rooms,
    props: [...courtyard.props, ...cafe.props, ...civic.props],
    blocked: [...blocked, ...civic.blocked],
    spots: [],
    signs: [...signs, ...civic.signs],
    civic: civic.rooms,
    road: civic.road,
  };
  return { build, desks, seats: [...seats, ...civic.seats] };
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
        civicRoomId: null,
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
      floors,
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
