import { screen, type Display } from "electron";
import { log } from "./logger";

export interface DisplaySnapshot {
  readonly id: number;
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly workArea: { x: number; y: number; width: number; height: number };
  readonly scaleFactor: number;
  readonly rotation: number;
  readonly internal: boolean;
  readonly label: string;
  readonly primary: boolean;
}

export interface DisplayTopology {
  readonly displays: ReadonlyArray<DisplaySnapshot>;
  readonly primaryId: number;
}

function snapshotDisplay(display: Display, primaryId: number): DisplaySnapshot {
  return {
    id: display.id,
    bounds: { ...display.bounds },
    workArea: { ...display.workArea },
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal,
    label: display.label,
    primary: display.id === primaryId,
  };
}

export function readDisplayTopology(): DisplayTopology {
  const primary = screen.getPrimaryDisplay();
  return {
    displays: screen
      .getAllDisplays()
      .map((d) => snapshotDisplay(d, primary.id)),
    primaryId: primary.id,
  };
}

export type DisplayChangeReason =
  "display-added" | "display-removed" | "display-metrics-changed";

/**
 * Subscribes to OS display add/remove/metrics events and pushes a fresh
 * topology snapshot to the renderer. Useful for window-state persistence
 * (a window restored onto a now-disconnected display needs to be moved)
 * and any layout code that branches on display count or scale factor.
 *
 * `metrics-changed` covers resolution changes, DPI shifts, rotation, and
 * primary-display swaps - basically any state the renderer would need to
 * re-read.
 */
export function installScreenMonitor(
  emit: (reason: DisplayChangeReason, topology: DisplayTopology) => void,
): void {
  let lastFingerprint = "";
  const fingerprintTopology = (topology: DisplayTopology): string =>
    `${topology.primaryId}|${topology.displays
      .map(
        (d) =>
          `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}r${d.rotation}`,
      )
      .join(";")}`;
  const emitIfChanged = (reason: DisplayChangeReason): void => {
    const topology = readDisplayTopology();
    const fingerprint = fingerprintTopology(topology);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    log.info(`[screen] ${reason}`, { count: topology.displays.length });
    emit(reason, topology);
  };
  screen.on("display-added", () => emitIfChanged("display-added"));
  screen.on("display-removed", () => emitIfChanged("display-removed"));
  screen.on("display-metrics-changed", () =>
    emitIfChanged("display-metrics-changed"),
  );
}
