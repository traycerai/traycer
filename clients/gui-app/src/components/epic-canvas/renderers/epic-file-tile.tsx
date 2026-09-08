/**
 * The `epic-file` tile: one file on the epic's own file plane, rendered
 * through the unified file-rendering core (D27).
 *
 * ## Thin by construction
 *
 * Two seams do the work and this file owns neither. `useFileBytes` decides
 * where the bytes come from - loopback, a signed cloud url, or a settled
 * "unavailable" - and `resolveViewer` decides what renders them. What is left
 * here is the tile's own chrome: a header of manifest facts, the four
 * unavailable states each said in its own words, and the actions.
 *
 * ## Everything renderable is read LIVE
 *
 * The persisted ref carries `(epicId, path)` and nothing else. The sha, media
 * type, size, status, producer and tombstone come from the manifest on every
 * render (`useEpicFileEntry`), so a re-capture at the same path, an upload
 * finishing, a delete and a restore all move an open tile with no refetch -
 * and a tile reopened a week later shows the file as it is now rather than
 * replaying the object that happened to be current when it was opened.
 *
 * ## Producer is a ROLE, never an id
 *
 * `current.createdBy` is a user id and is manifest DATA (D31). Only
 * `producer.type` reaches the screen.
 */
import { useCallback, useState, type ReactNode } from "react";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { FileIcon, MoreHorizontal } from "lucide-react";
import {
  normalizeEpicFileStatus,
  type EpicFileEntry,
  type EpicFileStatusOrUnknown,
} from "@traycer/protocol/persistence/epic/files";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { BinaryPlaceholder } from "@/components/epic-canvas/binary-placeholder";
import {
  DEFAULT_ANIMATION_MS,
  ImagePreview,
} from "@/components/epic-canvas/image-preview/image-preview";
import { PdfPreviewLazy } from "@/components/epic-canvas/pdf-preview/pdf-preview-lazy";
import { VideoPreview } from "@/components/epic-canvas/video-preview/video-preview";
import { HtmlOpenInBrowserAction } from "@/components/epic-canvas/renderers/html-file-actions";
import { WorkspaceFileRenderer } from "@/components/epic-canvas/workspace-file/workspace-file-renderer";
import { useDiffClickToEdit } from "@/components/diff/use-diff-click-to-edit";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  useEpicDeleteFile,
  useEpicFileEntry,
  useEpicRecordingPoster,
  useEpicRestoreFile,
} from "@/hooks/epic/use-epic-files";
import { languageFromFilePath } from "@/lib/file-change-diff-hunks";
import {
  useFileBytes,
  type FileBytesState,
  type FileBytesUnavailableReason,
} from "@/lib/files/byte-source";
import {
  canDownloadToDevice,
  downloadBlobToDevice,
  hasSeparateDownloadRoute,
  saveBlobToDisk,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import {
  resolveViewer,
  type FileViewerEntry,
} from "@/lib/files/viewer-registry";
import { formatByteSize } from "@/lib/format-byte-size";
import { epicMutationKeys, uiQueryKeys } from "@/lib/query-keys";
import { isEditableRole } from "@/lib/epic-permissions";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { epicFileTileName } from "@/stores/epics/canvas/tile-schema/epic-file-tile";
import type { EpicFileTileRef } from "@/stores/epics/canvas/types";

interface EpicFileTileProps {
  readonly node: EpicFileTileRef;
  readonly viewTabId: string;
  readonly epicId: string;
}

const STATUS_LABEL: Readonly<Record<EpicFileStatusOrUnknown, string>> = {
  pending: "Uploading",
  available: "Available",
  failed: "Upload failed",
  "local-only": "On its device only",
  unknown: "Unknown state",
};

/**
 * The one place a byte count is shown, and it always says USED (D25): a
 * deleted file's bytes keep counting toward the epic's storage until the epic
 * itself is deleted, so a figure labelled "live" would read as a bug the first
 * time someone deleted a recording and watched the number stay put.
 */
const STORAGE_USED_HINT =
  "Storage used. Deleted files keep counting toward this epic until the epic itself is deleted.";

export function EpicFileTile(props: EpicFileTileProps): ReactNode {
  const entry = useEpicFileEntry(props.node.path);
  if (entry === null) {
    return (
      <EpicFileFrame node={props.node} entry={null} actions={null}>
        <EpicFileNotice
          title="This file is no longer listed"
          detail="Its manifest entry was removed or could not be read."
        />
      </EpicFileFrame>
    );
  }
  if (entry.deletedAt !== null) {
    return <EpicFileDeleted node={props.node} entry={entry} />;
  }
  return (
    <EpicFileContent
      node={props.node}
      entry={entry}
      viewTabId={props.viewTabId}
      epicId={props.epicId}
    />
  );
}

/** Header + body, the shell every state of the tile renders inside. */
function EpicFileFrame(props: {
  readonly node: EpicFileTileRef;
  readonly entry: EpicFileEntry | null;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <EpicFileHeader
        path={props.node.path}
        entry={props.entry}
        actions={props.actions}
      />
      <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-auto">
        {props.children}
      </div>
    </div>
  );
}

function EpicFileHeader(props: {
  readonly path: string;
  readonly entry: EpicFileEntry | null;
  readonly actions: ReactNode;
}): ReactNode {
  const entry = props.entry;
  return (
    <div
      className="flex h-9 w-full shrink-0 items-center gap-2 border-b border-canvas-border/70 px-3"
      data-testid="epic-file-header"
    >
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <StartTruncatedText className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
        {props.path}
      </StartTruncatedText>
      {entry === null ? null : (
        <>
          <span
            className="shrink-0 text-badge text-muted-foreground"
            data-testid="epic-file-kind"
          >
            {entry.kind}
          </span>
          <TooltipWrapper
            label={STORAGE_USED_HINT}
            side="bottom"
            sideOffset={undefined}
            align={undefined}
          >
            <span
              className="shrink-0 text-badge text-muted-foreground"
              data-testid="epic-file-size"
            >
              {formatByteSize(entry.current.byteLength)} used
            </span>
          </TooltipWrapper>
          <span
            className="shrink-0 text-badge text-muted-foreground"
            data-testid="epic-file-producer"
          >
            {entry.current.producer.type === "user" ? "person" : "agent"}
          </span>
          <span
            className="shrink-0 text-badge text-muted-foreground"
            data-testid="epic-file-status"
          >
            {STATUS_LABEL[normalizeEpicFileStatus(entry.status)]}
          </span>
        </>
      )}
      {props.actions}
    </div>
  );
}

function EpicFileNotice(props: {
  readonly title: string;
  readonly detail: string;
}): ReactNode {
  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm font-medium">{props.title}</p>
      <p className="max-w-prose text-xs text-muted-foreground">
        {props.detail}
      </p>
    </div>
  );
}

/**
 * A tombstoned entry (D25). Short-circuited BEFORE any byte source is built:
 * the manifest already says the bytes are gone, so asking the host and waiting
 * for it to say so too would show a spinner over a settled fact.
 */
function EpicFileDeleted(props: {
  readonly node: EpicFileTileRef;
  readonly entry: EpicFileEntry;
}): ReactNode {
  const restore = useEpicRestoreFile(props.node.epicId, props.node.path);
  const canWrite = isEditableRole(useEpicPermissionRole());
  const { mutate } = restore;
  const onRestore = useCallback((): void => {
    mutate({ epicId: props.node.epicId, path: props.node.path });
  }, [mutate, props.node.epicId, props.node.path]);

  return (
    <EpicFileFrame node={props.node} entry={props.entry} actions={null}>
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium">This file is no longer available</p>
        <p className="max-w-prose text-xs text-muted-foreground">
          It was deleted. Its {formatByteSize(props.entry.current.byteLength)}{" "}
          still count as storage used until this epic is deleted.
        </p>
        {canWrite ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={restore.isPending}
            onClick={onRestore}
            data-testid="epic-file-restore"
          >
            {restore.isPending ? (
              <AgentSpinningDots
                className="size-4"
                testId="epic-file-restore-spinner"
                variant={undefined}
              />
            ) : null}
            Restore
          </Button>
        ) : null}
      </div>
    </EpicFileFrame>
  );
}

/** A live entry: resolve bytes, resolve a viewer, render whichever settled. */
function EpicFileContent(props: {
  readonly node: EpicFileTileRef;
  readonly entry: EpicFileEntry;
  readonly viewTabId: string;
  readonly epicId: string;
}): ReactNode {
  const { entry, node } = props;
  const bytes = useFileBytes({
    kind: "epic-file",
    epicId: node.epicId,
    path: node.path,
    sha256: entry.current.sha256,
    mediaType: entry.current.mediaType,
  });
  // The host's delivered type wins once it has answered: it is the exact
  // `Content-Type` the bytes arrive under, while the manifest's is the sniff
  // recorded when the object was minted.
  const viewer = resolveViewer(
    bytes.mediaType ?? entry.current.mediaType,
    "epic-file",
  );

  return (
    <EpicFileFrame
      node={node}
      entry={entry}
      actions={
        <EpicFileActions
          node={node}
          viewer={viewer}
          bytes={bytes}
          viewTabId={props.viewTabId}
          epicId={props.epicId}
        />
      }
    >
      <EpicFileBody
        entry={entry}
        epicId={node.epicId}
        fileName={epicFileTileName(node.path)}
        path={node.path}
        bytes={bytes}
        viewer={viewer}
      />
    </EpicFileFrame>
  );
}

function EpicFileBody(props: {
  readonly entry: EpicFileEntry;
  /** The epic that OWNS the file - the poster sibling is looked up in it. */
  readonly epicId: string;
  readonly fileName: string;
  readonly path: string;
  readonly bytes: FileBytesState;
  readonly viewer: FileViewerEntry;
}): ReactNode {
  const { bytes } = props;
  if (bytes.status === "loading") {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center">
        <AgentSpinningDots
          className={undefined}
          testId="epic-file-loading"
          variant={undefined}
        />
      </div>
    );
  }
  if (bytes.status === "unsupported") {
    return (
      <EpicFileNotice
        title="This device can't open epic files"
        detail="The host serving this tab is older than the file plane. Update it to read files stored on this epic."
      />
    );
  }
  if (bytes.status === "unavailable") {
    return <EpicFileUnavailable entry={props.entry} reason={bytes.reason} />;
  }
  return (
    <EpicFileViewer
      epicId={props.epicId}
      recordingId={props.entry.recordingId}
      fileName={props.fileName}
      path={props.path}
      sizeBytes={props.entry.current.byteLength}
      src={bytes.src}
      viewer={props.viewer}
    />
  );
}

/**
 * Each settled reason in its own words.
 *
 * The wire collapses "the upload failed" and "this host keeps it and no other
 * can" into one `upload-unavailable` arm, because from the byte plane's side
 * they are the same answer. They are NOT the same thing to a person, so the
 * copy is taken from the manifest's own `status`, which distinguishes them.
 */
function EpicFileUnavailable(props: {
  readonly entry: EpicFileEntry;
  readonly reason: FileBytesUnavailableReason | null;
}): ReactNode {
  const hostLabel = useHostDirectoryEntry(useTabHostId())?.label ?? null;
  const status = normalizeEpicFileStatus(props.entry.status);
  if (props.reason === "upload-pending") {
    return (
      <EpicFileNotice
        title="Still uploading"
        detail={
          hostLabel === null
            ? "The device that made this file is still uploading it."
            : `Uploading from ${hostLabel}.`
        }
      />
    );
  }
  if (props.reason === "upload-unavailable" && status === "local-only") {
    return (
      <EpicFileNotice
        title="Kept on the device that made it"
        detail="This file was never uploaded, so only the device that produced it can open it."
      />
    );
  }
  if (props.reason === "upload-unavailable") {
    return (
      <EpicFileNotice
        title="The upload failed"
        detail="The device that made this file could not upload it, so no other device can open it."
      />
    );
  }
  if (props.reason === "deleted" || props.reason === "missing") {
    return (
      <EpicFileNotice
        title="This file is no longer available"
        detail="Its bytes are gone from this epic."
      />
    );
  }
  return (
    <EpicFileNotice
      title="Couldn't open this file"
      detail="The bytes could not be fetched. Close and reopen the tab to try again."
    />
  );
}

/**
 * Dispatch on the viewer FAMILY, not on the file. Each registered viewer keeps
 * its own prop contract until ticket 27 unifies them, so this switch is the
 * shape the registry's union asks for and collapses with it.
 */
function EpicFileViewer(props: {
  readonly epicId: string;
  /** Links this object to its recording's siblings (D14); `null` for a file. */
  readonly recordingId: string | null;
  readonly fileName: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly src: string;
  readonly viewer: FileViewerEntry;
}): ReactNode {
  const [viewerFailed, setViewerFailed] = useState(false);
  const onViewerFailed = useCallback((): void => {
    setViewerFailed(true);
  }, []);

  const placeholder = (
    <BinaryPlaceholder
      fileName={props.fileName}
      sizeBytes={props.sizeBytes}
      reason={viewerFailed ? "This file could not be displayed." : null}
      onOpenExternally={null}
      openExternallyOpening={false}
      compact={false}
    />
  );
  if (viewerFailed) return placeholder;

  const family = props.viewer.family;
  if (family === "image") {
    return (
      <ImagePreview
        status="ready"
        url={props.src}
        // No dimensions on the wire, so the viewer renders its constrained
        // no-dimensions fit rather than computing one from a size it does not
        // have. `epic.readFile` answers with an address, never a header.
        meta={null}
        servedFromCache={false}
        fileName={props.fileName}
        compact
        gesturesEnabled
        transformRef={null}
        onTransformChange={null}
        doubleClickOverride={null}
        animationMs={DEFAULT_ANIMATION_MS}
        onDecodeError={onViewerFailed}
      />
    );
  }
  if (family === "pdf") {
    return (
      <PdfPreviewLazy
        url={props.src}
        fileName={props.fileName}
        compact
        toolbarActions={null}
        onRenderFailure={onViewerFailed}
        onUnavailable={onViewerFailed}
      />
    );
  }
  if (family === "video") {
    return (
      <EpicFileVideo
        epicId={props.epicId}
        recordingId={props.recordingId}
        src={props.src}
        fileName={props.fileName}
        onError={onViewerFailed}
      />
    );
  }
  if (family === "text" || family === "html") {
    return (
      <EpicFileTextViewer
        src={props.src}
        fileName={props.fileName}
        path={props.path}
        fallback={placeholder}
      />
    );
  }
  // `binary` is the terminal arm of the fallback chain (D27), never a failure:
  // an unrecognized type renders as a file with a download affordance.
  return placeholder;
}

/**
 * The video viewer plus the poster resolution the viewer itself must not own.
 *
 * Its own component so the poster's byte source is a hook call on a mount that
 * exists only for the `video` family - `EpicFileViewer` dispatches on family
 * inside one render, and a second `useFileBytes` there would run for every
 * file the tile ever shows.
 *
 * The poster is an OPTIONAL companion: a recording has one only once the host
 * has written its entry (D14), and a plain `.mp4` dropped into `files/` has no
 * `recordingId` at all. Both cases resolve to `null` and the element simply
 * paints its own first frame instead.
 */
function EpicFileVideo(props: {
  readonly epicId: string;
  readonly recordingId: string | null;
  readonly src: string;
  readonly fileName: string;
  readonly onError: () => void;
}): ReactNode {
  const poster = useEpicRecordingPoster(props.recordingId);
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
  return (
    <VideoPreview
      src={props.src}
      // Only a SETTLED poster: an unavailable one (still uploading, kept on
      // the producing device) has no url, and the clip is watchable either
      // way - a still frame is never worth blocking playback on.
      posterSrc={posterBytes.status === "ready" ? posterBytes.src : null}
      fileName={props.fileName}
      onError={props.onError}
    />
  );
}

/**
 * The code viewer, for the two families that render decoded TEXT rather than a
 * `src` (D32 puts HTML here too, with an "Open in browser" action beside it).
 *
 * The blob is decoded through Query rather than an effect + loading flag, and
 * keyed by the `blob:` url, which IS the content identity: the blob cache
 * mints a new url when the bytes change and revokes the old one.
 */
function EpicFileTextViewer(props: {
  readonly src: string;
  readonly fileName: string;
  readonly path: string;
  readonly fallback: ReactNode;
}): ReactNode {
  const text = useQuery(
    queryOptions({
      queryKey: uiQueryKeys.fileBlobText(props.src),
      queryFn: async (): Promise<string> => {
        const response = await globalThis.fetch(props.src);
        if (!response.ok) {
          throw new Error(`File read failed (${response.status})`);
        }
        return response.text();
      },
    }),
  );
  // Read-only: the epic file plane has no write-back path (an object is
  // immutable and content-addressed), so the adapter exists only to satisfy
  // the renderer's contract and every activation route is inert.
  const editAdapter = useDiffClickToEdit({
    surfaceId: `epic-file:${props.path}`,
    enabled: false,
    active: false,
    onActivate: () => Promise.resolve({ kind: "rejected" as const }),
    onActivationError: () => undefined,
    onChange: () => undefined,
    onBlur: () => undefined,
    onSaveShortcut: () => undefined,
  });
  const onRevealConsumed = useCallback((): void => undefined, []);

  if (text.data === undefined) {
    return text.isError ? (
      props.fallback
    ) : (
      <div className="flex h-full min-h-0 w-full items-center justify-center">
        <AgentSpinningDots
          className={undefined}
          testId="epic-file-decoding"
          variant={undefined}
        />
      </div>
    );
  }
  return (
    <WorkspaceFileRenderer
      content={text.data}
      fileName={props.fileName}
      language={languageFromFilePath(props.fileName)}
      editing={false}
      editAdapter={editAdapter}
      wordWrap
      revealLine={null}
      revealNonce={null}
      findTarget={null}
      onRevealConsumed={onRevealConsumed}
      fileIdentity={null}
    />
  );
}

function EpicFileActions(props: {
  readonly node: EpicFileTileRef;
  readonly viewer: FileViewerEntry;
  readonly bytes: FileBytesState;
  readonly viewTabId: string;
  readonly epicId: string;
}): ReactNode {
  const canWrite = isEditableRole(useEpicPermissionRole());
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const remove = useEpicDeleteFile(props.node.epicId, props.node.path);
  const fileName = epicFileTileName(props.node.path);
  const src = props.bytes.status === "ready" ? props.bytes.src : null;

  const save = useMutation<SavedFile | null, Error, "download" | "share">({
    mutationKey: epicMutationKeys.saveFile(props.node.epicId, props.node.path),
    mutationFn: async (route) => {
      if (src === null) throw new Error("This file has no bytes to save yet.");
      const response = await globalThis.fetch(src);
      if (!response.ok) {
        throw new Error(`File read failed (${response.status})`);
      }
      const blob = await response.blob();
      return route === "share"
        ? saveBlobToDisk(blob, fileName, fileSave)
        : downloadBlobToDevice(blob, fileName, fileSave);
    },
    onSuccess: (saved, route) => {
      if (saved === null) return;
      // A "download" is a SAVE for toast purposes: the two words the toast
      // knows are "wrote it" and "handed it to a chooser", and only the share
      // leg is the second one.
      toastSavedFile(
        saved,
        openSaved.mutate,
        fileSave,
        route === "share" ? "share" : "save",
      );
    },
    onError: (error) => {
      toastFromRunnerError(error, `Couldn't save ${fileName}`);
    },
  });

  const { mutate: mutateRemove } = remove;
  const onDelete = useCallback((): void => {
    mutateRemove({ epicId: props.node.epicId, path: props.node.path });
  }, [mutateRemove, props.node.epicId, props.node.path]);

  return (
    <div className="flex shrink-0 items-center gap-1">
      {/* D32, and only where a loopback static server exists to serve it -
          `resolveViewer` raises the capability for an epic-file source alone. */}
      {props.viewer.capabilities.opensInBrowser ? (
        <HtmlOpenInBrowserAction
          fileEpicId={props.node.epicId}
          path={props.node.path}
          epicId={props.epicId}
          viewTabId={props.viewTabId}
        />
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TooltipWrapper
            label="File actions"
            side="bottom"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="File actions"
              data-testid="epic-file-actions"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </TooltipWrapper>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(80vw,14rem)]">
          {canDownloadToDevice(fileSave) ? (
            <DropdownMenuItem
              disabled={src === null || save.isPending}
              onSelect={() => save.mutate("download")}
              data-testid="epic-file-download"
            >
              Download
            </DropdownMenuItem>
          ) : null}
          {/* Only where the shell keeps the two apart: elsewhere its own save
              route IS the download, and a second item would be the same act
              under a word that promises something different. */}
          {hasSeparateDownloadRoute(fileSave) ? (
            <DropdownMenuItem
              disabled={src === null || save.isPending}
              onSelect={() => save.mutate("share")}
              data-testid="epic-file-share"
            >
              Share
            </DropdownMenuItem>
          ) : null}
          {canWrite ? (
            <DropdownMenuItem
              variant="destructive"
              disabled={remove.isPending}
              onSelect={onDelete}
              data-testid="epic-file-delete"
            >
              Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
