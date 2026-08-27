/**
 * One dwell primitive for every "hold still on a target and it arms" gesture.
 *
 * There were three of these, with three different timer strategies:
 * `EdgeSplitDwellMachine` owned an injectable timer, the strip drag model was
 * pure and owned none, and the root provider owned two more by hand. Two
 * durations across three implementations of one idea.
 *
 * That is not a tidiness problem. **A dwell that owns no timer cannot fire on
 * its own** - it only advances when some caller happens to re-invoke it - and a
 * stationary pointer emits no pointer events, so the gesture goes *silently*
 * dead: nothing looks broken, the thing simply never happens. That defect
 * shipped twice, in two different gestures, and the second site never inherited
 * the first fix because the fix lived in a caller rather than in a shared
 * thing.
 *
 * So the guarantee here is structural, not stylistic: **a latch always owns its
 * own timer**, and there is no way to construct one that depends on a caller
 * remembering to advance it. Timings stay per-caller - 400ms for the header
 * merge and edge split, 220ms for a pane body - because converging the
 * mechanism must not converge the feel.
 */

/** Injectable so tests drive a fake clock, as `edge-split-dwell.ts` already did. */
export interface DwellTimer {
  readonly set: (callback: () => void, timeoutMs: number) => number;
  readonly clear: (timer: number) => void;
}

export const browserDwellTimer: DwellTimer = {
  set: (callback, timeoutMs) => window.setTimeout(callback, timeoutMs),
  clear: (timer) => {
    window.clearTimeout(timer);
  },
};

export interface DwellPoint {
  readonly x: number;
  readonly y: number;
}

export type DwellState =
  | { readonly kind: "idle" }
  | { readonly kind: "armed"; readonly key: string; readonly sinceMs: number }
  | { readonly kind: "fired"; readonly key: string };

export interface DwellLatchOptions {
  /** How long the pointer must settle before the latch fires. */
  readonly dwellMs: number;
  /**
   * Movement budget during the settle. Exceeding it re-anchors rather than
   * cancelling outright, so drifting never accumulates its way to a fire but
   * stopping still arms.
   */
  readonly stillnessPx: number;
  readonly timer: DwellTimer;
  /** Called on every state transition, including the self-driven fire. */
  readonly onChange: (state: DwellState) => void;
}

export class DwellLatch {
  private state: DwellState = { kind: "idle" };
  private anchor: DwellPoint | null = null;
  private timer: number | null = null;

  constructor(private readonly options: DwellLatchOptions) {}

  getState(): DwellState {
    return this.state;
  }

  isFired(key: string): boolean {
    return this.state.kind === "fired" && this.state.key === key;
  }

  /**
   * Report where the pointer is and what it is over. `key === null` means no
   * target, which resets. Everything else - arming, re-anchoring, and firing -
   * is the latch's own business.
   */
  observe(input: {
    readonly key: string | null;
    readonly point: DwellPoint | null;
    readonly nowMs: number;
  }): DwellState {
    const { key, point, nowMs } = input;
    if (key === null || point === null) {
      this.reset();
      return this.state;
    }
    const current = this.state;
    if (current.kind !== "idle" && current.key !== key) {
      // Left the target: cancel immediately rather than letting a stale arm
      // carry over to whatever the pointer moved onto.
      this.restart(key, point, nowMs);
      return this.state;
    }
    if (current.kind === "fired") return this.state;
    if (current.kind === "idle") {
      this.restart(key, point, nowMs);
      return this.state;
    }
    const travelled = Math.hypot(
      point.x - (this.anchor?.x ?? point.x),
      point.y - (this.anchor?.y ?? point.y),
    );
    if (travelled > this.options.stillnessPx) {
      this.restart(key, point, nowMs);
      return this.state;
    }
    if (nowMs - current.sinceMs >= this.options.dwellMs) {
      this.fire(key);
    }
    return this.state;
  }

  reset(): void {
    this.clearTimer();
    this.anchor = null;
    if (this.state.kind === "idle") return;
    this.setState({ kind: "idle" });
  }

  private restart(key: string, point: DwellPoint, nowMs: number): void {
    this.anchor = point;
    this.setState({ kind: "armed", key, sinceMs: nowMs });
    this.schedule(key, this.options.dwellMs);
  }

  /**
   * The whole point of the primitive: the latch wakes itself. Without this a
   * held pointer never advances the dwell, because a stationary pointer emits
   * no events for a caller to forward.
   */
  private schedule(key: string, delayMs: number): void {
    this.clearTimer();
    // Scheduled for exactly the dwell, not dwell+1: callers assert the timeout
    // they configured, and the callback re-checks state rather than the clock,
    // so there is nothing for a fudge factor to protect against.
    this.timer = this.options.timer.set(
      () => {
        this.timer = null;
        if (this.state.kind === "armed" && this.state.key === key) {
          this.fire(key);
        }
      },
      Math.max(0, delayMs),
    );
  }

  private fire(key: string): void {
    this.clearTimer();
    this.setState({ kind: "fired", key });
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.options.timer.clear(this.timer);
    this.timer = null;
  }

  private setState(state: DwellState): void {
    this.state = state;
    this.options.onChange(state);
  }
}
