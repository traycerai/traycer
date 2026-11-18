import { app } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import {
  isTrackpadScrollKind,
  type TrackpadScrollEvent,
} from "../../ipc-contracts/trackpad-scroll-phase-types";
import { log } from "./logger";

interface AddonScrollEvent {
  readonly kind: unknown;
  readonly scrollingDeltaX: unknown;
  readonly scrollingDeltaY: unknown;
  readonly timestamp: unknown;
  readonly precise: unknown;
  readonly modified: unknown;
}

interface TrackpadScrollAddon {
  start(listener: (event: AddonScrollEvent) => void): void;
  stop(): void;
}

const addonRequire = createRequire(__filename);

/**
 * Forwards the macOS trackpad scroll stream to `emit`. Returns the teardown.
 * Off macOS or when the addon cannot load, no scroll events are forwarded.
 */
export function installTrackpadScrollPhaseMonitor(
  emit: (event: TrackpadScrollEvent) => void,
): () => void {
  if (process.platform !== "darwin") return () => {};
  let addon: TrackpadScrollAddon;
  try {
    // The native binary sits beside the main bundle, unpacked from the asar
    // because a `.node` file cannot be dlopen'ed out of an archive.
    addon = addonRequire(
      path
        .join(__dirname, "native", "trackpad_scroll_phase.node")
        .replace("app.asar", "app.asar.unpacked"),
    ) as TrackpadScrollAddon;
  } catch (error) {
    log.warn("[trackpad-scroll-phase] addon unavailable; swipe gesture off", {
      packaged: app.isPackaged,
      error: error instanceof Error ? error.message : String(error),
    });
    return () => {};
  }
  addon.start((event) => {
    if (!isTrackpadScrollKind(event.kind)) return;
    // Pixel deltas are the input contract; a wheel that reports lines would
    // read as a huge pull.
    if (event.precise !== true) return;
    if (
      typeof event.scrollingDeltaX !== "number" ||
      typeof event.scrollingDeltaY !== "number" ||
      typeof event.timestamp !== "number"
    )
      return;
    emit({
      kind: event.kind,
      scrollingDeltaX: event.scrollingDeltaX,
      scrollingDeltaY: event.scrollingDeltaY,
      timestamp: event.timestamp,
      modified: event.modified === true,
    });
  });
  log.info("[trackpad-scroll-phase] monitor started");
  return () => addon.stop();
}
