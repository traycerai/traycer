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
 * - A `label` is centered on `x` with its baseline above `y`, per the shared
 *   type.
 *
 * A DESK IS ONLY DRAWN FOR AN AGENT THAT EXISTS AS OF THE CURSOR. The floor
 * plan covers every agent in the epic so positions never shift as playback
 * reveals people, but rendering an empty desk for someone who has not been
 * created yet would leak the future into a historical view.
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
  type OfficeFrame,
  type OfficeHitRegion,
  type OfficeLayout,
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
const NAMEPLATE_X_OFFSET = 18;
const NAMEPLATE_Y_OFFSET = 4;
const LOGO_X_OFFSET = 24;
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
/**
 * Sits the monitor on the desk's back edge, aligned to where the desk sprite
 * draws its keyboard rather than to the desk's own centre - the screen belongs
 * behind the keys, not behind the middle of the furniture.
 */
const MONITOR_X_OFFSET = 3;
const MONITOR_Y_OFFSET = -8;
const IDLE_MONITOR_ALPHA = 0.6;
const ARCHIVED_ALPHA = 0.45;
const DESK_WIDTH_TILES = 2;
/** Desk row plus chair row - what a click on "that person's desk" means. */
const DESK_HIT_ROWS = 2;
/** Spread of the per-agent animation phase offset. */
const PHASE_SPREAD_MS = 1000;

interface TransientBubble {
  readonly sprite: OfficeSpriteName;
  remainingMs: number;
}

/**
 * A coffee break, as a state: `outbound` walking to the machine, `waiting`
 * standing at it, `return` walking back. `none` is everyone else.
 */
type OfficeWander = "none" | "outbound" | "waiting" | "return";

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
  wander: OfficeWander;
  /** Scene time left standing at the machine, while `wander` is `waiting`. */
  wanderWaitMs: number;
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
 * Everything the floor plan depends on. Names, harnesses and archive flags are
 * deliberately absent: a rename must not restack the office.
 */
function agentSetSignature(agents: ReadonlyArray<OfficeAgentInput>): string {
  return agents
    .map(
      (agent) =>
        `${agent.id}\u0000${agent.parentId ?? ""}\u0000${agent.createdAt}`,
    )
    .sort()
    .join("\u0001");
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
    wander: "none",
    wanderWaitMs: 0,
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
  private agentSignature: string | null = null;
  private pulse: CommGraphPulse | null = null;
  private lastPulseKey: string | null = null;
  private playing = false;
  private reducedMotion = false;
  private stepMs = 0;
  private nowMs = 0;
  private synced = false;
  /** Where a character stands to use the coffee machine; `null` if unreachable. */
  private coffeeStandTile: OfficeTilePos | null = null;

  /** `layoutOffice` in production; injected so tests can pin a floor plan. */
  constructor(layoutOf: OfficeLayoutFn) {
    this.layoutOf = layoutOf;
    this.currentLayout = layoutOf([]);
    this.recomputeCoffeeStandTile();
  }

  layout(): OfficeLayout {
    return this.currentLayout;
  }

  sync(input: OfficeSceneInput): void {
    const firstSync = !this.synced;
    this.synced = true;
    this.visibleAgentIds = input.visibleAgentIds;
    this.statusById = input.statusById;
    this.playing = input.playing;
    this.reducedMotion = input.reducedMotion;
    this.stepMs = input.stepMs;
    this.pulse = input.pulse;
    this.agentById = new Map(input.agents.map((agent) => [agent.id, agent]));

    const signature = agentSetSignature(input.agents);
    const layoutChanged = signature !== this.agentSignature;
    if (layoutChanged) {
      this.agentSignature = signature;
      this.currentLayout = this.layoutOf(input.agents);
      this.recomputeCoffeeStandTile();
      // Before reconciling, so a newly spawned walker is not immediately
      // re-pathed to the destination it was just given.
      this.rehomeCharacters();
    }
    this.reconcileCharacters(input, firstSync);
    // A break ends on the sync that ends it, not on the tick after: playback
    // starting or an agent picking work back up are both seen here first.
    for (const character of this.characters.values()) {
      if (character.wander === "none") continue;
      if (!this.wanderMustEnd(character.agentId)) continue;
      this.returnFromWander(character);
    }

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

  private reconcileCharacters(
    input: OfficeSceneInput,
    firstSync: boolean,
  ): void {
    for (const agentId of Array.from(this.characters.keys())) {
      if (input.visibleAgentIds.has(agentId)) continue;
      this.removeCharacter(agentId);
    }
    for (const agent of input.agents) {
      if (!input.visibleAgentIds.has(agent.id)) continue;
      if (this.characters.has(agent.id)) continue;
      const desk = this.currentLayout.desks.get(agent.id);
      if (desk === undefined) continue;
      // Walking in is what a REVEAL looks like: playback advancing, or the
      // cursor resting on the very row that created this agent. A hand-scrubbed
      // jump and a live arrival while paused are not reveals - they are the
      // floor being restated - so those seat silently.
      const walksIn =
        !firstSync &&
        !input.reducedMotion &&
        (input.playing || isCreatedPulseFor(input.pulse, agent.id));
      this.characters.set(
        agent.id,
        walksIn
          ? this.spawnAtDoor(agent.id, desk)
          : seatedCharacter(agent.id, desk),
      );
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
    const door = this.currentLayout.doorTile;
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
      wander: "none",
      wanderWaitMs: 0,
    };
  }

  /**
   * After a re-layout, everyone whose desk MOVED walks to the new one; everyone
   * whose desk stayed put keeps their exact position. Comparing destinations
   * rather than current positions is what keeps a walker that is already headed
   * to the right chair from being restarted every re-layout.
   */
  private rehomeCharacters(): void {
    for (const character of this.characters.values()) {
      const desk = this.currentLayout.desks.get(character.agentId);
      if (desk === undefined) continue;
      const destination = this.destinationOf(character);
      if (
        destination.col === desk.chairTile.col &&
        destination.row === desk.chairTile.row
      ) {
        continue;
      }
      this.walkTo(character, desk.chairTile);
    }
  }

  private destinationOf(character: OfficeCharacter): OfficeTilePos {
    const last = character.path.at(-1);
    if (!character.seated && last !== undefined) return last;
    return { col: Math.round(character.col), row: Math.round(character.row) };
  }

  /** Any deliberate re-route ends a break; `returnFromWander` re-opens one. */
  private walkTo(character: OfficeCharacter, goal: OfficeTilePos): void {
    character.wander = "none";
    character.wanderWaitMs = 0;
    const start = {
      col: Math.round(character.col),
      row: Math.round(character.row),
    };
    const path = this.reducedMotion
      ? null
      : findOfficePath(this.currentLayout, start, goal);
    if (path === null || path.length === 0) {
      character.col = goal.col;
      character.row = goal.row;
      character.facing = "up";
      character.seated = true;
      character.path = [];
      character.pathIndex = 0;
      character.idleMs = 0;
      return;
    }
    character.col = start.col;
    character.row = start.row;
    character.seated = false;
    character.path = path;
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
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
    if (character.wander !== "none" && this.wanderMustEnd(character.agentId)) {
      this.returnFromWander(character);
    }
    if (character.wander === "waiting") {
      character.wanderWaitMs -= dtMs;
      if (character.wanderWaitMs <= 0) this.returnFromWander(character);
      return;
    }
    if (!character.seated) {
      this.advanceWalk(character, dtMs);
      return;
    }
    if (this.statusOf(character.agentId) === "idle") character.idleMs += dtMs;
    else character.idleMs = 0;
  }

  // ---- Coffee breaks -------------------------------------------------- //

  private recomputeCoffeeStandTile(): void {
    const layout = this.currentLayout;
    this.coffeeStandTile = null;
    const machine = layout.props.find(
      (prop) => prop.sprite.name === "coffee-machine",
    );
    if (machine === undefined) return;
    for (const offset of WANDER_STAND_OFFSETS) {
      const col = machine.tile.col + offset.col;
      const row = machine.tile.row + offset.row;
      if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) {
        continue;
      }
      if (!layout.walkable[row][col]) continue;
      this.coffeeStandTile = { col, row };
      return;
    }
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
    const target = this.coffeeStandTile;
    if (target === null) return;
    let active = 0;
    for (const character of this.characters.values()) {
      if (character.wander !== "none") active += 1;
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
      if (character.wander !== "none") continue;
      if (!character.seated) continue;
      if (this.wanderMustEnd(character.agentId)) continue;
      const threshold = IDLE_WANDER_MS + wanderStaggerMs(character.agentId);
      if (character.idleMs < threshold) continue;
      if (this.startWander(character, target)) active += 1;
    }
  }

  private startWander(
    character: OfficeCharacter,
    target: OfficeTilePos,
  ): boolean {
    const start = {
      col: Math.round(character.col),
      row: Math.round(character.row),
    };
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
    character.wander = "outbound";
    character.wanderWaitMs = 0;
    return true;
  }

  private returnFromWander(character: OfficeCharacter): void {
    if (character.wander === "return") return;
    const desk = this.currentLayout.desks.get(character.agentId);
    if (desk === undefined) {
      character.wander = "none";
      character.wanderWaitMs = 0;
      return;
    }
    this.walkTo(character, desk.chairTile);
    // `walkTo` seats instantly when motion is reduced or no route exists, and
    // that IS the return in those cases - there is nothing left to walk.
    if (!character.seated) character.wander = "return";
  }

  private advanceWalk(character: OfficeCharacter, dtMs: number): void {
    character.walkPhaseMs += dtMs;
    let budget = (dtMs / 1000) * WALK_TILES_PER_SECOND;
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
    if (character.wander === "outbound") {
      // Arrived at the machine: standing, facing it, for a fixed beat.
      character.wander = "waiting";
      character.wanderWaitMs = WANDER_WAIT_MS;
      character.facing = "up";
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
    character.wander = "none";
    character.wanderWaitMs = 0;
  }

  private statusOf(agentId: string): OfficeAgentStatus {
    return this.statusById.get(agentId) ?? "idle";
  }

  private poseFor(character: OfficeCharacter): OfficeCharacterPose {
    if (!character.seated) {
      // On foot but with nothing left to walk: standing at the machine.
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
    if (row === layout.doorTile.row && col === layout.doorTile.col) {
      return "door";
    }
    if (row === 0) return "wall-top";
    if (row === 1 || row === layout.rows - 1) return "wall";
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
      // Shares the desk's sort key so it always lands ON the desk, even though
      // it is drawn above the desk's own top edge.
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: this.monitorSpriteFor(desk.agentId) },
          x: deskX + MONITOR_X_OFFSET,
          y: deskY + MONITOR_Y_OFFSET,
          alpha: this.monitorAlphaFor(desk.agentId),
        },
        sortY: deskY,
      });
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
      const plateX = deskX + NAMEPLATE_X_OFFSET;
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
            x: deskX + LOGO_X_OFFSET,
            y: deskY + LOGO_Y_OFFSET,
            alpha:
              this.statusOf(desk.agentId) === "archived"
                ? ARCHIVED_ALPHA
                : undefined,
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

  private monitorSpriteFor(agentId: string): OfficeSpriteName {
    const status = this.statusOf(agentId);
    if (status === "archived") return "monitor-off";
    if (status === "working") {
      return this.screenFrame(agentId, MONITOR_WORKING_FRAME_MS);
    }
    if (status === "background") {
      return this.screenFrame(agentId, MONITOR_BACKGROUND_FRAME_MS);
    }
    return "monitor-on";
  }

  /** Shares the typing phase offset, so a screen and its typist agree. */
  private screenFrame(agentId: string, frameMs: number): OfficeSpriteName {
    const phase = this.nowMs + phaseOffsetMs(agentId);
    return Math.floor(phase / frameMs) % 2 === 0
      ? "monitor-on"
      : "monitor-on-b";
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
      const archived = this.statusOf(character.agentId) === "archived";
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
      const from = this.headPointOf(envelope.fromAgentId);
      const to = this.headPointOf(envelope.toAgentId);
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
    if (status === "attention") return "bubble-attention";
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
    if (inFlight !== undefined) return this.headPointOf(inFlight.fromAgentId);
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
}
