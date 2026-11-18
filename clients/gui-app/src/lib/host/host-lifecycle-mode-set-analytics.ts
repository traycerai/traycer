import type {
  HostLifecycleMode,
  HostLifecycleView,
  IHostLifecycleHost,
} from "@traycer-clients/shared/platform/runner-host";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsHostLifecycleSource,
} from "@/lib/analytics";

/** A surface in THIS window that can send main a mode change. */
export type HostLifecycleWindowSource = Exclude<
  AnalyticsHostLifecycleSource,
  "cli"
>;

interface SeenPolicy {
  readonly mode: HostLifecycleMode;
  readonly rev: number;
}

interface Expectation {
  readonly mode: HostLifecycleMode;
  readonly source: HostLifecycleWindowSource;
}

/**
 * `host_lifecycle_mode_set`, reported when the mode is WRITTEN rather than
 * when a surface asked for it.
 *
 * Main pushes the policy view to every window after each write it observes,
 * the CLI's included, tagged with who wrote it (`desired.updatedBy`). A push
 * whose rev moved AND whose mode changed is one mode set; main writes nothing
 * for a mode the file already has, so a remembered Stop that a busy-retry
 * repeats is one event, and a `remember()` that failed is none.
 *
 * Attribution:
 * - a desktop write is reported only by the window that EXPECTED it - the one
 *   whose surface sent that mode - with that surface as the source. Every
 *   other window sees the same push and says nothing.
 * - a CLI write expects nothing anywhere, so exactly one window reports it:
 *   the leader, the window holding the leader Web Lock
 *   (`HostLifecycleAnalyticsBridge`). A CLI write that lands while leadership
 *   is changing hands - the leader window closed, the next one not yet
 *   granted - is not reported: a missed event, never a doubled one.
 * - the set mutation's own `applied` reply carries the same view, and the
 *   reply and the push travel on different IPC pipes, so whichever lands
 *   first reports and the other finds nothing left to report.
 *
 * One instance per window, keyed by that window's lifecycle bridge.
 */
export class HostLifecycleModeSetAnalytics {
  private seen: SeenPolicy | null = null;
  private expected: Expectation | null = null;
  private leader = false;

  /** A surface in this window sent `mode` to main. */
  expect(mode: HostLifecycleMode, source: HostLifecycleWindowSource): void {
    // Main writes nothing for the mode the file already has.
    if (this.seen !== null && this.seen.mode === mode) return;
    this.expected = { mode, source };
  }

  /** That surface's request ended without a write (refused, failed, cancelled). */
  withdraw(source: HostLifecycleWindowSource): void {
    if (this.expected !== null && this.expected.source === source) {
      this.expected = null;
    }
  }

  setLeader(leader: boolean): void {
    this.leader = leader;
  }

  /** The policy as first read, unless a push already said more. */
  seed(view: HostLifecycleView): void {
    if (this.seen === null) this.seen = policyOf(view);
  }

  /** Main's change push. */
  observe(view: HostLifecycleView): void {
    const next = policyOf(view);
    const previous = this.seen;
    this.seen = next;
    const expected = this.expected;
    const expectedHere = expected !== null && expected.mode === next.mode;
    // Whoever wrote it, the mode this window expected is now on file, so the
    // expectation is spent either way.
    if (expectedHere) this.expected = null;
    switch (view.desired.updatedBy) {
      case "desktop":
        // An expectation is only registered for a mode other than the one on
        // file, so with nothing seen yet it is still evidence of a change.
        if (expectedHere && (previous === null || isModeSet(previous, next))) {
          emit(next.mode, expected.source);
        }
        return;
      case "cli":
        if (this.leader && previous !== null && isModeSet(previous, next)) {
          emit(next.mode, "cli");
        }
        return;
      case null:
        return;
    }
  }

  /**
   * The set mutation's reply: the `applied` view, or `null` for any other
   * result (nothing was written).
   */
  settle(
    source: HostLifecycleWindowSource,
    applied: HostLifecycleView | null,
  ): void {
    const expected = this.expected;
    if (expected === null || expected.source !== source) return;
    this.expected = null;
    if (applied === null) return;
    const next = policyOf(applied);
    if (next.mode !== expected.mode) return;
    const previous = this.seen;
    this.seen = next;
    if (previous === null || isModeSet(previous, next)) {
      emit(next.mode, source);
    }
  }
}

function policyOf(view: HostLifecycleView): SeenPolicy {
  return { mode: view.desired.mode, rev: view.desired.rev };
}

/** A write happened (the rev moved) and it changed the mode. */
function isModeSet(previous: SeenPolicy, next: SeenPolicy): boolean {
  return previous.rev !== next.rev && previous.mode !== next.mode;
}

function emit(
  mode: HostLifecycleMode,
  source: AnalyticsHostLifecycleSource,
): void {
  Analytics.getInstance().track(AnalyticsEvent.HostLifecycleModeSet, {
    mode,
    source,
  });
}

const trackers = new WeakMap<
  IHostLifecycleHost,
  HostLifecycleModeSetAnalytics
>();

/** This window's tracker: one per lifecycle bridge object, made on first use. */
export function hostLifecycleModeSetAnalyticsFor(
  hostLifecycle: IHostLifecycleHost,
): HostLifecycleModeSetAnalytics {
  const existing = trackers.get(hostLifecycle);
  if (existing !== undefined) return existing;
  const created = new HostLifecycleModeSetAnalytics();
  trackers.set(hostLifecycle, created);
  return created;
}
