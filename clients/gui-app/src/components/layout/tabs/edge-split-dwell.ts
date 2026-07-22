import type { TopLevelEdgeSplitTarget } from "@/components/layout/tabs/top-level-tab-dnd";

export const EDGE_SPLIT_DWELL_MS = 400;

export type EdgeSplitDwellState =
  | { readonly kind: "idle" }
  | { readonly kind: "armed"; readonly target: TopLevelEdgeSplitTarget }
  | { readonly kind: "preview"; readonly target: TopLevelEdgeSplitTarget }
  | { readonly kind: "commit"; readonly target: TopLevelEdgeSplitTarget };

export interface EdgeSplitTimer {
  readonly set: (callback: () => void, timeout: number) => number;
  readonly clear: (timer: number) => void;
}

export const edgeSplitBrowserTimer: EdgeSplitTimer = {
  set: (callback, timeout) => window.setTimeout(callback, timeout),
  clear: (timer) => window.clearTimeout(timer),
};

/**
 * Gesture-local finite-state machine. It has no React state and is usable from
 * the root provider's refs, so an autoscroll collision update cannot leave a
 * preview timer alive after the semantic target changed.
 */
export class EdgeSplitDwellMachine {
  private state: EdgeSplitDwellState = { kind: "idle" };
  private timer: number | null = null;
  private isTargetValid: (target: TopLevelEdgeSplitTarget) => boolean = () =>
    false;

  constructor(
    private readonly onStateChanged: (state: EdgeSplitDwellState) => void,
    private readonly timers: EdgeSplitTimer,
  ) {}

  setTargetValidator(
    validator: (target: TopLevelEdgeSplitTarget) => boolean,
  ): void {
    this.isTargetValid = validator;
  }

  getState(): EdgeSplitDwellState {
    return this.state;
  }

  observe(target: TopLevelEdgeSplitTarget | null): void {
    if (target === null || !this.isTargetValid(target)) {
      this.reset();
      return;
    }
    const current = this.state.kind === "idle" ? null : this.state.target;
    if (sameTarget(current, target)) return;
    this.clearTimer();
    this.setState({ kind: "armed", target });
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (
        this.state.kind !== "armed" ||
        !sameTarget(this.state.target, target) ||
        !this.isTargetValid(target)
      ) {
        this.reset();
        return;
      }
      this.setState({ kind: "preview", target });
    }, EDGE_SPLIT_DWELL_MS);
  }

  commit(
    target: TopLevelEdgeSplitTarget | null,
  ): TopLevelEdgeSplitTarget | null {
    if (
      target === null ||
      this.state.kind !== "preview" ||
      !sameTarget(this.state.target, target) ||
      !this.isTargetValid(target)
    ) {
      this.reset();
      return null;
    }
    this.clearTimer();
    this.setState({ kind: "commit", target });
    return target;
  }

  reset(): void {
    this.clearTimer();
    if (this.state.kind === "idle") return;
    this.setState({ kind: "idle" });
  }

  revalidate(): void {
    if (this.state.kind === "idle") return;
    if (this.isTargetValid(this.state.target)) return;
    this.reset();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private setState(state: EdgeSplitDwellState): void {
    this.state = state;
    this.onStateChanged(state);
  }
}

function sameTarget(
  left: TopLevelEdgeSplitTarget | null,
  right: TopLevelEdgeSplitTarget,
): boolean {
  return (
    left !== null &&
    left.side === right.side &&
    left.targetRef.kind === right.targetRef.kind &&
    left.targetRef.id === right.targetRef.id
  );
}
