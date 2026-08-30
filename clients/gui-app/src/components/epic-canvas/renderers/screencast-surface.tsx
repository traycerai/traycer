import type { ScreencastSession } from "@/lib/browser-view/sessions/use-screencast-session";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import { BrowserVideoStatsOverlay } from "./browser-video-stats-overlay";

/**
 * The pixels of a screencast tile, for both viewers (pointer and touch).
 *
 * ONE plane paints at a time, and the loader covers every gap between two
 * (ticket 26):
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
 * `<video>` still mounts before it can paint - an element has to be in the
 * tree to decode - but it mounts over the LOADER: the host has stopped the
 * JPEG cast for the whole attempt, so there is no frame left to keep alive
 * underneath it and nothing to swap out from under the viewer.
 */
export function ScreencastSurface(props: {
  readonly session: ScreencastSession;
  readonly emptyHint: string;
}) {
  const { session } = props;
  const { image, video } = session;
  const { imageRef, videoRef } = session.refs;
  const painting = video.active || image !== null;
  return (
    <>
      {painting ? null : (
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
              {props.emptyHint}
            </div>
          </div>
        </div>
      )}
      {image === null ? null : (
        <img
          ref={imageRef}
          src={image.src}
          alt="Browser screencast"
          className="h-full w-full object-contain"
          draggable={false}
          onLoad={() => session.notePresented(image.sequence)}
        />
      )}
      {video.media === null ? null : (
        <video
          ref={videoRef}
          data-testid="browser-screencast-video"
          autoPlay
          playsInline
          muted
          className={cn(
            "absolute inset-0 h-full w-full object-contain",
            video.active ? null : "opacity-0",
          )}
        />
      )}
      {import.meta.env.DEV ? (
        <BrowserVideoStatsOverlay session={session} />
      ) : null}
    </>
  );
}
