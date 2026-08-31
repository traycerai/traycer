import type { ReactElement, ReactNode, RefObject } from "react";
import type { ScreencastSession } from "@/lib/browser-view/sessions/use-screencast-session";
import type {
  AgentCursorPosition,
  ScreencastFrameSize,
} from "@/lib/browser-view/sessions/screencast-input-encoding";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { cn } from "@/lib/utils";
import { AgentCursorOverlay } from "./agent-cursor-overlay";
import { BrowserVideoStatsOverlay } from "./browser-video-stats-overlay";

/**
 * The pixels of a browser mirror: a JPEG frame, an optional video track over
 * it, the agent's ghost cursor, and a loader for the gaps.
 *
 * Shared by the tile ({@link ScreencastSurface}) and by PiP
 * (`pip-preview-surface.tsx`). The two differ only in what feeds them - the
 * tile hands over its `ScreencastSession`, PiP its own subscription plus the
 * tile's borrowed track - and in which of them keeps a live JPEG under the
 * video (the tile's host stops its cast for the whole video attempt, PiP's
 * never stops). Both are `object-contain` in one box, which is what lets one
 * cursor mapping serve either plane.
 */
export function ScreencastPixels(props: {
  readonly imageSrc: string | null;
  readonly imageAlt: string;
  readonly imageRef: RefObject<HTMLImageElement | null> | null;
  readonly imageClassName: string | null;
  readonly onImageLoad: (() => void) | null;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly videoMounted: boolean;
  readonly videoActive: boolean;
  readonly videoTestId: string;
  readonly onVideoLoadedData: (() => void) | null;
  readonly loader: ReactNode;
  readonly cursor: AgentCursorPosition | null;
  readonly frameSize: ScreencastFrameSize | null;
}): ReactElement {
  // Destructured to locals before they reach a `ref` prop: `react-hooks/refs`
  // rejects a member expression there.
  const { imageRef, videoRef } = props;
  const painting = props.videoActive || props.imageSrc !== null;
  return (
    <>
      {painting ? null : props.loader}
      {props.imageSrc === null ? null : (
        <img
          ref={imageRef}
          src={props.imageSrc}
          alt={props.imageAlt}
          hidden={props.videoActive}
          className={cn("h-full w-full object-contain", props.imageClassName)}
          draggable={false}
          onLoad={props.onImageLoad ?? undefined}
        />
      )}
      {props.videoMounted ? (
        <video
          ref={videoRef}
          data-testid={props.videoTestId}
          autoPlay
          playsInline
          muted
          className={cn(
            "absolute inset-0 h-full w-full object-contain",
            props.videoActive ? null : "opacity-0",
          )}
          onLoadedData={props.onVideoLoadedData ?? undefined}
        />
      ) : null}
      <AgentCursorOverlay cursor={props.cursor} frameSize={props.frameSize} />
    </>
  );
}

/**
 * The tile's half. ONE plane paints at a time, and the loader covers every gap
 * between two (ticket 26):
 *
 * ```
 *   loader ──video live──▶ VIDEO ──track death──▶ loader ──JPEG frames──▶ JPEG
 *   loader ──deadline/no-capability──▶ JPEG
 *   JPEG ──renegotiation──▶ loader ──▶ VIDEO
 * ```
 *
 * The `<img>` and the `<video>` share one overlay button and the same
 * `object-contain` geometry, so the overlay handlers, the arm ring and the
 * hit-test normalization are shared rather than duplicated per plane. The
 * `<video>` still mounts before it can paint - an element has to be in the tree
 * to decode - but it mounts over the LOADER: the host has stopped the JPEG cast
 * for the whole attempt, so there is no frame left underneath it.
 */
export function ScreencastSurface(props: {
  readonly session: ScreencastSession;
}) {
  const { session } = props;
  const { image, video } = session;
  const { imageRef, videoRef } = session.refs;
  const verb = useCoarsePointer() ? "Tap" : "Click";
  return (
    <>
      <ScreencastPixels
        imageSrc={image?.src ?? null}
        imageAlt="Browser screencast"
        imageRef={imageRef}
        imageClassName={null}
        onImageLoad={
          image === null ? null : () => session.notePresented(image.sequence)
        }
        videoRef={videoRef}
        videoMounted={video.media !== null}
        videoActive={video.active}
        videoTestId="browser-screencast-video"
        onVideoLoadedData={null}
        loader={
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
            <div>
              <div className="flex items-center justify-center gap-2 text-ui-base font-medium">
                <AgentSpinningDots
                  className="text-muted-foreground"
                  testId="screencast-connecting"
                  variant={undefined}
                />
                Connecting
              </div>
              <div className="mt-1 max-w-[min(90vw,32rem)] text-ui-sm text-muted-foreground">
                {verb} the screencast to control this browser tab.
              </div>
            </div>
          </div>
        }
        cursor={session.agentCursor}
        frameSize={session.frameSize}
      />
      {import.meta.env.DEV ? (
        <BrowserVideoStatsOverlay session={session} />
      ) : null}
    </>
  );
}
