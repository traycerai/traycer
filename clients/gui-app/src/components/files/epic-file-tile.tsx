import type { ReactNode } from "react";
import { toast } from "sonner";
import { Download, Globe, MoreHorizontal } from "lucide-react";
import { HtmlViewer } from "@/components/files/viewers/html-viewer";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import {
  useEpicFileDownload,
  useEpicFileOpenInBrowser,
} from "@/hooks/files/use-epic-file-mutations";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { epicFileViewer } from "@/lib/files/viewer-registry";
import type { EpicFileTileRef } from "@/stores/epics/canvas/types";

interface EpicFileTileProps {
  readonly node: EpicFileTileRef;
  readonly epicId: string;
}

const COPIED_RESET_MS = 2000;

/**
 * One epic file, expanded (D22): a bar with the file's path and actions over
 * the viewer its kind picks. Bound, like every tile, to its tab's host - the
 * host that reads the bytes and decides a page's network policy.
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
  const openInBrowser = useEpicFileOpenInBrowser(address);
  const download = useEpicFileDownload(hostId, address);
  const { copy } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: () => toast.success("Path copied"),
    onError: () => toast.error("Couldn't copy the path"),
  });

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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-canvas-border/70 px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-muted-foreground">
          {node.path}
        </span>
        {/* The version navigator mounts here once the Files panel lands. */}
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        {viewer.kind === "html" ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={offline || openInBrowser.isPending}
            onClick={() => openInBrowser.mutate()}
          >
            <Globe aria-hidden />
            Open in browser
            {openInBrowser.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
          </Button>
        ) : null}
        {/* Download saves the text the viewer read; other kinds wait for a
            byte source (ranges), which arrives with their viewers. */}
        {viewer.kind === "html" ? (
          <TooltipWrapper
            label="Download"
            side="bottom"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              variant="muted"
              size="icon-sm"
              aria-label="Download"
              disabled={offline || download.isPending}
              onClick={() => download.mutate()}
            >
              <Download aria-hidden />
            </Button>
          </TooltipWrapper>
        ) : null}
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
      </div>
      <div className="min-h-0 flex-1">
        {viewer.kind === "html" ? (
          <HtmlViewer
            // A new version is a new document, with fresh frame state.
            key={node.sha256}
            hostId={hostId}
            address={address}
            title={node.name}
            initialHeight={null}
            onOpenInBrowser={() => openInBrowser.mutate()}
            openInBrowserPending={openInBrowser.isPending}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-ui-sm text-muted-foreground">
            <p>No preview for this file.</p>
          </div>
        )}
      </div>
    </div>
  );
}
