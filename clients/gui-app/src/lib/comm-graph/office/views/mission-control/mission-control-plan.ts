/**
 * Mission control: one amphitheatre, one floor, console tiers facing a board.
 *
 * Geometry, top to bottom: a four-row `big-board` with a lounge beside it, the
 * HQ occupant at a podium facing the room, then tiers of 12+2r consoles. A
 * team is a contiguous run; its lead sits at the aisle end. Growth appends a
 * tier at the bottom and never moves a seat that already exists.
 */
import { compareByCreation } from "@/lib/comm-graph/office/office-layout";
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import type { OfficePopulation } from "@/lib/comm-graph/office/office-population";
import type { OfficePlanInput } from "@/lib/comm-graph/office/views/office-view";
import type {
  OfficeAgentInput,
  OfficeAmenity,
  OfficeAreaSign,
  OfficeDesk,
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

const VIEW_ID = "mission-control" as const;
const ROOM_ID = "hall";
const SEAT_ID_NONE = "-";
const FLOOR_INDEX = 0;

export const TIER_BASE_SEATS = 12;
export const TIER_SEAT_GROWTH = 2;
const AISLE_EVERY = 12;
export const ROWS_PER_TIER = 3;
const CONSOLE_WIDTH_TILES = 2;
const MIN_SIDE_TILES = 2;

const BOARD_ROWS = 4;
const BOARD_COLS = 24;
const LOUNGE_COLS = 18;
const WHITEBOARD_WIDTH_TILES = 2;

const HQ_CHAIR_ROW = 5;
const PODIUM_ROW = 6;
const WALKWAY_ROW = 7;
export const TIERS_ORIGIN_ROW = 8;
const FOOT_ROWS = 2;

const QUEUE_FACING: OfficeFacing = "down";
const CONSOLE_FACING: OfficeFacing = "up";
const PODIUM_FACING: OfficeFacing = "down";

const QUEUE_LENGTH = 4;
const ROOM_SIGN_WIDTH_TILES = 2;
const PLATE_WIDTH_TILES = 1;
const HOST_SIGN_WIDTH_TILES = 2;

export interface MissionControlTeamReserve {
  readonly teamId: string;
  readonly seatId: string;
}

export interface MissionControlHostBand {
  readonly col: number;
  readonly row: number;
  readonly sprite: OfficeSpriteName;
}

export interface MissionControlFrozen {
  readonly tierSeatCounts: ReadonlyArray<number>;
  readonly centerCol: number;
  readonly teamReserveSeatIds: ReadonlyArray<MissionControlTeamReserve>;
  readonly hostBands: ReadonlyArray<MissionControlHostBand>;
  readonly bandByTile: Readonly<Record<string, OfficeSpriteName>>;
  readonly podByTile: Readonly<Record<string, OfficeSpriteName>>;
}

interface ConsoleSlot {
  readonly index: number;
  readonly tier: number;
  readonly indexInTier: number;
  readonly deskTile: OfficeTilePos;
  readonly chairTile: OfficeTilePos;
  readonly aisleEnd: boolean;
}

interface SlotFill {
  agentId: string | null;
  teamId: string | null;
  hostId: string | null;
  reserveForTeamId: string | null;
}

interface Placement {
  readonly agentId: string | null;
  readonly teamId: string | null;
  readonly hostId: string | null;
  readonly reserveForTeamId: string | null;
}

interface LoungeFixture {
  readonly sprite: OfficeSpriteName;
  readonly col: number;
  readonly row: number;
  readonly widthTiles: number;
  readonly occupiable: boolean;
}

function tileKey(tile: OfficeTilePos): string {
  return `${tile.col},${tile.row}`;
}

function sameTile(left: OfficeTilePos, right: OfficeTilePos): boolean {
  return left.col === right.col && left.row === right.row;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTeamReserve(value: unknown): value is MissionControlTeamReserve {
  if (value === null || typeof value !== "object") return false;
  if (!("teamId" in value) || !("seatId" in value)) return false;
  return typeof value.teamId === "string" && typeof value.seatId === "string";
}

function isHostBand(value: unknown): value is MissionControlHostBand {
  if (value === null || typeof value !== "object") return false;
  if (!("col" in value) || !("row" in value) || !("sprite" in value)) {
    return false;
  }
  return (
    isFiniteNumber(value.col) &&
    isFiniteNumber(value.row) &&
    typeof value.sprite === "string"
  );
}

function isFrozenPayload(value: {
  readonly tierSeatCounts: unknown;
  readonly centerCol: unknown;
  readonly teamReserveSeatIds: unknown;
  readonly hostBands: unknown;
  readonly bandByTile: unknown;
  readonly podByTile: unknown;
}): boolean {
  if (!Array.isArray(value.tierSeatCounts)) return false;
  if (!value.tierSeatCounts.every(isFiniteNumber)) return false;
  if (!isFiniteNumber(value.centerCol)) return false;
  if (!Array.isArray(value.teamReserveSeatIds)) return false;
  if (!value.teamReserveSeatIds.every(isTeamReserve)) return false;
  if (!Array.isArray(value.hostBands)) return false;
  if (!value.hostBands.every(isHostBand)) return false;
  if (!isSpriteRecord(value.bandByTile)) return false;
  return isSpriteRecord(value.podByTile);
}

export function isMissionControlFrozen(
  value: unknown,
): value is MissionControlFrozen {
  if (value === null || typeof value !== "object") return false;
  if (!("tierSeatCounts" in value)) return false;
  if (!("centerCol" in value)) return false;
  if (!("teamReserveSeatIds" in value)) return false;
  if (!("hostBands" in value)) return false;
  if (!("bandByTile" in value)) return false;
  if (!("podByTile" in value)) return false;
  return isFrozenPayload(value);
}

function isSpriteRecord(
  value: unknown,
): value is Readonly<Record<string, OfficeSpriteName>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function frozenOf(
  layout: OfficeLayout | null,
): MissionControlFrozen | null {
  if (layout === null || layout.view !== VIEW_ID) return null;
  if (!isMissionControlFrozen(layout.frozen)) return null;
  return layout.frozen;
}

export function seatingWidth(seatCount: number): number {
  if (seatCount <= 0) return 0;
  const gaps = Math.floor((seatCount - 1) / AISLE_EVERY);
  return seatCount * CONSOLE_WIDTH_TILES + gaps;
}

export function tierSeatCount(tier: number): number {
  return TIER_BASE_SEATS + TIER_SEAT_GROWTH * tier;
}

function tiersToHold(seats: number): number[] {
  if (seats <= 0) return [];
  const counts: number[] = [];
  let capacity = 0;
  while (capacity < seats) {
    const next = tierSeatCount(counts.length);
    counts.push(next);
    capacity += next;
  }
  return counts;
}

function deskColInTier(indexInTier: number, originCol: number): number {
  const gapsBefore = Math.floor(indexInTier / AISLE_EVERY);
  return originCol + indexInTier * CONSOLE_WIDTH_TILES + gapsBefore;
}

export function originColFor(seatCount: number, centerCol: number): number {
  const width = seatingWidth(seatCount);
  return Math.max(MIN_SIDE_TILES, centerCol - Math.floor(width / 2));
}

function isAisleEnd(indexInTier: number, seatCount: number): boolean {
  if (indexInTier === 0 || indexInTier === seatCount - 1) return true;
  const inGroup = indexInTier % AISLE_EVERY;
  return inGroup === 0 || inGroup === AISLE_EVERY - 1;
}

function consoleSeatId(index: number): string {
  return `${SEAT_ID_NONE}/${FLOOR_INDEX}/${ROOM_ID}/${index}`;
}

function podiumSeatId(): string {
  return `${SEAT_ID_NONE}/${FLOOR_INDEX}/${ROOM_ID}/podium`;
}

function agentsById(
  agents: ReadonlyArray<OfficeAgentInput>,
): ReadonlyMap<string, OfficeAgentInput> {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

function podiumAgentId(
  partition: OfficePopulation,
  byId: ReadonlyMap<string, OfficeAgentInput>,
): string | null {
  let best: OfficeAgentInput | null = null;
  for (const member of partition.members.values()) {
    if (member.agentClass !== "hq") continue;
    const agent = byId.get(member.agentId);
    if (agent === undefined) continue;
    if (best === null || compareByCreation(agent, best) < 0) best = agent;
  }
  return best === null ? null : best.id;
}

function incumbentPodiumId(
  input: OfficePlanInput,
  byId: ReadonlyMap<string, OfficeAgentInput>,
): string | null {
  const occupied = input.occupancy.get(podiumSeatId());
  if (occupied !== undefined && byId.has(occupied)) return occupied;
  const previous = input.previous;
  if (previous !== null) {
    for (const desk of previous.desks.values()) {
      if (desk.seatId !== podiumSeatId()) continue;
      if (byId.has(desk.agentId)) return desk.agentId;
    }
  }
  return podiumAgentId(input.partition, byId);
}

function placementsFor(
  input: OfficePlanInput,
  hqId: string | null,
): ReadonlyArray<Placement> {
  const placements: Placement[] = [];
  for (const host of input.partition.hosts) {
    if (host.hqAgentId !== null && host.hqAgentId !== hqId) {
      placements.push({
        agentId: host.hqAgentId,
        teamId: null,
        hostId: host.hostId,
        reserveForTeamId: null,
      });
    }
    for (const team of host.teams) {
      for (const memberId of team.memberAgentIds) {
        if (memberId === hqId) continue;
        placements.push({
          agentId: memberId,
          teamId: team.teamId,
          hostId: host.hostId,
          reserveForTeamId: null,
        });
      }
      placements.push({
        agentId: null,
        teamId: team.teamId,
        hostId: host.hostId,
        reserveForTeamId: team.teamId,
      });
    }
    for (const solo of host.solos) {
      if (solo.agentId === hqId) continue;
      placements.push({
        agentId: solo.agentId,
        teamId: solo.teamId,
        hostId: host.hostId,
        reserveForTeamId: null,
      });
    }
  }
  return placements;
}

function initialCenterCol(tierCounts: ReadonlyArray<number>): number {
  let widest = BOARD_COLS + 1 + LOUNGE_COLS;
  for (const count of tierCounts) {
    widest = Math.max(widest, seatingWidth(count));
  }
  return Math.floor((widest + 2 * MIN_SIDE_TILES) / 2);
}

function colsFor(tierCounts: ReadonlyArray<number>, centerCol: number): number {
  let right = BOARD_COLS + 1 + LOUNGE_COLS + MIN_SIDE_TILES;
  const boardOrigin = Math.max(1, centerCol - Math.floor(BOARD_COLS / 2));
  right = Math.max(right, boardOrigin + BOARD_COLS + 1 + LOUNGE_COLS);
  for (const count of tierCounts) {
    const origin = originColFor(count, centerCol);
    right = Math.max(right, origin + seatingWidth(count) + MIN_SIDE_TILES);
  }
  return Math.max(right + 1, 16);
}

function rowsFor(tierCount: number): number {
  return TIERS_ORIGIN_ROW + tierCount * ROWS_PER_TIER + FOOT_ROWS;
}

function buildSlots(
  tierCounts: ReadonlyArray<number>,
  centerCol: number,
): ReadonlyArray<ConsoleSlot> {
  const slots: ConsoleSlot[] = [];
  let index = 0;
  for (let tier = 0; tier < tierCounts.length; tier += 1) {
    const count = tierCounts[tier];
    const origin = originColFor(count, centerCol);
    const consoleRow = TIERS_ORIGIN_ROW + tier * ROWS_PER_TIER;
    const chairRow = consoleRow + 1;
    for (let i = 0; i < count; i += 1) {
      const col = deskColInTier(i, origin);
      slots.push({
        index,
        tier,
        indexInTier: i,
        deskTile: { col, row: consoleRow },
        chairTile: { col, row: chairRow },
        aisleEnd: isAisleEnd(i, count),
      });
      index += 1;
    }
  }
  return slots;
}

function preferAisleEnd(left: ConsoleSlot, right: ConsoleSlot): ConsoleSlot {
  if (left.aisleEnd && !right.aisleEnd) return left;
  if (right.aisleEnd && !left.aisleEnd) return right;
  return left;
}

function emptyFills(count: number): SlotFill[] {
  const fills: SlotFill[] = [];
  for (let i = 0; i < count; i += 1) {
    fills.push({
      agentId: null,
      teamId: null,
      hostId: null,
      reserveForTeamId: null,
    });
  }
  return fills;
}

function fillRun(
  fills: SlotFill[],
  slots: ReadonlyArray<ConsoleSlot>,
  start: number,
  run: ReadonlyArray<Placement>,
): void {
  const end = start + run.length - 1;
  const left = slots[start];
  const right = slots[end];
  const namedLead = run.find(
    (placement) =>
      placement.agentId !== null &&
      placement.reserveForTeamId === null &&
      placement.agentId === placement.teamId,
  );
  const leadPlacement =
    namedLead === undefined
      ? run.find(
          (placement) =>
            placement.agentId !== null && placement.reserveForTeamId === null,
        )
      : namedLead;
  const reserve = run.find((placement) => placement.reserveForTeamId !== null);
  const members = run.filter(
    (placement) => placement !== leadPlacement && placement !== reserve,
  );
  const leadSlot = preferAisleEnd(left, right);
  const leadAtLeft = leadSlot.index === left.index;
  const ordered: Placement[] = [];
  if (leadAtLeft) {
    if (leadPlacement !== undefined) ordered.push(leadPlacement);
    ordered.push(...members);
    if (reserve !== undefined) ordered.push(reserve);
  } else {
    if (reserve !== undefined) ordered.push(reserve);
    ordered.push(...members);
    if (leadPlacement !== undefined) ordered.push(leadPlacement);
  }
  for (let offset = 0; offset < ordered.length; offset += 1) {
    const placement = ordered[offset];
    fills[start + offset] = {
      agentId: placement.agentId,
      teamId: placement.teamId,
      hostId: placement.hostId,
      reserveForTeamId: placement.reserveForTeamId,
    };
  }
}

function rangeIsFree(
  used: ReadonlyArray<boolean>,
  start: number,
  length: number,
): boolean {
  if (start < 0 || start + length > used.length) return false;
  for (let i = 0; i < length; i += 1) {
    if (used[start + i]) return false;
  }
  return true;
}

function slotIsRightAisle(
  slots: ReadonlyArray<ConsoleSlot>,
  index: number,
): boolean {
  const slot = slots[index];
  const inGroup = slot.indexInTier % AISLE_EVERY;
  if (inGroup === AISLE_EVERY - 1) return true;
  if (index === slots.length - 1) return true;
  return slots[index + 1].tier !== slot.tier;
}

function firstAisleAlignedStart(
  slots: ReadonlyArray<ConsoleSlot>,
  used: ReadonlyArray<boolean>,
  length: number,
): number {
  for (let i = 0; i < slots.length; i += 1) {
    if (!slots[i].aisleEnd) continue;
    if (slotIsRightAisle(slots, i)) {
      if (rangeIsFree(used, i - length + 1, length)) return i - length + 1;
    } else if (rangeIsFree(used, i, length)) {
      return i;
    }
  }
  return -1;
}

function markUsed(used: boolean[], start: number, length: number): void {
  for (let i = 0; i < length; i += 1) used[start + i] = true;
}

function firstUnused(used: ReadonlyArray<boolean>): number {
  for (let i = 0; i < used.length; i += 1) {
    if (!used[i]) return i;
  }
  return -1;
}

function fillPacked(
  fills: SlotFill[],
  slots: ReadonlyArray<ConsoleSlot>,
  placements: ReadonlyArray<Placement>,
): boolean {
  const used: boolean[] = [];
  for (let i = 0; i < fills.length; i += 1) used.push(false);

  let index = 0;
  const singles: Placement[] = [];
  while (index < placements.length) {
    const current = placements[index];
    if (current.teamId !== null && current.reserveForTeamId === null) {
      const teamId = current.teamId;
      const run: Placement[] = [];
      while (index < placements.length && placements[index].teamId === teamId) {
        run.push(placements[index]);
        index += 1;
      }
      const start = firstAisleAlignedStart(slots, used, run.length);
      if (start < 0) return false;
      fillRun(fills, slots, start, run);
      markUsed(used, start, run.length);
      continue;
    }
    singles.push(current);
    index += 1;
  }
  for (const placement of singles) {
    const free = firstUnused(used);
    if (free < 0) return false;
    fills[free] = {
      agentId: placement.agentId,
      teamId: placement.teamId,
      hostId: placement.hostId,
      reserveForTeamId: placement.reserveForTeamId,
    };
    used[free] = true;
  }
  return true;
}

function occupiedAgentIds(
  occupancy: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  return new Set(occupancy.values());
}

function appendTiersUntil(counts: number[], needed: number): void {
  let capacity = 0;
  for (const count of counts) capacity += count;
  while (capacity < needed) {
    const next = tierSeatCount(counts.length);
    counts.push(next);
    capacity += next;
  }
}

function hostOfAgent(input: OfficePlanInput, agentId: string): string | null {
  return input.partition.members.get(agentId)?.hostId ?? null;
}

function teamOfAgent(input: OfficePlanInput, agentId: string): string | null {
  return input.partition.members.get(agentId)?.teamId ?? null;
}

interface Packing {
  readonly tierCounts: ReadonlyArray<number>;
  readonly centerCol: number;
  readonly cols: number;
  readonly rows: number;
  readonly slots: ReadonlyArray<ConsoleSlot>;
  readonly fills: ReadonlyArray<SlotFill>;
  readonly hqId: string | null;
  readonly podiumCol: number;
  readonly boardOriginCol: number;
  readonly loungeOriginCol: number;
  readonly teamReserves: ReadonlyArray<MissionControlTeamReserve>;
}

function packFresh(input: OfficePlanInput): Packing {
  const byId = agentsById(input.agents);
  const hqId = podiumAgentId(input.partition, byId);
  const placements = placementsFor(input, hqId);
  const tierCounts = tiersToHold(placements.length);
  let centerCol = initialCenterCol(tierCounts);
  let slots = buildSlots(tierCounts, centerCol);
  let fills = emptyFills(slots.length);
  let seated = fillPacked(fills, slots, placements);
  while (!seated && tierCounts.length < 64) {
    appendTiersUntil(tierCounts, slots.length + 1);
    centerCol = initialCenterCol(tierCounts);
    slots = buildSlots(tierCounts, centerCol);
    fills = emptyFills(slots.length);
    seated = fillPacked(fills, slots, placements);
  }
  return finishPacking({
    tierCounts,
    centerCol,
    cols: colsFor(tierCounts, centerCol),
    rows: rowsFor(tierCounts.length),
    slots,
    fills,
    hqId,
  });
}

function consoleIndexFromSeatId(seatId: string): number | null {
  const prefix = `${SEAT_ID_NONE}/${FLOOR_INDEX}/${ROOM_ID}/`;
  if (!seatId.startsWith(prefix)) return null;
  const raw = seatId.slice(prefix.length);
  if (raw === "podium") return null;
  const index = Number.parseInt(raw, 10);
  if (!Number.isFinite(index) || index < 0) return null;
  return index;
}

function collectArrivals(
  input: OfficePlanInput,
  byId: ReadonlyMap<string, OfficeAgentInput>,
  hqId: string | null,
): ReadonlyArray<OfficeAgentInput> {
  const spokenFor = occupiedAgentIds(input.occupancy);
  const arrivals: OfficeAgentInput[] = [];
  for (const agent of input.agents) {
    if (agent.id === hqId) continue;
    if (spokenFor.has(agent.id)) continue;
    arrivals.push(agent);
  }
  for (const agentId of input.needsCapacity) {
    if (agentId === hqId) continue;
    if (spokenFor.has(agentId)) continue;
    if (arrivals.some((agent) => agent.id === agentId)) continue;
    const agent = byId.get(agentId);
    if (agent !== undefined) arrivals.push(agent);
  }
  return arrivals;
}

function pinOccupancy(
  input: OfficePlanInput,
  byId: ReadonlyMap<string, OfficeAgentInput>,
  fills: SlotFill[],
): void {
  for (const [seatId, agentId] of input.occupancy) {
    if (!byId.has(agentId)) continue;
    const index = consoleIndexFromSeatId(seatId);
    if (index === null || index >= fills.length) continue;
    fills[index] = {
      agentId,
      teamId: teamOfAgent(input, agentId),
      hostId: hostOfAgent(input, agentId),
      reserveForTeamId: null,
    };
  }
}

/**
 * Keep last plan's assignments when occupancy is empty (a status-only replan
 * still passes `previous`). Occupancy wins where it already named a seat.
 */
function pinPreviousDesks(
  previousLayout: OfficeLayout | null,
  input: OfficePlanInput,
  byId: ReadonlyMap<string, OfficeAgentInput>,
  fills: SlotFill[],
): void {
  if (previousLayout === null) return;
  for (const desk of previousLayout.desks.values()) {
    if (desk.kind !== "console") continue;
    if (!byId.has(desk.agentId)) continue;
    const index = consoleIndexFromSeatId(desk.seatId);
    if (index === null || index >= fills.length) continue;
    if (fills[index].agentId !== null) continue;
    fills[index] = {
      agentId: desk.agentId,
      teamId: teamOfAgent(input, desk.agentId),
      hostId: hostOfAgent(input, desk.agentId),
      reserveForTeamId: null,
    };
  }
}

function copyPreviousEmptyHosts(
  previousLayout: OfficeLayout | null,
  fills: SlotFill[],
): void {
  if (previousLayout === null) return;
  for (const seat of previousLayout.seats.values()) {
    if (seat.kind !== "console") continue;
    const index = consoleIndexFromSeatId(seat.seatId);
    if (index === null || index >= fills.length) continue;
    if (fills[index].agentId !== null) continue;
    fills[index].hostId = seat.hostId;
  }
}

function restoreTeamReserves(
  previous: MissionControlFrozen,
  fills: SlotFill[],
): Map<string, number> {
  const reserveByTeam = new Map<string, number>();
  for (const entry of previous.teamReserveSeatIds) {
    const index = consoleIndexFromSeatId(entry.seatId);
    if (index === null || index >= fills.length) continue;
    reserveByTeam.set(entry.teamId, index);
    if (fills[index].agentId === null) {
      fills[index].reserveForTeamId = entry.teamId;
      fills[index].teamId = entry.teamId;
    }
  }
  return reserveByTeam;
}

function firstOpenFill(fills: ReadonlyArray<SlotFill>, start: number): number {
  for (let i = start; i < fills.length; i += 1) {
    if (fills[i].agentId === null && fills[i].reserveForTeamId === null) {
      return i;
    }
  }
  return -1;
}

function lastTierStartIndex(slots: ReadonlyArray<ConsoleSlot>): number {
  if (slots.length === 0) return 0;
  const last = slots[slots.length - 1];
  return last.index - last.indexInTier;
}

function extendFillsTo(fills: SlotFill[], count: number): void {
  while (fills.length < count) {
    fills.push({
      agentId: null,
      teamId: null,
      hostId: null,
      reserveForTeamId: null,
    });
  }
}

function reserveIndexFor(
  fills: ReadonlyArray<SlotFill>,
  reserveByTeam: ReadonlyMap<string, number>,
  teamId: string | null,
): number {
  if (teamId === null) return -1;
  const reserved = reserveByTeam.get(teamId);
  if (reserved === undefined) return -1;
  if (reserved < 0 || reserved >= fills.length) return -1;
  if (fills[reserved].agentId !== null) return -1;
  return reserved;
}

function growOpenIndex(request: {
  fills: SlotFill[];
  slots: ConsoleSlot[];
  counts: number[];
  readonly centerCol: number;
  readonly reserveByTeam: ReadonlyMap<string, number>;
  readonly teamId: string | null;
}): number {
  const { fills, slots, counts, centerCol, reserveByTeam, teamId } = request;
  let index = reserveIndexFor(fills, reserveByTeam, teamId);
  if (index >= 0) return index;
  index = firstOpenFill(fills, lastTierStartIndex(slots));
  if (index >= 0) return index;
  const previousLength = fills.length;
  appendTiersUntil(counts, slots.length + 1);
  const grown = buildSlots(counts, centerCol);
  slots.length = 0;
  for (const slot of grown) slots.push(slot);
  extendFillsTo(fills, slots.length);
  return firstOpenFill(fills, previousLength);
}

function fillOccupied(fills: ReadonlyArray<SlotFill>): boolean[] {
  const used: boolean[] = [];
  for (const fill of fills) {
    used.push(fill.agentId !== null || fill.reserveForTeamId !== null);
  }
  return used;
}

function growSlots(request: {
  fills: SlotFill[];
  slots: ConsoleSlot[];
  counts: number[];
  readonly centerCol: number;
}): void {
  appendTiersUntil(request.counts, request.slots.length + 1);
  const grown = buildSlots(request.counts, request.centerCol);
  request.slots.length = 0;
  for (const slot of grown) request.slots.push(slot);
  extendFillsTo(request.fills, request.slots.length);
}

function seatOneArrival(request: {
  readonly input: OfficePlanInput;
  readonly agent: OfficeAgentInput;
  readonly teamId: string | null;
  fills: SlotFill[];
  slots: ConsoleSlot[];
  counts: number[];
  readonly centerCol: number;
  readonly takenAgents: Set<string>;
  readonly reserveByTeam: Map<string, number>;
}): void {
  const { agent, teamId, fills, takenAgents, reserveByTeam } = request;
  const index = growOpenIndex({
    fills,
    slots: request.slots,
    counts: request.counts,
    centerCol: request.centerCol,
    reserveByTeam,
    teamId,
  });
  if (index < 0) return;
  fills[index] = {
    agentId: agent.id,
    teamId:
      teamId ?? request.input.partition.members.get(agent.id)?.teamId ?? null,
    hostId: hostOfAgent(request.input, agent.id),
    reserveForTeamId: null,
  };
  takenAgents.add(agent.id);
  if (teamId !== null && reserveByTeam.get(teamId) === index) {
    reserveByTeam.delete(teamId);
  }
}

function membersInTeamOrder(
  input: OfficePlanInput,
  teamId: string,
  members: ReadonlyArray<OfficeAgentInput>,
): ReadonlyArray<OfficeAgentInput> {
  const remaining = new Map(members.map((agent) => [agent.id, agent] as const));
  const ordered: OfficeAgentInput[] = [];
  const team = input.partition.teamOf(teamId);
  const roster =
    team === null ? members.map((agent) => agent.id) : team.memberAgentIds;
  for (const id of roster) {
    const agent = remaining.get(id);
    if (agent === undefined) continue;
    ordered.push(agent);
    remaining.delete(id);
  }
  for (const leftover of remaining.values()) ordered.push(leftover);
  return ordered;
}

function placeNewTeamRun(request: {
  readonly input: OfficePlanInput;
  readonly teamId: string;
  readonly members: ReadonlyArray<OfficeAgentInput>;
  fills: SlotFill[];
  slots: ConsoleSlot[];
  counts: number[];
  readonly centerCol: number;
  readonly takenAgents: Set<string>;
  readonly reserveByTeam: Map<string, number>;
}): void {
  const members = membersInTeamOrder(
    request.input,
    request.teamId,
    request.members,
  );
  const { teamId, fills, slots, takenAgents, reserveByTeam } = request;
  const hostId = hostOfAgent(request.input, teamId);
  const length = members.length + 1;
  let start = firstAisleAlignedStart(slots, fillOccupied(fills), length);
  while (start < 0 && request.counts.length < 64) {
    growSlots({
      fills,
      slots,
      counts: request.counts,
      centerCol: request.centerCol,
    });
    start = firstAisleAlignedStart(slots, fillOccupied(fills), length);
  }
  if (start < 0) return;
  const run: Placement[] = [];
  for (const agent of members) {
    run.push({
      agentId: agent.id,
      teamId,
      hostId,
      reserveForTeamId: null,
    });
  }
  run.push({
    agentId: null,
    teamId,
    hostId,
    reserveForTeamId: teamId,
  });
  fillRun(fills, slots, start, run);
  for (const agent of members) takenAgents.add(agent.id);
  for (let i = start; i < start + length; i += 1) {
    if (fills[i].reserveForTeamId === teamId) {
      reserveByTeam.set(teamId, i);
      break;
    }
  }
}

function seatArrivals(request: {
  readonly input: OfficePlanInput;
  readonly arrivals: ReadonlyArray<OfficeAgentInput>;
  readonly established: ReadonlySet<string>;
  fills: SlotFill[];
  slots: ConsoleSlot[];
  counts: number[];
  readonly centerCol: number;
  readonly takenAgents: Set<string>;
  readonly reserveByTeam: Map<string, number>;
}): void {
  const { input, arrivals, established, takenAgents, reserveByTeam } = request;
  const newTeams = new Map<string, OfficeAgentInput[]>();
  const joiners: OfficeAgentInput[] = [];
  const solos: OfficeAgentInput[] = [];
  for (const agent of arrivals) {
    if (takenAgents.has(agent.id)) continue;
    const member = input.partition.members.get(agent.id);
    const teamId = member?.agentClass === "team" ? member.teamId : null;
    if (teamId === null) {
      solos.push(agent);
      continue;
    }
    if (established.has(teamId) || reserveByTeam.has(teamId)) {
      joiners.push(agent);
      continue;
    }
    const group = newTeams.get(teamId) ?? [];
    group.push(agent);
    newTeams.set(teamId, group);
  }
  for (const agent of joiners) {
    const member = input.partition.members.get(agent.id);
    seatOneArrival({
      input,
      agent,
      teamId: member?.agentClass === "team" ? member.teamId : null,
      fills: request.fills,
      slots: request.slots,
      counts: request.counts,
      centerCol: request.centerCol,
      takenAgents,
      reserveByTeam,
    });
  }
  for (const [teamId, members] of newTeams) {
    placeNewTeamRun({
      input,
      teamId,
      members,
      fills: request.fills,
      slots: request.slots,
      counts: request.counts,
      centerCol: request.centerCol,
      takenAgents,
      reserveByTeam,
    });
  }
  for (const agent of solos) {
    seatOneArrival({
      input,
      agent,
      teamId: null,
      fills: request.fills,
      slots: request.slots,
      counts: request.counts,
      centerCol: request.centerCol,
      takenAgents,
      reserveByTeam,
    });
  }
}

function establishedTeamIds(
  input: OfficePlanInput,
  previous: MissionControlFrozen,
): Set<string> {
  const known = new Set(
    previous.teamReserveSeatIds.map((entry) => entry.teamId),
  );
  const layout = input.previous;
  if (layout === null) return known;
  for (const desk of layout.desks.values()) {
    const teamId = teamOfAgent(input, desk.agentId);
    if (teamId !== null) known.add(teamId);
  }
  return known;
}

function ensureTeamReserves(request: {
  readonly input: OfficePlanInput;
  readonly established: ReadonlySet<string>;
  fills: SlotFill[];
  slots: ConsoleSlot[];
  counts: number[];
  readonly centerCol: number;
  readonly reserveByTeam: Map<string, number>;
}): void {
  const { input, established, fills, reserveByTeam } = request;
  for (const host of input.partition.hosts) {
    for (const team of host.teams) {
      if (established.has(team.teamId)) continue;
      if (reserveByTeam.has(team.teamId)) continue;
      const index = growOpenIndex({
        fills,
        slots: request.slots,
        counts: request.counts,
        centerCol: request.centerCol,
        reserveByTeam,
        teamId: null,
      });
      if (index < 0) continue;
      fills[index] = {
        agentId: null,
        teamId: team.teamId,
        hostId: host.hostId,
        reserveForTeamId: team.teamId,
      };
      reserveByTeam.set(team.teamId, index);
    }
  }
}

function packFromPrevious(
  input: OfficePlanInput,
  previous: MissionControlFrozen,
): Packing {
  const byId = agentsById(input.agents);
  const hqId = incumbentPodiumId(input, byId);
  const counts = [...previous.tierSeatCounts];
  const centerCol = previous.centerCol;
  const arrivals = collectArrivals(input, byId, hqId);

  const slots = [...buildSlots(counts, centerCol)];
  const fills = emptyFills(slots.length);
  pinOccupancy(input, byId, fills);
  pinPreviousDesks(input.previous, input, byId, fills);

  const takenAgents = new Set<string>();
  for (const fill of fills) {
    if (fill.agentId !== null) takenAgents.add(fill.agentId);
  }
  const reserveByTeam = restoreTeamReserves(previous, fills);
  copyPreviousEmptyHosts(input.previous, fills);
  const established = establishedTeamIds(input, previous);
  seatArrivals({
    input,
    arrivals,
    established,
    fills,
    slots,
    counts,
    centerCol,
    takenAgents,
    reserveByTeam,
  });
  ensureTeamReserves({
    input,
    established,
    fills,
    slots,
    counts,
    centerCol,
    reserveByTeam,
  });

  return finishPacking({
    tierCounts: counts,
    centerCol,
    cols: colsFor(counts, centerCol),
    rows: rowsFor(counts.length),
    slots,
    fills,
    hqId,
  });
}

function finishPacking(request: {
  readonly tierCounts: ReadonlyArray<number>;
  readonly centerCol: number;
  readonly cols: number;
  readonly rows: number;
  readonly slots: ReadonlyArray<ConsoleSlot>;
  readonly fills: ReadonlyArray<SlotFill>;
  readonly hqId: string | null;
}): Packing {
  const boardOriginCol = Math.max(
    1,
    request.centerCol - Math.floor(BOARD_COLS / 2),
  );
  const loungeOriginCol = boardOriginCol + BOARD_COLS + 1;
  const podiumCol = Math.max(1, request.centerCol - 1);
  const teamReserves: MissionControlTeamReserve[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < request.fills.length; i += 1) {
    const fill = request.fills[i];
    if (fill.reserveForTeamId === null) continue;
    if (fill.agentId !== null) continue;
    if (seen.has(fill.reserveForTeamId)) continue;
    seen.add(fill.reserveForTeamId);
    teamReserves.push({
      teamId: fill.reserveForTeamId,
      seatId: consoleSeatId(i),
    });
  }
  return {
    tierCounts: request.tierCounts,
    centerCol: request.centerCol,
    cols: request.cols,
    rows: request.rows,
    slots: request.slots,
    fills: request.fills,
    hqId: request.hqId,
    podiumCol,
    boardOriginCol,
    loungeOriginCol,
    teamReserves,
  };
}

function pack(input: OfficePlanInput): Packing {
  const previous = frozenOf(input.previous);
  if (previous !== null) return packFromPrevious(input, previous);
  return packFresh(input);
}

function inBounds(cols: number, rows: number, tile: OfficeTilePos): boolean {
  return tile.col >= 0 && tile.row >= 0 && tile.col < cols && tile.row < rows;
}

function blankWalkable(cols: number, rows: number): boolean[][] {
  const grid: boolean[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < cols; col += 1) line.push(true);
    grid.push(line);
  }
  return grid;
}

function blockTile(
  walkable: boolean[][],
  cols: number,
  rows: number,
  tile: OfficeTilePos,
): void {
  if (!inBounds(cols, rows, tile)) return;
  walkable[tile.row][tile.col] = false;
}

function loungeFixtures(loungeOriginCol: number): ReadonlyArray<LoungeFixture> {
  const c = loungeOriginCol;
  return [
    {
      sprite: "reception",
      col: c + 3,
      row: 1,
      widthTiles: 2,
      occupiable: false,
    },
    {
      sprite: "coffee-machine",
      col: c + 10,
      row: 2,
      widthTiles: 1,
      occupiable: false,
    },
    {
      sprite: "water-cooler",
      col: c + 12,
      row: 2,
      widthTiles: 1,
      occupiable: false,
    },
    { sprite: "plant", col: c + 14, row: 2, widthTiles: 1, occupiable: false },
    {
      sprite: "cafe-table",
      col: c + 1,
      row: 3,
      widthTiles: 2,
      occupiable: false,
    },
    {
      sprite: "cafe-table",
      col: c + 5,
      row: 3,
      widthTiles: 2,
      occupiable: false,
    },
    { sprite: "bin", col: c + 16, row: 3, widthTiles: 1, occupiable: false },
    { sprite: "sofa", col: c + 1, row: 5, widthTiles: 2, occupiable: false },
    { sprite: "armchair", col: c + 5, row: 5, widthTiles: 1, occupiable: true },
    {
      sprite: "bookcase",
      col: c + 7,
      row: 5,
      widthTiles: 1,
      occupiable: false,
    },
    {
      sprite: "sleep-bag",
      col: c + 10,
      row: 5,
      widthTiles: 1,
      occupiable: true,
    },
    {
      sprite: "sleep-bag",
      col: c + 12,
      row: 5,
      widthTiles: 1,
      occupiable: true,
    },
    {
      sprite: "pingpong-table",
      col: c + 8,
      row: 6,
      widthTiles: 2,
      occupiable: false,
    },
    {
      sprite: "treadmill",
      col: c + 12,
      row: 6,
      widthTiles: 1,
      occupiable: true,
    },
  ];
}

function blockFixture(
  walkable: boolean[][],
  cols: number,
  rows: number,
  fixture: LoungeFixture,
): void {
  if (fixture.occupiable) return;
  for (let offset = 0; offset < fixture.widthTiles; offset += 1) {
    blockTile(walkable, cols, rows, {
      col: fixture.col + offset,
      row: fixture.row,
    });
  }
}

function buildWalkable(packing: Packing): boolean[][] {
  const { cols, rows } = packing;
  const walkable = blankWalkable(cols, rows);
  for (
    let col = packing.boardOriginCol;
    col < packing.boardOriginCol + BOARD_COLS;
    col += 1
  ) {
    for (let row = 0; row < BOARD_ROWS; row += 1) {
      blockTile(walkable, cols, rows, { col, row });
    }
  }
  blockTile(walkable, cols, rows, {
    col: packing.podiumCol,
    row: PODIUM_ROW,
  });
  blockTile(walkable, cols, rows, {
    col: packing.podiumCol + 1,
    row: PODIUM_ROW,
  });
  blockTile(walkable, cols, rows, {
    col: packing.podiumCol,
    row: HQ_CHAIR_ROW,
  });
  for (const slot of packing.slots) {
    blockTile(walkable, cols, rows, slot.deskTile);
    blockTile(walkable, cols, rows, {
      col: slot.deskTile.col + 1,
      row: slot.deskTile.row,
    });
    blockTile(walkable, cols, rows, slot.chairTile);
  }
  for (const fixture of loungeFixtures(packing.loungeOriginCol)) {
    blockFixture(walkable, cols, rows, fixture);
  }
  const spine = packing.loungeOriginCol;
  for (let row = 0; row <= WALKWAY_ROW; row += 1) {
    if (inBounds(cols, rows, { col: spine, row })) {
      walkable[row][spine] = true;
    }
  }
  blockTile(walkable, cols, rows, {
    col: packing.podiumCol,
    row: HQ_CHAIR_ROW,
  });
  return walkable;
}

interface SpotSink {
  readonly spots: OfficeErrandSpot[];
  readonly used: Set<string>;
  readonly walkable: boolean[][];
  readonly cols: number;
  readonly rows: number;
}

interface SpotSpec {
  readonly kind: OfficeErrandSpot["kind"];
  readonly tile: OfficeTilePos;
  readonly facing: OfficeFacing;
  readonly fixtureId: string;
  readonly actionTile: OfficeTilePos | null;
}

function addSpot(sink: SpotSink, spec: SpotSpec): void {
  if (!inBounds(sink.cols, sink.rows, spec.tile)) return;
  if (!sink.walkable[spec.tile.row][spec.tile.col]) return;
  const key = tileKey(spec.tile);
  if (sink.used.has(key)) return;
  sink.used.add(key);
  sink.spots.push({
    kind: spec.kind,
    tile: spec.tile,
    facing: spec.facing,
    audience: { kind: "floor" },
    fixtureId: spec.fixtureId,
    approachTile: spec.tile,
    actionTile: spec.actionTile,
    floorIndex: FLOOR_INDEX,
  });
}

function loungeSpotSpecs(loungeOriginCol: number): ReadonlyArray<SpotSpec> {
  const c = loungeOriginCol;
  return [
    {
      kind: "coffee",
      tile: { col: c + 10, row: 3 },
      facing: "up",
      fixtureId: "lounge/coffee",
      actionTile: { col: c + 10, row: 2 },
    },
    {
      kind: "cooler",
      tile: { col: c + 11, row: 2 },
      facing: "right",
      fixtureId: "lounge/cooler",
      actionTile: { col: c + 12, row: 2 },
    },
    {
      kind: "cooler",
      tile: { col: c + 13, row: 2 },
      facing: "left",
      fixtureId: "lounge/cooler",
      actionTile: { col: c + 12, row: 2 },
    },
    {
      kind: "water-plant",
      tile: { col: c + 14, row: 3 },
      facing: "up",
      fixtureId: "lounge/plant",
      actionTile: { col: c + 14, row: 2 },
    },
    {
      kind: "cafe",
      tile: { col: c + 1, row: 4 },
      facing: "up",
      fixtureId: "lounge/cafe/0",
      actionTile: { col: c + 1, row: 3 },
    },
    {
      kind: "cafe",
      tile: { col: c + 2, row: 4 },
      facing: "up",
      fixtureId: "lounge/cafe/0",
      actionTile: { col: c + 1, row: 3 },
    },
    {
      kind: "cafe",
      tile: { col: c + 5, row: 4 },
      facing: "up",
      fixtureId: "lounge/cafe/1",
      actionTile: { col: c + 5, row: 3 },
    },
    {
      kind: "cafe",
      tile: { col: c + 6, row: 4 },
      facing: "up",
      fixtureId: "lounge/cafe/1",
      actionTile: { col: c + 5, row: 3 },
    },
    {
      kind: "bin",
      tile: { col: c + 16, row: 4 },
      facing: "up",
      fixtureId: "lounge/bin",
      actionTile: { col: c + 16, row: 3 },
    },
    {
      kind: "sofa",
      tile: { col: c + 1, row: 6 },
      facing: "up",
      fixtureId: "lounge/sofa",
      actionTile: { col: c + 1, row: 5 },
    },
    {
      kind: "sofa",
      tile: { col: c + 2, row: 6 },
      facing: "up",
      fixtureId: "lounge/sofa",
      actionTile: { col: c + 1, row: 5 },
    },
    {
      kind: "read",
      tile: { col: c + 5, row: 5 },
      facing: "down",
      fixtureId: "lounge/read",
      actionTile: { col: c + 7, row: 5 },
    },
    {
      kind: "nap",
      tile: { col: c + 10, row: 5 },
      facing: "down",
      fixtureId: "lounge/nap/0",
      actionTile: null,
    },
    {
      kind: "nap",
      tile: { col: c + 12, row: 5 },
      facing: "down",
      fixtureId: "lounge/nap/1",
      actionTile: null,
    },
    {
      kind: "pingpong",
      tile: { col: c + 7, row: 6 },
      facing: "right",
      fixtureId: "lounge/pingpong",
      actionTile: { col: c + 8, row: 6 },
    },
    {
      kind: "pingpong",
      tile: { col: c + 10, row: 6 },
      facing: "left",
      fixtureId: "lounge/pingpong",
      actionTile: { col: c + 8, row: 6 },
    },
    {
      kind: "treadmill",
      tile: { col: c + 12, row: 6 },
      facing: "up",
      fixtureId: "lounge/treadmill",
      actionTile: null,
    },
  ];
}

function buildSpots(
  packing: Packing,
  walkable: boolean[][],
  reserved: ReadonlySet<string>,
): ReadonlyArray<OfficeErrandSpot> {
  const spots: OfficeErrandSpot[] = [];
  const sink: SpotSink = {
    spots,
    used: new Set(reserved),
    walkable,
    cols: packing.cols,
    rows: packing.rows,
  };
  for (const spec of loungeSpotSpecs(packing.loungeOriginCol)) {
    addSpot(sink, spec);
  }
  for (
    let col = packing.boardOriginCol;
    col < packing.boardOriginCol + BOARD_COLS;
    col += 4
  ) {
    addSpot(sink, {
      kind: "whiteboard",
      tile: { col, row: BOARD_ROWS },
      facing: "up",
      fixtureId: `board/whiteboard/${col}`,
      actionTile: { col, row: BOARD_ROWS - 1 },
    });
  }
  return spots;
}

function buildProps(packing: Packing): ReadonlyArray<OfficeProp> {
  const props: OfficeProp[] = [];
  for (let row = 0; row < BOARD_ROWS; row += 1) {
    for (
      let col = packing.boardOriginCol;
      col < packing.boardOriginCol + BOARD_COLS;
      col += WHITEBOARD_WIDTH_TILES
    ) {
      props.push({ sprite: { name: "whiteboard" }, tile: { col, row } });
    }
  }
  for (const fixture of loungeFixtures(packing.loungeOriginCol)) {
    props.push({
      sprite: { name: fixture.sprite },
      tile: { col: fixture.col, row: fixture.row },
    });
  }
  return props;
}

function corridorTilesOf(
  packing: Packing,
  walkable: boolean[][],
  reserved: ReadonlySet<string>,
): ReadonlyArray<OfficeTilePos> {
  const tiles: OfficeTilePos[] = [];
  for (let tier = 0; tier < packing.tierCounts.length; tier += 1) {
    const aisleRow = TIERS_ORIGIN_ROW + tier * ROWS_PER_TIER + 2;
    for (let col = 1; col < packing.cols - 1; col += 1) {
      if (!walkable[aisleRow][col]) continue;
      const tile: OfficeTilePos = { col, row: aisleRow };
      if (reserved.has(tileKey(tile))) continue;
      tiles.push(tile);
    }
  }
  for (let col = 1; col < packing.cols - 1; col += 1) {
    if (!walkable[WALKWAY_ROW][col]) continue;
    const tile: OfficeTilePos = { col, row: WALKWAY_ROW };
    if (reserved.has(tileKey(tile))) continue;
    tiles.push(tile);
  }
  return tiles;
}

function queueTiles(request: {
  readonly packing: Packing;
  readonly walkable: boolean[][];
  readonly reception: OfficeTilePos;
  readonly door: OfficeTilePos;
  readonly lobby: OfficeTilePos;
}): ReadonlyArray<OfficeTilePos> {
  const { packing, walkable, reception, door, lobby } = request;
  const candidates: OfficeTilePos[] = [
    { col: reception.col, row: reception.row + 1 },
    { col: reception.col + 1, row: reception.row + 1 },
    { col: reception.col + 2, row: reception.row },
    { col: reception.col + 2, row: reception.row + 1 },
    { col: reception.col - 1, row: reception.row },
    { col: reception.col - 1, row: reception.row + 1 },
    { col: reception.col, row: reception.row + 2 },
    { col: reception.col + 1, row: reception.row + 2 },
  ];
  const tiles: OfficeTilePos[] = [];
  for (const tile of candidates) {
    if (tiles.length >= QUEUE_LENGTH) break;
    if (!inBounds(packing.cols, packing.rows, tile)) continue;
    if (!walkable[tile.row][tile.col]) continue;
    if (sameTile(tile, door) || sameTile(tile, lobby)) continue;
    if (tiles.some((chosen) => sameTile(chosen, tile))) continue;
    tiles.push(tile);
  }
  return tiles;
}

function uniqueHosts(input: OfficePlanInput): ReadonlyArray<string | null> {
  const hosts: Array<string | null> = [];
  for (const host of input.partition.hosts) {
    hosts.push(host.hostId);
  }
  if (hosts.length === 0) hosts.push(null);
  return hosts;
}

function buildSigns(
  packing: Packing,
  input: OfficePlanInput,
  byId: ReadonlyMap<string, OfficeAgentInput>,
): ReadonlyArray<OfficeSign> {
  const signs: OfficeSign[] = [];
  const agentIds = input.agents.map((agent) => agent.id);
  const hq = packing.hqId === null ? null : byId.get(packing.hqId);
  signs.push({
    kind: "hq-board",
    tile: { col: packing.boardOriginCol, row: 0 },
    widthTiles: Math.min(8, BOARD_COLS),
    text: hq === undefined || hq === null ? "" : hq.name,
    ownerAgentId: packing.hqId,
    hostId: hq === undefined || hq === null ? null : hq.hostId,
    agentIds,
  });
  signs.push({
    kind: "area",
    tile: { col: packing.loungeOriginCol, row: 0 },
    widthTiles: ROOM_SIGN_WIDTH_TILES,
    text: "Lounge",
    ownerAgentId: null,
    hostId: null,
    agentIds: [],
  });
  const leadPlates = new Map<string, OfficeTilePos>();
  for (let i = 0; i < packing.slots.length; i += 1) {
    const fill = packing.fills[i];
    if (fill.agentId === null || fill.teamId === null) continue;
    if (fill.agentId !== fill.teamId) continue;
    const slot = packing.slots[i];
    const towardAisle =
      slot.indexInTier === 0 || slot.aisleEnd
        ? { col: slot.deskTile.col - 1, row: slot.chairTile.row }
        : {
            col: slot.deskTile.col + CONSOLE_WIDTH_TILES,
            row: slot.chairTile.row,
          };
    leadPlates.set(fill.teamId, towardAisle);
  }
  for (const [teamId, tile] of leadPlates) {
    const lead = byId.get(teamId);
    signs.push({
      kind: "plate",
      tile,
      widthTiles: PLATE_WIDTH_TILES,
      text: lead === undefined ? teamId : lead.name,
      ownerAgentId: teamId,
      hostId: lead === undefined ? null : lead.hostId,
      agentIds: [],
    });
  }
  const hosts = uniqueHosts(input);
  const stride = HOST_SIGN_WIDTH_TILES + 2;
  const left = 1;
  const maxStart = packing.cols - 1 - HOST_SIGN_WIDTH_TILES;
  const perRow = Math.max(1, Math.floor((maxStart - left) / stride) + 1);
  for (let i = 0; i < hosts.length; i += 1) {
    const rowIndex = Math.floor(i / perRow);
    const colIndex = i % perRow;
    signs.push({
      kind: "host",
      tile: {
        col: left + colIndex * stride,
        row: packing.rows - 1 - rowIndex,
      },
      widthTiles: HOST_SIGN_WIDTH_TILES,
      text: "",
      ownerAgentId: null,
      hostId: hosts[i],
      agentIds: [],
    });
  }
  return signs;
}

function podBoundsOf(tiles: ReadonlyArray<OfficeTilePos>): OfficeTileRect {
  const first = tiles[0];
  let minCol = first.col;
  let maxCol = first.col;
  let minRow = first.row;
  let maxRow = first.row;
  for (const tile of tiles) {
    minCol = Math.min(minCol, tile.col);
    maxCol = Math.max(maxCol, tile.col);
    minRow = Math.min(minRow, tile.row);
    maxRow = Math.max(maxRow, tile.row);
  }
  return {
    col: minCol,
    row: minRow,
    cols: maxCol - minCol + CONSOLE_WIDTH_TILES,
    rows: maxRow - minRow + 1,
  };
}

function flushTeamRun(request: {
  readonly packing: Packing;
  readonly byId: ReadonlyMap<string, OfficeAgentInput>;
  readonly teamId: string;
  readonly start: number;
  readonly end: number;
  readonly tint: "cool" | "warm";
  readonly style: OfficeRoom["pods"][number]["style"];
  readonly pods: OfficeRoom["pods"][number][];
}): void {
  if (request.end <= request.start) return;
  const tiles: OfficeTilePos[] = [];
  for (let i = request.start; i < request.end; i += 1) {
    const slot = request.packing.slots[i];
    tiles.push(slot.deskTile, slot.chairTile);
  }
  const bounds = podBoundsOf(tiles);
  const lead = request.byId.get(request.teamId);
  request.pods.push({
    leadAgentId: request.teamId,
    name: lead === undefined ? request.teamId : lead.name,
    depth: 1,
    bounds,
    plateTile: { col: bounds.col - 1, row: bounds.row + 1 },
    style: request.style,
    tint: request.tint,
  });
}

function teamTintOf(
  tintFor: Map<string, "cool" | "warm">,
  teamId: string,
  tintIndex: { value: number },
): "cool" | "warm" {
  const existing = tintFor.get(teamId);
  if (existing !== undefined) return existing;
  const tint = tintIndex.value % 2 === 0 ? "cool" : "warm";
  tintFor.set(teamId, tint);
  tintIndex.value += 1;
  return tint;
}

function teamPods(
  packing: Packing,
  byId: ReadonlyMap<string, OfficeAgentInput>,
): OfficeRoom["pods"] {
  const pods: OfficeRoom["pods"][number][] = [];
  const tintFor = new Map<string, "cool" | "warm">();
  const tintIndex = { value: 0 };
  let runTeam: string | null = null;
  let runStart = 0;
  for (let i = 0; i <= packing.slots.length; i += 1) {
    const teamId = i < packing.fills.length ? packing.fills[i].teamId : null;
    const sameRow =
      i < packing.slots.length &&
      runTeam !== null &&
      packing.slots[i].deskTile.row === packing.slots[runStart].deskTile.row;
    if (teamId !== null && teamId === runTeam && sameRow) continue;
    if (runTeam !== null) {
      const tint = teamTintOf(tintFor, runTeam, tintIndex);
      flushTeamRun({
        packing,
        byId,
        teamId: runTeam,
        start: runStart,
        end: i,
        tint,
        style: tint === "warm" ? "planters" : "glass",
        pods,
      });
    }
    if (teamId === null || i >= packing.slots.length) {
      runTeam = null;
      continue;
    }
    teamTintOf(tintFor, teamId, tintIndex);
    runTeam = teamId;
    runStart = i;
  }
  return pods;
}

function buildDesks(
  packing: Packing,
  byId: ReadonlyMap<string, OfficeAgentInput>,
): {
  readonly desks: ReadonlyMap<string, OfficeDesk>;
  readonly seats: ReadonlyMap<string, OfficeSeat>;
} {
  const desks = new Map<string, OfficeDesk>();
  const seats = new Map<string, OfficeSeat>();
  if (packing.hqId !== null) {
    const hq = byId.get(packing.hqId);
    const seat: OfficeDesk = {
      seatId: podiumSeatId(),
      kind: "desk",
      deskTile: { col: packing.podiumCol, row: PODIUM_ROW },
      chairTile: { col: packing.podiumCol, row: HQ_CHAIR_ROW },
      facing: PODIUM_FACING,
      hitTiles: { width: CONSOLE_WIDTH_TILES, height: 1 },
      floorIndex: FLOOR_INDEX,
      roomId: ROOM_ID,
      hostId: hq === undefined ? null : hq.hostId,
      manager: true,
      agentId: packing.hqId,
    };
    desks.set(packing.hqId, seat);
    seats.set(seat.seatId, seat);
  } else {
    const reserve: OfficeSeat = {
      seatId: podiumSeatId(),
      kind: "desk",
      deskTile: { col: packing.podiumCol, row: PODIUM_ROW },
      chairTile: { col: packing.podiumCol, row: HQ_CHAIR_ROW },
      facing: PODIUM_FACING,
      hitTiles: { width: CONSOLE_WIDTH_TILES, height: 1 },
      floorIndex: FLOOR_INDEX,
      roomId: ROOM_ID,
      hostId: null,
      manager: true,
    };
    seats.set(reserve.seatId, reserve);
  }
  for (let i = 0; i < packing.slots.length; i += 1) {
    const slot = packing.slots[i];
    const fill = packing.fills[i];
    const base: OfficeSeat = {
      seatId: consoleSeatId(i),
      kind: "console",
      deskTile: slot.deskTile,
      chairTile: slot.chairTile,
      facing: CONSOLE_FACING,
      hitTiles: { width: CONSOLE_WIDTH_TILES, height: 1 },
      floorIndex: FLOOR_INDEX,
      roomId: ROOM_ID,
      hostId: fill.hostId,
      manager: false,
    };
    seats.set(base.seatId, base);
    if (fill.agentId === null) continue;
    const desk: OfficeDesk = { ...base, agentId: fill.agentId };
    desks.set(fill.agentId, desk);
    seats.set(base.seatId, desk);
  }
  return { desks, seats };
}

function visitTileOf(
  packing: Packing,
  walkable: boolean[][],
): OfficeTilePos | null {
  const candidates: OfficeTilePos[] = [
    { col: packing.podiumCol, row: WALKWAY_ROW },
    { col: packing.podiumCol - 1, row: WALKWAY_ROW },
    { col: packing.podiumCol + 2, row: WALKWAY_ROW },
    { col: packing.podiumCol - 1, row: HQ_CHAIR_ROW },
    { col: packing.podiumCol + 2, row: HQ_CHAIR_ROW },
  ];
  for (const tile of candidates) {
    if (!inBounds(packing.cols, packing.rows, tile)) continue;
    if (walkable[tile.row][tile.col]) return tile;
  }
  return null;
}

function hostPalette(index: number): {
  readonly even: OfficeSpriteName;
  readonly odd: OfficeSpriteName;
} {
  if (index % 2 === 0) {
    return { even: "floor-pod-warm-a", odd: "floor-pod-warm-b" };
  }
  return { even: "floor-pod-a", odd: "floor-pod-b" };
}

function hostBandsOf(packing: Packing): ReadonlyArray<MissionControlHostBand> {
  const byHost = new Map<string, OfficeTilePos[]>();
  for (let i = 0; i < packing.slots.length; i += 1) {
    const hostId = packing.fills[i].hostId;
    if (hostId === null) continue;
    const tiles = byHost.get(hostId) ?? [];
    tiles.push(packing.slots[i].deskTile);
    byHost.set(hostId, tiles);
  }
  const hosts = [...byHost.keys()].sort();
  const bands: MissionControlHostBand[] = [];
  for (let h = 0; h < hosts.length; h += 1) {
    const palette = hostPalette(h);
    const byRow = new Map<number, number>();
    const tiles = byHost.get(hosts[h]);
    if (tiles === undefined) continue;
    for (const tile of tiles) {
      const current = byRow.get(tile.row);
      if (current === undefined || tile.col < current) {
        byRow.set(tile.row, tile.col);
      }
    }
    for (const [row, col] of byRow) {
      const even = (col - 1 + row) % 2 === 0;
      bands.push({
        col: col - 1,
        row,
        sprite: even ? palette.even : palette.odd,
      });
      const chairEven = (col - 1 + row + 1) % 2 === 0;
      bands.push({
        col: col - 1,
        row: row + 1,
        sprite: chairEven ? palette.even : palette.odd,
      });
    }
  }
  return bands;
}

function bandByTileOf(
  bands: ReadonlyArray<MissionControlHostBand>,
): Record<string, OfficeSpriteName> {
  const out: Record<string, OfficeSpriteName> = {};
  for (const band of bands) {
    out[`${band.col},${band.row}`] = band.sprite;
  }
  return out;
}

function podFloorSprite(
  tint: "cool" | "warm",
  col: number,
  row: number,
): OfficeSpriteName {
  const even = (col + row) % 2 === 0;
  if (tint === "warm") {
    return even ? "floor-pod-warm-a" : "floor-pod-warm-b";
  }
  return even ? "floor-pod-a" : "floor-pod-b";
}

function podByTileOf(
  pods: OfficeRoom["pods"],
): Record<string, OfficeSpriteName> {
  const out: Record<string, OfficeSpriteName> = {};
  for (const pod of pods) {
    for (let r = 0; r < pod.bounds.rows; r += 1) {
      for (let c = 0; c < pod.bounds.cols; c += 1) {
        const col = pod.bounds.col + c;
        const row = pod.bounds.row + r;
        out[`${col},${row}`] = podFloorSprite(pod.tint, col, row);
      }
    }
  }
  return out;
}

export function planMissionControl(input: OfficePlanInput): OfficeLayout {
  const packing = pack(input);
  const byId = agentsById(input.agents);
  const walkable = buildWalkable(packing);
  const doorTile: OfficeTilePos = {
    col: packing.loungeOriginCol,
    row: 1,
  };
  if (inBounds(packing.cols, packing.rows, doorTile)) {
    walkable[doorTile.row][doorTile.col] = true;
  }
  const lobbyTile: OfficeTilePos = {
    col: packing.loungeOriginCol,
    row: 2,
  };
  const receptionTile: OfficeTilePos = {
    col: packing.loungeOriginCol + 3,
    row: 1,
  };
  const receptionQueueTiles = queueTiles({
    packing,
    walkable,
    reception: receptionTile,
    door: doorTile,
    lobby: lobbyTile,
  });
  const reserved = new Set<string>([
    tileKey(doorTile),
    tileKey(lobbyTile),
    ...receptionQueueTiles.map(tileKey),
  ]);
  const errandSpots = buildSpots(packing, walkable, reserved);
  for (const spot of errandSpots) reserved.add(tileKey(spot.approachTile));
  const corridorTiles = corridorTilesOf(packing, walkable, reserved);
  const { desks, seats } = buildDesks(packing, byId);
  const signs = buildSigns(packing, input, byId);
  const visitTile = visitTileOf(packing, walkable);
  const hq = packing.hqId === null ? null : byId.get(packing.hqId);
  const room: OfficeRoom = {
    rootAgentId: ROOM_ID,
    name: hq === undefined || hq === null ? "Mission control" : hq.name,
    bounds: {
      col: 0,
      row: 0,
      cols: packing.cols,
      rows: packing.rows,
    },
    doorTile,
    signTile: { col: packing.boardOriginCol, row: 0 },
    pods: teamPods(packing, byId),
    visitTile,
  };
  const pods = room.pods;
  const areaSigns: ReadonlyArray<OfficeAreaSign> = [
    { name: "Lounge", signTile: { col: packing.loungeOriginCol, row: 0 } },
  ];
  const amenities: ReadonlyArray<OfficeAmenity> = [];
  const floor: OfficeFloor = {
    hostId: null,
    bounds: { col: 0, row: 0, cols: packing.cols, rows: packing.rows },
    doorTile,
    lobbyTile,
    receptionTile,
    receptionQueueTiles,
    queueFacing: QUEUE_FACING,
    corridorTiles,
    clockTile: {
      col: packing.boardOriginCol + BOARD_COLS - 1,
      row: 0,
    },
    stairsTile: null,
    errandSpots,
    cafeteria: null,
    gameRoom: null,
    areaSigns,
    amenities,
  };
  const hostBands = hostBandsOf(packing);
  const frozen: MissionControlFrozen = {
    tierSeatCounts: packing.tierCounts,
    centerCol: packing.centerCol,
    teamReserveSeatIds: packing.teamReserves,
    hostBands,
    bandByTile: bandByTileOf(hostBands),
    podByTile: podByTileOf(pods),
  };
  return {
    view: VIEW_ID,
    cols: packing.cols,
    rows: packing.rows,
    desks,
    seats,
    signs,
    rooms: [room],
    floors: [floor],
    doorTile,
    lobbyTile,
    props: buildProps(packing),
    walkable,
    frozen,
    shiftFromPrevious: null,
    stable: true,
  };
}

export function measureMissionControl(input: OfficePlanInput): OfficeSize {
  const packing = pack(input);
  return {
    width: packing.cols * OFFICE_TILE,
    height: packing.rows * OFFICE_TILE,
  };
}
