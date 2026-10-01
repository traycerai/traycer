/**
 * The one spring stepper the editor's motion runs on (L-29, section 6).
 *
 * Critically damped by default: the ring, the reflowing siblings and the
 * release all want "arrives and stops", not "arrives and wobbles". A spring
 * rather than a duration because these targets move WHILE the animation runs -
 * a selection that travels to a region whose row is still reflowing, a sibling
 * that is being dragged past - and a tween restarted every frame reads as
 * stutter.
 */

/** How far and how slow a value may be and still count as arrived. */
const SETTLED_DISTANCE = 0.05;
const SETTLED_VELOCITY = 0.2;

/**
 * A dropped frame must not launch the value across the screen: at 1/30 the
 * integrator stays stable and a long stall reads as a slower arrival rather
 * than an overshoot.
 */
export const MAX_SPRING_STEP_SECONDS = 1 / 30;

/** The travelling selection ring (section 6). */
export const RING_SPRING = { response: 0.35, zeta: 1 } as const;

/** The siblings reflowing around a member being dragged past them (section 6). */
export const DRAG_SIBLING_SPRING = { response: 0.34, zeta: 1 } as const;

/**
 * The release, which is the one spring in the editor allowed a little bounce -
 * and only because the gesture that ended handed it momentum (L-29). Let go
 * from a standstill it has no velocity and no distance to cover, so the same
 * underdamped spring simply places the member. Under either reduced-motion
 * gate the drop is placed outright and this never runs.
 */
export const DRAG_RELEASE_SPRING = { response: 0.32, zeta: 0.8 } as const;

export class Spring {
  private current: number;
  private target: number;
  private velocity = 0;

  constructor(
    value: number,
    private readonly response: number,
    private readonly zeta: number,
  ) {
    this.current = value;
    this.target = value;
  }

  get value(): number {
    return this.current;
  }

  setTarget(target: number): void {
    this.target = target;
  }

  /**
   * Hand the spring the speed the gesture it continues was carrying (L-29).
   *
   * The whole difference between a release that is thrown and one that is
   * merely placed, and the reason the drop is a spring rather than a tween.
   */
  setVelocity(velocity: number): void {
    this.velocity = velocity;
  }

  /** Arrive instantly, with no momentum left over. Reduced motion, and first paint. */
  snap(target: number): void {
    this.current = target;
    this.target = target;
    this.velocity = 0;
  }

  step(deltaSeconds: number): number {
    const frequency = (2 * Math.PI) / this.response;
    const stiffness = frequency * frequency;
    const damping = 2 * this.zeta * frequency;
    const acceleration =
      -stiffness * (this.current - this.target) - damping * this.velocity;
    this.velocity += acceleration * deltaSeconds;
    this.current += this.velocity * deltaSeconds;
    return this.current;
  }

  settled(): boolean {
    return (
      Math.abs(this.current - this.target) < SETTLED_DISTANCE &&
      Math.abs(this.velocity) < SETTLED_VELOCITY
    );
  }
}
