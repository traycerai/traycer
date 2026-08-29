import type { ScreencastSession } from "@/lib/browser-view/sessions/use-screencast-session";
import { cn } from "@/lib/utils";
import { BrowserVideoStatsOverlay } from "./browser-video-stats-overlay";

/**
 * The pixels of a screencast tile, for both viewers (pointer and touch).
 *
 * Two surfaces, one box: the JPEG `<img>` and the video plane's `<video>` sit
 * in the same overlay button with the same `object-contain` geometry, so the
 * overlay handlers, the arm ring and the hit-test normalization are shared
 * rather than duplicated per plane.
 *
 * The `<video>` mounts as soon as the track arrives but stays transparent
 * until it has decoded a frame - it has to be rendered to decode, and the JPEG
 * underneath must keep painting until then (no black-tile window). The `<img>`
 * is only hidden, never unmounted, so a fallback to JPEG repaints the moment
 * the pump's next frame lands - the host's `started` frame is latched and will
 * not fire again (G4).
 */
export function ScreencastSurface(props: {
  readonly session: ScreencastSession;
  readonly emptyHint: string;
}) {
  const { session } = props;
  const { image, video } = session;
  const { imageRef, videoRef } = session.refs;
  return (
    <>
      {image === null && !video.active ? (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
          <div>
            <div className="text-ui-base font-medium">Waiting for frames</div>
            <div className="mt-1 max-w-[min(90vw,32rem)] text-ui-sm text-muted-foreground">
              {props.emptyHint}
            </div>
          </div>
        </div>
      ) : null}
      {image === null ? null : (
        <img
          ref={imageRef}
          src={image.src}
          alt="Browser screencast"
          hidden={video.active}
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
