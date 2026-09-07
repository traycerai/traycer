import {
  Profiler,
  useCallback,
  useRef,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";
import { logPerfEvent } from "@/lib/perf/perf-telemetry";
import { roundPerfMs } from "@/components/settings/panels/worktrees-settings-perf";

/** NOTE: `Profiler.onRender` only fires under a profiling-enabled React build */
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
