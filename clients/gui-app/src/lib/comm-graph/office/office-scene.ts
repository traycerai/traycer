/**
 * The office simulation: who is where, who is walking, what is bubbling, and
 * which envelopes are in the air at this instant.
 *
 * PURE AND DETERMINISTIC BY CONSTRUCTION. Nothing here reads a clock, a random
 * source, the DOM or a canvas. Time enters only through `tick(dtMs)` and
 * per-agent variety only through a hash of the agent id, so two scenes fed the
 * same sync/tick sequence produce identical frames. That is what makes
 * playback scrubbable, replayable and testable - a scene that sampled
 * `Date.now()` would render a different floor every time the same cursor was
 * revisited.
 *
 * ANCHORS the canvas must honour - a frame is coordinates and nothing else:
 *
 * - `floor`, `props` and `actors` sprites are TOP-LEFT anchored at `(x, y)`.
 * - A character sits at `(col * OFFICE_TILE, row * OFFICE_TILE - 4)`: its feet
 *   land on its tile and its head rises above it.
 * - `overlay` sprites (bubbles, sparkles) are BOTTOM-CENTER anchored - `x` is
 *   the character's horizontal centre, `y` its top minus two.
 * - `envelope` drawables are CENTER anchored. Their `y` ALREADY includes the
 *   flight arc, and `progress` is the EASED parameter, so a ground shadow must
 *   be derived from that same value or it will slide out from under the
 *   envelope.
 * - `clock` drawables are CENTER anchored on the clock FACE, so the hands are
 *   drawn outward from `(x, y)`.
 * - A `label` is centered on `x` with its baseline above `y`, per the shared
 *   type.
 *
 * A DESK IS ONLY DRAWN FOR AN AGENT THAT EXISTS AS OF THE CURSOR. The floor
 * plan covers every agent in the epic so positions never shift as playback
 * reveals people, but rendering an empty desk for someone who has not been
 * created yet would leak the future into a historical view.
 *
 * MESSAGES FLY BETWEEN SEATS, never between bodies. An envelope aimed at
 * wherever a character happens to be standing lands in an empty chair the
 * moment that character is walking in or away at reception, so both endpoints
 * are the agents' DESKS and anyone an envelope touches is seated first.
 */
import type {
  CommGraphPulse,
  CommGraphPulseKind,
} from "@/lib/comm-graph/comm-graph-timeline";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeCharacterPose,
  type OfficeDesk,
  type OfficeDrawable,
  type OfficeEnvelopeHitRegion,
  type OfficeFacing,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeHitRegion,
  type OfficeLayout,
  type OfficeModelTier,
  type OfficePoint,
  type OfficeProp,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSpriteName,
  type OfficeSpriteRef,
  type OfficeTilePos,
} from "@/lib/comm-graph/office/office-types";

export type OfficeLayoutFn = (
  agents: ReadonlyArray<OfficeAgentInput>,
) => OfficeLayout;

const WALK_TILES_PER_SECOND = 3;
/**
 * An arrival is not a stroll. A newcomer's first message lands within a step of
 * its creation, so the walk from the door has to be over by then or the
 * envelope arrives at an empty chair.
 */
const ARRIVAL_TILES_PER_SECOND = 8;
/**
 * Below this step length playback is running fast enough that a walk-in would
 * still be in progress when the next row is drawn, so arrivals are announced
 * with a sparkle at the desk instead.
 */
const FAST_PLAYBACK_STEP_MS = 600;
const WALK_FRAME_MS = 120;
const TYPING_FRAME_MS = 180;
const BACKGROUND_FRAME_MS = 400;
const BUBBLE_BOB_MS = 500;
const BUBBLE_HELLO_MS = 700;
const SPARKLE_MS = 400;
/** Only a floor that has been still this long starts dozing. */
const IDLE_SLEEP_MS = 20_000;
const ENVELOPE_STEP_FRACTION = 0.75;
const ENVELOPE_MIN_MS = 350;
const ENVELOPE_MAX_MS = 900;
/**
 * Peak height of an envelope's flight, in sprite pixels. Exported because the
 * renderer has to undo it: the drawable's `y` already has this lift folded in,
 * and adding it back is what recovers the ground line the shadow sits on.
 */
export const ENVELOPE_ARC_LIFT = 14;
/**
 * A burst of traffic in one step must not turn the floor into confetti, and an
 * unbounded list would grow without limit while scrubbing. Oldest is dropped
 * because the newest rows are the ones the cursor is actually about.
 */
const MAX_LIVE_ENVELOPES = 24;
/** Even with motion off an arrival has to be on screen long enough to see. */
const REDUCED_MOTION_ARRIVAL_MS = 300;
const CHARACTER_Y_OFFSET = -4;
const BUBBLE_GAP = 2;
const LABEL_GAP = 8;
const MAX_LABEL_CHARS = 14;
/** A cabin's sign is two tiles wide, so its name gets less room than a desk's. */
const MAX_ROOM_LABEL_CHARS = 12;
/** Baseline of the cabin name, measured down from the sign sprite's own top. */
const SIGN_LABEL_BASELINE = 11;
const SIGN_WIDTH_TILES = 2;
/**
 * A lit screen is never still: two frames alternate while an agent is in a
 * turn, and far more slowly while it is only working in the background.
 */
const MONITOR_WORKING_FRAME_MS = 260;
const MONITOR_BACKGROUND_FRAME_MS = 700;
/** The plate on the desk's right half, and the logo standing on top of it. */
const NAMEPLATE_Y_OFFSET = 4;
const LOGO_Y_OFFSET = 1;
/** Slack around an envelope's box, so a moving 10x8 target stays clickable. */
const ENVELOPE_HIT_PADDING = 2;
/**
 * Coffee breaks. Only a LIVE floor takes them, and only after a long enough
 * stretch of nothing that the stillness itself is the point - the stagger is
 * what keeps a quiet epic from standing up in unison.
 */
const IDLE_WANDER_MS = 25_000;
const WANDER_STAGGER_SPREAD_MS = 15_000;
const WANDER_WAIT_MS = 4_000;
/** More than two at the machine at once reads as an evacuation, not a break. */
const MAX_WANDERING_AGENTS = 2;
/** Deterministic search for the tile a character stands on to use the machine. */
const WANDER_STAND_OFFSETS: ReadonlyArray<OfficeTilePos> = [
  { col: -1, row: 0 },
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: 0, row: -1 },
];
const IDLE_MONITOR_ALPHA = 0.6;
const ARCHIVED_ALPHA = 0.45;
const DESK_WIDTH_TILES = 2;
/** Desk row plus chair row - what a click on "that person's desk" means. */
const DESK_HIT_ROWS = 2;
/** Spread of the per-agent animation phase offset. */
const PHASE_SPREAD_MS = 1000;
/**
 * The unanswered-request pile, indexed by how many are waiting (1, 2, 3+).
 * Every height shares one BASE line on the desk, so the pile grows upward as
 * it deepens instead of floating off the furniture.
 */
interface OfficeEnvelopeStack {
  readonly sprite: OfficeSpriteName;
  readonly xOffset: number;
  readonly yOffset: number;
}

const ENVELOPE_STACKS: ReadonlyArray<OfficeEnvelopeStack> = [
  { sprite: "envelope-stack-1", xOffset: 1, yOffset: -2 },
  { sprite: "envelope-stack-2", xOffset: 1, yOffset: -4 },
  { sprite: "envelope-stack-3", xOffset: 1, yOffset: -6 },
];

/**
 * The screen on a desk, by the coarse size class of the agent's model: a
 * laptop, a single monitor, or dual wide displays. `onB` is the second lit
 * frame, and a tier that has none simply does not animate.
 *
 * Offsets sit the screen on the desk's back edge, aligned to where the desk
 * sprite draws its keyboard rather than to the desk's own centre - the screen
 * belongs behind the keys, not behind the middle of the furniture. The crash
 * map is one 16x12 for every tier, so it carries its OWN offset rather than
 * borrowing a wide screen's.
 *
 * The plate moves with the screen for the same reason: a wide display reaches
 * across the desk's right half, so a large tier sets its own plate and badge
 * columns instead of overlapping them.
 */
interface OfficeScreenArt {
  readonly on: OfficeSpriteName;
  readonly onB: OfficeSpriteName | null;
  readonly off: OfficeSpriteName;
  readonly xOffset: number;
  readonly yOffset: number;
  readonly crashXOffset: number;
  readonly crashYOffset: number;
  readonly plateXOffset: number;
  readonly logoXOffset: number;
}

const SCREEN_ART: Readonly<Record<OfficeModelTier, OfficeScreenArt>> = {
  small: {
    on: "monitor-small-on",
    onB: null,
    off: "monitor-small-off",
    xOffset: 5,
    yOffset: -5,
    crashXOffset: 3,
    crashYOffset: -8,
    plateXOffset: 18,
    logoXOffset: 24,
  },
  medium: {
    on: "monitor-on",
    onB: "monitor-on-b",
    off: "monitor-off",
    xOffset: 3,
    yOffset: -8,
    crashXOffset: 3,
    crashYOffset: -8,
    plateXOffset: 18,
    logoXOffset: 24,
  },
  large: {
    on: "monitor-wide-on",
    onB: "monitor-wide-on-b",
    off: "monitor-wide-off",
    xOffset: 0,
    yOffset: -8,
    crashXOffset: 4,
    crashYOffset: -8,
    plateXOffset: 20,
    logoXOffset: 26,
  },
};

interface TransientBubble {
  readonly sprite: OfficeSpriteName;
  remainingMs: number;
}

/**
 * What a character is away from its desk FOR. One field rather than several
 * flags, because every one of these drives the same path and only one of them
 * can be true at a time.
 *
 * - `arriving` - walking in from its floor's door to take a seat.
 * - `coffee-out` / `coffee-wait` / `coffee-return` - a break at the machine.
 * - `queue-out` / `queue-stand` - waiting at reception for a person.
 * - `leaving` - archived; walking to the door to disappear.
 * - `returning` - walking back to its own chair from anything else.
 *
 * A break keeps its own return state rather than folding into `returning`,
 * because the cap on how many people are away at once has to count the walk
 * back: release the slot at the machine and the next bored agent stands up
 * while the last one is still crossing the floor.
 */
type OfficeErrand =
  | "none"
  | "arriving"
  | "coffee-out"
  | "coffee-wait"
  | "coffee-return"
  | "queue-out"
  | "queue-stand"
  | "leaving"
  | "returning";

interface OfficeCharacter {
  readonly agentId: string;
  /** Tile coordinates, fractional while walking. */
  col: number;
  row: number;
  facing: OfficeFacing;
  seated: boolean;
  path: ReadonlyArray<OfficeTilePos>;
  pathIndex: number;
  walkPhaseMs: number;
  /** Scene time spent seated and idle; drives the sleep bubble. */
  idleMs: number;
  bubble: TransientBubble | null;
  sparkleMs: number;
  errand: OfficeErrand;
  /** Scene time left standing at the machine, while `errand` is `coffee-wait`. */
  waitMs: number;
  /** The reception slot this character was assigned, while it holds one. */
  queueTile: OfficeTilePos | null;
}

interface OfficeEnvelope {
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly pulseKind: CommGraphPulseKind;
  /** The pair edge the message belongs to, carried through to the drawable. */
  readonly edgeId: string;
  elapsedMs: number;
  readonly durationMs: number;
}

interface SortedProp {
  readonly drawable: OfficeDrawable;
  readonly sortY: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;
}

/** FNV-1a: a stable, dependency-free spread over agent ids. */
function hashAgentId(agentId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * A per-agent phase offset, so a room of typists does not hammer its keyboards
 * in lockstep. Seeded from the id rather than from arrival order, which would
 * make the animation depend on how the timeline was scrubbed.
 */
function phaseOffsetMs(agentId: string): number {
  return hashAgentId(agentId) % PHASE_SPREAD_MS;
}

/**
 * How much longer than the threshold THIS agent sits still before getting up.
 * Derived from the id for the same reason the typing phase is: a floor where
 * everyone stands at once is an animation, not an office.
 */
function wanderStaggerMs(agentId: string): number {
  return hashAgentId(agentId) % WANDER_STAGGER_SPREAD_MS;
}

/**
 * Everything the floor plan depends on. Names and archive flags are
 * deliberately absent: a rename must not restack the office. The HOST is not,
 * because it decides which storey the agent lives on.
 */
function agentSetSignature(agents: ReadonlyArray<OfficeAgentInput>): string {
  return agents
    .map(
      (agent) =>
        `${agent.id} ${agent.parentId ?? ""} ${agent.createdAt} ${agent.hostId ?? ""}`,
    )
    .sort()
    .join("");
}

/**
 * Where a prop's sprite is drawn, given that props are TOP-LEFT anchored.
 *
 * A prop taller than its tile would otherwise spill DOWN over whatever sits
 * on the row below - a plant over its own chair, a rug over the doorway.
 * Lifting by the overhang puts the sprite's FOOT on its tile, which is where
 * a standing object actually stands; a one-tile prop is unaffected.
 */
function spriteFootY(sprite: OfficeSpriteRef, tileRow: number): number {
  return (
    tileRow * OFFICE_TILE - (officeSpriteSize(sprite).height - OFFICE_TILE)
  );
}

function propDrawY(prop: OfficeProp): number {
  return spriteFootY(prop.sprite, prop.tile.row);
}

function facingFor(dCol: number, dRow: number): OfficeFacing | null {
  if (Math.abs(dCol) >= Math.abs(dRow) && dCol !== 0) {
    return dCol > 0 ? "right" : "left";
  }
  if (dRow !== 0) return dRow > 0 ? "down" : "up";
  return null;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function sameTile(
  left: OfficeTilePos | null,
  right: OfficeTilePos | null,
): boolean {
  if (left === null || right === null) return false;
  return left.col === right.col && left.row === right.row;
}

/**
 * An in-flight envelope's clickable box: its sprite, padded, so a target that
 * is both small and moving can still be hit.
 */
function envelopeHitRegionsOf(
  overlay: ReadonlyArray<OfficeDrawable>,
): ReadonlyArray<OfficeEnvelopeHitRegion> {
  const size = officeSpriteSize({ name: "envelope" });
  const regions: OfficeEnvelopeHitRegion[] = [];
  for (const drawable of overlay) {
    if (drawable.kind !== "envelope") continue;
    regions.push({
      edgeId: drawable.edgeId,
      rect: {
        x: drawable.x - size.width / 2 - ENVELOPE_HIT_PADDING,
        y: drawable.y - size.height / 2 - ENVELOPE_HIT_PADDING,
        width: size.width + ENVELOPE_HIT_PADDING * 2,
        height: size.height + ENVELOPE_HIT_PADDING * 2,
      },
    });
  }
  return regions;
}

function containsPoint(rect: OfficeRect, point: OfficePoint): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function isCreatedPulseFor(
  pulse: CommGraphPulse | null,
  agentId: string,
): boolean {
  if (pulse === null) return false;
  if (pulse.kind !== "edge") return false;
  return pulse.pulseKind === "created" && pulse.toAgentId === agentId;
}

function pulseSenderId(pulse: CommGraphPulse | null): string | null {
  if (pulse === null) return null;
  return pulse.kind === "edge" ? pulse.fromAgentId : pulse.senderAgentId;
}

function seatedCharacter(agentId: string, desk: OfficeDesk): OfficeCharacter {
  return {
    agentId,
    col: desk.chairTile.col,
    row: desk.chairTile.row,
    // Seated means facing the screen, which is up the floor and away from us.
    facing: "up",
    seated: true,
    path: [],
    pathIndex: 0,
    walkPhaseMs: 0,
    idleMs: 0,
    bubble: null,
    sparkleMs: 0,
    errand: "none",
    waitMs: 0,
    queueTile: null,
  };
}

export class OfficeScene {
  private readonly layoutOf: OfficeLayoutFn;
  private currentLayout: OfficeLayout;
  private readonly characters = new Map<string, OfficeCharacter>();
  private envelopes: OfficeEnvelope[] = [];
  private agentById = new Map<string, OfficeAgentInput>();
  private visibleAgentIds: ReadonlySet<string> = new Set<string>();
  private statusById: ReadonlyMap<string, OfficeAgentStatus> = new Map<
    string,
    OfficeAgentStatus
  >();
  private openRequestsByReceiver: ReadonlyMap<string, number> = new Map<
    string,
    number
  >();
  private agentSignature: string | null = null;
  private pulse: CommGraphPulse | null = null;
  private lastPulseKey: string | null = null;
  private playing = false;
  private reducedMotion = false;
  private stepMs = 0;
  private cursorMs: number | null = null;
  private clockMs = 0;
  private nowMs = 0;
  private synced = false;
  /** Archived AS OF the cursor at the last sync; the walk-out reads changes. */
  private archivedIds: ReadonlySet<string> = new Set<string>();
  /** Archived agents whose character has already walked out; their desk is sheeted. */
  private readonly departedIds = new Set<string>();
  /** Agents un-archived by a scrub back, which walk in again on this sync. */
  private readonly returningIds = new Set<string>();
  /** Agents needing a person, in the order they were first seen needing one. */
  private queueOrder: string[] = [];
  /** Where a character stands to use each floor's machine; `null` if unreachable. */
  private coffeeStandByFloor: ReadonlyArray<OfficeTilePos | null> = [];

  /** `layoutOffice` in production; injected so tests can pin a floor plan. */
  constructor(layoutOf: OfficeLayoutFn) {
    this.layoutOf = layoutOf;
    this.currentLayout = layoutOf([]);
    this.recomputeCoffeeStands();
  }

  layout(): OfficeLayout {
    return this.currentLayout;
  }

  sync(input: OfficeSceneInput): void {
    const firstSync = !this.synced;
    this.synced = true;
    this.visibleAgentIds = input.visibleAgentIds;
    this.statusById = input.statusById;
    this.openRequestsByReceiver = input.openRequestsByReceiver;
    this.playing = input.playing;
    this.reducedMotion = input.reducedMotion;
    this.stepMs = input.stepMs;
    this.cursorMs = input.cursorMs;
    this.clockMs = input.clockMs;
    this.pulse = input.pulse;
    this.agentById = new Map(input.agents.map((agent) => [agent.id, agent]));

    const signature = agentSetSignature(input.agents);
    const layoutChanged = signature !== this.agentSignature;
    if (layoutChanged) {
      this.agentSignature = signature;
      this.currentLayout = this.layoutOf(input.agents);
      this.recomputeCoffeeStands();
      // Before reconciling, so a newly spawned walker is not immediately
      // re-pathed to the destination it was just given.
      this.rehomeCharacters();
    }
    this.applyArchivalTransitions(input, firstSync);
    this.reconcileCharacters(input, firstSync);
    this.returningIds.clear();
    // A break ends on the sync that ends it, not on the tick after: playback
    // starting or an agent picking work back up are both seen here first.
    for (const character of this.characters.values()) {
      if (!this.onCoffeeBreak(character)) continue;
      if (!this.wanderMustEnd(character.agentId)) continue;
      this.returnToDesk(character);
    }
    this.updateReceptionQueue();

    if (input.pulseKey !== this.lastPulseKey) {
      this.lastPulseKey = input.pulseKey;
      // A first sync MATERIALIZES the floor as of the cursor; it does not
      // replay the row the cursor happens to be sitting on.
      if (!firstSync) this.applyPulse(input.pulse);
    }
  }

  tick(dtMs: number): void {
    if (dtMs <= 0) return;
    this.nowMs += dtMs;
    for (const character of this.characters.values()) {
      this.advanceCharacter(character, dtMs);
    }
    this.updateWanderStarts();
    this.advanceEnvelopes(dtMs);
  }

  frame(): OfficeFrame {
    const overlay = this.buildOverlay();
    return {
      size: {
        width: this.currentLayout.cols * OFFICE_TILE,
        height: this.currentLayout.rows * OFFICE_TILE,
      },
      floor: this.buildFloor(),
      props: this.buildProps(),
      actors: this.buildActors(),
      overlay,
      hitRegions: this.buildHitRegions(),
      envelopeHitRegions: envelopeHitRegionsOf(overlay),
      focus: this.focusPoint(),
    };
  }

  /** Characters win over desks: a person is the more specific target. */
  hitTest(point: OfficePoint): string | null {
    const ordered = this.orderedCharacters();
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const character = ordered[index];
      const x = character.col * OFFICE_TILE;
      const y = character.row * OFFICE_TILE + CHARACTER_Y_OFFSET;
      if (
        point.x >= x &&
        point.x < x + OFFICE_CHARACTER_WIDTH &&
        point.y >= y &&
        point.y < y + OFFICE_CHARACTER_HEIGHT
      ) {
        return character.agentId;
      }
    }
    for (const desk of this.visibleDesks()) {
      const x = desk.deskTile.col * OFFICE_TILE;
      const y = desk.deskTile.row * OFFICE_TILE;
      if (
        point.x >= x &&
        point.x < x + DESK_WIDTH_TILES * OFFICE_TILE &&
        point.y >= y &&
        point.y < y + DESK_HIT_ROWS * OFFICE_TILE
      ) {
        return desk.agentId;
      }
    }
    return null;
  }

  /**
   * The pair edge of the envelope under the point, topmost first - a message
   * is a more specific target than the floor it happens to be flying over, so
   * the canvas asks this BEFORE `hitTest`.
   */
  hitTestEnvelope(point: OfficePoint): string | null {
    const regions = envelopeHitRegionsOf(this.buildOverlay());
    for (let index = regions.length - 1; index >= 0; index -= 1) {
      const region = regions[index];
      if (containsPoint(region.rect, point)) return region.edgeId;
    }
    return null;
  }

  // ---- Population ---------------------------------------------------- //

  /**
   * Archived AS OF THE CURSOR, which is the only reading a scrubbable floor
   * can use: `archivedAt` is a moment on the same timeline the cursor sits on,
   * so a record archived after the cursor is still at its desk in that view.
   */
  private isArchivedAsOf(agent: OfficeAgentInput): boolean {
    const archivedAt = agent.archivedAt;
    if (archivedAt === null) return false;
    return this.cursorMs === null || archivedAt <= this.cursorMs;
  }

  /**
   * Archiving is a DEPARTURE, not a state flip: the character stands, walks to
   * its floor's door and is gone, and only then does the desk get its sheet.
   * Scrubbing back un-archives, and the same person walks in again.
   */
  private applyArchivalTransitions(
    input: OfficeSceneInput,
    firstSync: boolean,
  ): void {
    const archived = new Set<string>();
    for (const agent of input.agents) {
      if (this.isArchivedAsOf(agent)) archived.add(agent.id);
    }
    // No walk on the first sync or with motion reduced: the floor is being
    // MATERIALIZED as of the cursor, and a departure nobody saw begin is just
    // an empty desk.
    const instant = firstSync || input.reducedMotion;
    this.sendArchivedHome(input, archived, instant);
    this.readmitUnarchived(input, archived, instant);
    // A character mid-departure whose agent is no longer archived turns
    // around: the cursor moved back before the archival, so the walk it was
    // performing never happened.
    for (const character of this.characters.values()) {
      if (character.errand !== "leaving") continue;
      if (archived.has(character.agentId)) continue;
      this.returnToDesk(character);
    }
    this.archivedIds = archived;
  }

  /** Starts the walk out, or removes the character outright when instant. */
  private sendArchivedHome(
    input: OfficeSceneInput,
    archived: ReadonlySet<string>,
    instant: boolean,
  ): void {
    for (const agentId of archived) {
      if (this.departedIds.has(agentId)) continue;
      const character = this.characters.get(agentId);
      if (character === undefined || !input.visibleAgentIds.has(agentId)) {
        this.departedIds.add(agentId);
        continue;
      }
      if (instant) {
        this.characters.delete(agentId);
        this.departedIds.add(agentId);
        continue;
      }
      if (character.errand === "leaving") continue;
      this.startLeaving(character);
    }
  }

  /** Queues a walk back in for anyone the cursor has moved back before. */
  private readmitUnarchived(
    input: OfficeSceneInput,
    archived: ReadonlySet<string>,
    instant: boolean,
  ): void {
    for (const agentId of Array.from(this.departedIds)) {
      if (archived.has(agentId)) continue;
      this.departedIds.delete(agentId);
      if (instant) continue;
      if (!input.visibleAgentIds.has(agentId)) continue;
      this.returningIds.add(agentId);
    }
  }

  private reconcileCharacters(
    input: OfficeSceneInput,
    firstSync: boolean,
  ): void {
    for (const agentId of Array.from(this.characters.keys())) {
      if (input.visibleAgentIds.has(agentId)) continue;
      this.removeCharacter(agentId);
    }
    // Fast playback outruns a walk: the newcomer would still be crossing the
    // floor when the next row is drawn, so the arrival is a sparkle instead.
    const fastPlayback = input.playing && input.stepMs < FAST_PLAYBACK_STEP_MS;
    for (const agent of input.agents) {
      if (!input.visibleAgentIds.has(agent.id)) continue;
      if (this.characters.has(agent.id)) continue;
      if (this.departedIds.has(agent.id)) continue;
      const desk = this.currentLayout.desks.get(agent.id);
      if (desk === undefined) continue;
      // Walking in is what a REVEAL looks like: playback advancing, the cursor
      // resting on the very row that created this agent, or a scrub back past
      // its archival. A hand-scrubbed jump and a live arrival while paused are
      // not reveals - they are the floor being restated - so those seat
      // silently.
      const revealed =
        this.returningIds.has(agent.id) ||
        input.playing ||
        isCreatedPulseFor(input.pulse, agent.id);
      const announced = !firstSync && !input.reducedMotion && revealed;
      if (announced && !fastPlayback) {
        this.characters.set(agent.id, this.spawnAtDoor(agent.id, desk));
        continue;
      }
      const character = seatedCharacter(agent.id, desk);
      if (announced) character.sparkleMs = SPARKLE_MS;
      this.characters.set(agent.id, character);
    }
  }

  private removeCharacter(agentId: string): void {
    this.characters.delete(agentId);
    this.envelopes = this.envelopes.filter(
      (envelope) =>
        envelope.fromAgentId !== agentId && envelope.toAgentId !== agentId,
    );
  }

  private spawnAtDoor(agentId: string, desk: OfficeDesk): OfficeCharacter {
    const door = this.floorOfAgent(agentId).doorTile;
    const path = findOfficePath(this.currentLayout, door, desk.chairTile);
    if (path === null || path.length === 0) {
      return seatedCharacter(agentId, desk);
    }
    return {
      agentId,
      col: door.col,
      row: door.row,
      facing: "up",
      seated: false,
      path,
      pathIndex: 0,
      walkPhaseMs: 0,
      idleMs: 0,
      bubble: null,
      sparkleMs: 0,
      errand: "arriving",
      waitMs: 0,
      queueTile: null,
    };
  }

  /**
   * After a re-layout, everyone whose desk MOVED walks to the new one; everyone
   * whose desk stayed put keeps their exact position. Comparing destinations
   * rather than current positions is what keeps a walker that is already headed
   * to the right chair from being restarted every re-layout.
   *
   * A departure and a reception queue are left alone: those are not headed for
   * a chair at all, and their own updaters re-target them on this same sync.
   */
  private rehomeCharacters(): void {
    for (const character of this.characters.values()) {
      if (character.errand === "leaving") continue;
      if (this.inReceptionQueue(character)) continue;
      const desk = this.currentLayout.desks.get(character.agentId);
      if (desk === undefined) continue;
      const destination = this.destinationOf(character);
      if (
        destination.col === desk.chairTile.col &&
        destination.row === desk.chairTile.row
      ) {
        continue;
      }
      this.returnToDesk(character);
    }
  }

  private destinationOf(character: OfficeCharacter): OfficeTilePos {
    const last = character.path.at(-1);
    if (!character.seated && last !== undefined) return last;
    return { col: Math.round(character.col), row: Math.round(character.row) };
  }

  private startTileOf(character: OfficeCharacter): OfficeTilePos {
    return { col: Math.round(character.col), row: Math.round(character.row) };
  }

  /** Walks toward `goal`, or lands on it outright when there is no route. */
  private walkTo(character: OfficeCharacter, goal: OfficeTilePos): boolean {
    const start = this.startTileOf(character);
    const path = this.reducedMotion
      ? null
      : findOfficePath(this.currentLayout, start, goal);
    if (path === null || path.length === 0) {
      character.col = goal.col;
      character.row = goal.row;
      character.path = [];
      character.pathIndex = 0;
      character.idleMs = 0;
      return false;
    }
    character.col = start.col;
    character.row = start.row;
    character.seated = false;
    character.path = path;
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    return true;
  }

  /** Back to its own chair, from a break, a queue or a moved desk. */
  private returnToDesk(character: OfficeCharacter): void {
    const desk = this.currentLayout.desks.get(character.agentId);
    if (desk === undefined) {
      character.errand = "none";
      character.waitMs = 0;
      character.queueTile = null;
      return;
    }
    const fromBreak = this.onCoffeeErrand(character);
    character.queueTile = null;
    character.waitMs = 0;
    if (this.walkTo(character, desk.chairTile)) {
      character.errand = fromBreak ? "coffee-return" : "returning";
      return;
    }
    // No route, or motion is reduced: sitting down IS the return.
    character.facing = "up";
    character.seated = true;
    character.errand = "none";
  }

  /** Seats a character at once, wherever it was and whatever it was doing. */
  private seatNow(agentId: string): void {
    const character = this.characters.get(agentId);
    if (character === undefined) return;
    // A departing character is on its way out; dragging it back would undo an
    // archival the data has already stated.
    if (character.errand === "leaving") return;
    const desk = this.currentLayout.desks.get(agentId);
    if (desk === undefined) return;
    character.col = desk.chairTile.col;
    character.row = desk.chairTile.row;
    character.facing = "up";
    character.seated = true;
    character.path = [];
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    character.errand = "none";
    character.waitMs = 0;
    character.queueTile = null;
  }

  private startLeaving(character: OfficeCharacter): void {
    const door = this.floorOfAgent(character.agentId).doorTile;
    const start = this.startTileOf(character);
    const path = findOfficePath(this.currentLayout, start, door);
    if (path === null || path.length === 0) {
      this.depart(character.agentId);
      return;
    }
    character.col = start.col;
    character.row = start.row;
    character.seated = false;
    character.path = path;
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    character.errand = "leaving";
    character.queueTile = null;
    character.waitMs = 0;
  }

  private depart(agentId: string): void {
    this.removeCharacter(agentId);
    this.departedIds.add(agentId);
  }

  // ---- Reception ------------------------------------------------------ //

  private inReceptionQueue(character: OfficeCharacter): boolean {
    return (
      character.errand === "queue-out" || character.errand === "queue-stand"
    );
  }

  private needsReception(agentId: string): boolean {
    const status = this.statusOf(agentId);
    if (status !== "attention" && status !== "failure") return false;
    if (!this.visibleAgentIds.has(agentId)) return false;
    if (this.archivedIds.has(agentId)) return false;
    return this.characters.has(agentId);
  }

  /**
   * Whoever needs a person queues at their own floor's reception, in the order
   * they started needing one. Arrival order is kept as a list rather than
   * re-derived, because "who got here first" is not recoverable from the
   * statuses alone; newcomers within one sync break their tie by id so the
   * queue is still a function of the data.
   *
   * A floor with more people needing help than it has standing room leaves the
   * overflow at their desks, bubble and all - a queue that grew past the lobby
   * would read as a crowd, and there is nowhere to put them anyway.
   */
  private updateReceptionQueue(): void {
    const needy = new Set<string>();
    for (const agentId of this.characters.keys()) {
      if (this.needsReception(agentId)) needy.add(agentId);
    }
    this.queueOrder = this.queueOrder.filter((agentId) => needy.has(agentId));
    const known = new Set(this.queueOrder);
    const newcomers: string[] = [];
    for (const agentId of needy) {
      if (!known.has(agentId)) newcomers.push(agentId);
    }
    newcomers.sort();
    this.queueOrder.push(...newcomers);

    const slots = new Map<string, OfficeTilePos>();
    const takenByFloor = new Map<number, number>();
    for (const agentId of this.queueOrder) {
      const floorIndex = this.floorIndexOfAgent(agentId);
      const floor = this.currentLayout.floors[floorIndex];
      const taken = takenByFloor.get(floorIndex) ?? 0;
      if (taken >= floor.receptionQueueTiles.length) continue;
      slots.set(agentId, floor.receptionQueueTiles[taken]);
      takenByFloor.set(floorIndex, taken + 1);
    }

    for (const character of this.characters.values()) {
      if (character.errand === "leaving") continue;
      const slot = slots.get(character.agentId);
      if (slot === undefined) {
        if (this.inReceptionQueue(character)) this.returnToDesk(character);
        continue;
      }
      if (
        this.inReceptionQueue(character) &&
        sameTile(character.queueTile, slot)
      ) {
        continue;
      }
      this.startQueueWalk(character, slot);
    }
  }

  private startQueueWalk(
    character: OfficeCharacter,
    slot: OfficeTilePos,
  ): void {
    const start = this.startTileOf(character);
    const standing = (): void => {
      character.col = slot.col;
      character.row = slot.row;
      // Facing the counter, which is the way a person waiting actually stands.
      character.facing = "down";
      character.seated = false;
      character.path = [];
      character.pathIndex = 0;
      character.walkPhaseMs = 0;
      character.idleMs = 0;
      character.errand = "queue-stand";
      character.queueTile = slot;
      character.waitMs = 0;
    };
    if (this.reducedMotion) {
      standing();
      return;
    }
    if (start.col === slot.col && start.row === slot.row) {
      standing();
      return;
    }
    const path = findOfficePath(this.currentLayout, start, slot);
    // No route means no queue: a character is never teleported out of its
    // chair, it simply keeps its bubble where it sits.
    if (path === null || path.length === 0) return;
    character.col = start.col;
    character.row = start.row;
    character.seated = false;
    character.path = path;
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    character.errand = "queue-out";
    character.queueTile = slot;
    character.waitMs = 0;
  }

  // ---- Pulses and envelopes ------------------------------------------ //

  private applyPulse(pulse: CommGraphPulse | null): void {
    if (pulse === null) return;
    if (pulse.kind === "agent") {
      // A half-edge has no second desk to fly between, so the visible agent
      // just acknowledges the message.
      this.showBubble(pulse.agentId, "bubble-hello", BUBBLE_HELLO_MS);
      return;
    }
    if (pulse.pulseKind === "notice") {
      // A notice travels back TO the agent that is waiting, so its `from` is
      // the stalled side - the one that owes the answer.
      this.showBubble(
        pulse.fromAgentId,
        "bubble-notice",
        Math.max(this.stepMs, REDUCED_MOTION_ARRIVAL_MS),
      );
    }
    if (!this.characters.has(pulse.fromAgentId)) return;
    if (!this.characters.has(pulse.toAgentId)) return;
    // Sending is done sitting down: an agent caught mid-walk takes its seat
    // before the envelope leaves, so the flight starts from a body.
    this.seatNow(pulse.fromAgentId);
    // ...and so does receiving - except on a `created` edge, where the walk in
    // from the door IS what the row is showing.
    if (pulse.pulseKind !== "created") this.seatNow(pulse.toAgentId);
    if (this.reducedMotion) {
      this.deliver(pulse.toAgentId, pulse.pulseKind);
      return;
    }
    this.envelopes.push({
      fromAgentId: pulse.fromAgentId,
      toAgentId: pulse.toAgentId,
      pulseKind: pulse.pulseKind,
      edgeId: pulse.edgeId,
      elapsedMs: 0,
      durationMs: clamp(
        this.stepMs * ENVELOPE_STEP_FRACTION,
        ENVELOPE_MIN_MS,
        ENVELOPE_MAX_MS,
      ),
    });
    while (this.envelopes.length > MAX_LIVE_ENVELOPES) this.envelopes.shift();
  }

  private deliver(agentId: string, pulseKind: CommGraphPulseKind): void {
    // The acknowledgement belongs over a seated head; a walk-in that is still
    // crossing the floor is cut short rather than bubbled at from a corridor.
    if (pulseKind !== "created") this.seatNow(agentId);
    this.showBubble(
      agentId,
      pulseKind === "notice" ? "bubble-notice" : "bubble-hello",
      BUBBLE_HELLO_MS,
    );
    if (pulseKind !== "created") return;
    const character = this.characters.get(agentId);
    if (character === undefined) return;
    character.sparkleMs = SPARKLE_MS;
  }

  private showBubble(
    agentId: string,
    sprite: OfficeSpriteName,
    durationMs: number,
  ): void {
    const character = this.characters.get(agentId);
    if (character === undefined) return;
    character.bubble = { sprite, remainingMs: durationMs };
  }

  private advanceEnvelopes(dtMs: number): void {
    if (this.envelopes.length === 0) return;
    const live: OfficeEnvelope[] = [];
    for (const envelope of this.envelopes) {
      envelope.elapsedMs += dtMs;
      if (envelope.elapsedMs < envelope.durationMs) {
        live.push(envelope);
        continue;
      }
      this.deliver(envelope.toAgentId, envelope.pulseKind);
    }
    this.envelopes = live;
  }

  // ---- Character animation ------------------------------------------- //

  private advanceCharacter(character: OfficeCharacter, dtMs: number): void {
    const bubble = character.bubble;
    if (bubble !== null) {
      bubble.remainingMs -= dtMs;
      if (bubble.remainingMs <= 0) character.bubble = null;
    }
    if (character.sparkleMs > 0) {
      character.sparkleMs = Math.max(0, character.sparkleMs - dtMs);
    }
    if (
      this.onCoffeeBreak(character) &&
      this.wanderMustEnd(character.agentId)
    ) {
      this.returnToDesk(character);
    }
    if (character.errand === "coffee-wait") {
      character.waitMs -= dtMs;
      if (character.waitMs <= 0) this.returnToDesk(character);
      return;
    }
    // Waiting at reception ends when the status does, which only a sync sees.
    if (character.errand === "queue-stand") return;
    if (!character.seated) {
      this.advanceWalk(character, dtMs);
      return;
    }
    if (this.statusOf(character.agentId) === "idle") character.idleMs += dtMs;
    else character.idleMs = 0;
  }

  // ---- Coffee breaks -------------------------------------------------- //

  /** At the machine, or on the way to it - a break that can still be cut short. */
  private onCoffeeBreak(character: OfficeCharacter): boolean {
    return (
      character.errand === "coffee-out" || character.errand === "coffee-wait"
    );
  }

  /** ...plus the walk back, which is still time spent away from the desk. */
  private onCoffeeErrand(character: OfficeCharacter): boolean {
    return (
      this.onCoffeeBreak(character) || character.errand === "coffee-return"
    );
  }

  private recomputeCoffeeStands(): void {
    const layout = this.currentLayout;
    const stands: Array<OfficeTilePos | null> = [];
    for (const floor of layout.floors) {
      stands.push(this.coffeeStandOn(floor));
    }
    this.coffeeStandByFloor = stands;
  }

  private coffeeStandOn(floor: OfficeFloor): OfficeTilePos | null {
    const layout = this.currentLayout;
    const top = floor.bounds.row;
    const bottom = top + floor.bounds.rows - 1;
    const machine = layout.props.find(
      (prop) =>
        prop.sprite.name === "coffee-machine" &&
        prop.tile.row >= top &&
        prop.tile.row <= bottom,
    );
    if (machine === undefined) return null;
    for (const offset of WANDER_STAND_OFFSETS) {
      const col = machine.tile.col + offset.col;
      const row = machine.tile.row + offset.row;
      if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) {
        continue;
      }
      if (!layout.walkable[row][col]) continue;
      return { col, row };
    }
    return null;
  }

  /**
   * A break belongs to a LIVE floor and to an agent that is still idle, still
   * on it, and still nothing is happening to it. Playback makes every agent
   * idle between its own rows, so a break during it would fire constantly.
   */
  private wanderMustEnd(agentId: string): boolean {
    if (this.playing) return true;
    if (!this.visibleAgentIds.has(agentId)) return true;
    return this.statusOf(agentId) !== "idle";
  }

  private updateWanderStarts(): void {
    if (this.playing || this.reducedMotion) return;
    let active = 0;
    for (const character of this.characters.values()) {
      if (this.onCoffeeErrand(character)) active += 1;
    }
    // Canonical order, so WHICH of a dozen equally bored agents gets up is a
    // fact about their ids rather than about map insertion order.
    const candidates = Array.from(this.characters.values()).sort(
      (left, right) => {
        if (left.agentId === right.agentId) return 0;
        return left.agentId < right.agentId ? -1 : 1;
      },
    );
    for (const character of candidates) {
      if (active >= MAX_WANDERING_AGENTS) return;
      if (character.errand !== "none") continue;
      if (!character.seated) continue;
      if (this.wanderMustEnd(character.agentId)) continue;
      const threshold = IDLE_WANDER_MS + wanderStaggerMs(character.agentId);
      if (character.idleMs < threshold) continue;
      const target =
        this.coffeeStandByFloor[this.floorIndexOfAgent(character.agentId)];
      if (target === null) continue;
      if (this.startWander(character, target)) active += 1;
    }
  }

  private startWander(
    character: OfficeCharacter,
    target: OfficeTilePos,
  ): boolean {
    const start = this.startTileOf(character);
    const path = findOfficePath(this.currentLayout, start, target);
    // No route means no break: a character must never be teleported out of its
    // chair for something as incidental as a coffee.
    if (path === null || path.length === 0) return false;
    character.col = start.col;
    character.row = start.row;
    character.seated = false;
    character.path = path;
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    character.errand = "coffee-out";
    character.waitMs = 0;
    return true;
  }

  private advanceWalk(character: OfficeCharacter, dtMs: number): void {
    character.walkPhaseMs += dtMs;
    const speed =
      character.errand === "arriving"
        ? ARRIVAL_TILES_PER_SECOND
        : WALK_TILES_PER_SECOND;
    let budget = (dtMs / 1000) * speed;
    while (budget > 0 && character.pathIndex < character.path.length) {
      const target = character.path[character.pathIndex];
      const dCol = target.col - character.col;
      const dRow = target.row - character.row;
      // Steps are axis-aligned single tiles, so Manhattan distance IS the
      // distance travelled.
      const distance = Math.abs(dCol) + Math.abs(dRow);
      const nextFacing = facingFor(dCol, dRow);
      if (nextFacing !== null) character.facing = nextFacing;
      if (distance <= budget) {
        character.col = target.col;
        character.row = target.row;
        character.pathIndex += 1;
        budget -= distance;
        continue;
      }
      const fraction = budget / distance;
      character.col += dCol * fraction;
      character.row += dRow * fraction;
      budget = 0;
    }
    if (character.pathIndex < character.path.length) return;
    if (character.errand === "leaving") {
      // Out of the door and off the floor; the desk takes its dust sheet.
      this.depart(character.agentId);
      return;
    }
    if (character.errand === "coffee-out") {
      // Arrived at the machine: standing, facing it, for a fixed beat.
      character.errand = "coffee-wait";
      character.waitMs = WANDER_WAIT_MS;
      character.facing = "up";
      character.path = [];
      character.pathIndex = 0;
      character.walkPhaseMs = 0;
      return;
    }
    if (character.errand === "queue-out") {
      character.errand = "queue-stand";
      character.facing = "down";
      character.path = [];
      character.pathIndex = 0;
      character.walkPhaseMs = 0;
      return;
    }
    character.seated = true;
    character.facing = "up";
    character.path = [];
    character.pathIndex = 0;
    character.idleMs = 0;
    character.errand = "none";
    character.waitMs = 0;
    character.queueTile = null;
  }

  private statusOf(agentId: string): OfficeAgentStatus {
    return this.statusById.get(agentId) ?? "idle";
  }

  private poseFor(character: OfficeCharacter): OfficeCharacterPose {
    if (!character.seated) {
      // On foot but with nothing left to walk: standing at the machine or in
      // the queue.
      if (character.pathIndex >= character.path.length) return "stand";
      return Math.floor(character.walkPhaseMs / WALK_FRAME_MS) % 2 === 0
        ? "walk1"
        : "walk2";
    }
    const status = this.statusOf(character.agentId);
    if (status === "working") {
      return this.typingPose(character.agentId, TYPING_FRAME_MS);
    }
    if (status === "background") {
      return this.typingPose(character.agentId, BACKGROUND_FRAME_MS);
    }
    return "sit";
  }

  private typingPose(agentId: string, frameMs: number): OfficeCharacterPose {
    const phase = this.nowMs + phaseOffsetMs(agentId);
    return Math.floor(phase / frameMs) % 2 === 0 ? "type1" : "type2";
  }

  // ---- Frame assembly ------------------------------------------------ //

  private buildFloor(): ReadonlyArray<OfficeDrawable> {
    const layout = this.currentLayout;
    const floor: OfficeDrawable[] = [];
    for (let row = 0; row < layout.rows; row += 1) {
      for (let col = 0; col < layout.cols; col += 1) {
        floor.push({
          kind: "sprite",
          sprite: { name: this.floorSpriteAt(col, row) },
          x: col * OFFICE_TILE,
          y: row * OFFICE_TILE,
        });
      }
    }
    // Cabin walls sit ON the floor tiles and UNDER the lobby rug: they are the
    // building's inner structure, not furniture standing on it.
    for (const room of layout.rooms) {
      const { col, row, cols, rows } = room.bounds;
      const right = col + cols - 1;
      const bottom = row + rows - 1;
      const wallAt = (wallCol: number, wallRow: number): void => {
        const isDoor =
          wallRow === room.doorTile.row && wallCol === room.doorTile.col;
        floor.push({
          kind: "sprite",
          sprite: { name: isDoor ? "door" : "wall" },
          x: wallCol * OFFICE_TILE,
          y: wallRow * OFFICE_TILE,
        });
      };
      for (let scanCol = col; scanCol <= right; scanCol += 1) {
        floor.push({
          kind: "sprite",
          sprite: { name: "wall-top" },
          x: scanCol * OFFICE_TILE,
          y: row * OFFICE_TILE,
        });
        wallAt(scanCol, row + 1);
        wallAt(scanCol, bottom);
      }
      for (let scanRow = row + 2; scanRow < bottom; scanRow += 1) {
        wallAt(col, scanRow);
        wallAt(right, scanRow);
      }
    }
    // A stairwell is a hole in the FLOOR, not a thing standing on it, so it is
    // drawn from its own top-left tile with no foot lift at all.
    for (const floorPlan of layout.floors) {
      const stairsTile = floorPlan.stairsTile;
      if (stairsTile === null) continue;
      floor.push({
        kind: "sprite",
        sprite: { name: "stairs" },
        x: stairsTile.col * OFFICE_TILE,
        y: stairsTile.row * OFFICE_TILE,
      });
    }
    for (const prop of layout.props) {
      if (prop.sprite.name !== "rug") continue;
      // Centred on its tile as well as lifted onto it: the rug is wider than
      // one tile and the door sits directly below the lobby, so a top-left
      // draw would carpet over the way in.
      const overhang = officeSpriteSize(prop.sprite).width - OFFICE_TILE;
      floor.push({
        kind: "sprite",
        sprite: prop.sprite,
        x: prop.tile.col * OFFICE_TILE - overhang / 2,
        y: propDrawY(prop),
      });
    }
    return floor;
  }

  private floorSpriteAt(col: number, row: number): OfficeSpriteName {
    const layout = this.currentLayout;
    for (const floor of layout.floors) {
      if (row === floor.doorTile.row && col === floor.doorTile.col) {
        return "door";
      }
    }
    // A storey's cap wins over the storey above's bottom wall on the row the
    // two SHARE: what a viewer sees between two floors is one capped wall.
    for (const floor of layout.floors) {
      if (row === floor.bounds.row) return "wall-top";
    }
    for (const floor of layout.floors) {
      const top = floor.bounds.row;
      if (row === top + 1 || row === top + floor.bounds.rows - 1) return "wall";
    }
    if (col === 0 || col === layout.cols - 1) return "wall";
    return (col + row) % 2 === 0 ? "floor-a" : "floor-b";
  }

  private buildProps(): ReadonlyArray<OfficeDrawable> {
    const sorted: SortedProp[] = [];
    for (const desk of this.visibleDesks()) {
      const deskX = desk.deskTile.col * OFFICE_TILE;
      const deskY = desk.deskTile.row * OFFICE_TILE;
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: "desk" },
          x: deskX,
          y: deskY,
        },
        sortY: deskY,
      });
      if (this.isDeskSheeted(desk.agentId)) {
        this.pushSheetedDesk(sorted, desk);
        continue;
      }
      // Shares the desk's sort key so it always lands ON the desk, even though
      // it is drawn above the desk's own top edge.
      const art = this.screenArtFor(desk.agentId);
      const screen = this.monitorSpriteFor(desk.agentId);
      const crashed = screen === "monitor-crash";
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: screen },
          x: deskX + (crashed ? art.crashXOffset : art.xOffset),
          y: deskY + (crashed ? art.crashYOffset : art.yOffset),
          alpha: this.monitorAlphaFor(desk.agentId),
        },
        sortY: deskY,
      });
      // After the screen, in the same bucket: the paper is in FRONT of the
      // display's lower-left corner, not behind it.
      const stack = this.envelopeStackFor(desk.agentId);
      if (stack !== null) {
        sorted.push({
          drawable: {
            kind: "sprite",
            sprite: { name: stack.sprite },
            x: deskX + stack.xOffset,
            y: deskY + stack.yOffset,
          },
          sortY: deskY,
        });
      }
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: "chair" },
          x: desk.chairTile.col * OFFICE_TILE,
          y: desk.chairTile.row * OFFICE_TILE,
        },
        sortY: desk.chairTile.row * OFFICE_TILE,
      });
      // The plate and its logo share the desk's sort key for the same reason
      // the monitor does: they are ON the desk, drawn above its own top edge.
      const plateX = deskX + art.plateXOffset;
      const plateY = deskY + NAMEPLATE_Y_OFFSET;
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: "nameplate" },
          x: plateX,
          y: plateY,
        },
        sortY: deskY,
      });
      const agent = this.agentById.get(desk.agentId);
      // The scene places the logo and never sees the icon; a record that
      // carries no harness simply has an empty plate.
      if (agent !== undefined && agent.harnessId !== null) {
        sorted.push({
          drawable: {
            kind: "logo",
            harnessId: agent.harnessId,
            x: deskX + art.logoXOffset,
            y: deskY + LOGO_Y_OFFSET,
          },
          sortY: deskY,
        });
      }
    }
    for (const room of this.currentLayout.rooms) {
      const signX = room.signTile.col * OFFICE_TILE;
      const signY = spriteFootY({ name: "sign" }, room.signTile.row);
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: "sign" },
          x: signX,
          y: signY,
        },
        sortY: room.signTile.row * OFFICE_TILE,
      });
      sorted.push({
        drawable: {
          kind: "label",
          text: truncate(room.name, MAX_ROOM_LABEL_CHARS),
          x: signX + (SIGN_WIDTH_TILES * OFFICE_TILE) / 2,
          y: signY + SIGN_LABEL_BASELINE,
          // The sign's field is dark in both themes, so the name is written on
          // it rather than in the floor's own text colour.
          tone: "bright",
        },
        sortY: room.signTile.row * OFFICE_TILE,
      });
    }
    for (const prop of this.currentLayout.props) {
      if (prop.sprite.name === "rug") continue;
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: prop.sprite,
          x: prop.tile.col * OFFICE_TILE,
          y: propDrawY(prop),
        },
        // Keyed by the prop's TILE, never by its lifted draw position: a tall
        // prop still belongs to the row it occupies, and sorting on the lift
        // would file it behind the row above.
        sortY: prop.tile.row * OFFICE_TILE,
      });
    }
    // Stable, so same-row props keep the order they were pushed in.
    sorted.sort((left, right) => left.sortY - right.sortY);
    return sorted.map((entry) => entry.drawable);
  }

  /**
   * An archived agent's desk, once its character has left: sheeted over, its
   * chair holding a packed box, no screen and no plate. The name stays, muted,
   * because a nameless sheeted desk is a hole in the floor plan rather than a
   * record of who used to sit there.
   */
  private pushSheetedDesk(sorted: SortedProp[], desk: OfficeDesk): void {
    const deskX = desk.deskTile.col * OFFICE_TILE;
    const deskY = desk.deskTile.row * OFFICE_TILE;
    const chairX = desk.chairTile.col * OFFICE_TILE;
    const chairY = desk.chairTile.row * OFFICE_TILE;
    sorted.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "dust-sheet" },
        x: deskX,
        y: deskY,
      },
      sortY: deskY,
    });
    sorted.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "chair" },
        x: chairX,
        y: chairY,
      },
      sortY: chairY,
    });
    // Under the desk's RIGHT half - the chair is under its left, and a packed
    // box standing in the seat would read as furniture rather than as moving
    // out.
    const boxTile: OfficeTilePos = {
      col: desk.deskTile.col + 1,
      row: desk.deskTile.row + 1,
    };
    sorted.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "box" },
        x: boxTile.col * OFFICE_TILE,
        y: spriteFootY({ name: "box" }, boxTile.row),
      },
      sortY: boxTile.row * OFFICE_TILE,
    });
    const agent = this.agentById.get(desk.agentId);
    if (agent === undefined) return;
    sorted.push({
      drawable: {
        kind: "label",
        text: truncate(agent.name, MAX_LABEL_CHARS),
        // Exactly where the seated character's own label was, so the desk does
        // not appear to shift when its owner leaves.
        x: chairX + OFFICE_CHARACTER_WIDTH / 2,
        y: chairY + CHARACTER_Y_OFFSET + OFFICE_CHARACTER_HEIGHT + LABEL_GAP,
        tone: "muted",
      },
      sortY: chairY,
    });
  }

  /** Sheeted once the archive is real AND the person has actually gone. */
  private isDeskSheeted(agentId: string): boolean {
    return this.departedIds.has(agentId) && this.archivedIds.has(agentId);
  }

  private envelopeStackFor(agentId: string): OfficeEnvelopeStack | null {
    const open = this.openRequestsByReceiver.get(agentId) ?? 0;
    if (open <= 0) return null;
    const index = Math.min(open, ENVELOPE_STACKS.length) - 1;
    return ENVELOPE_STACKS[index];
  }

  private screenArtFor(agentId: string): OfficeScreenArt {
    const agent = this.agentById.get(agentId);
    if (agent === undefined) return SCREEN_ART.medium;
    return SCREEN_ART[agent.modelTier];
  }

  private monitorSpriteFor(agentId: string): OfficeSpriteName {
    const status = this.statusOf(agentId);
    // One crash map serves every tier; the renderer draws it at the tier's own
    // screen offset, which is where that desk's display already was.
    if (status === "failure") return "monitor-crash";
    const art = this.screenArtFor(agentId);
    if (status === "archived") return art.off;
    if (status === "working") {
      return this.screenFrame(agentId, art, MONITOR_WORKING_FRAME_MS);
    }
    if (status === "background") {
      return this.screenFrame(agentId, art, MONITOR_BACKGROUND_FRAME_MS);
    }
    return art.on;
  }

  /** Shares the typing phase offset, so a screen and its typist agree. */
  private screenFrame(
    agentId: string,
    art: OfficeScreenArt,
    frameMs: number,
  ): OfficeSpriteName {
    const second = art.onB;
    // A laptop has one lit frame, so it simply does not flicker.
    if (second === null) return art.on;
    const phase = this.nowMs + phaseOffsetMs(agentId);
    return Math.floor(phase / frameMs) % 2 === 0 ? art.on : second;
  }

  private monitorAlphaFor(agentId: string): number | undefined {
    const status = this.statusOf(agentId);
    // Idle keeps a LIT monitor, merely dimmed: the screen is on, nobody is at
    // it. Only an archived record actually powers down.
    if (status === "idle") return IDLE_MONITOR_ALPHA;
    if (status === "archived") return ARCHIVED_ALPHA;
    return undefined;
  }

  private buildActors(): ReadonlyArray<OfficeDrawable> {
    const actors: OfficeDrawable[] = [];
    for (const character of this.orderedCharacters()) {
      const agent = this.agentById.get(character.agentId);
      if (agent === undefined) continue;
      const archived = this.archivedIds.has(character.agentId);
      const x = character.col * OFFICE_TILE;
      const y = character.row * OFFICE_TILE + CHARACTER_Y_OFFSET;
      actors.push({
        kind: "sprite",
        sprite: {
          name: "character",
          facing: character.facing,
          pose: this.poseFor(character),
          appearance: agent.appearance,
        },
        x,
        y,
        alpha: archived ? ARCHIVED_ALPHA : undefined,
      });
      actors.push({
        kind: "label",
        text: truncate(agent.name, MAX_LABEL_CHARS),
        x: x + OFFICE_CHARACTER_WIDTH / 2,
        y: y + OFFICE_CHARACTER_HEIGHT + LABEL_GAP,
        tone: archived ? "muted" : "default",
      });
    }
    return actors;
  }

  private buildOverlay(): ReadonlyArray<OfficeDrawable> {
    const overlay: OfficeDrawable[] = [];
    const clockSize = officeSpriteSize({ name: "clock" });
    for (const floor of this.currentLayout.floors) {
      // CENTER anchored on the face the `clock` prop just drew, so the hands
      // pivot on the dial rather than on its corner.
      overlay.push({
        kind: "clock",
        x: floor.clockTile.col * OFFICE_TILE + clockSize.width / 2,
        y:
          spriteFootY({ name: "clock" }, floor.clockTile.row) +
          clockSize.height / 2,
        timeMs: this.clockMs,
      });
    }
    for (const character of this.orderedCharacters()) {
      const head = this.headPointOfCharacter(character);
      const bubble = this.bubbleFor(character);
      if (bubble !== null) {
        // Only the attention bubble bobs; a floor where every bubble moved
        // would read as noise rather than as a call for help.
        const bobOffset =
          Math.floor(this.nowMs / BUBBLE_BOB_MS) % 2 === 0 ? -1 : 1;
        const bob = bubble === "bubble-attention" ? bobOffset : 0;
        overlay.push({
          kind: "sprite",
          sprite: { name: bubble },
          x: head.x,
          y: head.y - BUBBLE_GAP + bob,
        });
      }
      if (character.sparkleMs > 0) {
        overlay.push({
          kind: "sprite",
          sprite: { name: "sparkle" },
          x: head.x,
          y: head.y - BUBBLE_GAP,
        });
      }
    }
    for (const envelope of this.envelopes) {
      const from = this.seatPointOf(envelope.fromAgentId);
      const to = this.seatPointOf(envelope.toAgentId);
      if (from === null || to === null) continue;
      const progress = easeInOut(
        clamp(envelope.elapsedMs / envelope.durationMs, 0, 1),
      );
      overlay.push({
        kind: "envelope",
        x: from.x + (to.x - from.x) * progress,
        y:
          from.y +
          (to.y - from.y) * progress -
          ENVELOPE_ARC_LIFT * 4 * progress * (1 - progress),
        pulseKind: envelope.pulseKind,
        progress,
        edgeId: envelope.edgeId,
      });
    }
    return overlay;
  }

  /**
   * A transient acknowledgement outranks a standing state: it lasts under a
   * second and reports the row the cursor is on, which is what the viewer is
   * looking at. The standing bubble is still there when it expires.
   */
  private bubbleFor(character: OfficeCharacter): OfficeSpriteName | null {
    const transient = character.bubble;
    if (transient !== null) return transient.sprite;
    const status = this.statusOf(character.agentId);
    // A failure needs a person exactly as much as an interview does, and the
    // crashed screen at the desk is what says which of the two it is.
    if (status === "failure" || status === "attention") {
      return "bubble-attention";
    }
    if (status === "awaiting") return "bubble-awaiting";
    // Dozing is a statement about a LIVE floor going quiet. During playback
    // every agent is idle between its own rows, so it would fire constantly.
    if (status !== "idle" || this.playing) return null;
    if (character.idleMs > IDLE_SLEEP_MS) return "bubble-sleep";
    return null;
  }

  private buildHitRegions(): ReadonlyArray<OfficeHitRegion> {
    const regions: OfficeHitRegion[] = [];
    for (const character of this.orderedCharacters()) {
      regions.push({
        agentId: character.agentId,
        rect: {
          x: character.col * OFFICE_TILE,
          y: character.row * OFFICE_TILE + CHARACTER_Y_OFFSET,
          width: OFFICE_CHARACTER_WIDTH,
          height: OFFICE_CHARACTER_HEIGHT,
        },
      });
    }
    for (const desk of this.visibleDesks()) {
      regions.push({
        agentId: desk.agentId,
        rect: {
          x: desk.deskTile.col * OFFICE_TILE,
          y: desk.deskTile.row * OFFICE_TILE,
          width: DESK_WIDTH_TILES * OFFICE_TILE,
          height: DESK_HIT_ROWS * OFFICE_TILE,
        },
      });
    }
    return regions;
  }

  private focusPoint(): OfficePoint | null {
    const inFlight = this.envelopes.at(0);
    if (inFlight !== undefined) return this.seatPointOf(inFlight.fromAgentId);
    const senderId = pulseSenderId(this.pulse);
    if (senderId === null) return null;
    return this.headPointOf(senderId);
  }

  // ---- Shared derivations -------------------------------------------- //

  private visibleDesks(): ReadonlyArray<OfficeDesk> {
    const desks: OfficeDesk[] = [];
    for (const desk of this.currentLayout.desks.values()) {
      if (!this.visibleAgentIds.has(desk.agentId)) continue;
      desks.push(desk);
    }
    return desks;
  }

  /** Baseline order: a character lower on the floor overlaps one above it. */
  private orderedCharacters(): ReadonlyArray<OfficeCharacter> {
    return Array.from(this.characters.values()).sort((left, right) => {
      if (left.row !== right.row) return left.row - right.row;
      if (left.col !== right.col) return left.col - right.col;
      if (left.agentId === right.agentId) return 0;
      return left.agentId < right.agentId ? -1 : 1;
    });
  }

  private headPointOf(agentId: string): OfficePoint | null {
    const character = this.characters.get(agentId);
    if (character === undefined) return null;
    return this.headPointOfCharacter(character);
  }

  private headPointOfCharacter(character: OfficeCharacter): OfficePoint {
    return {
      x: character.col * OFFICE_TILE + OFFICE_CHARACTER_WIDTH / 2,
      y: character.row * OFFICE_TILE + CHARACTER_Y_OFFSET,
    };
  }

  /**
   * Where an agent's head is WHEN SEATED - the endpoint every envelope uses.
   * A flight aimed at a live position lands in an empty chair the moment its
   * owner is walking in or standing at reception.
   */
  private seatPointOf(agentId: string): OfficePoint | null {
    const desk = this.currentLayout.desks.get(agentId);
    if (desk === undefined) return null;
    return {
      x: desk.chairTile.col * OFFICE_TILE + OFFICE_CHARACTER_WIDTH / 2,
      y: desk.chairTile.row * OFFICE_TILE + CHARACTER_Y_OFFSET,
    };
  }

  /** The storey an agent lives on; its door, lobby and reception are that one's. */
  private floorIndexOfAgent(agentId: string): number {
    const desk = this.currentLayout.desks.get(agentId);
    if (desk === undefined) return 0;
    const floors = this.currentLayout.floors;
    for (let index = 0; index < floors.length; index += 1) {
      const top = floors[index].bounds.row;
      const bottom = top + floors[index].bounds.rows - 1;
      if (desk.deskTile.row >= top && desk.deskTile.row <= bottom) return index;
    }
    return 0;
  }

  private floorOfAgent(agentId: string): OfficeFloor {
    return this.currentLayout.floors[this.floorIndexOfAgent(agentId)];
  }
}
