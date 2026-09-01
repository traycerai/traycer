import { useEffect, useRef, useState, type ReactElement } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ScreencastPixels } from "@/components/epic-canvas/renderers/screencast-surface";
import type { PipPreview } from "@/lib/browser-view/pip/pip-frame-capture";
import { startPlayback } from "@/lib/browser-view/sessions/video-plane-session";

/**
 * The pixels of the PiP mirror: the JPEG frame its own subscription delivers,
 * with the tile's shared video track painted over it when one exists.
 *
 * PiP never attaches to the video broker, so its own JPEG cast runs for the
 * whole life of the mirror - there is a live frame under the borrowed track,
 * not a stale one, which is why this one keeps the layering the tile dropped.
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
    // A source attached after mount still needs the kick: a paused element can
    // still flip `decoded` on `loadeddata` and hide the live JPEG behind it.
    startPlayback(element);
    return () => {
      element.srcObject = null;
      setDecoded(false);
    };
  }, [stream]);

  return (
    <ScreencastPixels
      imageSrc={preview.src}
      imageAlt="Browser preview"
      imageRef={null}
      imageClassName="outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
      onImageLoad={null}
      videoRef={videoRef}
      videoMounted={stream !== null}
      videoActive={stream !== null && decoded}
      videoTestId="agent-browser-pip-video"
      onVideoLoadedData={() => setDecoded(true)}
      loader={
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <AgentSpinningDots
            className={undefined}
            testId="agent-browser-pip-loading"
            variant={undefined}
          />
        </span>
      }
      cursor={preview.cursor}
      frameSize={preview.frameSize}
    />
  );
}
