import { useEffect } from "react";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { layoutSnapshotProperties } from "@/lib/layout/layout-diff";
import {
  claimLayoutSnapshotWindow,
  releaseLayoutSnapshotWindow,
} from "@/lib/layout/layout-snapshot-gate";
import { startResourceTelemetry } from "@/lib/resources/resource-telemetry";
import { getLayoutSnapshot } from "@/stores/layout/layout-store";
import { useTabsStore } from "@/stores/tabs";

/**
 * The app shell's own telemetry, for the lifetime of the shell (L-84).
 *
 * Two things launch from here because both are facts about the app starting
 * rather than about any surface in it, and this component is already mounted
 * once for the shell's lifetime - which is exactly the "on app launch" moment
 * they want. A third bootstrap is what tech-plan section 7 refused.
 *
 * The periodic resource sampler reads its workload context here rather than
 * inside the sampler, so `lib/resources/resource-telemetry.ts` stays
 * store-free and directly testable. It is read at sample time (not
 * subscribed) - a sample is a point-in-time reading, and subscribing would
 * re-render this bridge on every tab change for no benefit.
 *
 * `layout_snapshot` is at most once per 24h per device, which is what the gate
 * keeps a remount from breaking. The window is claimed BEFORE the send,
 * because a second renderer must lose the race, and given back when the send
 * does not go out (L-83, G3-04).
 */
export function AppTelemetryBridge(): null {
  useEffect(
    () =>
      startResourceTelemetry(() => ({
        openTabs: useTabsStore.getState().stripOrder.length,
      })),
    [],
  );
  useEffect(() => {
    if (!claimLayoutSnapshotWindow(Date.now())) return;
    const sent = Analytics.getInstance().track(
      AnalyticsEvent.LayoutSnapshot,
      layoutSnapshotProperties(getLayoutSnapshot()),
    );
    if (!sent) releaseLayoutSnapshotWindow();
  }, []);
  return null;
}
