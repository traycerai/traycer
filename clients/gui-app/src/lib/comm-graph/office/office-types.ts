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
  /** Wall tile carrying this floor's clock. */
  readonly clockTile: OfficeTilePos;
  /** Top-left of the two-by-two stairwell, or `null` on a single-floor building. */
  readonly stairsTile: OfficeTilePos | null;
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
