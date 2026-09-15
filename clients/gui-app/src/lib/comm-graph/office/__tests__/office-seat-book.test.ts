import { describe, expect, it } from "vitest";
import { OfficeSeatBook } from "@/lib/comm-graph/office/office-seat-book";
import type {
  OfficeSeatPreference,
  OfficeSeatWant,
} from "@/lib/comm-graph/office/office-seat-book";
import type {
  OfficeAgentStatus,
  OfficeDesk,
  OfficeFloor,
  OfficeLayout,
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
 * The seat book never reads a layout's cols, rows, rooms, props or walkable
 * grid - only `desks`, `seats`, `stable` and, for an unassigned agent's
 * preference floor, `floors[i].hostId` - so those other fields are filled
 * with the emptiest values that still type-check. Building layouts by hand
 * here (never through `layoutOffice`) is what makes reserve seats, which
 * Floor never produces, possible to test at all.
 */
interface SeatSpec {
  readonly seatId: string;
  readonly kind: OfficeSeatKind;
  readonly roomId: string | null;
  readonly floorIndex: number;
  readonly deskTile: OfficeTilePos;
  /** Omitted specs default to `null`, the single-host shape most cases want. */
  readonly hostId?: string | null;
  /** The civic room a bed or a lounge chair belongs to; omitted on a desk. */
  readonly civicRoomId?: string | null;
}

function tile(col: number, row: number): OfficeTilePos {
  return { col, row };
}

/**
 * A WAKE's preference: somewhere to work, and the plan is told when there is
 * nowhere. Every case that predates the civic layer wants exactly this, so it
 * is written once rather than thirty-three times - and a case that wants a bed
 * or a chair has to say so, which is the point of the two fields.
 */
function wake(roomId: string | null, floorIndex: number): OfficeSeatPreference {
  return { roomId, floorIndex, wants: "desk", shortfall: "plan" };
}

/**
 * A CIVIC claim: a seat of one kind, and a miss that never asks the plan to
 * grow the office (C2 - capacity is the cap).
 */
function civic(
  wants: OfficeSeatWant,
  floorIndex: number,
): OfficeSeatPreference {
  return { roomId: null, floorIndex, wants, shortfall: "none" };
}

function makeSeat(spec: SeatSpec): OfficeSeat {
  return {
    seatId: spec.seatId,
    kind: spec.kind,
    deskTile: spec.deskTile,
    // The chair sits one row below the desk - close enough to a real plan to
    // give `locate` and the walking case something to project.
    chairTile: tile(spec.deskTile.col, spec.deskTile.row + 1),
    facing: "up",
    hitTiles:
      spec.kind === "cubby" ? { width: 1, height: 1 } : { width: 2, height: 2 },
    hitBox: null,
    floorIndex: spec.floorIndex,
    roomId: spec.roomId,
    hostId: spec.hostId ?? null,
    manager: false,
    civicRoomId: spec.civicRoomId ?? null,
  };
}

/** A floor's authoritative host, at the array index its own `floorIndex` reads. */
interface FloorSpec {
  readonly hostId: string | null;
}

/** The emptiest `OfficeFloor` that still type-checks, for a given host and row. */
function makeFloor(hostId: string | null, row: number): OfficeFloor {
  return {
    hostId,
    bounds: { col: 0, row, cols: 40, rows: 10 },
    doorTile: tile(0, row),
    lobbyTile: tile(1, row),
    receptionTile: tile(2, row),
    receptionQueueTiles: [],
    queueFacing: "down",
    corridorTiles: [],
    clockTile: tile(3, row),
    stairsTile: null,
    errandSpots: [],
    cafeteria: null,
    gameRoom: null,
    areaSigns: [],
    amenities: [],
    civic: [],
    road: null,
  };
}

interface LayoutSpec {
  readonly seats: ReadonlyArray<SeatSpec>;
  /** agentId -> seatId, the plan's initial assignment. */
  readonly desks: ReadonlyMap<string, string>;
  readonly stable: boolean;
  /**
   * `layout.floors[i]`'s host, index by index. Omitted (the default for
   * every existing case) leaves `floors: []`, which is exactly the "no
   * storey at that index" input the unassigned branch's seat-scan fallback
   * is meant for - those cases stay on that fallback path, unchanged.
   */
  readonly floors?: ReadonlyArray<FloorSpec>;
}

function buildLayout(spec: LayoutSpec): OfficeLayout {
  const seats = new Map<string, OfficeSeat>();
  for (const seatSpec of spec.seats)
    seats.set(seatSpec.seatId, makeSeat(seatSpec));
  const desks = new Map<string, OfficeDesk>();
  for (const [agentId, seatId] of spec.desks) {
    const seat = seats.get(seatId);
    if (seat === undefined)
      throw new Error(`no seat "${seatId}" for ${agentId}`);
    desks.set(agentId, { ...seat, agentId });
  }
  const floors = (spec.floors ?? []).map((floorSpec, floorIndex) =>
    makeFloor(floorSpec.hostId, floorIndex * 10),
  );
  return {
    view: "floor",
    cols: 40,
    rows: 40,
    desks,
    seats,
    signs: [],
    rooms: [],
    floors,
    doorTile: tile(0, 0),
    lobbyTile: tile(0, 0),
    props: [],
    walkable: [],
    frozen: null,
    shiftFromPrevious: null,
    stable: spec.stable,
  };
}

/**
 * `occupant` is the book's injective view; this checks it stays that way and
 * agrees with `effectiveSeat` for every agent the book currently knows,
 * which is the "no seat ever double-booked" invariant every scenario below
 * must hold after every mutation, not only at the end.
 */
function assertNoDoubleBooking(book: OfficeSeatBook): void {
  const claimedBy = new Map<string, string>();
  for (const agentId of book.knownAgentIds()) {
    const seat = book.effectiveSeat(agentId);
    if (seat === null) continue;
    const holder = claimedBy.get(seat.seatId);
    expect(holder).toBeUndefined();
    claimedBy.set(seat.seatId, agentId);
    expect(book.occupant(seat.seatId)).toBe(agentId);
  }
}

const ROOM = "team-a";

describe("OfficeSeatBook", () => {
  it("wakes a cubby agent into a claim, seats an arrival, then releases the wake on archive", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "cubby-b",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    assertNoDoubleBooking(book);
    expect(book.effectiveSeat("A")?.seatId).toBe("cubby-a");

    // Wake: A claims the room's only reserve desk.
    const claimed = book.claim("A", wake(ROOM, 0));
    expect(claimed?.seatId).toBe("desk-1");
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");
    expect(book.occupant("desk-1")).toBe("A");
    assertNoDoubleBooking(book);

    // Arrive: B joins, in its own cubby. A's claim survives the re-adopt
    // because desk-1 is still standing and still A's.
    const grown = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "cubby-b",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
      ],
      desks: new Map([
        ["A", "cubby-a"],
        ["B", "cubby-b"],
      ]),
      stable: true,
    });
    book.adopt(grown, ["A", "B"], "keep");
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");
    expect(book.effectiveSeat("B")?.seatId).toBe("cubby-b");
    assertNoDoubleBooking(book);

    // Archive: A stops wanting the reserve seat and then actually leaves it.
    book.endClaim("A");
    expect(book.effectiveSeat("A")?.seatId).toBe("cubby-a");
    book.vacated("A");
    expect(book.occupant("desk-1")).toBeNull();
    assertNoDoubleBooking(book);
  });

  it("never hands a claimed seat to an arrival, even on the layout that offers it", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    book.claim("A", wake(ROOM, 0));
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");

    // The plan should have read `occupancy` and steered around desk-1, but
    // this one offers it to a brand-new arrival anyway.
    const conflicted = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([
        ["A", "cubby-a"],
        ["New", "desk-1"],
      ]),
      stable: true,
    });
    book.adopt(conflicted, ["A", "New"], "keep");

    // The claimant keeps the seat it is already walking towards...
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");
    // ...which leaves the arrival with nowhere to sit at all.
    expect(book.effectiveSeat("New")).toBeNull();
    expect(book.needsCapacity()).toContain("New");
    assertNoDoubleBooking(book);
  });

  it("scrubs claims back to what the as-of statuses say, in canonical order", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    book.claim("A", wake(ROOM, 0));
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");

    // Scrub back to a cursor where A was never hot: the claim it holds now
    // must not survive re-derivation from scratch.
    const cold: ReadonlyMap<string, OfficeAgentStatus> = new Map([
      ["A", "idle"],
    ]);
    book.recomputeClaims(cold, ["A"]);
    expect(book.effectiveSeat("A")?.seatId).toBe("cubby-a");
    assertNoDoubleBooking(book);

    // Scrub forward again to a cursor where A is hot: the claim is rebuilt.
    const hot: ReadonlyMap<string, OfficeAgentStatus> = new Map([
      ["A", "working"],
    ]);
    book.recomputeClaims(hot, ["A"]);
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");
    assertNoDoubleBooking(book);
  });

  it("gives two simultaneous wakes two different reserve seats, in the caller's order", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "cubby-b",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
        {
          seatId: "desk-2",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(6, 0),
        },
      ],
      desks: new Map([
        ["A", "cubby-a"],
        ["B", "cubby-b"],
      ]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A", "B"], "keep");

    const first = book.claim("A", wake(ROOM, 0));
    const second = book.claim("B", wake(ROOM, 0));
    expect(first?.seatId).toBe("desk-1");
    expect(second?.seatId).toBe("desk-2");
    assertNoDoubleBooking(book);

    // Claiming in the opposite order is just as deterministic: whoever asks
    // first gets seat-id order's first free seat, same as above.
    const reordered = new OfficeSeatBook();
    reordered.adopt(layout, ["A", "B"], "keep");
    const bFirst = reordered.claim("B", wake(ROOM, 0));
    const aSecond = reordered.claim("A", wake(ROOM, 0));
    expect(bFirst?.seatId).toBe("desk-1");
    expect(aSecond?.seatId).toBe("desk-2");
    assertNoDoubleBooking(reordered);
  });

  it("keeps a released seat held between endClaim and vacated", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "cubby-c",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
      ],
      desks: new Map([
        ["A", "cubby-a"],
        ["C", "cubby-c"],
      ]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A", "C"], "keep");
    book.claim("A", wake(ROOM, 0));
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");

    book.endClaim("A");
    // The character is walking home: its own effective seat is the cubby
    // again, but the desk it is leaving is still nobody else's to take.
    expect(book.effectiveSeat("A")?.seatId).toBe("cubby-a");
    expect(book.occupancy().get("desk-1")).toBe("A");
    const duringRelease = book.claim("C", wake(ROOM, 0));
    expect(duringRelease).toBeNull();
    expect(book.needsCapacity()).toContain("C");
    assertNoDoubleBooking(book);

    book.vacated("A");
    // Now the seat is actually empty, and the agent that was shut out gets it.
    const afterVacate = book.claim("C", wake(ROOM, 0));
    expect(afterVacate?.seatId).toBe("desk-1");
    expect(book.needsCapacity()).not.toContain("C");
    assertNoDoubleBooking(book);
  });

  it("puts an exhausted wake into needsCapacity, then seats it once a plan adds room", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([
        ["A", "cubby-a"],
        ["B", "desk-1"],
      ]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A", "B"], "keep");

    // Every non-cubby seat is already B's: A's wake finds nothing free.
    const exhausted = book.claim("A", wake(ROOM, 0));
    expect(exhausted).toBeNull();
    expect(book.needsCapacity()).toEqual(["A"]);
    assertNoDoubleBooking(book);

    // The next plan adds a seat. B keeps its desk (stable), A keeps its
    // cubby, and only now does A's wake have somewhere to go.
    const grown = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "desk-2",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
      ],
      desks: new Map([
        ["A", "cubby-a"],
        ["B", "desk-1"],
      ]),
      stable: true,
    });
    book.adopt(grown, ["A", "B"], "keep");
    const seated = book.claim("A", wake(ROOM, 0));
    expect(seated?.seatId).toBe("desk-2");
    expect(book.needsCapacity()).toEqual([]);
    assertNoDoubleBooking(book);
  });

  it("stops asking for capacity once a starved wake gives up, even without ever getting a seat", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([
        ["A", "cubby-a"],
        ["B", "desk-1"],
      ]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A", "B"], "keep");
    expect(book.claim("A", wake(ROOM, 0))).toBeNull();
    expect(book.needsCapacity()).toContain("A");

    // A goes cold before a seat ever opened up: it stops wanting one, and
    // must stop being a reason the next plan grows the office - otherwise a
    // wake that gave up would ask for capacity forever.
    book.endClaim("A");
    expect(book.needsCapacity()).not.toContain("A");
    assertNoDoubleBooking(book);
  });

  it("never wakes an agent into a free cubby, however empty the room is", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        // Standing empty, and still not somewhere to wake into: a cubby is
        // where a cold agent WAITS, so claiming one would be a walk to
        // nowhere. The agent stays lit where it is and asks for capacity.
        {
          seatId: "cubby-spare",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");

    expect(book.claim("A", wake(ROOM, 0))).toBeNull();
    expect(book.effectiveSeat("A")?.seatId).toBe("cubby-a");
    expect(book.occupant("cubby-spare")).toBeNull();
    expect(book.needsCapacity()).toEqual(["A"]);
    assertNoDoubleBooking(book);
  });

  it("forgets a removed agent and frees the seat it held", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
      ],
      desks: new Map([["A", "desk-1"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    expect(book.occupant("desk-1")).toBe("A");

    book.adopt(layout, [], "keep");
    expect(book.knownAgentIds()).toEqual([]);
    expect(book.occupant("desk-1")).toBeNull();
    expect(book.effectiveSeat("A")).toBeNull();
    assertNoDoubleBooking(book);
  });

  it("re-packs everybody from layout.desks on an unstable layout, reporting only who moved", () => {
    const before = buildLayout({
      seats: [
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-2",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([
        ["A", "desk-1"],
        ["B", "desk-2"],
      ]),
      stable: false,
    });
    const book = new OfficeSeatBook();
    const firstMoved = book.adopt(before, ["A", "B"], "keep");
    // Nobody was known before this adopt, so there is no "before" tile to
    // compare against yet - the first plan seats everybody without a walk.
    expect(firstMoved).toEqual([]);

    // BOTH original seat ids survive here - only who is assigned to each one
    // swaps. Removing a seat id (as a stable re-adopt would too, since a
    // vanished seat drops its holder) makes the moved set identical whether
    // unstable adoption truly follows `layout.desks` or merely notices a
    // missing seat; keeping both alive is what proves it reads the new
    // assignments rather than reacting to a disappearance.
    const swapped = buildLayout({
      seats: [
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-2",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([
        ["A", "desk-2"],
        ["B", "desk-1"],
      ]),
      stable: false,
    });
    const moved = book.adopt(swapped, ["A", "B"], "keep");
    expect(moved.slice().sort()).toEqual(["A", "B"]);
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-2");
    expect(book.effectiveSeat("B")?.seatId).toBe("desk-1");
    assertNoDoubleBooking(book);

    // The same swap under `stable: true` must NOT move anybody: a stable
    // layout keeps a known agent in the seat it already has, so the plan's
    // new (and here, contradictory) assignment is simply ignored for A and B.
    const stableBook = new OfficeSeatBook();
    const stableBefore = buildLayout({
      seats: [
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-2",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([
        ["A", "desk-1"],
        ["B", "desk-2"],
      ]),
      stable: true,
    });
    stableBook.adopt(stableBefore, ["A", "B"], "keep");
    const stableSwapped = buildLayout({
      seats: [
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-2",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([
        ["A", "desk-2"],
        ["B", "desk-1"],
      ]),
      stable: true,
    });
    const stableMoved = stableBook.adopt(stableSwapped, ["A", "B"], "keep");
    expect(stableMoved).toEqual([]);
    expect(stableBook.effectiveSeat("A")?.seatId).toBe("desk-1");
    expect(stableBook.effectiveSeat("B")?.seatId).toBe("desk-2");
    assertNoDoubleBooking(stableBook);
  });

  it("locates a seated agent, a walking agent and a cubby agent through the projector", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(3, 2),
        },
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(5, 2),
        },
      ],
      desks: new Map([
        ["Seated", "desk-1"],
        ["Cubby", "cubby-a"],
        ["Walker", "desk-1"],
      ]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    // "Walker" shares a seat id with "Seated" only to keep the fixture small;
    // its `away` tile means `locate` never reads its assignment at all.
    book.adopt(layout, ["Seated", "Cubby"], "keep");

    // Deliberately not the identity: a test against `project: (c, r) => (c, r)`
    // would pass even if `locate` forgot to call it.
    const projector: OfficeProjector = {
      project: (col, row) => ({ x: col * 16 + 100, y: row * 16 + 7 }),
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      seatLift: () => 0,
    };

    const seatedBox = book.locate("Seated", projector, null);
    const deskOrigin = projector.project(3, 2);
    expect(seatedBox).toEqual({
      x: deskOrigin.x,
      y: deskOrigin.y,
      width: 2 * OFFICE_TILE,
      height: 2 * OFFICE_TILE,
    });

    const cubbyBox = book.locate("Cubby", projector, null);
    const cubbyOrigin = projector.project(5, 2);
    expect(cubbyBox).toEqual({
      x: cubbyOrigin.x,
      y: cubbyOrigin.y,
      width: OFFICE_TILE,
      height: OFFICE_TILE,
    });

    const away = { col: 2.5, row: 4 };
    const walkerBox = book.locate("Walker", projector, away);
    const walkerOrigin = projector.project(away.col, away.row);
    expect(walkerBox).toEqual({
      x: walkerOrigin.x,
      y: walkerOrigin.y + (OFFICE_TILE - OFFICE_CHARACTER_HEIGHT),
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    });
  });

  it("reactivates a still-releasing claim on a renewed wake instead of shopping for a new seat", () => {
    // A, B, C are cubby agents sharing one room with two reserve desks.
    const layout = buildLayout({
      seats: [
        {
          seatId: "c-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "c-b",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "c-c",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
        {
          seatId: "r1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(6, 0),
        },
        {
          seatId: "r2",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(8, 0),
        },
      ],
      desks: new Map([
        ["A", "c-a"],
        ["B", "c-b"],
        ["C", "c-c"],
      ]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A", "B", "C"], "keep");
    const preference = wake(ROOM, 0);

    expect(book.claim("B", preference)?.seatId).toBe("r1");
    expect(book.claim("A", preference)?.seatId).toBe("r2");
    assertNoDoubleBooking(book);

    book.endClaim("A");
    book.endClaim("B");
    // B has actually left; A is still walking home when it wakes again.
    book.vacated("B");
    assertNoDoubleBooking(book);

    // A renewed wake reactivates A's OWN reservation - it must not pick the
    // now-free r1, which would silently drop A's still-releasing claim on r2
    // and let a third agent claim r2 out from under it.
    expect(book.claim("A", preference)?.seatId).toBe("r2");
    expect(book.claim("C", preference)?.seatId).toBe("r1");
    assertNoDoubleBooking(book);
  });

  it("never advertises an away agent's own assignment as free, even across an unstable re-adopt", () => {
    const before = buildLayout({
      seats: [
        {
          seatId: "c-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "c-b",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "R",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
        {
          seatId: "H",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(6, 0),
        },
      ],
      desks: new Map([
        ["A", "c-a"],
        ["B", "c-b"],
      ]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(before, ["A", "B"], "keep");
    expect(book.claim("A", wake(ROOM, 0))?.seatId).toBe("H");
    assertNoDoubleBooking(book);

    // An unstable re-plan moves A's home assignment onto R while A's claim on
    // H is still held. A is not sitting at R - it is away on its claim - so R
    // must still read as spoken for.
    const after = buildLayout({
      seats: [
        {
          seatId: "c-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "c-b",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "R",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
        {
          seatId: "H",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(6, 0),
        },
      ],
      desks: new Map([
        ["A", "R"],
        ["B", "c-b"],
      ]),
      stable: false,
    });
    book.adopt(after, ["A", "B"], "keep");
    expect(book.occupancy().get("R")).toBe("A");
    expect(book.claim("B", wake(ROOM, 0))).toBeNull();
    expect(book.needsCapacity()).toContain("B");
    assertNoDoubleBooking(book);

    // A finally goes home: only now is R free for the wake that was shut out.
    book.endClaim("A");
    book.vacated("A");
    expect(book.effectiveSeat("A")?.seatId).toBe("R");
    const seated = book.claim("B", wake(ROOM, 0));
    expect(seated?.seatId).toBe("H");
    assertNoDoubleBooking(book);
  });

  describe("host-scoped exhaustion", () => {
    const HOST_1 = "host-1";
    const HOST_2 = "host-2";

    it("stays on the agent's own host even when the only free seat is on another", () => {
      const layout = buildLayout({
        seats: [
          {
            seatId: "a-cubby",
            kind: "cubby",
            roomId: ROOM,
            floorIndex: 0,
            deskTile: tile(0, 0),
            hostId: HOST_1,
          },
          {
            seatId: "b-desk",
            kind: "desk",
            roomId: "other",
            floorIndex: 1,
            deskTile: tile(0, 0),
            hostId: HOST_2,
          },
        ],
        desks: new Map([["A", "a-cubby"]]),
        stable: true,
      });
      const book = new OfficeSeatBook();
      book.adopt(layout, ["A"], "keep");
      // The only candidate is on host-2; A lives on host-1, so this must not
      // walk it across buildings - it must ask the plan for local capacity.
      expect(book.claim("A", wake(null, 0))).toBeNull();
      expect(book.needsCapacity()).toEqual(["A"]);
      assertNoDoubleBooking(book);
    });

    it("finds a free seat on the agent's own host when one exists there too", () => {
      const layout = buildLayout({
        seats: [
          {
            seatId: "a-cubby",
            kind: "cubby",
            roomId: ROOM,
            floorIndex: 0,
            deskTile: tile(0, 0),
            hostId: HOST_1,
          },
          {
            seatId: "a-desk",
            kind: "desk",
            roomId: ROOM,
            floorIndex: 0,
            deskTile: tile(2, 0),
            hostId: HOST_1,
          },
          {
            seatId: "b-desk",
            kind: "desk",
            roomId: "other",
            floorIndex: 1,
            deskTile: tile(0, 0),
            hostId: HOST_2,
          },
        ],
        desks: new Map([["A", "a-cubby"]]),
        stable: true,
      });
      const book = new OfficeSeatBook();
      book.adopt(layout, ["A"], "keep");
      const seat = book.claim("A", wake(ROOM, 0));
      expect(seat?.seatId).toBe("a-desk");
      expect(book.needsCapacity()).toEqual([]);
      assertNoDoubleBooking(book);
    });
  });

  describe("N2: an unassigned agent's preference floor may itself be empty", () => {
    it("reads the empty preference floor's own host and finds the free desk one floor up", () => {
      // Floor 0 is explicitly host-a and has no seats at all; floor 1, also
      // host-a, has the only free desk. Before N2 this went to
      // `needsCapacity` because the unassigned branch inferred the host by
      // scanning floor 0's (nonexistent) seats instead of reading
      // `layout.floors[0].hostId` - it never learned floor 0 was host-a's at
      // all, let alone that host-a had a desk open elsewhere.
      const layout = buildLayout({
        seats: [
          {
            seatId: "desk-1",
            kind: "desk",
            roomId: null,
            floorIndex: 1,
            deskTile: tile(0, 10),
            hostId: "host-a",
          },
        ],
        desks: new Map(),
        stable: true,
        floors: [{ hostId: "host-a" }, { hostId: "host-a" }],
      });
      const book = new OfficeSeatBook();
      book.adopt(layout, ["A"], "keep");
      const seat = book.claim("A", wake(null, 0));
      expect(seat?.seatId).toBe("desk-1");
      expect(book.needsCapacity()).toEqual([]);
      assertNoDoubleBooking(book);
    });

    it("treats a null floor host the same way: an unattributed building is still a building", () => {
      // Same shape, both floors explicitly hostless. A null host is its own
      // host, not "unresolved" - this is what tells empty topology apart from
      // missing identity: both floors say something, and what they say
      // happens to be `null`.
      const layout = buildLayout({
        seats: [
          {
            seatId: "desk-1",
            kind: "desk",
            roomId: null,
            floorIndex: 1,
            deskTile: tile(0, 10),
            hostId: null,
          },
        ],
        desks: new Map(),
        stable: true,
        floors: [{ hostId: null }, { hostId: null }],
      });
      const book = new OfficeSeatBook();
      book.adopt(layout, ["A"], "keep");
      const seat = book.claim("A", wake(null, 0));
      expect(seat?.seatId).toBe("desk-1");
      expect(book.needsCapacity()).toEqual([]);
      assertNoDoubleBooking(book);
    });

    it("still refuses when the empty preference floor's host is not the one with the free desk", () => {
      // Floor 0 (empty, host-a) is where A wakes; the only free desk is on
      // floor 1, but floor 1 belongs to host-b. F3's host scoping must
      // survive N2's fix: reading the floor's own host must not turn into
      // reading ANY floor's host.
      const layout = buildLayout({
        seats: [
          {
            seatId: "desk-1",
            kind: "desk",
            roomId: null,
            floorIndex: 1,
            deskTile: tile(0, 10),
            hostId: "host-b",
          },
        ],
        desks: new Map(),
        stable: true,
        floors: [{ hostId: "host-a" }, { hostId: "host-b" }],
      });
      const book = new OfficeSeatBook();
      book.adopt(layout, ["A"], "keep");
      expect(book.claim("A", wake(null, 0))).toBeNull();
      expect(book.needsCapacity()).toEqual(["A"]);
      assertNoDoubleBooking(book);
    });
  });

  it("orders candidates by room, then floor bullpen, then anywhere local, against a seat-id order that would pick wrong", () => {
    const OTHER_ROOM = "other-room";
    // Seat ids are named so plain seat-id order disagrees with every tier:
    // the same-room seat sorts LAST, the bullpen seat sorts BEFORE the other
    // room's seat even though the tiers rank the opposite way. If the book
    // ever fell back to bare seat-id order, at least one of the three
    // assertions below would pick the wrong seat.
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "z-same-room",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "m-bullpen",
          kind: "desk",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
        {
          seatId: "a-other-room",
          kind: "desk",
          roomId: OTHER_ROOM,
          floorIndex: 0,
          deskTile: tile(6, 0),
        },
      ],
      desks: new Map([["A", "cubby"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A", "B", "C"], "keep");
    const preference = wake(ROOM, 0);

    // A's own room wins over both other tiers, despite sorting last by id.
    expect(book.claim("A", preference)?.seatId).toBe("z-same-room");
    assertNoDoubleBooking(book);

    // With the room seat gone, the floor's bullpen wins over the other local
    // room's seat, even though "a-other-room" sorts before "m-bullpen".
    expect(book.claim("B", preference)?.seatId).toBe("m-bullpen");
    assertNoDoubleBooking(book);

    // Only the other room's seat is left.
    expect(book.claim("C", preference)?.seatId).toBe("a-other-room");
    assertNoDoubleBooking(book);
  });

  it("reconciles the shortfall with a direct desk assignment, no further claim() call needed", () => {
    // F6: a failed wake that later gets a REAL desk straight from the plan
    // (not through another claim()) must leave needsCapacity, or a hot agent
    // already at a desk keeps demanding growth forever.
    const small = buildLayout({
      seats: [
        {
          seatId: "c",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
      ],
      desks: new Map([["A", "c"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(small, ["A"], "keep");
    expect(book.claim("A", wake(ROOM, 0))).toBeNull();
    expect(book.needsCapacity()).toEqual(["A"]);

    const grown = buildLayout({
      seats: [
        {
          seatId: "D",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([["A", "D"]]),
      stable: true,
    });
    book.adopt(grown, ["A"], "keep");
    expect(book.effectiveSeat("A")?.seatId).toBe("D");
    expect(book.needsCapacity()).toEqual([]);
    assertNoDoubleBooking(book);
  });

  it("treats vacated before endClaim as a no-op: the claim is still held", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    book.claim("A", wake(ROOM, 0));
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");

    // `vacated` before `endClaim` answers a question that has not been asked
    // yet: the agent never said it wanted to leave, so its claim is still
    // held and the seat is still its effective one.
    book.vacated("A");
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");
    expect(book.occupant("desk-1")).toBe("A");
    assertNoDoubleBooking(book);

    // The normal path still works afterwards.
    book.endClaim("A");
    expect(book.effectiveSeat("A")?.seatId).toBe("cubby-a");
    book.vacated("A");
    expect(book.occupant("desk-1")).toBeNull();
    assertNoDoubleBooking(book);
  });

  it("frees a held claim's seat immediately when the agent is removed", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    book.claim("A", wake(ROOM, 0));
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");

    // A is removed from the roster entirely, still holding its claim.
    book.adopt(layout, [], "keep");
    expect(book.occupant("desk-1")).toBeNull();
    expect(book.knownAgentIds()).toEqual([]);
    assertNoDoubleBooking(book);
  });

  it("frees a releasing claim's seat immediately when the agent is removed", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    book.claim("A", wake(ROOM, 0));
    // A has stopped wanting the seat but has not vacated it yet.
    book.endClaim("A");
    expect(book.occupancy().get("desk-1")).toBe("A");

    book.adopt(layout, [], "keep");
    expect(book.occupant("desk-1")).toBeNull();
    expect(book.knownAgentIds()).toEqual([]);
    assertNoDoubleBooking(book);
  });

  it("lets the caller's order decide which of two competing hot cubby agents gets the seat on scrub", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "cubby-b",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        // Exactly one non-cubby seat: A and B cannot both get one.
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
      ],
      desks: new Map([
        ["A", "cubby-a"],
        ["B", "cubby-b"],
      ]),
      stable: true,
    });
    const hot: ReadonlyMap<string, OfficeAgentStatus> = new Map([
      ["A", "working"],
      ["B", "working"],
    ]);

    const aFirst = new OfficeSeatBook();
    aFirst.adopt(layout, ["A", "B"], "keep");
    aFirst.recomputeClaims(hot, ["A", "B"]);
    expect(aFirst.effectiveSeat("A")?.seatId).toBe("desk-1");
    expect(aFirst.effectiveSeat("B")?.seatId).toBe("cubby-b");
    expect(aFirst.needsCapacity()).toEqual(["B"]);
    assertNoDoubleBooking(aFirst);

    const bFirst = new OfficeSeatBook();
    bFirst.adopt(layout, ["A", "B"], "keep");
    bFirst.recomputeClaims(hot, ["B", "A"]);
    expect(bFirst.effectiveSeat("B")?.seatId).toBe("desk-1");
    expect(bFirst.effectiveSeat("A")?.seatId).toBe("cubby-a");
    expect(bFirst.needsCapacity()).toEqual(["A"]);
    assertNoDoubleBooking(bFirst);
  });

  it("locates an adopted agent by its held claim, not its underlying assignment", () => {
    // Unlike the walker case above, this agent IS adopted and holds a real
    // claim: `locate` must read `effectiveSeat`. Reading `assignedSeat`
    // instead would silently point the camera at the empty cubby.
    const layout = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(3, 2),
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    book.claim("A", wake(ROOM, 0));
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");
    expect(book.assignedSeat("A")?.seatId).toBe("cubby-a");

    const projector: OfficeProjector = {
      project: (col, row) => ({ x: col * 16 + 100, y: row * 16 + 7 }),
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      seatLift: () => 0,
    };
    const box = book.locate("A", projector, null);
    const deskOrigin = projector.project(3, 2);
    expect(box).toEqual({
      x: deskOrigin.x,
      y: deskOrigin.y,
      width: 2 * OFFICE_TILE,
      height: 2 * OFFICE_TILE,
    });
  });

  it("seats a later wake from the layout just adopted, not from a seat list left over from the last one", () => {
    // Control, not a fails-before case: this passes on the unfixed tree too,
    // because the unfixed tree sorts the registry fresh on every claim. What
    // it has to catch is a cache built on the first adopt and never rebuilt
    // - after the second adopt both readers of the sorted ids would still
    // walk layout A's seats, which no longer exist, and the wake would find
    // nothing.
    const layoutA = buildLayout({
      seats: [
        {
          seatId: "a-cubby",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
          hostId: "host-a",
        },
        {
          seatId: "a-desk",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
          hostId: "host-a",
        },
      ],
      desks: new Map([["A", "a-cubby"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layoutA, ["A", "U"], "keep");
    const fromA = book.claim("A", wake(ROOM, 0));
    expect(fromA?.seatId).toBe("a-desk");
    expect(fromA?.hostId).toBe("host-a");
    assertNoDoubleBooking(book);

    // B's registry shares no ids with A, a different count, and different
    // hosts and floors. `floors` is omitted so a wake whose preference names
    // floor 1 has no storey to read and must take owningHostOf's seat-scan
    // fallback.
    const layoutB = buildLayout({
      seats: [
        {
          seatId: "b-cubby",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 10),
          hostId: "host-b",
        },
        {
          seatId: "b-desk",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 10),
          hostId: "host-b",
        },
        {
          seatId: "b-scan-desk",
          kind: "desk",
          roomId: null,
          floorIndex: 1,
          deskTile: tile(4, 20),
          hostId: "host-u",
        },
      ],
      desks: new Map([["A", "b-cubby"]]),
      stable: true,
    });
    book.adopt(layoutB, ["A", "U"], "keep");

    // firstFreeSeat: A is assigned on host-b, so the ordinary claim path
    // walks the cached ids looking for a free desk there.
    const fromB = book.claim("A", wake(ROOM, 0));
    expect(fromB?.seatId).toBe("b-desk");
    expect(fromB?.hostId).toBe("host-b");
    assertNoDoubleBooking(book);

    // owningHostOf's seat-scan fallback: U has no assignment, and floor 1
    // is not a storey this layout carries, so the scan has to name host-u
    // from B's own seats. A stale cache would still be walking A's ids,
    // find none of them in B, and refuse to resolve a host at all.
    const scanned = book.claim("U", wake(null, 1));
    expect(scanned?.seatId).toBe("b-scan-desk");
    expect(scanned?.hostId).toBe("host-u");
    assertNoDoubleBooking(book);
  });

  it("never wakes an agent into a bed or a lounge chair, and still takes a console", () => {
    // Seat ids put the bed first, then the chair: if the want filter were
    // missing, A would be handed the bed. A wake that took a civic seat
    // would put a working agent in a crash bed, and the next crash would
    // find none.
    const civicOnly = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "a-bed",
          kind: "bed",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(2, 0),
          civicRoomId: "infirmary",
        },
        {
          seatId: "b-lounge",
          kind: "lounge",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(4, 0),
          civicRoomId: "waiting-room",
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const civicBook = new OfficeSeatBook();
    civicBook.adopt(civicOnly, ["A"], "keep");
    expect(civicBook.claim("A", wake(ROOM, 0))).toBeNull();
    expect(civicBook.effectiveSeat("A")?.seatId).toBe("cubby-a");
    expect(civicBook.occupant("a-bed")).toBeNull();
    expect(civicBook.occupant("b-lounge")).toBeNull();
    expect(civicBook.needsCapacity()).toEqual(["A"]);
    assertNoDoubleBooking(civicBook);

    // The same floor with a console added. A wake has always been able to
    // take a console, so this pins "civic excluded" rather than the weaker
    // "only desks". The bed still sorts first: a want that treated console
    // as civic would leave A unseated (or in the bed).
    const withConsole = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "a-bed",
          kind: "bed",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(2, 0),
          civicRoomId: "infirmary",
        },
        {
          seatId: "b-lounge",
          kind: "lounge",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(4, 0),
          civicRoomId: "waiting-room",
        },
        {
          seatId: "z-console",
          kind: "console",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(6, 0),
        },
      ],
      desks: new Map([["A", "cubby-a"]]),
      stable: true,
    });
    const consoleBook = new OfficeSeatBook();
    consoleBook.adopt(withConsole, ["A"], "keep");
    expect(consoleBook.claim("A", wake(ROOM, 0))?.seatId).toBe("z-console");
    expect(consoleBook.occupant("a-bed")).toBeNull();
    expect(consoleBook.occupant("b-lounge")).toBeNull();
    expect(consoleBook.needsCapacity()).toEqual([]);
    assertNoDoubleBooking(consoleBook);
  });

  it("never seats a civic claim at a desk", () => {
    // A free desk and no bed. If want were ignored, the civic claim would
    // take "a-spare" (it sorts first among the free non-cubbies) and a
    // crashed agent would look like a wake.
    const layout = buildLayout({
      seats: [
        {
          seatId: "home",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "a-spare",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([["A", "home"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    expect(book.claim("A", civic("bed", 0))).toBeNull();
    expect(book.effectiveSeat("A")?.seatId).toBe("home");
    expect(book.occupant("a-spare")).toBeNull();
    assertNoDoubleBooking(book);
  });

  it("never raises needsCapacity for a civic miss, and still does for a starved wake", () => {
    // Same office as the civic-never-takes-a-desk case: a free desk, no bed.
    const withDesk = buildLayout({
      seats: [
        {
          seatId: "home",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "a-spare",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([["A", "home"]]),
      stable: true,
    });
    const civicBook = new OfficeSeatBook();
    civicBook.adopt(withDesk, ["A"], "keep");
    expect(civicBook.claim("A", civic("bed", 0))).toBeNull();
    // C2: a civic miss is the cap doing its job, not a floor that owes a
    // bed. The spare desk is still free; the miss must not ask the plan to
    // grow around it.
    expect(civicBook.needsCapacity()).toEqual([]);
    assertNoDoubleBooking(civicBook);

    // Control: the same agent, starved of desks, claiming as a wake. A
    // wake against `withDesk` would take a-spare and never reach
    // claimShortfall, so it would not prove that shortfall still writes.
    // Without this, deleting shortfall (never writing claimShortfall)
    // would still pass the civic assertion above.
    const noDesk = buildLayout({
      seats: [
        {
          seatId: "cubby-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
      ],
      desks: new Map([
        ["A", "cubby-a"],
        ["B", "desk-1"],
      ]),
      stable: true,
    });
    const wakeBook = new OfficeSeatBook();
    wakeBook.adopt(noDesk, ["A", "B"], "keep");
    expect(wakeBook.claim("A", wake(ROOM, 0))).toBeNull();
    expect(wakeBook.needsCapacity()).toEqual(["A"]);
    assertNoDoubleBooking(wakeBook);
  });

  it("keeps occupant injective under mixed wakes and civic claims", () => {
    // Two cubby wakes shopping for desks, two crashes for one bed, one
    // wait for one chair. occupant is the injective view: if a wake could
    // take a bed, or two civic claims could share one, this is where it
    // would show - so the check runs after every mutation, not only at
    // the end.
    const layout = buildLayout({
      seats: [
        {
          seatId: "c-a",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "c-e",
          kind: "cubby",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "d-b",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 0),
        },
        {
          seatId: "d-c",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(6, 0),
        },
        {
          seatId: "d-d",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(8, 0),
        },
        {
          seatId: "r1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(10, 0),
        },
        {
          seatId: "r2",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(12, 0),
        },
        {
          seatId: "bed-1",
          kind: "bed",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(14, 0),
          civicRoomId: "infirmary",
        },
        {
          seatId: "lounge-1",
          kind: "lounge",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(16, 0),
          civicRoomId: "waiting-room",
        },
      ],
      desks: new Map([
        ["A", "c-a"],
        ["B", "d-b"],
        ["C", "d-c"],
        ["D", "d-d"],
        ["E", "c-e"],
      ]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A", "B", "C", "D", "E"], "keep");
    assertNoDoubleBooking(book);

    expect(book.claim("A", wake(ROOM, 0))?.seatId).toBe("r1");
    assertNoDoubleBooking(book);

    expect(book.claim("B", civic("bed", 0))?.seatId).toBe("bed-1");
    // The desk stays assigned while the bed is held: occupancy still
    // lists it, so a plan cannot hand B's desk to an arrival, and the
    // walk home has somewhere to go.
    expect(book.assignedSeat("B")?.seatId).toBe("d-b");
    expect(book.effectiveSeat("B")?.seatId).toBe("bed-1");
    expect(book.civicClaimOf("B")).toBe("bed");
    assertNoDoubleBooking(book);

    // C arrives at the same bed second: capacity is the cap, so it stays
    // at its desk and is not a reason to grow the office.
    expect(book.claim("C", civic("bed", 0))).toBeNull();
    expect(book.effectiveSeat("C")?.seatId).toBe("d-c");
    expect(book.needsCapacity()).not.toContain("C");
    assertNoDoubleBooking(book);

    expect(book.claim("D", civic("lounge", 0))?.seatId).toBe("lounge-1");
    expect(book.civicClaimOf("D")).toBe("lounge");
    assertNoDoubleBooking(book);

    // Seat-id order among the remaining free desks: r2, not a civic seat
    // and not anybody's home.
    expect(book.claim("E", wake(ROOM, 0))?.seatId).toBe("r2");
    expect(book.civicClaimOf("E")).toBeNull();
    assertNoDoubleBooking(book);

    expect(book.occupant("bed-1")).toBe("B");
    expect(book.occupant("lounge-1")).toBe("D");
    expect(book.occupant("r1")).toBe("A");
    expect(book.occupant("r2")).toBe("E");
    expect(book.occupant("d-b")).toBeNull();
    expect(book.needsCapacity()).toEqual([]);
    assertNoDoubleBooking(book);
  });

  it("keeps a civic claim across a stable keep-adopt and drops it on fresh", () => {
    // The bed is still standing in both adoptions. "keep" is every ordinary
    // re-plan: the claim is a reservation the plan was told about. "fresh"
    // is a plan made from scratch, so the civic claim is dropped with every
    // other claim - the scene re-derives them from statuses on the next
    // line. If keep dropped it, a crash would stand up on every sync; if
    // fresh kept it, the settle would leave a bed reservation the new
    // plan never made.
    const layout = buildLayout({
      seats: [
        {
          seatId: "desk-a",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "bed-1",
          kind: "bed",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(2, 0),
          civicRoomId: "infirmary",
        },
      ],
      desks: new Map([["A", "desk-a"]]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    expect(book.claim("A", civic("bed", 0))?.seatId).toBe("bed-1");
    expect(book.civicClaimOf("A")).toBe("bed");
    expect(book.assignedSeat("A")?.seatId).toBe("desk-a");
    assertNoDoubleBooking(book);

    book.adopt(layout, ["A"], "keep");
    expect(book.civicClaimOf("A")).toBe("bed");
    expect(book.effectiveSeat("A")?.seatId).toBe("bed-1");
    expect(book.assignedSeat("A")?.seatId).toBe("desk-a");
    assertNoDoubleBooking(book);

    book.adopt(layout, ["A"], "fresh");
    expect(book.civicClaimOf("A")).toBeNull();
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-a");
    expect(book.occupant("bed-1")).toBeNull();
    assertNoDoubleBooking(book);
  });

  it("keeps a released civic seat held between endClaim and vacated", () => {
    const layout = buildLayout({
      seats: [
        {
          seatId: "desk-a",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        {
          seatId: "desk-b",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(2, 0),
        },
        {
          seatId: "bed-1",
          kind: "bed",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(4, 0),
          civicRoomId: "infirmary",
        },
      ],
      desks: new Map([
        ["A", "desk-a"],
        ["B", "desk-b"],
      ]),
      stable: true,
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A", "B"], "keep");
    expect(book.claim("A", civic("bed", 0))?.seatId).toBe("bed-1");
    expect(book.assignedSeat("A")?.seatId).toBe("desk-a");
    expect(book.effectiveSeat("A")?.seatId).toBe("bed-1");
    expect(book.civicClaimOf("A")).toBe("bed");
    assertNoDoubleBooking(book);

    book.endClaim("A");
    // The character is walking home: its effective seat is the desk again
    // and civicClaimOf is null (a releasing claim is not held), but the
    // bed is still nobody else's until vacated. A second crash taking it
    // in between would put two agents in one bed.
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-a");
    expect(book.civicClaimOf("A")).toBeNull();
    expect(book.occupancy().get("bed-1")).toBe("A");
    expect(book.claim("B", civic("bed", 0))).toBeNull();
    expect(book.effectiveSeat("B")?.seatId).toBe("desk-b");
    assertNoDoubleBooking(book);

    book.vacated("A");
    expect(book.claim("B", civic("bed", 0))?.seatId).toBe("bed-1");
    expect(book.civicClaimOf("B")).toBe("bed");
    expect(book.assignedSeat("B")?.seatId).toBe("desk-b");
    expect(book.occupant("bed-1")).toBe("B");
    assertNoDoubleBooking(book);
  });
});

describe("OfficeSeatBook fixup 8c - a fresh adoption (D66)", () => {
  /**
   * THE BOOK IS WHAT THE OFFICE IS, which is why a plan made from scratch has
   * to be taken up from scratch.
   *
   * `"keep"` exists because the plan is handed this book's occupancy and
   * honours it, so the book honours the plan back. The settle plan is handed
   * none of it - no previous, no occupancy, no shortfall - so there is nothing
   * to honour, and keeping seats against it is not stability but
   * disagreement: cubby ids outlive a re-plan, so the agent that held one
   * keeps sitting in a cubby the new plan gave nobody, while the agent the
   * new plan gave it to gets no seat at all and lands in the shortfall. That
   * is the cold reviewer's second finding, and it is this one call away.
   */
  it("takes a stable layout's own desks wholesale, leaving nobody in the shortfall", () => {
    const kept = "kept-cubby";
    const desk = "real-desk";
    const first = buildLayout({
      stable: true,
      seats: [
        {
          seatId: kept,
          kind: "cubby",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(1, 1),
        },
        {
          seatId: desk,
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 1),
        },
      ],
      desks: new Map([["A", kept]]),
    });
    const book = new OfficeSeatBook();
    book.adopt(first, ["A", "B"], "keep");
    // The provisional shape of the defect: A lives in the cubby, and the desk
    // the next plan means for it belongs to nobody yet.
    expect(book.assignedSeat("A")?.seatId).toBe(kept);

    // The settle plan: the same two seats still exist - that is exactly why
    // `"keep"` failed - but A is now meant to be at the desk and B in the
    // cubby.
    const settled = buildLayout({
      stable: true,
      seats: [
        {
          seatId: kept,
          kind: "cubby",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(1, 1),
        },
        {
          seatId: desk,
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(4, 1),
        },
      ],
      desks: new Map([
        ["A", desk],
        ["B", kept],
      ]),
    });

    const keepMoved = new OfficeSeatBook();
    keepMoved.adopt(first, ["A", "B"], "keep");
    keepMoved.adopt(settled, ["A", "B"], "keep");
    // The finding itself, pinned so the fix below is a change: A holds the
    // cubby the plan gave B, B is left with nothing, and B is owed capacity
    // the office already has.
    expect(keepMoved.assignedSeat("A")?.seatId).toBe(kept);
    expect(keepMoved.assignedSeat("B")).toBeNull();
    expect(keepMoved.needsCapacity()).toEqual(["B"]);

    const moved = book.adopt(settled, ["A", "B"], "fresh");
    expect(book.assignedSeat("A")?.seatId).toBe(desk);
    expect(book.assignedSeat("B")?.seatId).toBe(kept);
    expect(book.needsCapacity()).toEqual([]);
    // And the caller still learns who has to walk: A's chair moved, B had no
    // chair to move from.
    expect(moved).toEqual(["A"]);
    assertNoDoubleBooking(book);
  });

  /**
   * A fresh adoption drops the claims with the assignment - a reserve taken
   * while the feed was behind was taken from a status that had not arrived,
   * and the scene re-derives every claim from the settled statuses on the
   * next line. What must not survive is a claim pointing into the office the
   * settle just replaced.
   */
  it("drops the claims and the shortfall it was carrying", () => {
    const cubby = "c-0";
    const reserve = "r-0";
    const layout = buildLayout({
      stable: true,
      seats: [
        {
          seatId: cubby,
          kind: "cubby",
          roomId: null,
          floorIndex: 0,
          deskTile: tile(1, 1),
        },
        {
          // A reserve is a seat the plan draws and nobody is assigned to, not
          // a kind of its own - and it must not be a cubby, which is the one
          // kind a claim will never take.
          seatId: reserve,
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(6, 1),
        },
      ],
      desks: new Map([["A", cubby]]),
    });
    const book = new OfficeSeatBook();
    book.adopt(layout, ["A"], "keep");
    const claimed = book.claim("A", wake(ROOM, 0));
    expect(claimed?.seatId).toBe(reserve);
    expect(book.effectiveSeat("A")?.seatId).toBe(reserve);

    book.adopt(layout, ["A"], "fresh");
    // Back to what the plan says, with no claim overriding it.
    expect(book.effectiveSeat("A")?.seatId).toBe(cubby);
    expect(book.needsCapacity()).toEqual([]);
    assertNoDoubleBooking(book);
  });
});
