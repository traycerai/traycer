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
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/foundation";
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
  | "monitor-off"
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
 * The floor plan for one epic. Pure function of the agent set, recomputed when
 * the set changes and never persisted: a desk is a function of who exists, not
 * a stored coordinate.
 */
export interface OfficeLayout {
  readonly cols: number;
  readonly rows: number;
  /** One desk per agent in the input set, keyed by agent id. */
  readonly desks: ReadonlyMap<string, OfficeDesk>;
  /** Where characters enter and leave. Always a walkable tile on the boundary wall. */
  readonly doorTile: OfficeTilePos;
  /** Where a character stands after walking in, before its desk exists. */
  readonly lobbyTile: OfficeTilePos;
  /** Decorative props (plants, coffee machine, whiteboard, windows). */
  readonly props: ReadonlyArray<OfficeProp>;
  /** `walkable[row][col]`; desks, chairs, walls and props are not walkable. */
  readonly walkable: ReadonlyArray<ReadonlyArray<boolean>>;
}

// ---- Scene inputs --------------------------------------------------- //

export interface OfficeAgentInput {
  readonly id: string;
  readonly name: string;
  readonly kind: CommGraphAgentKind;
  readonly harnessId: TuiHarnessId | null;
  readonly parentId: string | null;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly appearance: OfficeAppearance;
}

/**
 * What the character is doing, in precedence order (highest first):
 *
 * - `attention` - a person is needed (failure / interview / approval pending).
 * - `awaiting` - sent an `expectReply` request that has no reply yet.
 * - `working` - in an active turn.
 * - `archived` - archived record; seated but ghosted, monitor off. Outranks
 *   the quiet states because an archived agent has nothing left to do, but
 *   yields to anything the data says is still happening to it.
 * - `background` - background work only.
 * - `idle` - seated, nothing to do.
 */
export type OfficeAgentStatus =
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
      readonly tone: "default" | "muted";
    }
  | {
      readonly kind: "envelope";
      readonly x: number;
      readonly y: number;
      readonly pulseKind: CommGraphPulseKind;
      /** 0..1 progress along the flight, for the shadow and arc. */
      readonly progress: number;
    };

export interface OfficeHitRegion {
  readonly agentId: string;
  readonly rect: OfficeRect;
}

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
