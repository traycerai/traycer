import { describe, expect, it } from "vitest";
import { OfficeSeatBook } from "@/lib/comm-graph/office/office-seat-book";
import type {
  OfficeAgentStatus,
  OfficeDesk,
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
 * The seat book never reads a layout's cols, rows, rooms, floors, props or
 * walkable grid - only `desks`, `seats` and `stable` - so those fields are
 * filled with the emptiest values that still type-check. Building layouts by
 * hand here (never through `layoutOffice`) is what makes reserve seats, which
 * Floor never produces, possible to test at all.
 */
interface SeatSpec {
  readonly seatId: string;
  readonly kind: OfficeSeatKind;
  readonly roomId: string | null;
  readonly floorIndex: number;
  readonly deskTile: OfficeTilePos;
}

function tile(col: number, row: number): OfficeTilePos {
  return { col, row };
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
    floorIndex: spec.floorIndex,
    roomId: spec.roomId,
    hostId: null,
    manager: false,
  };
}

interface LayoutSpec {
  readonly seats: ReadonlyArray<SeatSpec>;
  /** agentId -> seatId, the plan's initial assignment. */
  readonly desks: ReadonlyMap<string, string>;
  readonly stable: boolean;
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
  return {
    view: "floor",
    cols: 40,
    rows: 40,
    desks,
    seats,
    signs: [],
    rooms: [],
    floors: [],
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
    book.adopt(layout, ["A"]);
    assertNoDoubleBooking(book);
    expect(book.effectiveSeat("A")?.seatId).toBe("cubby-a");

    // Wake: A claims the room's only reserve desk.
    const claimed = book.claim("A", { roomId: ROOM, floorIndex: 0 });
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
    book.adopt(grown, ["A", "B"]);
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
    book.adopt(layout, ["A"]);
    book.claim("A", { roomId: ROOM, floorIndex: 0 });
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
    book.adopt(conflicted, ["A", "New"]);

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
    book.adopt(layout, ["A"]);
    book.claim("A", { roomId: ROOM, floorIndex: 0 });
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
    book.adopt(layout, ["A", "B"]);

    const first = book.claim("A", { roomId: ROOM, floorIndex: 0 });
    const second = book.claim("B", { roomId: ROOM, floorIndex: 0 });
    expect(first?.seatId).toBe("desk-1");
    expect(second?.seatId).toBe("desk-2");
    assertNoDoubleBooking(book);

    // Claiming in the opposite order is just as deterministic: whoever asks
    // first gets seat-id order's first free seat, same as above.
    const reordered = new OfficeSeatBook();
    reordered.adopt(layout, ["A", "B"]);
    const bFirst = reordered.claim("B", { roomId: ROOM, floorIndex: 0 });
    const aSecond = reordered.claim("A", { roomId: ROOM, floorIndex: 0 });
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
    book.adopt(layout, ["A", "C"]);
    book.claim("A", { roomId: ROOM, floorIndex: 0 });
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");

    book.endClaim("A");
    // The character is walking home: its own effective seat is the cubby
    // again, but the desk it is leaving is still nobody else's to take.
    expect(book.effectiveSeat("A")?.seatId).toBe("cubby-a");
    expect(book.occupancy().get("desk-1")).toBe("A");
    const duringRelease = book.claim("C", { roomId: ROOM, floorIndex: 0 });
    expect(duringRelease).toBeNull();
    expect(book.needsCapacity()).toContain("C");
    assertNoDoubleBooking(book);

    book.vacated("A");
    // Now the seat is actually empty, and the agent that was shut out gets it.
    const afterVacate = book.claim("C", { roomId: ROOM, floorIndex: 0 });
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
    book.adopt(layout, ["A", "B"]);

    // Every non-cubby seat is already B's: A's wake finds nothing free.
    const exhausted = book.claim("A", { roomId: ROOM, floorIndex: 0 });
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
    book.adopt(grown, ["A", "B"]);
    const seated = book.claim("A", { roomId: ROOM, floorIndex: 0 });
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
    book.adopt(layout, ["A", "B"]);
    expect(book.claim("A", { roomId: ROOM, floorIndex: 0 })).toBeNull();
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
    book.adopt(layout, ["A"]);

    expect(book.claim("A", { roomId: ROOM, floorIndex: 0 })).toBeNull();
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
    book.adopt(layout, ["A"]);
    expect(book.occupant("desk-1")).toBe("A");

    book.adopt(layout, []);
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
    const firstMoved = book.adopt(before, ["A", "B"]);
    // Nobody was known before this adopt, so there is no "before" tile to
    // compare against yet - the first plan seats everybody without a walk.
    expect(firstMoved).toEqual([]);

    const repacked = buildLayout({
      seats: [
        {
          seatId: "desk-1",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(0, 0),
        },
        // B's chair tile changed; A's did not.
        {
          seatId: "desk-3",
          kind: "desk",
          roomId: ROOM,
          floorIndex: 0,
          deskTile: tile(6, 0),
        },
      ],
      desks: new Map([
        ["A", "desk-1"],
        ["B", "desk-3"],
      ]),
      stable: false,
    });
    const moved = book.adopt(repacked, ["A", "B"]);
    expect(moved).toEqual(["B"]);
    expect(book.effectiveSeat("A")?.seatId).toBe("desk-1");
    expect(book.effectiveSeat("B")?.seatId).toBe("desk-3");
    assertNoDoubleBooking(book);
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
    book.adopt(layout, ["Seated", "Cubby"]);

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
});
