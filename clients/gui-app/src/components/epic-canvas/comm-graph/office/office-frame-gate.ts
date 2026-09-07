/**
 * VISIBILITY - a canvas nobody can see is not drawn to.
 * The second is not the first: an unselected Traycer tab keeps its tiles mounted under `display:none`, which no page-level event reports. 2.
 */

/** A frame longer than this is a tab that was asleep, not a slow frame. */
export const OFFICE_MAX_FRAME_MS = 100;

/** The drawing rate. The SIMULATION still advances in real time. */
export const OFFICE_FRAME_INTERVAL_MS = 33;

/**
 * A tile hidden for an hour must not replay an hour, but resuming EXACTLY where it paused looks frozen - agents standing mid-stride until the next event happens to move them.
 */
export const OFFICE_RESUME_CATCH_UP_MS = 2_000;

/** What the floor looks like on the frame being considered. */
export interface OfficeFloorMotion {
  /** Anything moving: an envelope, a walk, a bubble, a lit screen. */
  readonly animating: boolean;
  /** The minute the wall clock is showing, as a whole number. */
  readonly minute: number;
  /** A camera pan running or waiting to start. */
  readonly panning: boolean;
}

/**
 * `checkVisibility` is the direct answer and covers the case this exists for - an ancestor with `display:none` - which a bounding box alone does NOT: a zero-sized box is also what a tile that has not been laid out yet has.
 * `getClientRects` is the fallback for engines without it, where an empty list means the same thing.
 */
export function isElementVisible(element: Element): boolean {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility();
  }
  return element.getClientRects().length > 0;
}

/**
 * Deliberately a small mutable object rather than free functions: both rules are about what happened on the PREVIOUS frame, and threading that through the loop by hand is how one of them ends up silently disabled.
 */
export class OfficeFrameGate {
  private sinceLastFrame = 0;
  private lastDrawnMinute = -1;

  /**
   * The whole accumulated slice comes back rather than one interval's worth: the simulation is ticked with it, which is what keeps a walk taking the same wall-clock time at any frame rate.
   */
  elapsed(dtMs: number): number | null {
    this.sinceLastFrame += Math.min(OFFICE_MAX_FRAME_MS, Math.max(0, dtMs));
    if (this.sinceLastFrame < OFFICE_FRAME_INTERVAL_MS) return null;
    // Zeroing the accumulator would make a 60Hz display land on 16, 32, 48 - drawing every third vsync at 20fps rather than the 30 asked for, and losing the 15ms each time.
    const carry = this.sinceLastFrame % OFFICE_FRAME_INTERVAL_MS;
    const elapsed = this.sinceLastFrame - carry;
    this.sinceLastFrame = carry;
    return elapsed;
  }

  /**
   * Whether this frame has to be painted.
   * A still floor is still redrawn when the clock's MINUTE turns over, or its hands would sit wrong until something else happened to move.
   */
  shouldDraw(motion: OfficeFloorMotion): boolean {
    const idle =
      !motion.animating &&
      motion.minute === this.lastDrawnMinute &&
      !motion.panning;
    if (idle) return false;
    this.lastDrawnMinute = motion.minute;
    return true;
  }

  /**
   * The canvas a resumed tile comes back to holds whatever was last painted into it, which on a still floor is a frame from before the pause - and the idle skip, seeing the same minute it last drew, would leave that stale image up until something happened to move.
   */
  resume(): void {
    this.sinceLastFrame = OFFICE_FRAME_INTERVAL_MS;
    this.invalidate();
  }

  /**
   * Forgets what was last painted, so the next frame is drawn whatever the floor is doing.
   * The idle skip's premise is that the canvas still HOLDS the last frame.
   */
  invalidate(): void {
    this.lastDrawnMinute = -1;
  }
}

/**
 * Bounded, and never negative: a clock that jumped backwards while the tile was hidden must not rewind the floor.
 */
export function officeCatchUpMs(pausedForMs: number): number {
  if (pausedForMs <= 0) return 0;
  return Math.min(OFFICE_RESUME_CATCH_UP_MS, pausedForMs);
}
