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
  readonly fingerDeltaX: unknown;
  readonly fingerDeltaY: unknown;
  readonly timestamp: unknown;
  readonly precise: unknown;
  readonly modified: unknown;
}

interface TrackpadScrollAddon {
  start(listener: (event: AddonScrollEvent) => void): void;
  stop(): void;
}

// `build:native` drops the universal binary beside the main bundle. Inside a
// packaged app that directory is asar-unpacked (`asarUnpack` in package.json)
// because a `.node` file cannot be dlopen'ed out of an archive.
function addonPath(): string {
  return path
    .join(__dirname, "native", "trackpad_scroll_phase.node")
    .replace("app.asar", "app.asar.unpacked");
}

const addonRequire = createRequire(__filename);

/**
 * Forwards the macOS trackpad scroll stream to `emit`. Returns the teardown.
 * A no-op off macOS or when the addon is missing: the gesture that depends on
 * it simply stays unavailable, which the renderer reads from the preload
 * surface, not from here.
 */
export function installTrackpadScrollPhaseMonitor(
  emit: (event: TrackpadScrollEvent) => void,
): () => void {
  if (process.platform !== "darwin") return () => {};
  let addon: TrackpadScrollAddon;
  try {
    addon = addonRequire(addonPath()) as TrackpadScrollAddon;
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
      typeof event.fingerDeltaX !== "number" ||
      typeof event.fingerDeltaY !== "number" ||
      typeof event.timestamp !== "number"
    )
      return;
    emit({
      kind: event.kind,
      fingerDeltaX: event.fingerDeltaX,
      fingerDeltaY: event.fingerDeltaY,
      timestamp: event.timestamp,
      modified: event.modified === true,
    });
  });
  log.info("[trackpad-scroll-phase] monitor started");
  return () => addon.stop();
}
