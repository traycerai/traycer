/**
 * A recording (or any `video/*` epic file) embedded in an assistant message by
 * an ordinary markdown link or image whose target is an epic path (D28).
 *
 * ## Why it is not `EpicFileVideo`
 *
 * The tile version (`epic-canvas/renderers/epic-file-tile.tsx`) is handed a
 * `src` its parent already resolved, because the tile resolves bytes once and
 * dispatches on the viewer family. A transcript has no such parent: each
 * markdown target is its own file, so the clip's byte source is resolved HERE.
 * The poster half is then identical to the tile's, and both go through the one
 * `VideoPreview` (ticket 16) - which owns the app-wide "one playing at a time"
 * rule, so nothing on this side registers anything.
 *
 * ## The clip is never downloaded on mount
 *
 * `useFileBytes` answers a sniffed video with `delivery: "url"` (D10) and
 * `VideoPreview` sets `preload="metadata"`, so a transcript with ten
 * recordings in it fetches ten headers and ten poster images, not ten clips.
 */
import { useCallback, useState, type ReactNode } from "react";

import { VideoPreview } from "@/components/epic-canvas/video-preview/video-preview";
import {
  useEpicFileEntry,
  useEpicRecordingPoster,
} from "@/hooks/epic/use-epic-files";
import { useFileBytes } from "@/lib/files/byte-source";
import {
  AttachmentImageFailure,
  AttachmentImageLoading,
} from "./attachment-image";

export interface InlineVideoProps {
  readonly epicId: string;
  /** Manifest key of the clip (`files/...`), from the file resolution entry. */
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
  /** The markdown alt / link text, used as the element's accessible name. */
  readonly label: string;
}

export function InlineVideo(props: InlineVideoProps): ReactNode {
  // A decode/codec failure the element reports is terminal for this mount -
  // the same contract `EpicFileViewer` gives `VideoPreview`, and the reason
  // the component takes an `onError` at all.
  const [failed, setFailed] = useState(false);
  const onError = useCallback((): void => setFailed(true), []);

  const clip = useFileBytes({
    kind: "epic-file",
    epicId: props.epicId,
    path: props.path,
    sha256: props.sha256,
    mediaType: props.mediaType,
  });

  // The poster is found through the clip's manifest entry rather than by
  // deriving `<id>.poster.png` from the path: a recording is three sibling
  // objects linked by `recordingId` (D14), the poster lands AFTER the clip on
  // a stop, and a plain `.mp4` dropped into `files/` has no `recordingId` at
  // all. All three cases fall out of reading the entry.
  const clipEntry = useEpicFileEntry(props.path);
  const poster = useEpicRecordingPoster(clipEntry?.recordingId ?? null);
  const posterBytes = useFileBytes(
    poster === null
      ? null
      : {
          kind: "epic-file",
          epicId: props.epicId,
          path: poster.path,
          sha256: poster.entry.current.sha256,
          mediaType: poster.entry.current.mediaType,
        },
  );

  if (failed) {
    return (
      <AttachmentImageFailure
        alt={props.label}
        reason="Couldn't play this video."
      />
    );
  }
  if (clip.status === "loading") {
    return <AttachmentImageLoading label="Loading video" fullWidth={false} />;
  }
  if (clip.status !== "ready") {
    // `unsupported` (a host predating the file plane) lands here too. Both are
    // "there is nothing to play", and a transcript row is not the place to
    // explain a host build to someone.
    return (
      <AttachmentImageFailure
        alt={props.label}
        reason="This file is no longer available."
      />
    );
  }
  return (
    <span className="my-3 block aspect-video w-full max-w-prose overflow-hidden rounded-lg border border-border/70">
      <VideoPreview
        src={clip.src}
        // Only a SETTLED poster: an unavailable one has no url and the clip is
        // watchable either way - a still frame is never worth blocking on.
        posterSrc={posterBytes.status === "ready" ? posterBytes.src : null}
        fileName={props.label}
        onError={onError}
      />
    </span>
  );
}
