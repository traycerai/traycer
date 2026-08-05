import { useEffect } from "react";
import { startResourceTelemetry } from "@/lib/resources/resource-telemetry";
import { useTabsStore } from "@/stores/tabs";

/**
 * Starts the periodic resource sampler for the lifetime of the app shell.
 *
 * The workload context is read here rather than inside the sampler so
 * `lib/resources/resource-telemetry.ts` stays store-free and directly
 * testable. It is read at sample time (not subscribed) - a sample is a
 * point-in-time reading, and subscribing would re-render this bridge on every
 * tab change for no benefit.
 */
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
