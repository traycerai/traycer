import { useEffect, useRef, useState, type ReactElement } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AgentCursorOverlay } from "@/components/epic-canvas/renderers/agent-cursor-overlay";
import type { PipPreview } from "@/lib/browser-view/pip/pip-frame-capture";
import { cn } from "@/lib/utils";

/**
 * The pixels of the PiP mirror: the JPEG frame its own subscription delivers,
 * with the tile's shared video track painted over it when one exists.
 *
 * Both surfaces are `object-contain` in one box, as on the tile, but the
 * layering the tile deleted in ticket 26 is RIGHT here: a PiP subscriber never
 * attaches to the video broker, so its own JPEG cast keeps running for the
 * whole life of the mirror - there is a live frame under the borrowed track,
 * not a stale one. Deliberately NOT `ScreencastSurface`:
 *
 * - `ScreencastSurface` takes a `ScreencastSession`, and PiP has none. It does
 *   not use `useScreencastSession` at all - that hook is the tile's input,
 *   arming, viewport and negotiation machinery, and PiP is a passive mirror
 *   with a second transport (the Electron-native `startPipCapture` bridge)
 *   that hook cannot drive. So the wave-4 `captureDormantSnapshot` obligation
 *   does not arise here: PiP has no `browserPeekFrameKey` to write a dormant
 *   snapshot into, and nothing to hand a no-op to.
 * - Not adopting it also keeps the dev-only video stats overlay out of PiP,
 *   which is right: those stats describe the tile's negotiation round, and PiP
 *   never owns one.
 *
 * The agent cursor IS mounted, because co-drive legibility matters most in the
 * surface you keep while working elsewhere. It rides PiP's own subscription
 * (`agentCursor` frames), so it works over either plane - the overlay maps
 * normalized coordinates through the same contain-fit box.
 *
 * Downscaling is CSS only: the shared track carries the TILE's geometry, and
 * `object-contain` in the PiP box is the whole of "PiP downscales" (spec
 * decision 13).
 */
export function PipPreviewSurface(props: {
  readonly preview: PipPreview;
  readonly stream: MediaStream | null;
}): ReactElement {
  const { preview, stream } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [decoded, setDecoded] = useState(false);

  useEffect(() => {
    const element = videoRef.current;
    if (element === null || stream === null) {
      setDecoded(false);
      return;
    }
    element.srcObject = stream;
    return () => {
      element.srcObject = null;
      setDecoded(false);
    };
  }, [stream]);

  const videoActive = stream !== null && decoded;
  return (
    <>
      {preview.src === null && !videoActive ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <AgentSpinningDots
            className={undefined}
            testId="agent-browser-pip-loading"
            variant={undefined}
          />
        </span>
      ) : null}
      {preview.src === null ? null : (
        <img
          src={preview.src}
          alt="Browser preview"
          hidden={videoActive}
          className="h-full w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          draggable={false}
        />
      )}
      {stream === null ? null : (
        <video
          ref={videoRef}
          data-testid="agent-browser-pip-video"
          autoPlay
          playsInline
          muted
          className={cn(
            "absolute inset-0 h-full w-full object-contain",
            videoActive ? null : "opacity-0",
          )}
          onLoadedData={() => setDecoded(true)}
        />
      )}
      <AgentCursorOverlay
        cursor={preview.cursor}
        frameSize={preview.frameSize}
      />
    </>
  );
}
