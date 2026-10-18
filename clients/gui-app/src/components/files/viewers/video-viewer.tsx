import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { BlobViewerShell } from "@/components/files/viewers/blob-viewer-shell";
import { ViewerToolbar } from "@/components/files/viewers/viewer-toolbar";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useBlobObjectUrl } from "@/hooks/files/use-blob-object-url";
import {
  useEpicFileSignedUrl,
  type SignedUrlAnswer,
} from "@/hooks/files/use-epic-file-blob-query";
import { epicFileName } from "@/hooks/files/use-epic-file-mutations";
import { useEpicFileRecord } from "@/hooks/files/use-epic-file-record";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import { byteSourceCapBytes } from "@/lib/files/byte-source";
import { formatVideoCaption } from "@/lib/files/video-caption";
import { isMobileApp } from "@/lib/mobile-app";

export interface VideoViewerProps {
  readonly hostId: string;
  readonly address: EpicFileAddress;
  /** The tile's actions, drawn at the end of the video toolbar. */
  readonly actions: ReactNode;
}

/** A media element at or past this has metadata and a real `currentTime`. */
const HAVE_METADATA = 1;

/** Where the element's bytes come from, in the order a failure falls through. */
type VideoSource = "url" | "blob" | "download-only";

/** Position and play state, kept above the element so a new source resumes. */
interface Playback {
  time: number;
  playing: boolean;
}

/**
 * A video epic file, as ONE recovery state machine per file (the tile keys the
 * viewer by sha): signed URL → one refresh → bounded Blob → download only.
 *
 * - A published file streams from its signed https URL, which seeks and never
 *   touches the relay. Renewal at 80 % swaps the `src` of the same element.
 * - A media error refreshes the URL once per recovery attempt - the media 403
 *   (§2.4) - and reloads the element even when the host answers the same URL.
 *   A second error before the element loads again falls through to the Blob.
 * - An unpublished file goes straight to the Blob: spans into memory up to the
 *   platform cap. A Blob the element cannot play leaves Download only. The
 *   URL stays watched meanwhile, and the stream takes over once it publishes.
 *
 * A background renewal that fails, or answers `unavailable`, never unmounts an
 * element that is playing: the last good URL stays. Position and play state
 * live here, above every element, so each new source picks up where the last
 * one stopped.
 */
export function VideoViewer(props: VideoViewerProps): ReactNode {
  const { hostId, address, actions } = props;
  const name = epicFileName(address.path);
  const record = useEpicFileRecord(address.path);
  const byteLength =
    record !== null && record.entry.sha256 === address.sha256
      ? record.entry.byteLength
      : null;
  const playbackRef = useRef<Playback>({ time: 0, playing: false });
  const {
    source,
    activeUrl,
    reloads,
    handleUrlError,
    endRecovery,
    retry,
    fail,
  } = useVideoSource(hostId, address, playbackRef);

  if (source === "download-only") {
    return (
      <div className="flex size-full min-h-0 flex-col">
        <ViewerToolbar caption={name} actions={actions} />
        <div
          role="status"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-ui-sm text-muted-foreground"
        >
          <AlertTriangle className="size-5" aria-hidden />
          <p>This video can&apos;t be played here. Download it to watch it.</p>
          <Button variant="outline" size="sm" onClick={retry}>
            <RotateCw aria-hidden />
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (source === "blob") {
    return (
      <BlobViewerShell
        hostId={hostId}
        address={address}
        noun="video"
        tooLargeDetail="It plays here once the upload lands."
        maxBytes={byteSourceCapBytes("video", isMobileApp())}
        caption={name}
        actions={actions}
      >
        {(blob) => (
          <BlobVideo
            blob={blob}
            byteLength={byteLength ?? blob.size}
            playbackRef={playbackRef}
            actions={actions}
            onError={fail}
          />
        )}
      </BlobViewerShell>
    );
  }
  if (activeUrl === null) {
    return (
      <div className="flex size-full min-h-0 flex-col">
        <ViewerToolbar caption={name} actions={actions} />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <AgentSpinningDots
            className={undefined}
            testId="epic-file-loading"
            variant={undefined}
          />
        </div>
      </div>
    );
  }
  return (
    <VideoElement
      key={reloads}
      src={activeUrl}
      byteLength={byteLength}
      playbackRef={playbackRef}
      actions={actions}
      onError={handleUrlError}
      // Playing again ends the recovery attempt; a later failure gets its own.
      onLoaded={endRecovery}
    />
  );
}

interface VideoSourceMachine {
  readonly source: VideoSource;
  /** The last good signed URL; a failed renewal never clears it. */
  readonly activeUrl: string | null;
  /** Bumped to remount the element when a refresh answers the same URL. */
  readonly reloads: number;
  readonly handleUrlError: () => void;
  /** The element played again: a later failure gets its own refresh. */
  readonly endRecovery: () => void;
  readonly retry: () => void;
  /** The Blob would not play either. */
  readonly fail: () => void;
}

/**
 * The URL query's latest word: the URL it holds, or whether it has settled on
 * there being none (`unavailable`, or an error with no answer ever).
 */
function readUrlAnswer(url: UseQueryResult<SignedUrlAnswer, HostRpcError>): {
  readonly latestUrl: string | null;
  readonly noUrl: boolean;
} {
  const answer = url.data?.result ?? null;
  if (answer !== null && answer.kind === "url") {
    return { latestUrl: answer.url, noUrl: false };
  }
  return {
    latestUrl: null,
    noUrl: answer !== null || (url.isError && url.data === undefined),
  };
}

function useVideoSource(
  hostId: string,
  address: EpicFileAddress,
  playbackRef: RefObject<Playback>,
): VideoSourceMachine {
  const [source, setSource] = useState<VideoSource>("url");
  const [refreshUsed, setRefreshUsed] = useState(false);
  const [refreshAskedAt, setRefreshAskedAt] = useState<number | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // Set when the fallback was "no URL yet": the URL is then still watched, and
  // the stream takes over once the file is published.
  const [awaitingUrl, setAwaitingUrl] = useState(false);
  const url = useEpicFileSignedUrl(
    hostId,
    address,
    source === "url" || awaitingUrl,
  );

  const { latestUrl, noUrl } = readUrlAnswer(url);
  if (latestUrl !== null && latestUrl !== activeUrl) setActiveUrl(latestUrl);
  // Never published (or no URL ever arrived): the Blob is the only way in.
  if (source === "url" && activeUrl === null && noUrl) {
    setSource("blob");
    setAwaitingUrl(true);
  }
  // Published since: back to the stream, which resumes where playback stopped.
  // A Blob that is playing right now is left alone until a later renewal.
  useEffect(() => {
    if (!awaitingUrl || source === "url" || latestUrl === null) return;
    if (playbackRef.current.playing) return;
    setAwaitingUrl(false);
    setSource("url");
  }, [awaitingUrl, source, latestUrl, playbackRef]);
  // The refresh a media error asked for has answered.
  if (refreshAskedAt !== null && url.dataUpdatedAt > refreshAskedAt) {
    setRefreshAskedAt(null);
    if (latestUrl === null) setSource("blob");
    // The same URL again: only a reload makes the element try it again.
    else if (latestUrl === activeUrl) setReloads(reloads + 1);
  } else if (refreshAskedAt !== null && url.errorUpdatedAt > refreshAskedAt) {
    setRefreshAskedAt(null);
    setSource("blob");
  }

  return {
    source,
    activeUrl,
    reloads,
    handleUrlError: () => {
      if (refreshUsed) {
        setSource("blob");
        return;
      }
      setRefreshUsed(true);
      setRefreshAskedAt(Date.now());
      void url.refetch();
    },
    endRecovery: () => setRefreshUsed(false),
    retry: () => {
      setRefreshUsed(false);
      setRefreshAskedAt(null);
      setActiveUrl(null);
      setAwaitingUrl(false);
      setSource("url");
    },
    fail: () => setSource("download-only"),
  };
}

function BlobVideo(props: {
  readonly blob: Blob;
  readonly byteLength: number;
  readonly playbackRef: RefObject<Playback>;
  readonly actions: ReactNode;
  readonly onError: () => void;
}): ReactNode {
  const url = useBlobObjectUrl(props.blob);
  if (url === null) return null;
  return (
    <VideoElement
      src={url}
      byteLength={props.byteLength}
      playbackRef={props.playbackRef}
      actions={props.actions}
      onError={props.onError}
      onLoaded={null}
    />
  );
}

/**
 * The element under its toolbar. It reports position and play state up as they
 * happen and puts them back whenever a source reports its metadata, so a new
 * `src` (renewal) or a new element (reload, Blob) resumes where playback was.
 */
function VideoElement(props: {
  readonly src: string;
  readonly byteLength: number | null;
  readonly playbackRef: RefObject<Playback>;
  readonly actions: ReactNode;
  readonly onError: () => void;
  readonly onLoaded: (() => void) | null;
}): ReactNode {
  const { playbackRef } = props;
  const [facts, setFacts] = useState<{
    readonly durationSeconds: number;
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const caption = formatVideoCaption({
    durationSeconds: facts?.durationSeconds ?? null,
    width: facts?.width ?? null,
    height: facts?.height ?? null,
    byteLength: props.byteLength,
  });
  return (
    <div className="flex size-full min-h-0 flex-col">
      <ViewerToolbar
        caption={<span data-testid="epic-file-video-caption">{caption}</span>}
        actions={props.actions}
      />
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
        <video
          data-testid="epic-file-video"
          src={props.src}
          controls
          preload="metadata"
          className="max-h-full max-w-full"
          onTimeUpdate={(event) => {
            if (event.currentTarget.readyState < HAVE_METADATA) return;
            playbackRef.current.time = event.currentTarget.currentTime;
          }}
          onPlay={(event) => {
            if (event.currentTarget.readyState >= HAVE_METADATA) {
              playbackRef.current.playing = true;
            }
          }}
          onPause={(event) => {
            if (event.currentTarget.readyState >= HAVE_METADATA) {
              playbackRef.current.playing = false;
            }
          }}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            setFacts({
              durationSeconds: element.duration,
              width: element.videoWidth,
              height: element.videoHeight,
            });
            const { time, playing } = playbackRef.current;
            if (time > 0) element.currentTime = time;
            if (playing) void element.play().catch(() => {});
          }}
          onLoadedData={props.onLoaded ?? undefined}
          onError={props.onError}
        >
          {/* An agent's screen recording has no captions to offer. */}
          <track kind="captions" />
        </video>
      </div>
    </div>
  );
}
