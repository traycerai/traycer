import { RunnerHostEvent } from "../ipc-contracts/ipc-channels";
import type { TrackpadScrollEvent } from "../ipc-contracts/trackpad-scroll-phase-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface TrackpadScrollPhaseBridge {
  onEvent(handler: Listener<TrackpadScrollEvent>): Disposable;
}

export interface TrackpadScrollPhaseBridgeSurface {
  /** `null` off macOS: the renderer reads absence as "no lift signal here". */
  trackpadScrollPhase: TrackpadScrollPhaseBridge | null;
}

export function buildTrackpadScrollPhaseBridge(
  platform: NodeJS.Platform,
): TrackpadScrollPhaseBridgeSurface {
  if (platform !== "darwin") return { trackpadScrollPhase: null };
  return {
    trackpadScrollPhase: {
      onEvent: (handler) =>
        subscribe<TrackpadScrollEvent>(
          RunnerHostEvent.trackpadScrollPhase,
          handler,
        ),
    },
  };
}
