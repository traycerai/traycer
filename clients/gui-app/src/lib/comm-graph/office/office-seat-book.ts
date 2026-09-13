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
  OfficeSeatKind,
  OfficeTilePos,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

/**
 * WHETHER THE BOOK IS TAKING UP A NEW LAYOUT OR A NEW OFFICE.
 *
 * `"keep"` is every ordinary adoption: the plan was handed this book's
 * occupancy and honoured it, so the book honours the plan back and nobody is
 * moved out of a seat that still exists.
 *
 * `"fresh"` is for a plan that was made with no `previous`, no `occupancy` and
 * no shortfall - today that is the one the scene makes when the event feed
 * finally settles under a floor drawn without it. Keeping seats against such a
 * plan is not stability, it is disagreement: the office was re-planned
 * precisely because the assignment it grew from was provisional, and the quiet
 * stack's cubby ids outlive a re-plan, so `"keep"` left the whole population
 * sitting in cubbies the new plan had given nobody while `layout.desks` said
 * desk. Everything downstream - `effectiveSeat`, `whereabouts`, the character
 * positions, the directory - reads the book, so the book was the office and
 * the plan was decoration. Worse, the woken lead then claimed a reserve, its
 * shortfall reached `needsCapacity`, and the next sync planned the floor a
 * third time.
 *
 * A required parameter rather than a default, so every call site says which
 * kind of adoption it is making.
 */
export type OfficeSeatAdoption = "keep" | "fresh";

/**
 * WHAT KIND OF SEAT a claim is for.
 *
 * `"desk"` is every wake: somewhere to work. It is deliberately not
 * `OfficeSeatKind` - a console is a desk for this purpose and a wake has always
 * been able to take one, so narrowing the want to the literal kind would be a
 * behaviour change wearing a type change's clothes. What `"desk"` excludes is
 * the civic seats, which a wake must never take: a bed is for a crash and a
 * chair is for a wait, and an agent that merely woke up belongs in neither.
 */
export type OfficeSeatWant = "desk" | "bed" | "lounge";

/**
 * WHETHER A CLAIM THAT FINDS NOTHING ASKS THE PLAN TO GROW.
 *
 * `"plan"` is the wake's answer and the original behaviour: an agent that woke
 * with nowhere to sit is a floor that is too small, so it goes into
 * `needsCapacity` and the next layout makes room.
 *
 * `"none"` is the civic answer, and it is C2 - CAPACITY IS THE CAP. A floor
 * with two beds and three crashed agents is not a floor that needs a third
 * bed; it is a floor where one agent stays at its desk with its glyph up until
 * a bed comes free. Letting civic demand reach `needsCapacity` would re-plan
 * the office on every outbreak and grow a ward that empties again minutes
 * later, so a civic claim that finds nothing free simply returns `null`.
 */
export type OfficeSeatShortfall = "plan" | "none";

/** Where a waking agent would LIKE to sit: beside its team, on its own floor. */
export interface OfficeSeatPreference {
  readonly roomId: string | null;
  readonly floorIndex: number;
  readonly wants: OfficeSeatWant;
  readonly shortfall: OfficeSeatShortfall;
}

/** The civic seats, as a want. A seat of any other kind answers `"desk"`. */
function wantOfSeat(seat: OfficeSeat): OfficeSeatWant {
  if (seat.kind === "bed") return "bed";
  if (seat.kind === "lounge") return "lounge";
  return "desk";
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
  /**
   * `layout.seats` keys in canonical order.
   *
   * The two seat scans below have to agree with each other and with themselves
   * across runs, and the registry is a Map whose iteration order is whatever
   * the plan happened to build - so the order has to be imposed. Imposing it
   * per scan meant sorting the WHOLE registry inside a single `claim`, once to
   * resolve the building and again to find the desk, and `recomputeClaims`
   * pays that per hot agent: a thousand-seat office replaying a scrub sorted a
   * thousand ids some ninety times over. It is the same order every time, so
   * it is computed once, HERE - the one place `this.layout` is written, which
   * is what keeps the two from drifting apart.
   */
  private seatIdsInOrder: ReadonlyArray<string> = [];
  /** Every agent the last `adopt` was told about, in canonical order. */
  private known: ReadonlyArray<string> = [];
  /** Where an agent LIVES: its desk or its cubby. */
  private readonly seatIdOf = new Map<string, string>();
  private readonly claims = new Map<string, Claim>();
  /** Agents whose claim found nothing free; cleared the moment one is seated. */
  private readonly claimShortfall = new Set<string>();
  /** Effective seat, inverted. Injective over agents by construction. */
  private occupantBySeat: ReadonlyMap<string, string> = new Map();
  /** Assignment, inverted. `reassign` hands one seat to one agent, so injective too. */
  private assigneeBySeat: ReadonlyMap<string, string> = new Map();
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
   *
   * `"fresh"` is the other exception, and it is about the PLAN rather than the
   * view: a layout that was made from scratch has nothing to be stable
   * against, so the book takes it whole. See the note on the mode.
   */
  adopt(
    layout: OfficeLayout,
    agentIds: ReadonlyArray<string>,
    mode: OfficeSeatAdoption,
  ): ReadonlyArray<string> {
    const wanted = new Set(agentIds);
    const before = new Map<string, OfficeTilePos>();
    for (const agentId of agentIds) {
      const seat = this.effectiveSeat(agentId);
      if (seat !== null) before.set(agentId, seat.chairTile);
    }
    this.forgetAllBut(wanted);
    // BEFORE `reassign`, which is the whole of it: with nothing assigned,
    // nothing claimed and nobody owed a seat, the stable branch below finds no
    // seat to keep for anyone and every agent takes the desk this plan gave
    // it. Read against `layout.stable` and not instead of it - a stable view
    // planned from scratch still has stable GEOMETRY, and the next ordinary
    // adoption goes on honouring it.
    //
    // The chairs `before` are already captured above, so the caller still
    // learns who moved and its characters still walk.
    if (mode === "fresh") {
      this.seatIdOf.clear();
      this.claims.clear();
      this.claimShortfall.clear();
    }
    this.layout = layout;
    this.seatIdsInOrder = Array.from(layout.seats.keys()).sort(compareIds);
    this.known = [...agentIds].sort(compareIds);
    this.reassign(layout);
    this.dropStaleClaims(layout);
    this.refresh();
    this.reconcileShortfall();

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
   * Whose seat this IS, whether or not they are in it.
   *
   * The inverse of `assignedSeat`, and the difference from `occupant` is the
   * one the wake opens: an agent that has claimed a reserve occupies THAT and
   * still owns the cubby it has not walked out of yet.
   */
  assignee(seatId: string): string | null {
    return this.assigneeBySeat.get(seatId) ?? null;
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
    const spoken = new Map<string, string>();
    // ASSIGNMENTS FIRST, and this is the whole point: an agent away on a claim
    // still owns the seat it will walk back to. Leaving its home seat out of
    // this map advertises it as free, and then a plan hands somebody's cubby
    // to an arrival, or a second wake claims the desk its owner is coming
    // back to - and two agents answer `effectiveSeat` with one seat.
    for (const [agentId, seatId] of this.seatIdOf) spoken.set(seatId, agentId);
    // Then both kinds of claim. A held claim is where its agent is now; a
    // releasing one is a seat its agent has not finished leaving.
    for (const [agentId, claim] of this.claims) {
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
    if (existing !== undefined) {
      // An agent that goes hot again before it has finished walking home takes
      // ITS OWN seat back rather than shopping for another one. Picking a
      // second seat here would abandon a reservation that only `vacated` may
      // end, and the seat the agent is still standing in would go to somebody
      // else while it is in it.
      if (existing.state === "releasing") {
        this.claims.set(agentId, { ...existing, state: "held" });
        this.claimShortfall.delete(agentId);
        this.refresh();
      }
      return layout.seats.get(existing.seatId) ?? null;
    }
    const seat = this.firstFreeSeat(layout, agentId, preference);
    if (seat === null) {
      // C2: a civic claim that finds nothing is the cap doing its job, not a
      // floor that owes anybody a seat. See `OfficeSeatShortfall`.
      if (preference.shortfall === "plan") this.claimShortfall.add(agentId);
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
   * The civic seat this agent is HOLDING, by kind, or `null` for an agent that
   * holds none.
   *
   * `held` only. A releasing claim is an agent already walking home, and every
   * reader of this - the pose it draws in, the errand pass that leaves a civic
   * holder alone, the wake pass that skips one - is asking "is this agent in a
   * bed right now", to which "it is on its way out of one" is no.
   *
   * A reader rather than a second piece of state: the claim and the seat
   * registry already know, and a civic flag kept beside them is one more thing
   * that can disagree with where the agent actually is.
   */
  civicClaimOf(agentId: string): OfficeSeatKind | null {
    const layout = this.layout;
    if (layout === null) return null;
    const claim = this.claims.get(agentId);
    if (claim === undefined || claim.state !== "held") return null;
    const seat = layout.seats.get(claim.seatId);
    if (seat === undefined) return null;
    if (seat.kind !== "bed" && seat.kind !== "lounge") return null;
    return seat.kind;
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
        wants: "desk",
        shortfall: "plan",
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
    // Same rule the scene's own `seatBox` follows: a painted box, where the
    // plan declared one, is where this agent IS.
    if (seat.hitBox !== null) return seat.hitBox;
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

  /**
   * A plan can answer a wake with a real desk instead of a reserve seat. When
   * it does, the agent is seated and has no reason to call `claim` again, so
   * nothing else would ever take it back out of the shortfall - and every
   * later sync would keep asking the plan to grow an office that already has
   * room. A failed wake that is still in a cubby stays in the set, because
   * that one does still need a live seat.
   */
  private reconcileShortfall(): void {
    for (const agentId of Array.from(this.claimShortfall)) {
      const seat = this.effectiveSeat(agentId);
      if (seat === null || seat.kind === "cubby") continue;
      this.claimShortfall.delete(agentId);
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
    const assignees = new Map<string, string>();
    for (const agentId of this.known) {
      const assigned = this.assignedSeat(agentId);
      if (assigned !== null) assignees.set(assigned.seatId, agentId);
      const seat = this.effectiveSeat(agentId);
      if (seat === null) continue;
      occupants.set(seat.seatId, agentId);
    }
    this.occupantBySeat = occupants;
    this.assigneeBySeat = assignees;
  }

  /**
   * Which BUILDING this agent belongs to, from its own seat where it has one
   * and from the STOREY it is waking on where it does not.
   *
   * An empty floor is not an unknown floor. `layout.floors[i].hostId` is the
   * storey's own statement of which building it is part of, and it answers
   * whether or not anybody happens to be seated there - so an agent waking on
   * a floor with no desks on it can still be sent to a free desk upstairs in
   * the same building, instead of demanding capacity beside one.
   *
   * `null` as a HOST is an answer: the unattributed building is a building.
   * `resolved: false` is the absence of one, and an agent with no building has
   * no seat to be offered - the safe direction, since it asks the plan for
   * capacity rather than being sent somewhere impossible.
   */
  private owningHostOf(
    layout: OfficeLayout,
    agentId: string,
    preference: OfficeSeatPreference,
  ): { readonly resolved: boolean; readonly hostId: string | null } {
    const assigned = this.assignedSeat(agentId);
    if (assigned !== null) return { resolved: true, hostId: assigned.hostId };
    // Asked as "does this layout carry that storey", because a preference can
    // name one it does not and indexing an array is typed here as a hit.
    const index = preference.floorIndex;
    if (index >= 0 && index < layout.floors.length) {
      return { resolved: true, hostId: layout.floors[index].hostId };
    }
    // A layout that carries no storey at that index has not said where the
    // wake is happening, so the seats that claim to be there answer instead.
    for (const seatId of this.seatIdsInOrder) {
      const seat = layout.seats.get(seatId);
      if (seat === undefined) continue;
      if (seat.floorIndex !== preference.floorIndex) continue;
      return { resolved: true, hostId: seat.hostId };
    }
    return { resolved: false, hostId: null };
  }

  /**
   * The seat a wake should take: the agent's own room first, then its floor's
   * bullpen, then anywhere ON ITS OWN HOST, in seat-id order so two runs of
   * the same wake agree.
   *
   * "Anywhere" stops at the host. Hosts are separate buildings with no walkable
   * route between them, so a free desk in another one is not a seat this agent
   * can reach - offering it would strand the character mid-walk AND silence
   * the capacity demand that should have grown its own building.
   *
   * A cubby is never a target either. It is where a cold agent waits, so
   * waking into one would be a walk to nowhere.
   */
  private firstFreeSeat(
    layout: OfficeLayout,
    agentId: string,
    preference: OfficeSeatPreference,
  ): OfficeSeat | null {
    const owner = this.owningHostOf(layout, agentId, preference);
    if (!owner.resolved) return null;
    const spoken = this.occupancy();
    const free: OfficeSeat[] = [];
    for (const seatId of this.seatIdsInOrder) {
      const seat = layout.seats.get(seatId);
      if (seat === undefined || seat.kind === "cubby") continue;
      // The want is the first filter, so a wake can never be handed a bed and a
      // crash can never be handed a desk - whatever the room and floor rules
      // below would have preferred.
      if (wantOfSeat(seat) !== preference.wants) continue;
      if (seat.hostId !== owner.hostId) continue;
      // Spoken for is spoken for, including by this agent: a renewed wake
      // reactivates its own reservation above and never reaches here.
      if (spoken.has(seatId)) continue;
      free.push(seat);
    }
    // A CIVIC CLAIM READS FLOOR, THEN BUILDING, and nothing else. `roomId` is
    // the team's room and a bed has no team in it; the bullpen step is a
    // question about desks. So the rule is the one the plan states for every
    // view: a room of this kind on the agent's own storey if there is one,
    // else any on its host - which is what sends a crash on storey seven down
    // the stairwell to the plaza's beds where that view keeps them there.
    if (preference.wants !== "desk") {
      const onFloor = free.find(
        (seat) => seat.floorIndex === preference.floorIndex,
      );
      if (onFloor !== undefined) return onFloor;
      return free[0] ?? null;
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
