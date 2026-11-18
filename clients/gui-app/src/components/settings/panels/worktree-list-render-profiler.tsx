import {
  Profiler,
  useCallback,
  useRef,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";
import { logPerfEvent } from "@/lib/perf/perf-telemetry";
import { roundPerfMs } from "@/components/settings/panels/worktrees-settings-perf";

/**
 * Wraps the worktree list in a React `Profiler` so the render pass is timed by
 * React itself (no impure `performance.now()` in render). Emits
 * `worktree.list_render` on the first commit and whenever the row/visible-row
 * counts change, so keystrokes that leave the set unchanged don't flood.
 *
 * NOTE: `Profiler.onRender` only fires under a profiling-enabled React build
 * (`react-dom/profiling`); the desktop app ships the standard production
 * bundle, so `worktree.list_render` is effectively dev/profiling-build-only -
 * unlike the `localStorage["traycer:perf:telemetry"]` opt-in that gates other
 * perf events, there is no runtime flag that makes this one fire in a shipped
 * build. Aliasing the renderer to the profiling build would enable it, but
 * that carries render overhead for every user, not just this one signal - not
 * a decision to make for a single instrumentation point.
 */
export function WorktreeListRenderProfiler(props: {
  readonly rowCount: number;
  readonly visibleRowCount: number;
  readonly children: ReactNode;
}): ReactNode {
  const { rowCount, visibleRowCount } = props;
  const lastRef = useRef<{
    readonly rowCount: number;
    readonly visibleRowCount: number;
  } | null>(null);
  const onRender = useCallback<ProfilerOnRenderCallback>(
    (_id, _phase, actualDuration) => {
      const last = lastRef.current;
      if (
        last !== null &&
        last.rowCount === rowCount &&
        last.visibleRowCount === visibleRowCount
      ) {
        return;
      }
      lastRef.current = { rowCount, visibleRowCount };
      logPerfEvent("worktree.list_render", {
        rowCount,
        visibleRowCount,
        renderMs: roundPerfMs(actualDuration),
      });
    },
    [rowCount, visibleRowCount],
  );
  return (
    <Profiler id="worktrees-list" onRender={onRender}>
      {props.children}
    </Profiler>
  );
}
