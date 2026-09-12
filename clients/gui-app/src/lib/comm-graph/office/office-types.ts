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
  | "spire";

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
 * station. The kind is what the scene reads - never the view id.
 */
export type OfficeSeatKind = "desk" | "cubby" | "console";

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
  | "hq-board";

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
  | "grass";

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

/** Center of a tile, in sprite space. */
export function officeTileCenter(tile: OfficeTilePos): OfficePoint {
  return {
    x: tile.col * OFFICE_TILE + OFFICE_TILE / 2,
    y: tile.row * OFFICE_TILE + OFFICE_TILE / 2,
  };
}
