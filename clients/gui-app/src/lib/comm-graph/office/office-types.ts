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
import type {
  CommGraphPulse,
  CommGraphPulseKind,
} from "@/lib/comm-graph/comm-graph-timeline";

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
 */
export type OfficeCharacterPose =
  | "stand"
  | "walk1"
  | "walk2"
  | "sit"
  | "type1"
  | "type2";

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
  | "sparkle";

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

// ---- Layout ---------------------------------------------------------- //

export interface OfficeDesk {
  readonly agentId: string;
  /** Top-left tile of the two-tile-wide desk. */
  readonly deskTile: OfficeTilePos;
  /** The chair tile, directly below the desk's left tile. */
  readonly chairTile: OfficeTilePos;
  /** A root agent (no parent on the floor) gets a manager desk with a plant. */
  readonly manager: boolean;
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

export interface OfficeErrandSpot {
  readonly kind: OfficeErrandKind;
  readonly tile: OfficeTilePos;
  readonly facing: OfficeFacing;
}

/**
 * The floor plan for one epic. Pure function of the agent set, recomputed when
 * the set changes and never persisted: a desk is a function of who exists, not
 * a stored coordinate.
 */
export interface OfficeLayout {
  readonly cols: number;
  readonly rows: number;
  /** One desk per agent in the input set, keyed by agent id. */
  readonly desks: ReadonlyMap<string, OfficeDesk>;
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
    };

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
  readonly overlay: ReadonlyArray<OfficeDrawable>;
  readonly hitRegions: ReadonlyArray<OfficeHitRegion>;
  /** In-flight envelopes, in draw order; checked BEFORE `hitRegions` so a message over a desk wins. */
  readonly envelopeHitRegions: ReadonlyArray<OfficeEnvelopeHitRegion>;
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
