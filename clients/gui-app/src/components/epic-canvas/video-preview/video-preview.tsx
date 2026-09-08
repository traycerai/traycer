/**
 * The `video` family's viewer (D27): one `<video>` element and the three
 * behaviours a file surface owes it.
 *
 * ## It is a viewer, not a player
 *
 * Native `controls`, nothing custom. No scrubber, no speed menu, no
 * keyboard-shortcut layer, no chapter track - a recording tile is a place to
 * check what was captured, and the walkthrough generator that would need a
 * real timeline is explicitly out of this epic.
 *
 * ## `preload="metadata"`, never `auto`
 *
 * A recording runs to 512 MiB (`EPIC_FILE_MAX_BYTES`) and the Files panel can
 * open several tiles at once. `metadata` fetches the header - enough for the
 * duration and a seekable range - and leaves the rest to the range requests
 * the element makes when someone presses play. The poster is what fills the
 * frame until then, which is why D14 mints one per recording rather than
 * letting the element paint a first frame it would have to download for.
 *
 * ## `src` is handed over, never fetched
 *
 * The byte half returns `delivery: "url"` for a sniffed video (D10) precisely
 * so the element owns its own `Range` requests, its seeking and its cache. A
 * caller must not `fetch()` those bytes into a Blob to hand back a `blob:`
 * url: that downloads the whole clip to play the first second of it and
 * defeats seeking on the way. A `blob:` src is still legitimate here - it is
 * what the chat-attachment and workspace legs deliver - so this component
 * takes whatever `useFileBytes` settled on and asks no questions.
 */
import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type SyntheticEvent,
} from "react";

/**
 * The element that is playing, app-wide.
 *
 * Module-global on purpose: "one at a time" is a fact about the APP, not about
 * a tile or a canvas tab, and two recordings talking over each other is the
 * complaint whichever surfaces they were opened from. A React context would
 * scope the rule to a subtree and re-create it per provider, which is the one
 * shape that cannot express the rule.
 */
let playingVideo: HTMLVideoElement | null = null;

export interface VideoPreviewProps {
  /** A url the element fetches itself (loopback / signed) or a `blob:` one. */
  readonly src: string;
  /** The sibling poster object of D14, or `null` when the file has none. */
  readonly posterSrc: string | null;
  /** Accessible name - a `<video>` has no other text. */
  readonly fileName: string;
  /**
   * The element could not load or decode `src`. The caller renders its own
   * fallback, exactly as `ImagePreview.onDecodeError` and
   * `PdfPreviewLazy.onRenderFailure` do - a codec the runtime lacks and a
   * `media-src` the CSP refuses both arrive here, and neither is something
   * this component can say anything useful about.
   */
  readonly onError: () => void;
}

export function VideoPreview(props: VideoPreviewProps): ReactNode {
  const elementRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    // Unmounting while playing never fires `pause`, so without this the
    // module-global would hold a detached element for the rest of the session
    // and the next `play` would call `pause()` on a node in no document.
    //
    // The element is captured HERE and not read in the cleanup: React detaches
    // a ref earlier in the commit than it runs passive cleanups, so by then
    // `elementRef.current` is already `null` and the comparison can only ever
    // be false - which is exactly the leak this effect exists to close. Its
    // own test caught that.
    const element = elementRef.current;
    return () => {
      if (playingVideo === element) playingVideo = null;
    };
  }, []);

  const onPlay = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>): void => {
      const element = event.currentTarget;
      if (playingVideo !== null && playingVideo !== element) {
        playingVideo.pause();
      }
      playingVideo = element;
    },
    [],
  );

  const onStopped = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>): void => {
      if (playingVideo === event.currentTarget) playingVideo = null;
    },
    [],
  );

  const { onError } = props;
  const onLoadError = useCallback((): void => {
    onError();
  }, [onError]);

  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center p-2">
      <video
        ref={elementRef}
        src={props.src}
        poster={props.posterSrc ?? undefined}
        controls
        preload="metadata"
        // iOS otherwise takes any `play()` full-screen, which on a canvas tile
        // reads as the tab having navigated somewhere.
        playsInline
        aria-label={props.fileName}
        data-testid="video-preview"
        className="h-full max-h-full w-full max-w-full object-contain"
        onPlay={onPlay}
        onPause={onStopped}
        onEnded={onStopped}
        onError={onLoadError}
      >
        {/* A recording carries no audio track at all (D14), so there is
            nothing to caption. The empty track is what states that to
            `jsx-a11y/media-has-caption` - the alternative the rule accepts is
            `muted`, which would silence the legs that DO carry audio (a chat
            attachment, a workspace file). */}
        <track kind="captions" />
      </video>
    </div>
  );
}
