/**
 * Canvas-only since the sidebar hoist: the left sidebar is ONE app-level
 * instance mounted by the `/epics` layout route (`epic-sidebar-column.tsx`),
 * not part of each keep-alive pane. This shell renders the status row + tile
 * canvas for its pane, so sidebar collapse/resize can never remount canvas
 * content.
 */
import { useMemo, type ReactNode } from "react";
import { TileCanvas } from "@/components/epic-canvas/canvas/tile-canvas";
import { WorkspaceFileIconSpriteSheet } from "@/components/epic-canvas/workspace-file/workspace-file-icons";
import { EpicConnectionPill } from "@/components/epic-canvas/panels/epic-connection-pill";
import { EpicConnectionToasts } from "@/components/epic-canvas/panels/epic-connection-toasts";
import { CanvasSkeleton } from "@/components/epic-canvas/skeletons/canvas-skeleton";
import {
  useEpicSnapshotFetchError,
  useEpicSnapshotLoaded,
} from "@/lib/epic-selectors";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { PrListBackgroundMount } from "@/providers/pr-list-background-mount";

interface EpicShellProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly active: boolean;
}

/**
 * Mounted by `/epics/$epicId/$tabId`. A full permission revoke or remote delete
 * is handled app-level by `EpicAccessCoordinator`, which force-closes the tab
 * (and redirects an active tab to the epic list) - so this shell no longer
 * renders an in-place access-lost banner.
 */
export function EpicShell(props: EpicShellProps) {
  const { epicId, tabId, active } = props;
  const sessionReady = useMaybeOpenEpicHandle() !== null;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-r-lg bg-background"
      data-testid="epic-shell"
      data-epic-shell-root="true"
      data-epic-id={epicId}
      data-session-ready={sessionReady ? "true" : "false"}
    >
      <WorkspaceFileIconSpriteSheet />
      <EpicSessionGate fallback={<EpicShellLoadingBody />}>
        <EpicShellSessionBody epicId={epicId} tabId={tabId} active={active} />
      </EpicSessionGate>
    </div>
  );
}

function EpicShellSessionBody(props: EpicShellProps) {
  const snapshotLoaded = useEpicSnapshotLoaded();
  const snapshotFetchError = useEpicSnapshotFetchError();
  const snapshotContextValue = useMemo(
    () => ({ snapshotLoaded, snapshotFetchError }),
    [snapshotLoaded, snapshotFetchError],
  );

  return (
    <SnapshotLoadingProvider value={snapshotContextValue}>
      {props.active ? <EpicConnectionToasts epicId={props.epicId} /> : null}
      <ResourcesStreamMount epicId={props.epicId} />
      <PrListBackgroundMount
        epicId={props.epicId}
        tabId={props.tabId}
        active={props.active}
      />
      <CanvasColumn
        statusRow={<EpicShellStatusRow snapshotLoaded={snapshotLoaded} />}
        canvas={<TileCanvas epicId={props.epicId} tabId={props.tabId} />}
      />
    </SnapshotLoadingProvider>
  );
}

function EpicShellLoadingBody() {
  return (
    <CanvasColumn
      statusRow={<EpicShellStatusRow snapshotLoaded={false} />}
      canvas={<LoadingTileCanvas />}
    />
  );
}

interface EpicShellStatusRowProps {
  readonly snapshotLoaded: boolean;
}

function EpicShellStatusRow(props: EpicShellStatusRowProps) {
  return (
    <output
      data-testid="epic-shell-status-row"
      className="flex h-10 shrink-0 items-center justify-end gap-3 px-3 text-foreground"
    >
      {props.snapshotLoaded ? <EpicConnectionPill /> : null}
    </output>
  );
}

function CanvasColumn(props: {
  readonly statusRow: ReactNode;
  readonly canvas: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {props.statusRow}
      <div className="min-h-0 flex-1">{props.canvas}</div>
    </div>
  );
}

function LoadingTileCanvas() {
  return (
    <div
      className="canvas-token-scope relative h-full min-h-0 w-full overflow-hidden rounded-t-lg border border-canvas-border/70 bg-canvas text-canvas-foreground"
      data-testid="tile-canvas-loading"
    >
      <CanvasSkeleton />
    </div>
  );
}
