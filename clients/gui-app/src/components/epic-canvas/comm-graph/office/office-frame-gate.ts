/**
 * When the office is allowed to spend a frame.
 *
 * The floor's rAF loop lives in the canvas component, where jsdom's missing 2d
 * context means not one line of it ever runs under test. Every DECISION the
 * loop makes is therefore here instead: the loop is reduced to wiring, and the
 * three rules that actually save the battery are ordinary functions with an
 * ordinary suite.
 *
 * The rules, in the order the loop applies them:
 *
 * 1. VISIBILITY - a canvas nobody can see is not drawn to. Two independent
 *    ways to be invisible, and the floor answers to both: a hidden document
 *    (the browser's own signal) and a hidden tile. The second is not the
 *    first: an unselected Traycer tab keeps its tiles mounted under
 *    `display:none`, which no page-level event reports.
 * 2. RATE - 30fps, not the display's rate. Pixel art on a 16px grid moves a
 *    fraction of a pixel between two 60Hz frames, so half of them are
 *    identical images bought at the price of a full redraw.
 * 3. IDLENESS - a floor of seated agents between turns is a still life, and
 *    redrawing a still life sixty times a second is the same waste again.
 */

/** A frame longer than this is a tab that was asleep, not a slow frame. */
export const OFFICE_MAX_FRAME_MS = 100;

/** The drawing rate. The SIMULATION still advances in real time. */
export const OFFICE_FRAME_INTERVAL_MS = 33;

/**
 * How much simulated time a resume may catch up on. A tile hidden for an hour
 * must not replay an hour, but resuming EXACTLY where it paused looks frozen -
 * agents standing mid-stride until the next event happens to move them.
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
 * Whether an element is being rendered at all.
 *
 * `checkVisibility` is the direct answer and covers the case this exists for -
 * an ancestor with `display:none` - which a bounding box alone does NOT: a
 * zero-sized box is also what a tile that has not been laid out yet has.
 * `getClientRects` is the fallback for engines without it, where an empty list
 * means the same thing.
 */
export function isElementVisible(element: Element): boolean {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility();
  }
  return element.getClientRects().length > 0;
}

/**
 * Whether an element currently overlaps the browser viewport.
 *
 * `isElementVisible` answers "is this rendered at all" - true for an element
 * that participates in layout even when it sits far outside the scroll
 * viewport - so it is the wrong seed for intersection state: a tile mounted
 * off screen would read `true` and run a full plan, scene sync and first
 * bitmap allocation before the asynchronous `IntersectionObserver` reports
 * `false` and tears that work down. This tests the box against the viewport
 * the observer's default root uses, so the synchronous seed agrees with the
 * observer's first async answer - a foreground tile is eligible at once, an
 * off-screen one is not. A zero-sized box (not yet laid out) is not in the
 * viewport, and in jsdom, where `getBoundingClientRect` is all zeros, the
 * answer is `false` and the observer drives the state from there.
 *
 * A CONSERVATIVE seed against the window viewport ALONE. An
 * `IntersectionObserver` with the default root also clips through the
 * containing-block chain, so a tile scrolled out of the epic canvas - an
 * `overflow-hidden` ancestor - is not intersecting even when its raw box still
 * overlaps the window; that tile reads `true` here and runs one plan/sync/bake
 * before the observer's first async answer tears it down. That is the accepted
 * cost of NOT reading ancestor overflow synchronously: the only way to know an
 * ancestor clips is `getComputedStyle`, which is a prohibited call site here
 * (see clients/gui-app/AGENTS.md), and the observer is the authority on
 * clipping anyway. The seed's job is only to keep a foreground tile eligible at
 * once and an off-WINDOW one idle; the observer refines the rest a beat later.
 */
export function isElementInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const clipRight = window.innerWidth || document.documentElement.clientWidth;
  const clipBottom =
    window.innerHeight || document.documentElement.clientHeight;
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < clipBottom &&
    rect.left < clipRight
  );
}

/**
 * The rate cap and the idle skip, as one piece of state.
 *
 * Deliberately a small mutable object rather than free functions: both rules
 * are about what happened on the PREVIOUS frame, and threading that through
 * the loop by hand is how one of them ends up silently disabled.
 */
export class OfficeFrameGate {
  private sinceLastFrame = 0;
  private lastDrawnMinute = -1;
  /**
   * Whether the floor was moving when this gate last looked.
   *
   * THE SETTLING FRAME IS THE ONE THAT SHOWS THE END. The loop ticks the scene
   * and then asks whether it is animating, so the tick that lands the last
   * walker in its chair or takes the delivered envelope off the floor is the
   * tick after which the answer is no - and a gate that only asked the new
   * answer would refuse exactly the frame in which the motion finishes,
   * leaving the canvas holding the envelope a frame short of the desk and the
   * pip two pixels shy of its seat until something else happened to move.
   */
  private wasAnimating = false;

  /**
   * Accumulates real time and answers with the elapsed slice when the cap
   * allows a frame, or `null` to skip.
   *
   * The whole accumulated slice comes back rather than one interval's worth:
   * the simulation is ticked with it, which is what keeps a walk taking the
   * same wall-clock time at any frame rate.
   */
  elapsed(dtMs: number): number | null {
    this.sinceLastFrame += Math.min(OFFICE_MAX_FRAME_MS, Math.max(0, dtMs));
    if (this.sinceLastFrame < OFFICE_FRAME_INTERVAL_MS) return null;
    // The OVERSHOOT is carried, not dropped. Zeroing the accumulator would
    // make a 60Hz display land on 16, 32, 48 - drawing every third vsync at
    // 20fps rather than the 30 asked for, and losing the 15ms each time.
    const carry = this.sinceLastFrame % OFFICE_FRAME_INTERVAL_MS;
    const elapsed = this.sinceLastFrame - carry;
    this.sinceLastFrame = carry;
    return elapsed;
  }

  /**
   * Whether this frame has to be painted.
   *
   * A still floor is still redrawn when the clock's MINUTE turns over, or its
   * hands would sit wrong until something else happened to move.
   *
   * And once more after the motion stops, for the reason `wasAnimating` gives:
   * the frame in which a thing finishes is a frame in which nothing is moving
   * any more. ONE more - the latch clears with it - so a settled floor goes
   * quiescent on the next pass rather than redrawing forever.
   */
  shouldDraw(motion: OfficeFloorMotion): boolean {
    const settling = this.wasAnimating && !motion.animating;
    this.wasAnimating = motion.animating;
    const idle =
      !motion.animating &&
      !settling &&
      motion.minute === this.lastDrawnMinute &&
      !motion.panning;
    if (idle) return false;
    this.lastDrawnMinute = motion.minute;
    return true;
  }

  /**
   * Primes the gate so the first frame after a resume draws immediately.
   *
   * BOTH rules have to stand aside, not just the rate cap. The canvas a
   * resumed tile comes back to holds whatever was last painted into it, which
   * on a still floor is a frame from before the pause - and the idle skip,
   * seeing the same minute it last drew, would leave that stale image up until
   * something happened to move. Forgetting the drawn minute is what guarantees
   * the first frame back is painted.
   */
  resume(): void {
    this.sinceLastFrame = OFFICE_FRAME_INTERVAL_MS;
    this.invalidate();
  }

  /**
   * Forgets what was last painted, so the next frame is drawn whatever the
   * floor is doing.
   *
   * The idle skip's premise is that the canvas still HOLDS the last frame.
   * Anything that erases the bitmap breaks that premise, and assigning to a
   * canvas's `width` or `height` - which a resize or a device-pixel-ratio
   * change both do - clears it to transparent. On a still floor the skip would
   * then refuse every frame and the tile would stay blank until something
   * happened to move.
   */
  invalidate(): void {
    this.lastDrawnMinute = -1;
  }
}

/**
 * How much simulated time to fast-forward when the loop restarts, given how
 * long it was paused for. Bounded, and never negative: a clock that jumped
 * backwards while the tile was hidden must not rewind the floor.
 */
export function officeCatchUpMs(pausedForMs: number): number {
  if (pausedForMs <= 0) return 0;
  return Math.min(OFFICE_RESUME_CATCH_UP_MS, pausedForMs);
}
