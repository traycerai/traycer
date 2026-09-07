import { useEffect } from "react";
import { startResourceTelemetry } from "@/lib/resources/resource-telemetry";
import { useTabsStore } from "@/stores/tabs";

/** Read workload context at sample time, not subscribed, so the sampler stays store-free and this bridge does not re-render on every tab change. */
export function ResourceTelemetryBridge(): null {
  useEffect(
    () =>
      startResourceTelemetry(() => ({
        openTabs: useTabsStore.getState().stripOrder.length,
      })),
    [],
  );
  return null;
}
