/**
 * Shared vocabulary of the communication graph's OFFICE view: the pixel-art
 * floor where every agent is a character at a desk and every A2A message is an
 * envelope flying between desks.
 *
 * Three modules meet here and must not import each other's internals:
 *
 * - `office-pixel-art.ts` / `office-appearance.ts` DRAW: sprite maps, palettes,
 *   rasterization, deterministic per-agent looks.
 * - `office-layout.ts` / `office-scene.ts` SIMULATE: desk assignment, walking,
 *   sitting, typing, bubbles, envelopes. Pure; no DOM, no canvas, no clock.
 * - `comm-graph-office-canvas.tsx` PRESENTS: owns the `<canvas>`, the
 *   animation frame loop, the camera, hit-testing and the React wiring.
 *
 * Everything below is SPRITE SPACE: integer pixels at 1x, where one floor tile
 * is `OFFICE_TILE` px square. The canvas applies the camera (pan + zoom) on top
 * and never leaks screen pixels back into the scene.
 */
import type { GuiHarnessId } from "@traycer/protocol/persistence/epic/foundation";
import type { CommGraphAgentKind } from "@/lib/comm-graph/comm-graph-model";
import type { OfficeViewId } from "@/lib/comm-graph/office/office-view-vocabulary";
import type {
  CommGraphPulse,
  CommGraphPulseKind,
} from "@/lib/comm-graph/comm-graph-timeline";
// Type-only, and erased: `office-population.ts` reads this module back, so a
// value import here would close a real cycle.
import type { OfficePopulation } from "@/lib/comm-graph/office/office-population";

/** Side of one floor tile, in sprite-space pixels. */
export const OFFICE_TILE = 16;
/** Character sprite box: one tile wide, one and a quarter tall (head above). */
export const OFFICE_CHARACTER_WIDTH = 16;
export const OFFICE_CHARACTER_HEIGHT = 20;

/**
 * HOW FAR BELOW A SEAT'S FOOT ITS LETTERING SITS, in world pixels.
 *
 * Shared rather than repeated, because two different modules letter the same
 * row of seats: the scene writes a seated agent's name tag, and a view's
 * painter writes `reserve` under the empty chair next to it. Those two have to
 * land on one line - a painter that picked its own offset put `reserve`
 * INSIDE the console art in Mission control, where muted grey lettering on
 * grey furniture read as a name with its bottom half cut off (feedback round
 * 1: "lower half of labels on some agents are cut out").
 *
 * The number is a gap below the FEET, not below the furniture: a tag that
 * cleared the desk would still be over the chair on a view whose chair is
 * taller.
 */
export const OFFICE_LABEL_GAP = 8;

export type OfficeTheme = "light" | "dark";

export type OfficeFacing = "down" | "up" | "left" | "right";

/**
 * - `stand` / `walk1` / `walk2` - on foot, any facing.
 * - `sit` - seated at the desk, facing `up` (back to the viewer, screen ahead).
 * - `type1` / `type2` - seated and typing, alternated by the scene.
 * - `lean` - seated, tipped back from the desk: waiting on somebody else.
 * - `hand-up` - seated with an arm raised: this one needs a person.
 * - `crash` - seated, head in hands, in front of a dead screen.
 *
 * The last three are what a status looks like from behind, and they only ever
 * replace `sit`: a working agent types whatever else is true of it.
 */
export type OfficeCharacterPose =
  | "stand"
  | "walk1"
  | "walk2"
  | "sit"
  | "type1"
  | "type2"
  | "lean"
  | "hand-up"
  | "crash";

/**
 * Something WORN over a pose rather than a pose of its own, because it has to
 * survive the body underneath changing: a background agent still types.
 */
export type OfficeCharacterAccessory = "headphones";

/**
 * A character's look. Every value is a CSS hex color except `hairStyle`, which
 * indexes the sprite map variants. Derived deterministically from the agent id
 * so the same agent looks the same across sessions, windows and devices.
 */
export interface OfficeAppearance {
  readonly skin: string;
  readonly hair: string;
  readonly hairStyle: 0 | 1 | 2 | 3;
  readonly shirt: string;
  readonly pants: string;
  /** Brand tint: the harness color for a terminal agent, the app accent for a chat. */
  readonly accent: string;
}

export type OfficeSpriteName =
  | "character"
  | "desk"
  | "face"
  | "slab"
  | "desk-front"
  | "lamp"
  | "stairs-side"
  | "cubby"
  | "silhouette"
  | "skybridge"
  | "board"
  | "roof-edge"
  | "monitor-on"
  /** Second frame of a lit screen; the scene alternates it with `monitor-on` while the agent works. */
  | "monitor-on-b"
  | "monitor-off"
  /** Small plate on the desk's right half; the renderer draws the harness logo on it. */
  | "nameplate"
  /** Thin glass divider between desk clusters inside one cabin. */
  | "partition"
  /** Wall-mounted sign, two tiles wide; the cabin's name is drawn over it as a label. */
  | "sign"
  /** Laptop-sized screen for a small model tier; lit and dark variants. */
  | "monitor-small-on"
  | "monitor-small-off"
  /** Dual wide screens for a large model tier; `-b` is the second lit frame. */
  | "monitor-wide-on"
  | "monitor-wide-on-b"
  | "monitor-wide-off"
  /** A crashed screen: red with a sad face. Drawn at the tier's monitor size by the renderer scaling nothing - one 16×12 map, used for every tier. */
  | "monitor-crash"
  /** Unanswered requests piling on the receiver's desk; three heights. */
  | "envelope-stack-1"
  | "envelope-stack-2"
  | "envelope-stack-3"
  /** Wall clock face without hands; the renderer draws the hands from a `clock` drawable. */
  | "clock"
  /** Dust sheet over an archived agent's desk, desk-sized. */
  | "dust-sheet"
  /** Moving box beside an archived desk. */
  | "box"
  /** Reception counter in the lobby, two tiles wide. */
  | "reception"
  /** Stairwell between floors, two tiles square. */
  | "stairs"
  /** Water cooler in the cafeteria; an idle errand spot. */
  | "water-cooler"
  /** Round cafeteria table, two tiles wide; seats are the walkable tiles beside it. */
  | "cafe-table"
  /** Vending machine in the cafeteria. */
  | "vending"
  /** Menu board on the cafeteria's wall, two tiles wide; the renderer draws no text on it. */
  | "menu-board"
  /** Cafeteria sofa, two tiles wide; an idle agent lounges on it. */
  | "sofa"
  /** Waste bin beside a desk cluster; the target of a paper toss. */
  | "bin"
  /** Crumpled paper ball in flight; drawn like an envelope, tint-free. */
  | "paper-ball"
  /** Watering can held while tending a plant; drawn beside the character. */
  | "watering-can"
  /** Ping-pong table in the game room, two tiles wide, net across the middle. */
  | "pingpong-table"
  /** Arcade cabinet in the game room; lit screen. */
  | "arcade"
  /** Floor tiles inside a nested pod, tinted so a sub-team reads as a region; two checker variants. */
  | "floor-pod-a"
  | "floor-pod-b"
  /** Horizontal glass divider, the top/bottom edge of a pod; `partition` is the vertical one. */
  | "partition-h"
  /** Small plate at a pod's top-left corner; the sub-lead's name is drawn over it as a label. */
  | "pod-plate"
  /** Warm-tinted pod floor, the alternative to the cool `floor-pod-*` pair. */
  | "floor-pod-warm-a"
  | "floor-pod-warm-b"
  /** Planter box with a hedge; a pod outline style, one tile, works on any edge. */
  | "planter"
  /** Low bookshelf seen top-down; vertical and horizontal pod outline pieces. */
  | "shelf"
  | "shelf-h"
  /** Sleeping bag on the nap room floor; an agent lies on it. */
  | "sleep-bag"
  /** Armchair in the library nook. */
  | "armchair"
  /** Tall bookcase against a wall, the library's furniture. */
  | "bookcase"
  /** Garden ground, two checker variants. */
  | "floor-grass-a"
  | "floor-grass-b"
  /** Garden tree, one tile wide, two tall. */
  | "tree"
  /** Garden bench, two tiles wide; seats are the tiles in front. */
  | "bench"
  /** Foosball table, two tiles wide, players on both long sides. */
  | "foosball"
  /** Dartboard mounted on a wall face. */
  | "dartboard"
  /** Small chess table with a board; seats are the tiles either side. */
  | "chess-table"
  /** Wall-mounted TV for the console corner; lit. */
  | "tv"
  /** Treadmill in the gym; an agent walks in place on it. */
  | "treadmill"
  | "chair"
  | "plant"
  | "floor-a"
  | "floor-b"
  | "rug"
  | "wall"
  | "wall-top"
  | "door"
  | "window"
  | "whiteboard"
  | "coffee-machine"
  | "envelope"
  | "bubble-awaiting"
  | "bubble-attention"
  | "bubble-notice"
  | "bubble-hello"
  | "bubble-sleep"
  | "sparkle"
  /** Raised slab under a Mission control console row. */
  | "tier-step"
  /** The orchestrator's two-tile station below the big board. */
  | "podium"
  /** Amphitheatre workstation: two tiles, metal, facing the board. */
  | "console"
  /** Paving and lawn seen from the corner: one 32x16 diamond per tile. */
  | "floor-iso-a"
  | "floor-iso-b"
  | "floor-grass-iso-a"
  | "floor-grass-iso-b"
  /** A campus room's back walls, on its top-left and top-right edges. */
  | "wall-iso-left"
  | "wall-iso-right"
  /** The gate a district is entered through; it stands free on its tile. */
  | "door-iso"
  /** A campus desk, seen from the corner. */
  | "desk-iso"
  /** One storey of a city building: its two visible faces, and its roof. */
  | "block-left"
  | "block-right"
  | "block-top"
  /** A storey's windows, lit by what the agent inside is doing. */
  | "window-lit"
  | "window-dark"
  /** The mast that marks the HQ tower. */
  | "spire"
  /** An infirmary bed, two tiles wide; an agent in `failure` lies on it. */
  | "bed"
  /** Drawn over a bed whose seat is held, so an occupied ward reads at a glance. */
  | "bed-occupied"
  /** A waiting-room chair; symmetric, so one sprite serves both sides of the table. */
  | "lounge-chair"
  /** The lounge's low table, two tiles wide. */
  | "low-table"
  /** The archive's door of filing drawers, in the outer wall beside the entrance. */
  | "records-door"
  /** The red cross that marks the infirmary. */
  | "cross-sign"
  // ---- K2: the five other views' civic art ---------------------------- //
  //
  // One hunk, so K3's own art lands under it without a rebase that has to
  // interleave two sets of names.
  /** The dispensary's glazed screen: the plaza sees the ward through it. */
  | "glass-partition"
  /** Mission control's medbay light, alternating while a bed is held. */
  | "siren-light"
  | "siren-light-b"
  /** An infirmary bed, seen from the corner. */
  | "bed-iso"
  /** A waiting-room chair, seen from the corner. */
  | "lounge-chair-iso"
  /** The cross on a City hospital's roof, drawn on the roof diamond. */
  | "hospital-roof-cross"
  /** The bus stop's shelter: a roof on two posts, with the bench under it. */
  | "bus-shelter"
  /** The warehouse's roller door, standing free on its tile like `door-iso`. */
  | "warehouse-door-iso"
  /** A medbay bed on the amphitheatre floor, a console's two tiles wide. */
  | "medbay-bed"
  /** A gallery seat in the side aisle, facing the big board. */
  | "gallery-seat"
  /**
   * The three civic vehicles, each in two light frames and two projections.
   *
   * `-b` is the ALTERNATE LIGHT FRAME, the suffix `monitor-on-b` already uses:
   * the light is baked into the art rather than composited, so a vehicle is one
   * sprite per frame and the scene only says which. `-iso` is the isometric
   * drawing of the same vehicle, the suffix `desk-iso` already uses.
   *
   * `left` IS NEVER AUTHORED - it is `right` mirrored, the convention every
   * character body follows (`office-pixel-art.ts`, `selectMap`). That is why
   * twelve names cover three kinds times two facings times two frames times two
   * projections.
   */
  | "ambulance"
  | "ambulance-b"
  | "ambulance-iso"
  | "ambulance-iso-b"
  | "police-car"
  | "police-car-b"
  | "police-car-iso"
  | "police-car-iso-b"
  | "fire-engine"
  | "fire-engine-b"
  | "fire-engine-iso"
  | "fire-engine-iso-b";

/**
 * WHICH VEHICLE, which is also which trigger brought it: an ambulance for a
 * crash, a police car for an agent that needs a person, a fire engine for a
 * floor with three or more crashes at once.
 */
export type OfficeVehicleKind = "ambulance" | "police-car" | "fire-engine";

/**
 * Names one rasterized sprite. `facing`, `pose` and `appearance` only apply to
 * `character`; `tint` (a hex color) only to `envelope` and `sparkle`.
 */
export interface OfficeSpriteRef {
  readonly name: OfficeSpriteName;
  readonly facing?: OfficeFacing;
  readonly pose?: OfficeCharacterPose;
  readonly appearance?: OfficeAppearance;
  readonly tint?: string;
  /** Overlaid on a `character` after its pose and hair; nothing else takes one. */
  readonly accessory?: OfficeCharacterAccessory;
}

export interface OfficeSize {
  readonly width: number;
  readonly height: number;
}

export interface OfficePoint {
  readonly x: number;
  readonly y: number;
}

export interface OfficeTilePos {
  readonly col: number;
  readonly row: number;
}

export interface OfficeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A rectangle in whole tiles. */
export interface OfficeTileRect {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

// ---- Views ------------------------------------------------------------ //

/**
 * Which office a layout is a layout OF, re-exported from the vocabulary module
 * that owns it. It lives there because the settings store and the tile schema
 * need the name without the renderer graph this module sits in front of.
 */
export type { OfficeViewId };

/**
 * Semantic zoom, decided by the camera: `0` overview (pips with state glyphs),
 * `1` office, `2` close-up. A painter is handed one and draws for it; nothing
 * downstream re-derives the level from a zoom factor.
 */
export type OfficeLod = 0 | 1 | 2;

// ---- Layout ---------------------------------------------------------- //

/**
 * What kind of place an agent sits in. A `desk` is the full workstation every
 * view has had; a `cubby` is the one-tile slot a cold agent waits in with no
 * monitor, nameplate or errands; a `console` is the amphitheatre's two-tile
 * station. A `bed` and a `lounge` chair are the CIVIC seats: a place a status
 * puts somebody, held by a claim for as long as that status lasts. The kind is
 * what the scene reads - never the view id.
 */
export type OfficeSeatKind = "desk" | "cubby" | "console" | "bed" | "lounge";

/**
 * A room an agent's STATE sends it to, as opposed to one its work happens in.
 *
 * Four kinds, one per state that has somewhere to be: the infirmary for a
 * crash, the help desk for an agent that needs a person, the waiting room for
 * one waiting on a reply, the archive for one that has gone. Every view fills
 * the same four with its own words and its own geometry, which is what keeps
 * "where is this agent" one question with one answer across six offices.
 */
export type OfficeCivicKind =
  | "infirmary"
  | "help-desk"
  | "waiting-room"
  | "archive";

/**
 * One place an agent can sit, whether or not anybody sits there. Reserve seats
 * are seats: they carry ids from the moment the plan makes them, which is what
 * lets the seat book hand one out without inventing geometry of its own.
 */
export interface OfficeSeat {
  /**
   * Stable across plans: `"<host>/<floor>/<room>/<n>"`. On an append-stable
   * layout the same seat keeps the same id for the life of the view, which is
   * what makes "who is where" survive a re-plan.
   */
  readonly seatId: string;
  readonly kind: OfficeSeatKind;
  /** Top-left tile of the furniture; hit boxes are anchored here. */
  readonly deskTile: OfficeTilePos;
  /** Path goal, and the character's own tile once it is seated. */
  readonly chairTile: OfficeTilePos;
  /** Which way the seated character looks; `"up"` on Floor. */
  readonly facing: OfficeFacing;
  /** The seat's box in tiles from `deskTile`: 2×2 desk, 1×1 cubby, 2×1 console. */
  readonly hitTiles: OfficeSize;
  /**
   * Where this seat is actually PAINTED, in projected world pixels, or `null`
   * to take the `hitTiles` box from `deskTile` as before.
   *
   * A size in tiles anchored at the desk's own projected corner describes a
   * seat drawn at its tile, which is every seat on a layered or oblique view.
   * An isometric building is not: it is centred on `project(col + 0.5, row + 1)`
   * and rises `storeys × 8` px ABOVE that, so its painted box is offset from
   * the desk tile in both axes and no width and height can reach it - the hit
   * rect and the art share no pixel at all. A view that paints somewhere else
   * says where here rather than the contract growing a second tile-space
   * fiction; the seat book and the scene both read this first.
   */
  readonly hitBox: OfficeRect | null;
  /** The storey this seat belongs to: its door, lobby, queue and corridors. */
  readonly floorIndex: number;
  /** The room that owns it - visits, boards and plates - or `null` in the open. */
  readonly roomId: string | null;
  readonly hostId: string | null;
  /** A root agent (no parent on the floor) gets a manager desk with a plant. */
  readonly manager: boolean;
  /**
   * The civic room this seat belongs to, or `null` for a desk, cubby or
   * console.
   *
   * Carried on the SEAT rather than looked up by walking the floor's rooms,
   * because everything that asks - the seat book's preference filter, the
   * hover card's "where" line, the painter's choice of furniture - has a seat
   * in hand and no reason to know how a floor stores its rooms.
   */
  readonly civicRoomId: string | null;
  /** Alpha of the seated occupant's actor while idle at lod 1 and 2; absent means 1. */
  readonly idleAlpha?: number;
}

/** A seat the plan handed to an agent: the INITIAL assignment, not the truth. */
export interface OfficeDesk extends OfficeSeat {
  readonly agentId: string;
}

export interface OfficeProp {
  readonly sprite: OfficeSpriteRef;
  readonly tile: OfficeTilePos;
}

/**
 * One walled cabin per root agent (an agent with no parent on the floor). Its
 * whole subtree sits inside, so nesting reads as "who is in whose room".
 */
export interface OfficeRoom {
  readonly rootAgentId: string;
  /** The root agent's name, drawn on the wall sign. */
  readonly name: string;
  /** Outer bounds INCLUDING the cabin's own walls, in tiles. */
  readonly bounds: OfficeTileRect;
  /** Walkable gap in the cabin's bottom wall, opening onto the corridor. */
  readonly doorTile: OfficeTilePos;
  /** Left tile of the two-tile sign on the cabin's top wall. */
  readonly signTile: OfficeTilePos;
  /**
   * Nested sub-teams inside this cabin, one per agent that has children,
   * recursively. Depth 1 is a direct child of the root; a pod's bounds always
   * lie inside its parent pod's (or the cabin's) interior.
   */
  readonly pods: ReadonlyArray<OfficePod>;
  /**
   * Where a visitor from this same room stands to call on somebody, or `null`
   * where the room has no such tile. A visit is same-room in every view, so
   * the room owns the tile rather than the scene deriving it from a chair.
   */
  readonly visitTile: OfficeTilePos | null;
}

/**
 * A sub-team's region inside a cabin: its lead's desk at the top-left, the
 * lead's descendants packed inside. Drawn as tinted floor with a glass
 * outline and a name plate, not walls, so the cabin stays one room.
 */
export interface OfficePod {
  readonly leadAgentId: string;
  readonly name: string;
  /** 1 for a child of the cabin's root, 2 for a grandchild's pod, and so on. */
  readonly depth: number;
  /** Interior tiles of the pod, excluding the glass outline. */
  readonly bounds: OfficeTileRect;
  /** Where the name plate sits: the pod's top-left OUTLINE tile, outside `bounds`. */
  readonly plateTile: OfficeTilePos;
  /**
   * How the outline is drawn. Chosen by the layout from the lead's id hash
   * and depth so neighbouring pods differ and nested ones never match their
   * parent.
   */
  readonly style: OfficePodStyle;
  /** Floor tint family; also never the same as the parent's. */
  readonly tint: "cool" | "warm";
}

export type OfficePodStyle = "glass" | "planters" | "shelves";

/**
 * One civic room on one storey: where a state puts an agent.
 *
 * Shaped like an amenity on purpose - bounds, a door, a sign, a name - because
 * a painter that can draw a break room can draw an infirmary, and the two
 * differ in what sends somebody there rather than in what they look like. What
 * an amenity has no use for is the rest: the SEATS a claim may take, and the
 * KERB a vehicle stops at.
 *
 * The help desk and the archive carry no seats. The help desk is the view's
 * existing reception counter wearing this record so that its sign, its name and
 * its kerb come from the same place as the other three; the archive is a door
 * with a counter on it, and a room that kept one crate per archived agent would
 * grow without bound.
 */
export interface OfficeCivicRoom {
  /**
   * Stable across plans: `"<host>/civic/<kind>"`, and the host is the only thing
   * outside the kind that names it.
   *
   * NO FLOOR ORDINAL, which this carried until read X. A floor or district index
   * is a POSITION in the partition's host-id ordering, so a host arriving
   * lexically earlier renamed every later floor's rooms and seats, the book
   * adopted nothing, and patients holding beds were re-seated into each other's.
   *
   * WHAT THE UNIQUENESS RESTS ON, because it is not a prohibition in this
   * contract: every producer shipped today builds ONE civic pool per host. The
   * Floor groups its rooms once per host; Campus and City build one quarter per
   * partition host; Towers and Building keep one civic plaza per building, with a
   * host-to-building map carrying it across growth; Mission control's hall builds
   * one set globally, for every host at once (`hostScope: "every-host"`). Nothing
   * here forbids a producer from wanting TWO rooms of one kind for one host - and
   * the day one does, this id is what it has to extend, with a discriminator that
   * is a fact about the room rather than its rank in a sort.
   */
  readonly civicRoomId: string;
  readonly kind: OfficeCivicKind;
  /**
   * Outer bounds, INCLUDING this room's own walls WHERE IT HAS THEM - which is
   * `enclosure`'s answer and not this field's.
   *
   * This doc used to promise the walls outright, "like an amenity's". Measured
   * across the five views that plan civic rooms, that is true of four of the
   * twenty rooms: the Floor's infirmary and waiting room, Campus's sick bay and
   * records hut. The other sixteen are a counter, a bench row, a door or an
   * area of a hall, and their bounds are the furniture's extent.
   */
  readonly bounds: OfficeTileRect;
  /**
   * IS THIS ROOM A BUILDING OR A PIECE OF FURNITURE, stated by the plan.
   *
   * `"walled"` means the perimeter of `bounds` is this room's own structure: a
   * ward, a records hut, a lounge with its own four walls. `"open"` means the
   * bounds are the extent of FURNITURE standing in a larger space - a reception
   * counter, a row of benches on a lawn, a door in somebody else's wall.
   *
   * A PAINTER CANNOT WORK THIS OUT FROM THE TILES, which is why it is a field.
   * Walkability answers "where is the gap in this wall", not "is there a wall":
   * a counter's tiles are blocked because a counter is solid, exactly as a
   * wall's are, and a painter reading blockedness alone draws wall pieces round
   * an open desk. Measured, that is not an edge case - it is what happened.
   *
   * NOR CAN THE KIND ANSWER IT. At 309 agents the perimeter blockedness of the
   * SAME kind is opposite in two views: `waiting-room` is 17/17 across its top
   * row and 7/7 down its left on the Floor - a walled room - and 0/16 in
   * Campus, a bench row on open lawn. `infirmary` is 17/17 in Campus and 10/10
   * on the Floor but 0/16 in Mission control, whose ward is an area in one
   * hall. Three of the four kinds differ by view, so only the view knows.
   *
   * One direction of this is pinned across every view: a room that says
   * `"walled"` has its first bounds row fully blocked. The reverse is not
   * pinnable and must not be asserted - an open room's perimeter is blocked by
   * its own furniture, which is the confusion this field exists to end.
   */
  readonly enclosure: "walled" | "open";
  /** The way in; for the archive, where the walk-out ends. */
  readonly doorTile: OfficeTilePos;
  /** Left tile of the room's sign. */
  readonly signTile: OfficeTilePos;
  /** The view's own word for this kind: "Infirmary", "Sick bay", "Hospital". */
  readonly name: string;
  /** Beds or lounge chairs, in seat-id order; empty for the help desk and the archive. */
  readonly seatIds: ReadonlyArray<string>;
  readonly floorIndex: number;
  readonly hostId: string | null;
  /**
   * WHO THIS ROOM SERVES, stated by the plan rather than inferred from
   * `hostId`.
   *
   * `"host"` is a room of one building: its counters count that host's things,
   * and `hostId` names the host. Every view whose storeys belong to one host
   * each says this.
   *
   * `"every-host"` is a room the whole epic shares - Mission control's hall,
   * which is ONE floor for every host, so its ward, gallery, dispatch desk and
   * Records serve all of them. Such a room carries `hostId: null`, and THAT IS
   * WHY THE SCOPE HAS TO BE A FIELD: `null` already means the unattributed
   * host, a real host with its own agents and its own archived records, so a
   * counter reading `null` as "everybody" would report the unattributed host's
   * count on a shared room and a shared count on the unattributed one. The two
   * are different answers and only the plan knows which it meant.
   */
  readonly hostScope: "host" | "every-host";
  /**
   * Where a vehicle stops for this room - a tile of the floor's `road` - or
   * `null` where nothing drives to it. Carried by the PLAN because the road is
   * the plan's, and a scene that derived a kerb would be deriving geometry.
   */
  readonly kerbTile: OfficeTilePos | null;
}

/**
 * The lane vehicles drive along on one storey, as a polyline of tiles.
 *
 * DRAWN, NOT SEARCHED. A road is not part of `walkable` and no route is ever
 * found across it: a vehicle interpolates along `tiles` in order, entering at
 * `entryTile` and leaving at `exitTile`, and the view's projector maps each
 * tile to the screen exactly as it does for a walker. That is what lets one
 * route description work oblique and isometric alike.
 *
 * Declared here rather than beside the vehicles so that the plans which emit a
 * road and the code that eventually drives one share a single shape.
 */
export interface OfficeRoad {
  readonly entryTile: OfficeTilePos;
  /** In travel order, `entryTile` first and `exitTile` last. */
  readonly tiles: ReadonlyArray<OfficeTilePos>;
  readonly exitTile: OfficeTilePos;
}

/**
 * One building floor per host. A single-host epic has exactly one floor and
 * draws no stairwell or floor sign; several hosts stack floors vertically,
 * each with its own lobby, door and reception. Agents never cross floors:
 * messaging is host-local, so there is nothing to walk between.
 */
export interface OfficeFloor {
  /** `null` groups agents whose record predates host binding. */
  readonly hostId: string | null;
  /** Shown on the floor sign; the renderer resolves a host name, the layout only carries the id. */
  readonly bounds: OfficeTileRect;
  readonly doorTile: OfficeTilePos;
  readonly lobbyTile: OfficeTilePos;
  /** Left tile of the two-tile reception counter in this floor's lobby. */
  readonly receptionTile: OfficeTilePos;
  /**
   * Standing spots in front of reception, nearest first. Agents that need a
   * person queue here in arrival order.
   */
  readonly receptionQueueTiles: ReadonlyArray<OfficeTilePos>;
  /** Which way somebody in the queue looks; `"down"` on Floor. */
  readonly queueFacing: OfficeFacing;
  /**
   * The stroll tiles this storey OWNS: walkable floor that belongs to nothing
   * in particular - not a room, not an amenity, not the lobby, the door or the
   * queue, and not a tile some errand spot already names.
   *
   * Carried rather than scanned, because "the rows above the lobby" is a fact
   * about one storey of one view: an oblique aisle row and an isometric
   * district corridor are both corridors and neither is above a lobby.
   */
  readonly corridorTiles: ReadonlyArray<OfficeTilePos>;
  /** Wall tile carrying this floor's clock. */
  readonly clockTile: OfficeTilePos;
  /** Top-left of the two-by-two stairwell, or `null` on a single-floor building. */
  readonly stairsTile: OfficeTilePos | null;
  /**
   * Where an idle agent may wander to on this floor. Each spot is a WALKABLE
   * tile beside the thing it names, with the facing that looks at it. The
   * scene picks among them deterministically; spots are never desks, doors,
   * or queue tiles.
   */
  readonly errandSpots: ReadonlyArray<OfficeErrandSpot>;
  /**
   * The floor's cafeteria: a walled break room holding the coffee machine,
   * water cooler, vending machine, menu board and tables. Outer bounds
   * including its walls; `null` only when the floor is too small to hold one.
   */
  readonly cafeteria: OfficeTileRect | null;
  /**
   * The floor's game room: a walled room beside the cafeteria with a
   * ping-pong table and an arcade cabinet. Outer bounds including walls.
   */
  readonly gameRoom: OfficeTileRect | null;
  /**
   * Named areas on this floor, each with the left tile of a two-tile `sign`
   * on the area's top wall and the text drawn over it ("Cafeteria",
   * "Game room"). Cabins carry their own sign in `OfficeRoom`.
   */
  readonly areaSigns: ReadonlyArray<OfficeAreaSign>;
  /**
   * Every amenity room on this floor, including the cafeteria and game room
   * (which stay mirrored in their own fields). Which rooms exist and how big
   * they are follows the floor's agent count.
   */
  readonly amenities: ReadonlyArray<OfficeAmenity>;
  /**
   * The civic rooms on this storey, AT MOST ONE PER KIND. Empty on a view that
   * plans none.
   *
   * Separate from `amenities` rather than folded into it, because the two
   * answer different questions and every consumer asks only one of them: an
   * amenity is somewhere an idle agent MAY go, and the errand engine reads the
   * list to find out where; a civic room is where a status PUTS somebody, and
   * the errand engine must never send anyone there.
   */
  readonly civic: ReadonlyArray<OfficeCivicRoom>;
  /** The lane vehicles drive along this storey, or `null` where it has no street. */
  readonly road: OfficeRoad | null;
}

export type OfficeAmenityKind =
  | "cafeteria"
  | "game"
  | "nap"
  | "library"
  | "garden"
  | "gym";

export interface OfficeAmenity {
  readonly kind: OfficeAmenityKind;
  /** Outer bounds including the room's walls (the garden has a low hedge instead). */
  readonly bounds: OfficeTileRect;
  readonly doorTile: OfficeTilePos;
  /** Left tile of the room's two-tile wall sign. */
  readonly signTile: OfficeTilePos;
  readonly name: string;
}

export interface OfficeAreaSign {
  readonly name: string;
  readonly signTile: OfficeTilePos;
}

export type OfficeErrandKind =
  | "coffee"
  | "cooler"
  /** A seat at a cafeteria table. */
  | "cafe"
  | "vending"
  /** A seat on the cafeteria sofa. */
  | "sofa"
  /** Standing spot beside a waste bin, for a paper toss. */
  | "bin"
  /** Standing spot beside a cabin plant, for watering it. */
  | "water-plant"
  /** The corridor tile outside another cabin's door, for a peek inside. */
  | "peek"
  /** Beside the stairwell, looking down it; multi-floor buildings only. */
  | "stairs"
  /** One end of the ping-pong table; two agents rally. */
  | "pingpong"
  /** In front of the arcade cabinet. */
  | "arcade"
  /** One side of the foosball table; two agents play. */
  | "foosball"
  /** Throwing spot facing the dartboard. */
  | "darts"
  /** One seat at the chess table; two agents play. */
  | "chess"
  /** Sofa seat facing the TV. */
  | "console"
  /** A sleeping bag in the nap room. */
  | "nap"
  /** The armchair in the library nook. */
  | "read"
  /** A bench seat or a stroll spot in the garden. */
  | "garden"
  /** On the treadmill. */
  | "treadmill"
  | "whiteboard"
  | "window"
  | "plant"
  | "corridor";

/**
 * WHO may take a spot, as a fact about the plan rather than about the kind.
 *
 * Today's scene reasons from the kind - a bin belongs to the cabin it stands
 * in, a peek is somebody else's door - which is a rule about one floor plan
 * wearing the costume of a rule about errands. A plaza plant belongs to no
 * room at all and a leads-only whiteboard belongs to a class of agent, and
 * neither can be said in kinds without the scene learning view names.
 *
 * - `floor` - anyone whose seat is on this spot's storey.
 * - `room` - that cabin's own people, and nobody else: its bin, its plant.
 * - `not-room` - anyone with a room of their OWN that is not this one: the
 *   point of a peek is that the door is somebody else's. An agent with no room
 *   is refused, as it is for `room` - a deskless or open-plan agent is not
 *   given the run of every cabin on the storey.
 * - `leads` - team leads and the host's HQ occupant.
 * - `nobody` - a prop the plan stood up with no usable spot beside it.
 */
export type OfficeSpotAudience =
  | { readonly kind: "floor" }
  | { readonly kind: "room"; readonly roomId: string }
  | { readonly kind: "not-room"; readonly roomId: string }
  | { readonly kind: "leads" }
  | { readonly kind: "nobody" };

export interface OfficeErrandSpot {
  readonly kind: OfficeErrandKind;
  readonly tile: OfficeTilePos;
  readonly facing: OfficeFacing;
  /** Who has any business here. An ALIAS copies its canonical spot's. */
  readonly audience: OfficeSpotAudience;
  /**
   * The FIXTURE this spot belongs to - one id per table, sofa or board, not
   * one per row. Two agents rally when they stand at spots that share a
   * fixture, which is what stops a same-kind neighbour at a different table
   * from being read as the other end of this one.
   */
  readonly fixtureId: string;
  /** Where the walker actually stands; `tile` on Floor. */
  readonly approachTile: OfficeTilePos;
  /**
   * What a throw, a watering or a sparkle is aimed AT, or `null` for a spot
   * that acts on nothing. Projected like any other tile, so the target of a
   * paper ball is right in an isometric view too.
   */
  readonly actionTile: OfficeTilePos | null;
  readonly floorIndex: number;
  /**
   * The SEAT this spot's fixture is, for a fixture that is also somewhere the
   * seat book can seat somebody - or `null`, which is almost everything.
   *
   * A bin, a plant, a whiteboard and a coffee machine are furniture nobody is
   * ever IN, so their spots are always available and they carry `null`. A BENCH
   * is not: Campus's courtyard bench is both the fixture a stroll sits on and a
   * seat the waiting room lends, and the two readings of it are the same tile.
   * Without this the scene would send somebody to sit on a bench that already
   * has an agent lying on it - two characters at one tile, in different poses,
   * and the seat book convinced it seated one of them.
   *
   * So the SPOT names the seat and the errand pass asks whether it is taken. The
   * spot is the right place for it rather than the seat: a seat does not know it
   * is also a fixture, and a view that furnishes a room with two benches and one
   * stroll spot would otherwise have to keep the two lists agreeing by hand.
   */
  readonly seatId: string | null;
}

/**
 * What a piece of lettering on the plan NAMES. `room`, `pod` and `area` are
 * today's cabin signs, pod plates and amenity signs; `host`, `plate`, `board`
 * and `hq-board` are what the later views hang on a storey.
 */
export type OfficeSignKind =
  | "room"
  | "pod"
  | "area"
  | "host"
  | "plate"
  | "board"
  | "hq-board"
  /** A civic room's name, and the one kind of sign that may carry a counter. */
  | "civic";

/**
 * How a sign's lettering gives way when it is wider than the tiles it names.
 *
 * - `"name"` - the shared name ladder, derived at the cursor from whatever the
 *   owner is called right now (`officePlateRungs`).
 * - a list of readings, widest first - this sign's own wording said at
 *   decreasing lengths, for a plate that carries a SUMMARY rather than a name
 *   and so has no owner to re-letter from.
 *
 * A sign that declares neither is drawn as written, which is every sign that
 * is wider than its lettering can ever be.
 */
export type OfficeSignRungs = "name" | ReadonlyArray<string>;

/**
 * One piece of lettering, placed by the plan and drawn by the renderer.
 *
 * Signs leave the scene's prop pass because WHO a sign names is a plan fact
 * and WHETHER it can be drawn is a cursor fact: a sign whose owner does not
 * exist yet at the cursor has no name to show, and that check belongs where
 * the visible set is known rather than inside the packing.
 */
export interface OfficeSign {
  readonly kind: OfficeSignKind;
  /** Left tile of the sign; `widthTiles` runs right from here. */
  readonly tile: OfficeTilePos;
  readonly widthTiles: number;
  /** `""` where the renderer resolves the text itself, as for a host name. */
  readonly text: string;
  /** Drawn only while this agent is visible at the cursor; `null` draws always. */
  readonly ownerAgentId: string | null;
  readonly hostId: string | null;
  /** Boards only: whose statuses this sign summarises. */
  readonly agentIds: ReadonlyArray<string>;
  /**
   * The civic room this sign names, or `null` for every other kind of
   * lettering. What lets a counter be read off the room rather than baked into
   * the text at plan time, which would be a number that stops being true.
   */
  readonly civicRoomId: string | null;
  /**
   * What this sign says when its full lettering is wider than `widthTiles`;
   * absent draws the text as written.
   *
   * A plate is the one piece of lettering whose room can be narrower than its
   * own name - a two-desk pod is four tiles, and a twelve-character plate is
   * half as wide again as that at office zoom - so a plate that names a pod
   * declares how it comes down rather than overflowing into the pod beside it.
   */
  readonly rungs?: OfficeSignRungs;
}

/**
 * The floor plan for one epic. Pure function of the agent set, recomputed when
 * the set changes and never persisted: a desk is a function of who exists, not
 * a stored coordinate.
 */
export interface OfficeLayout {
  /** Which view produced this layout. The scene never reads it; the tests do. */
  readonly view: OfficeViewId;
  readonly cols: number;
  readonly rows: number;
  /** One desk per agent in the input set, keyed by agent id. */
  readonly desks: ReadonlyMap<string, OfficeDesk>;
  /**
   * EVERY seat the plan made, reserves included, keyed by `seatId`. The seat
   * book hands these out; `desks` is only the initial assignment.
   */
  readonly seats: ReadonlyMap<string, OfficeSeat>;
  /** Every piece of lettering on the plan, in draw order. */
  readonly signs: ReadonlyArray<OfficeSign>;
  /** One cabin per root agent, in layout order. Empty when there are no agents. */
  readonly rooms: ReadonlyArray<OfficeRoom>;
  /** One per host, in host-id order; never empty (an empty epic has one floor). */
  readonly floors: ReadonlyArray<OfficeFloor>;
  /** The building entrance: where characters enter and leave. Always a walkable tile on the outer wall. */
  readonly doorTile: OfficeTilePos;
  /** Where a character stands after walking in, before its desk exists. */
  readonly lobbyTile: OfficeTilePos;
  /** Decorative props (plants, coffee machine, whiteboard, windows). */
  readonly props: ReadonlyArray<OfficeProp>;
  /** `walkable[row][col]`; desks, chairs, walls and props are not walkable. */
  readonly walkable: ReadonlyArray<ReadonlyArray<boolean>>;
  /**
   * This view's own packing metadata, carried forward through `previous` so a
   * plan can re-pack the way it packed last time. OPAQUE to the scene, which
   * is the point: wings, tower counts, tier widths and lot grids are facts
   * about one packer and nothing outside it may read them.
   */
  readonly frozen: unknown;
  /**
   * How far the whole world moved since `previous`, or `null` when it did not.
   * The scene translates every tile and point it holds by this and pans the
   * camera back, so a building that grew a storey does not jump on screen.
   */
  readonly shiftFromPrevious: OfficeTilePos | null;
  /**
   * `true` where a seat only ever moves by `shiftFromPrevious`, so an
   * appended agent never rehomes anybody. Floor and Campus re-pack instead
   * and say `false`.
   */
  readonly stable: boolean;
}

// ---- Scene inputs --------------------------------------------------- //

/**
 * Coarse size class of the agent's model, derived client-side from the model
 * name. Decides the desk's screen: laptop, single monitor, or dual wide.
 */
export type OfficeModelTier = "small" | "medium" | "large";

export interface OfficeAgentInput {
  readonly id: string;
  readonly name: string;
  readonly kind: CommGraphAgentKind;
  /** Host the agent lives on; `null` for a record that predates host binding. Floors group by it. */
  readonly hostId: string | null;
  /** When the record was archived, or `null` while live. Compared against the time cursor. */
  readonly archivedAt: number | null;
  readonly modelTier: OfficeModelTier;
  /** The harness running this agent; `null` for a record that carries none. */
  readonly harnessId: GuiHarnessId | null;
  /** The model slug, when the record carries one. Shown on hover, never on the floor. */
  readonly model: string | null;
  readonly parentId: string | null;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly appearance: OfficeAppearance;
}

/**
 * What the character is doing, in precedence order (highest first):
 *
 * - `failure` - an unread failure notification; the screen has crashed.
 * - `attention` - a person is needed (interview / approval pending).
 * - `awaiting` - sent an `expectReply` request that has no reply yet.
 * - `working` - in an active turn.
 * - `archived` - archived record; seated but ghosted, monitor off. Outranks
 *   the quiet states because an archived agent has nothing left to do, but
 *   yields to anything the data says is still happening to it.
 * - `background` - background work only.
 * - `idle` - seated, nothing to do.
 */
export type OfficeAgentStatus =
  | "failure"
  | "attention"
  | "awaiting"
  | "working"
  | "archived"
  | "background"
  | "idle";

export interface OfficeSceneInput {
  /** EVERY agent in the epic; the layout runs over the full set. */
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  /** Agents that exist as of the time cursor; only these have a character. */
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  /**
   * HQ, teams and solos, computed once outside the scene and handed to every
   * plan, board and directory row - so a floor that seats somebody in a team's
   * room cannot disagree with the panel that calls them a solo.
   */
  readonly partition: OfficePopulation;
  /** Edge counts over the displayed graph. Only City's heights read it. */
  readonly activityById: ReadonlyMap<string, number>;
  /**
   * The canvas in CSS pixels. A plan reads the aspect once and freezes it; the
   * scene never re-plans because this changed.
   */
  readonly viewport: OfficeSize;
  /**
   * The timeline's pulse and a stable identity for the row behind it
   * (`commGraphEventKey`). The scene reacts to the KEY changing, so the same
   * pulse object re-supplied across frames spawns nothing new.
   */
  readonly pulse: CommGraphPulse | null;
  readonly pulseKey: string | null;
  /** Milliseconds one playback step lasts at the current speed; envelopes fit inside it. */
  readonly stepMs: number;
  /**
   * The cursor row's capture time, or `null` while live. Decides which agents
   * count as archived AS OF the floor being shown; live compares against now.
   */
  readonly cursorMs: number | null;
  /** What the wall clock shows: the cursor time during replay, local time while live. */
  readonly clockMs: number;
  /**
   * Unanswered `expectReply` requests per RECEIVER, as of the cursor. Drawn as
   * an envelope pile on that agent's desk. Derived from the same event array
   * the graph reads; absent agents count as zero.
   */
  readonly openRequestsByReceiver: ReadonlyMap<string, number>;
  readonly playing: boolean;
  /** `prefers-reduced-motion`: no walking, no flight; state changes apply instantly. */
  readonly reducedMotion: boolean;
  /**
   * WHETHER THE EVENT FEED HAS FINISHED REPLAYING - the snapshot's
   * `initialHistoryCaughtUp`, carried here rather than asked for by a call of
   * its own.
   *
   * An explicit view draws before this is true, because an office is a drawing
   * of the agent list and the events only say who among them is busy. What it
   * draws meanwhile is provisional: every status is the one the epic already
   * knew, so teams read cold and their members are planned into the quiet
   * cubbies. The scene watches this go true and re-plans once from the settled
   * partition (`adoptLayout`'s third trigger), because the agent set has not
   * changed and a status flip alone deliberately never re-plans.
   *
   * An INPUT and not a method: a transition the scene reads for itself, beside
   * the cursor rewind and the motion change, cannot be called in the wrong
   * order relative to the sync it belongs to.
   */
  readonly feedSettled: boolean;
}

// ---- Scene output --------------------------------------------------- //

export type OfficeDrawable =
  | {
      readonly kind: "sprite";
      readonly sprite: OfficeSpriteRef;
      readonly x: number;
      readonly y: number;
      /** 0..1; omitted means opaque. */
      readonly alpha?: number;
    }
  | {
      readonly kind: "label";
      readonly text: string;
      /** Anchor: horizontally centered on `x`, baseline above `y`. */
      readonly x: number;
      readonly y: number;
      /** `bright` is for text over a surface that is dark in both themes, such as a wall sign. */
      readonly tone: "default" | "muted" | "bright";
      /**
       * Whose name this is, or `null` for lettering that names nobody.
       *
       * Carried rather than recovered, so the renderer stops matching a tag to
       * a character by comparing coordinates against the hit regions - a test
       * that is wrong the moment two things share a centre line.
       */
      readonly ownerAgentId: string | null;
      /**
       * THE BOX THIS TAG HAS TO STAY INSIDE, in tiles, or `null` for lettering
       * that owns no box.
       *
       * A seated agent's tag is fitted to its seat: a cubby is ONE tile wide
       * and a truncated name is fourteen characters, so a row of cubbies used
       * to print its occupants over each other -
       * `team-4-member... team-6-member...` in one smear - while each name was
       * individually correct. A seat's own width is what makes two neighbours'
       * tags disjoint by construction, with no neighbour search and nothing
       * measured against the row.
       *
       * `null` means "draw it as written": a WALKER has left its seat and has
       * no box to be fitted to, and a painter's own lettering (`reserve`, a
       * room name, sign text) is laid out by whoever placed it. The renderer
       * resolves the reading, because how wide a tile is on screen is a camera
       * fact and the scene does not know the zoom.
       *
       * A WIDTH, NOT A BOX, and the tag is centred on its CHARACTER rather
       * than on the seat's centre - which are not the same point. Every
       * oblique desk is two tiles wide with `deskTile.col === chairTile.col`,
       * so its occupant stands on the box's LEFT column and a maximal reading
       * reaches half a tile past that edge while leaving half a tile unused on
       * the right. That is deliberate and it is safe: the offset is identical
       * for every seat in a row, so a row's tags shift together instead of
       * closing on each other, and a tag never reaches a NEIGHBOUR's tag. Held
       * by "a character anchored off its seat's centre still never reaches a
       * neighbour's tag" in `comm-graph-office-canvas.test.tsx` - measured on
       * two adjacent Towers desks, not argued.
       */
      readonly fitTiles: number | null;
    }
  | {
      /** Hands over a `clock` face sprite. CENTER anchored on the face. */
      readonly kind: "clock";
      readonly x: number;
      readonly y: number;
      readonly timeMs: number;
    }
  | {
      readonly kind: "envelope";
      readonly x: number;
      readonly y: number;
      readonly pulseKind: CommGraphPulseKind;
      /** 0..1 progress along the flight, for the shadow and arc. */
      readonly progress: number;
      /** The pair edge this message belongs to (`commGraphPairId`), so a click can open its thread. */
      readonly edgeId: string;
    }
  | {
      /**
       * A civic vehicle on a floor's road, BOTTOM-CENTER anchored on the tile
       * it is crossing, exactly as a walker is anchored on its foot point.
       *
       * The renderer resolves the sprite, because which of the twelve names
       * this is depends on the projection, and a scene does not know whether
       * its view draws oblique or isometric - the painter does. What the scene
       * knows is the three facts that vary per frame: which vehicle, which way
       * it points, and whether its light is on this instant.
       */
      readonly kind: "vehicle";
      readonly vehicleKind: OfficeVehicleKind;
      readonly x: number;
      readonly y: number;
      readonly facing: OfficeFacing;
      /** Alternates every 250 ms while the vehicle moves or waits. */
      readonly lights: 0 | 1;
    }
  | {
      /**
       * A harness logo, drawn by the renderer from the app's own icon set at
       * 12x12 sprite pixels, CENTER anchored. The scene places it; the scene
       * never sees the icon.
       */
      readonly kind: "logo";
      readonly harnessId: GuiHarnessId;
      readonly x: number;
      readonly y: number;
      readonly alpha?: number;
    }
  | {
      /**
       * One agent at OVERVIEW zoom, where a sixteen-pixel character is four
       * pixels across and its colour is the only thing left of it. A glyph
       * rides along because colour alone is not a state channel.
       */
      readonly kind: "pip";
      readonly x: number;
      readonly y: number;
      readonly status: OfficeAgentStatus;
      /** `ring` awaiting · `bang` attention or failure · `hollow` archived. */
      readonly glyph: OfficePipGlyph;
      readonly agentId: string;
    }
  | {
      /**
       * A filled rectangle in world pixels: the unit of a lod-0 block map.
       *
       * At overview zoom a floor is not drawn tile by tile - it is drawn as the
       * regions the tiles add up to, which is both the only legible reading at
       * that scale and the reason the whole-world bitmap can go away.
       */
      readonly kind: "block";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly fill: OfficeBlockFill;
      readonly alpha?: number;
    }
  | {
      /**
       * The same unit of a lod-0 block map, for a floor that is not
       * axis-aligned: a region's four PROJECTED corners, filled as one
       * quadrilateral.
       *
       * An isometric tile rectangle projects to a parallelogram, and the
       * rectangle that used to stand in for one was drawn over ground the
       * region does not cover while leaving ground it does cover bare - so the
       * pips, which are projected seats and therefore form the parallelogram,
       * spilled out of their own room at overview. A view whose projector IS
       * the identity has nothing to gain here and keeps `block`.
       *
       * The corners are the projections of the tile rect's own corners, in
       * perimeter order, so the shape is exactly the ground its tiles project
       * to - nothing more to reach past them for (`blockOverhangPx`), and the
       * silhouette a person sees one zoom step in.
       */
      readonly kind: "quad";
      readonly points: readonly [
        OfficePoint,
        OfficePoint,
        OfficePoint,
        OfficePoint,
      ];
      readonly fill: OfficeBlockFill;
    };

/** What a lod-0 block STANDS FOR; the renderer maps each to a theme colour. */
export type OfficeBlockFill =
  | "room"
  | "pod"
  | "storey"
  | "building"
  | "plaza"
  | "ground"
  | "grass"
  /** A civic room: the infirmary, the waiting room, the help desk, the archive. */
  | "civic";

/**
 * The mark drawn over a pip, so overview state survives colour blindness and a
 * four-pixel dot. `none` is the quiet states: working, background, idle.
 */
export type OfficePipGlyph = "none" | "ring" | "bang" | "hollow";

/**
 * One drawable in a DEPTH-ORDERED world stream, for the views whose props and
 * characters interleave (an oblique desk front covers its own occupant's lap;
 * an isometric building stands in front of whatever is behind it).
 *
 * `ownerAgentId` travels with the drawable so the renderer resolves a name tag
 * from the thing it drew rather than by scanning hit regions for whatever
 * happens to overlap it.
 */
export interface OfficeWorldDrawable {
  readonly drawable: OfficeDrawable;
  readonly depth: number;
  readonly ownerAgentId: string | null;
}

/**
 * THE DEPTH OF THE FLOOR PASS: behind everything, because the floor is drawn
 * before the world stream above and is not sorted into it.
 *
 * It is a depth so that a reader who has to ORDER a floor-pass drawable against
 * that stream - the scene's hit regions, placing the box of a seat whose only art
 * is a prop the plan stands on the ground - can say where it belongs in the one
 * scale the two share. Negative infinity rather than a large negative number
 * because the claim is total: there is no world depth this has to be tuned to
 * stay under, and a character standing in front of a bed therefore wins the
 * pointer at every pixel it covers.
 *
 * Here rather than beside `OfficePainter`, which is what answers with it: the
 * painter modules import their vocabulary from this one, and importing a VALUE
 * from the view registry instead would close a cycle through it.
 */
export const OFFICE_FLOOR_PASS_DEPTH = Number.NEGATIVE_INFINITY;

export interface OfficeHitRegion {
  readonly agentId: string;
  readonly rect: OfficeRect;
}

/** An in-flight envelope's clickable box, resolving to its pair edge. */
export interface OfficeEnvelopeHitRegion {
  readonly edgeId: string;
  readonly rect: OfficeRect;
}

/** The logo sprite's side, in sprite pixels. */
export const OFFICE_LOGO_SIZE = 12;

/**
 * One rendered frame. Layers are drawn in order; `actors` is already sorted by
 * baseline (`y`) so a character lower on the floor overlaps one above it.
 */
export interface OfficeFrame {
  readonly size: OfficeSize;
  /**
   * Changes only when `floor` does, so a renderer can cache what it drew from
   * it instead of re-drawing thousands of identical tiles every frame.
   *
   * The floor is a pure function of the LAYOUT - walls, pod tints, stairwells
   * and rugs - and the layout is rebuilt only when the set of agents changes.
   * Everything that moves is in `actors` or `overlay`.
   */
  readonly staticVersion: number;
  readonly floor: ReadonlyArray<OfficeDrawable>;
  readonly props: ReadonlyArray<OfficeDrawable>;
  readonly actors: ReadonlyArray<OfficeDrawable>;
  /**
   * Props and actors interleaved by depth, for a `world` painter; `null` for a
   * `layered` one, whose `props` and `actors` are the two passes instead.
   *
   * A view whose desk fronts cover their own occupants cannot be expressed as
   * two passes at all - which is why this is a different stream rather than a
   * sort order on the same one. The renderer draws exactly one of the two.
   */
  readonly world: ReadonlyArray<OfficeWorldDrawable> | null;
  readonly overlay: ReadonlyArray<OfficeDrawable>;
  /** FRONT-MOST FIRST, from the same order the frame was drawn in. */
  readonly hitRegions: ReadonlyArray<OfficeHitRegion>;
  /** In-flight envelopes, in draw order; checked BEFORE `hitRegions` so a message over a desk wins. */
  readonly envelopeHitRegions: ReadonlyArray<OfficeEnvelopeHitRegion>;
  /**
   * Agents whose character is not in its own seat, WITHIN THE VIEW RECT. The
   * frame is culled, so this is the culled set too: nothing outside the rect
   * was built, and nothing outside it can be drawn.
   */
  readonly awayAgentIds: ReadonlySet<string>;
  /**
   * Where the camera should look while playback is following the action: the
   * sender of the pulsing row, or `null` when nothing is in flight.
   */
  readonly focus: OfficePoint | null;
}

/**
 * WHAT THE CIVIC SIGNS COUNT, as of this moment.
 *
 * Two numbers with two different sources, which is why they travel together
 * rather than being derived where they are read: a room's occupancy is the
 * SEAT BOOK's - it moves when a claim is made or released, and only the book
 * knows - while the archive's tally is the PARTITION's and the statuses', so
 * that it is right on the first frame and at any cursor rather than counting
 * the walk-outs somebody happened to watch (C5).
 *
 * Outside the frame because a sign is not culled: the frame is built for the
 * view rect, and a counter on a sign two screens away is still the same
 * number when the camera reaches it.
 */
export interface OfficeCivicTally {
  /** Seats taken right now, by `civicRoomId`; a room with none is absent. */
  readonly occupiedByRoom: ReadonlyMap<string, number>;
  /** Archived records by host, `null` being the unattributed building's own. */
  readonly archivedByHost: ReadonlyMap<string | null, number>;
}

/** Center of a tile, in sprite space. */
export function officeTileCenter(tile: OfficeTilePos): OfficePoint {
  return {
    x: tile.col * OFFICE_TILE + OFFICE_TILE / 2,
    y: tile.row * OFFICE_TILE + OFFICE_TILE / 2,
  };
}
