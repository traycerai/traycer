import { RunnerHostEvent } from "../ipc-contracts/ipc-channels";
import type { TrackpadScrollPhaseTransition } from "../ipc-contracts/trackpad-scroll-phase-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface TrackpadScrollPhaseBridge {
  onTransition(handler: Listener<TrackpadScrollPhaseTransition>): Disposable;
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
      onTransition: (handler) =>
        subscribe<TrackpadScrollPhaseTransition>(
          RunnerHostEvent.trackpadScrollPhase,
          handler,
        ),
    },
  };
}
