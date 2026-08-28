import {
  dwellTargetKey,
  type TopLevelDwellTarget,
} from "@/components/layout/tabs/top-level-tab-dnd";
import {
  DwellLatch,
  browserDwellTimer,
  type DwellTimer,
} from "@/components/epic-canvas/dnd/dwell-latch";

export const EDGE_SPLIT_DWELL_MS = 400;

export type EdgeSplitDwellState =
  | { readonly kind: "idle" }
  | { readonly kind: "armed"; readonly target: TopLevelDwellTarget }
  | { readonly kind: "preview"; readonly target: TopLevelDwellTarget }
  | { readonly kind: "commit"; readonly target: TopLevelDwellTarget };

/**
 * Re-exported from the shared dwell primitive so this file no longer defines a
 * second timer abstraction. There is one dwell mechanism in the app now; the
 * timings stay per-caller.
 */
export type EdgeSplitTimer = DwellTimer;
export const edgeSplitBrowserTimer: DwellTimer = browserDwellTimer;

/**
 * Gesture-local finite-state machine. It has no React state and is usable from
 * the root provider's refs, so an autoscroll collision update cannot leave a
 * preview timer alive after the semantic target changed.
 */
export class EdgeSplitDwellMachine {
  private state: EdgeSplitDwellState = { kind: "idle" };
  private target: TopLevelDwellTarget | null = null;
  private isTargetValid: (target: TopLevelDwellTarget) => boolean = () => false;
  private readonly latch: DwellLatch;

  constructor(
    private readonly onStateChanged: (state: EdgeSplitDwellState) => void,
    timers: EdgeSplitTimer,
  ) {
    // The latch owns the timer. This machine used to own one of three separate
    // implementations; the shared one is what guarantees a held pointer arms
    // without the caller re-invoking anything.
    this.latch = new DwellLatch({
      dwellMs: EDGE_SPLIT_DWELL_MS,
      // This gesture has never had a stillness budget - it arms on target
      // identity alone - so the budget is effectively unbounded here rather
      // than silently introducing a new cancellation rule.
      stillnessPx: Number.POSITIVE_INFINITY,
      timer: timers,
      onChange: (latchState) => {
        if (latchState.kind !== "fired") return;
        const target = this.target;
        if (target === null || !this.isTargetValid(target)) {
          this.reset();
          return;
        }
        this.setState({ kind: "preview", target });
      },
    });
  }

  setTargetValidator(
    validator: (target: TopLevelDwellTarget) => boolean,
  ): void {
    this.isTargetValid = validator;
  }

  getState(): EdgeSplitDwellState {
    return this.state;
  }

  observe(target: TopLevelDwellTarget | null): void {
    if (target === null || !this.isTargetValid(target)) {
      this.reset();
      return;
    }
    const current = this.state.kind === "idle" ? null : this.state.target;
    if (sameTarget(current, target)) return;
    this.target = target;
    this.setState({ kind: "armed", target });
    // Point is irrelevant for this gesture; identity is the whole trigger.
    this.latch.observe({
      key: dwellTargetKey(target),
      point: { x: 0, y: 0 },
      nowMs: 0,
    });
  }

  commit(target: TopLevelDwellTarget | null): TopLevelDwellTarget | null {
    if (
      target === null ||
      this.state.kind !== "preview" ||
      !sameTarget(this.state.target, target) ||
      !this.isTargetValid(target)
    ) {
      this.reset();
      return null;
    }
    this.latch.reset();
    this.setState({ kind: "commit", target });
    return target;
  }

  reset(): void {
    this.latch.reset();
    this.target = null;
    if (this.state.kind === "idle") return;
    this.setState({ kind: "idle" });
  }

  revalidate(): void {
    if (this.state.kind === "idle") return;
    if (this.isTargetValid(this.state.target)) return;
    this.reset();
  }

  private setState(state: EdgeSplitDwellState): void {
    this.state = state;
    this.onStateChanged(state);
  }
}

function sameTarget(
  left: TopLevelDwellTarget | null,
  right: TopLevelDwellTarget,
): boolean {
  return left !== null && dwellTargetKey(left) === dwellTargetKey(right);
}
