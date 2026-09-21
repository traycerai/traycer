import { app } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import {
  isTrackpadScrollPhaseKind,
  type TrackpadScrollPhaseTransition,
} from "../../ipc-contracts/trackpad-scroll-phase-types";
import { log } from "./logger";

interface TrackpadScrollPhaseAddon {
  start(listener: (event: { readonly kind: unknown }) => void): void;
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
 * Forwards macOS trackpad finger-sequence transitions to `emit`. Returns the
 * teardown. A no-op off macOS or when the addon is missing: the gesture that
 * depends on it simply stays unavailable, which the renderer reads from the
 * preload surface, not from here.
 */
export function installTrackpadScrollPhaseMonitor(
  emit: (transition: TrackpadScrollPhaseTransition) => void,
): () => void {
  if (process.platform !== "darwin") return () => {};
  let addon: TrackpadScrollPhaseAddon;
  try {
    addon = addonRequire(addonPath()) as TrackpadScrollPhaseAddon;
  } catch (error) {
    log.warn("[trackpad-scroll-phase] addon unavailable; swipe gesture off", {
      packaged: app.isPackaged,
      error: error instanceof Error ? error.message : String(error),
    });
    return () => {};
  }
  addon.start((event) => {
    if (!isTrackpadScrollPhaseKind(event.kind)) return;
    emit({ kind: event.kind });
  });
  log.info("[trackpad-scroll-phase] monitor started");
  return () => addon.stop();
}
