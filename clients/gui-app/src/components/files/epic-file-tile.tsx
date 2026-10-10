import type { ReactNode } from "react";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";
import { EpicFileDownloadButton } from "@/components/files/epic-file-download-button";
import { EpicFileVersionNav } from "@/components/files/epic-file-version-nav";
import { MiddleTruncatedText } from "@/components/files/middle-truncated-text";
import { HtmlViewer } from "@/components/files/viewers/html-viewer";
import { ImageViewer } from "@/components/files/viewers/image-viewer";
import { PdfViewer } from "@/components/files/viewers/pdf-viewer";
import { VideoViewer } from "@/components/files/viewers/video-viewer";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useEpicFileDownload } from "@/hooks/files/use-epic-file-mutations";
import { useEpicFileRecord } from "@/hooks/files/use-epic-file-record";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { epicFileViewer } from "@/lib/files/viewer-registry";
import type { EpicFileTileRef } from "@/stores/epics/canvas/types";

interface EpicFileTileProps {
  readonly node: EpicFileTileRef;
  readonly epicId: string;
}

const COPIED_RESET_MS = 2000;
/** A path differs at its end: this many trailing characters never truncate. */
const PATH_TAIL_CHARS = 24;

/**
 * One epic file, expanded (D22), bound like every tile to its tab's host - the
 * host that reads the bytes and decides a page's network policy.
 *
 * One toolbar per tile (D40, Viewers): an image, video or PDF draws its own
 * kind's toolbar - what the file is, its controls - and the tile's actions
 * (version menu, Download, More) ride at its end. A page, and a file with no
 * viewer, get the plain path bar instead. Download works for every kind and
 * whether or not the bytes are on the host yet.
 *
 * A host outage never replaces the body (D10): a page that already loaded is
 * a running document the host is no longer needed for, so it keeps running
 * under a notice, and only the actions that need the host are disabled.
 */
export function EpicFileTile(props: EpicFileTileProps): ReactNode {
  const { node } = props;
  const hostId = useTabHostId();
  const reachability = useHostReachability(hostId);
  const offline = reachability.status === "unreachable";
  const address: EpicFileAddress = {
    epicId: props.epicId,
    path: node.path,
    sha256: node.sha256,
    via: node.via,
  };
  const viewer = epicFileViewer(node.path);
  // The manifest's title names the file where it has one (a page, an app).
  const title = useEpicFileRecord(node.path)?.entry.title?.trim() ?? "";
  const download = useEpicFileDownload(hostId, address);
  const { copy } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: () => toast.success("Path copied"),
    onError: () => toast.error("Couldn't copy the path"),
  });

  const versionNav = (
    <EpicFileVersionNav
      epicId={props.epicId}
      hostId={hostId}
      path={node.path}
    />
  );
  const fileActions = (
    <>
      <EpicFileDownloadButton download={download} disabled={offline} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="muted" size="icon-sm" aria-label="More">
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => copy(node.path)}>
            Copy path
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  const actions = (
    <>
      {versionNav}
      {fileActions}
    </>
  );

  function renderBody(): ReactNode {
    switch (viewer.kind) {
      case "html":
        return (
          <PathBar
            path={node.path}
            title={title}
            versionNav={versionNav}
            actions={fileActions}
          >
            <HtmlViewer
              // A new version is a new document, with fresh frame state.
              key={node.sha256}
              hostId={hostId}
              address={address}
              title={title.length > 0 ? title : node.name}
              initialHeight={null}
            />
          </PathBar>
        );
      case "image":
        return (
          <ImageViewer
            key={node.sha256}
            hostId={hostId}
            address={address}
            actions={actions}
          />
        );
      case "video":
        return (
          // One recovery state machine per file.
          <VideoViewer
            key={node.sha256}
            hostId={hostId}
            address={address}
            actions={actions}
          />
        );
      case "pdf":
        return (
          <PdfViewer
            key={node.sha256}
            hostId={hostId}
            address={address}
            actions={actions}
          />
        );
      case null:
        return (
          <PathBar
            path={node.path}
            title={title}
            versionNav={versionNav}
            actions={fileActions}
          >
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-ui-sm text-muted-foreground">
              <p>No preview for this file.</p>
            </div>
          </PathBar>
        );
    }
  }

  return (
    <div
      data-testid="epic-file-tile"
      className="flex h-full min-h-0 w-full flex-col bg-canvas"
    >
      {offline ? (
        <p
          role="status"
          data-testid="epic-file-tile-offline"
          className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-ui-xs text-warning-foreground"
        >
          Host &quot;{reachability.hostLabel}&quot; is unreachable. What is
          showing stays; its actions come back with the host.
        </p>
      ) : null}
      <div className="min-h-0 flex-1">{renderBody()}</div>
    </div>
  );
}

/**
 * The plain bar over a page or a file with no viewer (FileTile): the file's
 * title, or its path, truncated in the middle with the path in a tooltip. It
 * keeps a few characters of room; past that the actions wrap below it.
 */
function PathBar(props: {
  readonly path: string;
  /** The manifest's title, or `""` to show the path itself. */
  readonly title: string;
  readonly versionNav: ReactNode;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const hasTitle = props.title.length > 0;
  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-canvas-border/70 px-3 py-1">
        <TooltipWrapper
          label={props.path}
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <span
            data-testid="epic-file-path-bar-label"
            className="flex min-w-16 grow basis-0 text-ui-xs"
          >
            {/* A path differs at its end; a title reads from its start. */}
            {hasTitle ? (
              <span className="min-w-0 truncate text-foreground/85">
                {props.title}
              </span>
            ) : (
              <MiddleTruncatedText
                text={props.path}
                tailLength={PATH_TAIL_CHARS}
                className="font-mono text-muted-foreground"
              />
            )}
          </span>
        </TooltipWrapper>
        {props.versionNav}
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        {props.actions}
      </div>
      <div className="min-h-0 flex-1">{props.children}</div>
    </div>
  );
}
