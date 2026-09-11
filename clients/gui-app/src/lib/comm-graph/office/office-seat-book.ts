/**
 * WHO SITS WHERE, and the only thing allowed to answer it.
 *
 * The plan says where seats ARE. It does not say who is in them, because two
 * parties handing out the same chair is how a reserve seat gets double-booked:
 * the planner offers it to the agent it just made room for while the scene
 * offers it to the agent already walking towards it. So the book owns the
 * assignment, the plan is handed the book's occupancy as an input, and every
 * routine that needs a seat asks here rather than reading `layout.desks`.
 *
 * Three pieces of state, and the difference between them is the whole design:
 *
 * - the **assignment** is where an agent lives - its desk, or its cubby;
 * - a **claim** is a reserve seat a waking agent has taken for as long as it
 *   stays hot, which OVERRIDES the assignment while it is held;
 * - `needsCapacity` is the list of agents the book could not seat at all,
 *   which is a plan trigger: the next layout has to make room for them.
 *
 * A released seat is free once the character is OUT of it, never before, which
 * is why letting a claim go is two calls: `endClaim` when the agent stops
 * wanting it, `vacated` when it has actually left. Between the two the agent
 * is already walking home and the seat is still nobody else's.
 */
import { isOfficeHotStatus } from "@/lib/comm-graph/office/office-status";
import type {
  OfficeAgentStatus,
  OfficeLayout,
  OfficeRect,
  OfficeSeat,
  OfficeTilePos,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

/** Where a waking agent would LIKE to sit: beside its team, on its own floor. */
export interface OfficeSeatPreference {
  readonly roomId: string | null;
  readonly floorIndex: number;
}

/**
 * `held` while the agent still wants the seat, `releasing` from the moment it
 * stops until the character is actually out of it.
 */
type ClaimState = "held" | "releasing";

interface Claim {
  readonly seatId: string;
  /**
   * A claim counter, not a clock. The book has no time source and does not
   * need one: `since` exists to order two claims, and claims are made one at a
   * time in canonical order.
   */
  readonly since: number;
  readonly state: ClaimState;
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export class OfficeSeatBook {
  private layout: OfficeLayout | null = null;
  /** Every agent the last `adopt` was told about, in canonical order. */
  private known: ReadonlyArray<string> = [];
  /** Where an agent LIVES: its desk or its cubby. */
  private readonly seatIdOf = new Map<string, string>();
  private readonly claims = new Map<string, Claim>();
  /** Agents whose claim found nothing free; cleared the moment one is seated. */
  private readonly claimShortfall = new Set<string>();
  /** Effective seat, inverted. Injective over agents by construction. */
  private occupantBySeat: ReadonlyMap<string, string> = new Map();
  private claimSequence = 0;

  /**
   * Take up a new layout.
   *
   * An agent the book already knows keeps the seat it had, as long as that
   * seat still exists - the plan was given `occupancy` and honoured it, so
   * moving anybody here would be the book contradicting the plan it asked for.
   * An agent it does not know takes the desk the plan assigned it.
   *
   * An UNSTABLE layout is the exception: Floor and Campus re-pack from
   * scratch, so `layout.desks` is the truth for everybody and the return value
   * is whoever has to get up and walk to a new chair.
   */
  adopt(
    layout: OfficeLayout,
    agentIds: ReadonlyArray<string>,
  ): ReadonlyArray<string> {
    const wanted = new Set(agentIds);
    const before = new Map<string, OfficeTilePos>();
    for (const agentId of agentIds) {
      const seat = this.effectiveSeat(agentId);
      if (seat !== null) before.set(agentId, seat.chairTile);
    }
    this.forgetAllBut(wanted);
    this.layout = layout;
    this.known = [...agentIds].sort(compareIds);
    this.reassign(layout);
    this.dropStaleClaims(layout);
    this.refresh();

    const moved: string[] = [];
    for (const agentId of this.known) {
      const was = before.get(agentId);
      if (was === undefined) continue;
      const seat = this.effectiveSeat(agentId);
      if (seat === null) continue;
      if (seat.chairTile.col === was.col && seat.chairTile.row === was.row) {
        continue;
      }
      moved.push(agentId);
    }
    return moved;
  }

  /** Where the agent lives, ignoring any reserve seat it is borrowing. */
  assignedSeat(agentId: string): OfficeSeat | null {
    const layout = this.layout;
    if (layout === null) return null;
    const seatId = this.seatIdOf.get(agentId);
    if (seatId === undefined) return null;
    return layout.seats.get(seatId) ?? null;
  }

  /** The claim if one is held, else the assignment. Everything reads this. */
  effectiveSeat(agentId: string): OfficeSeat | null {
    const layout = this.layout;
    if (layout === null) return null;
    const claim = this.claims.get(agentId);
    if (claim !== undefined && claim.state === "held") {
      const seat = layout.seats.get(claim.seatId);
      if (seat !== undefined) return seat;
    }
    return this.assignedSeat(agentId);
  }

  /** Who is sitting in this seat right now, or `null` while it is empty. */
  occupant(seatId: string): string | null {
    return this.occupantBySeat.get(seatId) ?? null;
  }

  /**
   * The seats a plan MAY NOT HAND OUT, for `OfficePlanInput.occupancy`. Read
   * it that way and not as "who is sitting where": it is every occupied seat
   * PLUS the seat of any claim being released, which is still nobody else's
   * until its character is out of it.
   *
   * So an agent mid-release appears against two seats here, and against
   * exactly one in `occupant` - which is the injective one, and the one to ask
   * where somebody is.
   */
  occupancy(): ReadonlyMap<string, string> {
    const spoken = new Map(this.occupantBySeat);
    for (const [agentId, claim] of this.claims) {
      if (claim.state !== "releasing") continue;
      if (spoken.has(claim.seatId)) continue;
      spoken.set(claim.seatId, agentId);
    }
    return spoken;
  }

  /**
   * Agents the next plan has to make room for: the ones with no seat at all,
   * and the ones whose wake found no reserve free. Canonical order, so a plan
   * handed this list twice packs it the same way twice.
   */
  needsCapacity(): ReadonlyArray<string> {
    const short: string[] = [];
    for (const agentId of this.known) {
      if (
        this.claimShortfall.has(agentId) ||
        this.effectiveSeat(agentId) === null
      ) {
        short.push(agentId);
      }
    }
    return short;
  }

  /** The agents the last `adopt` covered, in canonical order. */
  knownAgentIds(): ReadonlyArray<string> {
    return this.known;
  }

  /**
   * Take a reserve seat: the first free one in the agent's own room, else the
   * first in its floor's bullpen, else the first anywhere, in seat-id order so
   * two runs of the same wake agree.
   *
   * A cubby is never a claim target. It is where a cold agent waits, so waking
   * into one would be a walk to nowhere - and an unoccupied cubby is the
   * quiet stack's spare room, not a desk.
   *
   * `null` means the office is full: the agent stays where it is, lit, and its
   * id goes into `needsCapacity` for the next plan to answer.
   */
  claim(agentId: string, preference: OfficeSeatPreference): OfficeSeat | null {
    const layout = this.layout;
    if (layout === null) return null;
    const existing = this.claims.get(agentId);
    if (existing !== undefined && existing.state === "held") {
      return layout.seats.get(existing.seatId) ?? null;
    }
    const seat = this.firstFreeSeat(layout, agentId, preference);
    if (seat === null) {
      this.claimShortfall.add(agentId);
      return null;
    }
    this.claimSequence += 1;
    this.claims.set(agentId, {
      seatId: seat.seatId,
      since: this.claimSequence,
      state: "held",
    });
    this.claimShortfall.delete(agentId);
    this.refresh();
    return seat;
  }

  /**
   * The agent no longer wants its claim: it is heading home, and its effective
   * seat is its assignment again from this moment. The reserve seat stays
   * reserved until `vacated` says the character has left it.
   */
  endClaim(agentId: string): void {
    // An agent that has stopped wanting a reserve seat stops being a reason to
    // grow the office, whether or not it ever got one. Without this, a wake
    // that went cold before a seat came free would ask the plan for capacity
    // forever.
    this.claimShortfall.delete(agentId);
    const claim = this.claims.get(agentId);
    if (claim === undefined || claim.state === "releasing") return;
    this.claims.set(agentId, { ...claim, state: "releasing" });
    this.refresh();
  }

  /** The character is out of the seat it was releasing: the seat is free now. */
  vacated(agentId: string): void {
    const claim = this.claims.get(agentId);
    if (claim === undefined || claim.state !== "releasing") return;
    this.claims.delete(agentId);
    this.refresh();
  }

  /**
   * Claims from scratch for the statuses AS OF a cursor, in the caller's
   * canonical order.
   *
   * Scrub-back cannot replay the walks that led to today's claims, so it does
   * not try: transient motion is dropped and the claims are re-derived, which
   * is the same treatment the rest of the scene's in-flight state gets.
   */
  recomputeClaims(
    statusById: ReadonlyMap<string, OfficeAgentStatus>,
    order: ReadonlyArray<string>,
  ): void {
    this.claims.clear();
    this.claimShortfall.clear();
    this.refresh();
    for (const agentId of order) {
      const seat = this.assignedSeat(agentId);
      if (seat === null || seat.kind !== "cubby") continue;
      if (!isOfficeHotStatus(statusById.get(agentId))) continue;
      this.claim(agentId, {
        roomId: seat.roomId,
        floorIndex: seat.floorIndex,
      });
    }
  }

  /**
   * Where to point the camera for this agent: its seat's hit box projected
   * through the view's projector, or its own box where it is away from the
   * seat and `away` says which tile it is on (fractions allowed - a walker is
   * between two of them).
   *
   * O(1) and independent of culling, because the directory and Find ask about
   * agents that are nowhere near the view rect.
   */
  locate(
    agentId: string,
    projector: OfficeProjector,
    away: OfficeTilePos | null,
  ): OfficeRect | null {
    if (away !== null) {
      const point = projector.project(away.col, away.row);
      return {
        x: point.x,
        // The character stands a tile tall with its head above the tile, so
        // its box starts that overhang above the tile's own top edge.
        y: point.y + (OFFICE_TILE - OFFICE_CHARACTER_HEIGHT),
        width: OFFICE_CHARACTER_WIDTH,
        height: OFFICE_CHARACTER_HEIGHT,
      };
    }
    const seat = this.effectiveSeat(agentId);
    if (seat === null) return null;
    const origin = projector.project(seat.deskTile.col, seat.deskTile.row);
    return {
      x: origin.x,
      y: origin.y,
      width: seat.hitTiles.width * OFFICE_TILE,
      height: seat.hitTiles.height * OFFICE_TILE,
    };
  }

  private forgetAllBut(wanted: ReadonlySet<string>): void {
    for (const agentId of Array.from(this.seatIdOf.keys())) {
      if (!wanted.has(agentId)) this.seatIdOf.delete(agentId);
    }
    for (const agentId of Array.from(this.claims.keys())) {
      if (!wanted.has(agentId)) this.claims.delete(agentId);
    }
    for (const agentId of Array.from(this.claimShortfall)) {
      if (!wanted.has(agentId)) this.claimShortfall.delete(agentId);
    }
  }

  /**
   * Known agents first, so an agent that stayed keeps its chair and an
   * arrival is the one that has to go somewhere else. An arrival whose desk
   * is already somebody's keeps no seat at all and lands in `needsCapacity`,
   * which is the honest reading: the plan and the book disagreed, and the
   * plan gets asked again rather than two people being sat in one chair.
   *
   * A CLAIMED seat counts as taken before anything else is handed out, on an
   * unstable layout too. The plan was given `occupancy` and should not have
   * offered it, but if it did, the agent walking towards that seat keeps it:
   * evicting a claim to honour a plan is the exact double-booking the book is
   * here to make impossible.
   */
  private reassign(layout: OfficeLayout): void {
    const taken = new Set<string>();
    for (const claim of this.claims.values()) taken.add(claim.seatId);
    if (layout.stable) {
      for (const agentId of this.known) {
        const current = this.seatIdOf.get(agentId);
        if (current !== undefined && layout.seats.has(current)) {
          taken.add(current);
          continue;
        }
        this.seatIdOf.delete(agentId);
      }
    } else {
      this.seatIdOf.clear();
    }
    for (const agentId of this.known) {
      if (this.seatIdOf.has(agentId)) continue;
      const desk = layout.desks.get(agentId);
      if (desk === undefined || taken.has(desk.seatId)) continue;
      this.seatIdOf.set(agentId, desk.seatId);
      taken.add(desk.seatId);
    }
  }

  /** A claim survives a re-plan only while its seat is still free to hold. */
  private dropStaleClaims(layout: OfficeLayout): void {
    const owners = new Map<string, string>();
    for (const [agentId, seatId] of this.seatIdOf) owners.set(seatId, agentId);
    for (const [agentId, claim] of Array.from(this.claims)) {
      if (!layout.seats.has(claim.seatId)) {
        this.claims.delete(agentId);
        continue;
      }
      const owner = owners.get(claim.seatId);
      if (owner !== undefined && owner !== agentId) this.claims.delete(agentId);
    }
  }

  /** One pass over the known agents: the effective seat of each, inverted. */
  private refresh(): void {
    const occupants = new Map<string, string>();
    for (const agentId of this.known) {
      const seat = this.effectiveSeat(agentId);
      if (seat === null) continue;
      occupants.set(seat.seatId, agentId);
    }
    this.occupantBySeat = occupants;
  }

  private firstFreeSeat(
    layout: OfficeLayout,
    agentId: string,
    preference: OfficeSeatPreference,
  ): OfficeSeat | null {
    const spoken = this.occupancy();
    const free: OfficeSeat[] = [];
    for (const seatId of Array.from(layout.seats.keys()).sort(compareIds)) {
      const seat = layout.seats.get(seatId);
      if (seat === undefined || seat.kind === "cubby") continue;
      const holder = spoken.get(seatId);
      if (holder !== undefined && holder !== agentId) continue;
      free.push(seat);
    }
    if (preference.roomId !== null) {
      const inRoom = free.find((seat) => seat.roomId === preference.roomId);
      if (inRoom !== undefined) return inRoom;
    }
    const inBullpen = free.find(
      (seat) =>
        seat.roomId === null && seat.floorIndex === preference.floorIndex,
    );
    if (inBullpen !== undefined) return inBullpen;
    return free[0] ?? null;
  }
}
