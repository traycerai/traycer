import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Runs the pending timers on the fake clock until none is left, and throws
 * with the count still pending if that never happens. The editor's own
 * one-shot timers (prosemirror-view's 20 ms selection check and `DOMObserver`
 * flush, TipTap's 1 ms `scheduleDestroy` after an unmount and its 0 ms core
 * timer) run out in two runs. Zero left means nothing scheduled can act
 * afterwards: a drag cannot raise an overlay again, and an unmounted editor has
 * been destroyed rather than left with its listeners when the clock is
 * restored. The five runs are a fail-only guard: only the count reaching zero
 * decides a pass.
 */
export async function runTimersUntilQuiet(): Promise<void> {
  for (let run = 1; run <= 5; run += 1) {
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    if (vi.getTimerCount() === 0) return;
  }
  throw new Error(`${String(vi.getTimerCount())} timers are still pending`);
}
