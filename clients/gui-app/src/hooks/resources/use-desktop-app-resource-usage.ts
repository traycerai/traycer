import { useSyncExternalStore } from "react";
import {
  desktopAppResourceUsageFromMetrics,
  getDesktopDiagnosticsBridge,
  type DesktopAppResourceUsage,
} from "@/lib/resources/desktop-app-resource-usage";

/**
 * This desktop shell's own process usage, sampled from the Electron
 * diagnostics bridge.
 *
 * ONE module-level sampler behind `useSyncExternalStore`, not a timer per
 * component: the poll is a real IPC round trip, so every surface that shows the
 * number has to share a cadence and a snapshot or they would disagree while
 * both were on screen. The interval starts with the first subscriber and stops
 * with the last, so nothing is sampled while nothing is displaying it.
 *
 * Outside Electron the bridge is absent and the reading is `null` — the shell
 * row simply does not exist in a browser.
 */
const DESKTOP_RESOURCE_SAMPLE_INTERVAL_MS = 1000;
const desktopAppResourceListeners = new Set<() => void>();
let desktopAppResourceSnapshot: DesktopAppResourceUsage | null = null;
let desktopAppResourceTimer: number | null = null;
let desktopAppResourceInFlight = false;

export function useDesktopAppResourceUsage(): DesktopAppResourceUsage | null {
  return useSyncExternalStore(
    subscribeDesktopAppResourceUsage,
    getDesktopAppResourceSnapshot,
    getDesktopAppResourceSnapshot,
  );
}

function subscribeDesktopAppResourceUsage(listener: () => void): () => void {
  desktopAppResourceListeners.add(listener);
  if (desktopAppResourceListeners.size === 1) {
    sampleDesktopAppResourceUsage();
    desktopAppResourceTimer = window.setInterval(
      sampleDesktopAppResourceUsage,
      DESKTOP_RESOURCE_SAMPLE_INTERVAL_MS,
    );
  }
  return () => {
    desktopAppResourceListeners.delete(listener);
    if (
      desktopAppResourceListeners.size === 0 &&
      desktopAppResourceTimer !== null
    ) {
      window.clearInterval(desktopAppResourceTimer);
      desktopAppResourceTimer = null;
    }
  };
}

function getDesktopAppResourceSnapshot(): DesktopAppResourceUsage | null {
  return desktopAppResourceSnapshot;
}

function sampleDesktopAppResourceUsage(): void {
  const bridge = getDesktopDiagnosticsBridge();
  if (bridge === null) {
    setDesktopAppResourceSnapshot(null);
    return;
  }
  if (desktopAppResourceInFlight) return;
  desktopAppResourceInFlight = true;
  void bridge
    .getMetrics()
    .then(
      (snapshot) => {
        setDesktopAppResourceSnapshot(
          desktopAppResourceUsageFromMetrics(snapshot, Date.now()),
        );
      },
      () => {
        setDesktopAppResourceSnapshot(null);
      },
    )
    .finally(() => {
      desktopAppResourceInFlight = false;
    });
}

function setDesktopAppResourceSnapshot(
  next: DesktopAppResourceUsage | null,
): void {
  desktopAppResourceSnapshot = next;
  for (const listener of Array.from(desktopAppResourceListeners)) {
    listener();
  }
}
