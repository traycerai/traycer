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
import { EpicSweepAction } from "@/components/epic-canvas/panels/epic-sweep-action";
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
import { ManagedCommandListStreamMount } from "@/providers/managed-command-list-stream-mount";

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
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="epic-shell"
      data-epic-shell-root="true"
      data-epic-id={epicId}
      data-session-ready={sessionReady ? "true" : "false"}
    >
      <WorkspaceFileIconSpriteSheet />
      <EpicSessionGate
        fallback={<EpicShellLoadingBody epicId={epicId} tabId={tabId} />}
      >
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
      <ManagedCommandListStreamMount epicId={props.epicId} />
      <CanvasColumn
        statusRow={
          <EpicShellStatusRow
            snapshotLoaded={snapshotLoaded}
            epicId={props.epicId}
            tabId={props.tabId}
          />
        }
        canvas={<TileCanvas epicId={props.epicId} tabId={props.tabId} />}
      />
    </SnapshotLoadingProvider>
  );
}

function EpicShellLoadingBody(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  return (
    <CanvasColumn
      statusRow={
        <EpicShellStatusRow
          snapshotLoaded={false}
          epicId={props.epicId}
          tabId={props.tabId}
        />
      }
      canvas={<LoadingTileCanvas />}
    />
  );
}

interface EpicShellStatusRowProps {
  readonly snapshotLoaded: boolean;
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Top-right status row: the sync pill plus the Task-level Sweep affordance.
 * Both are gated on `snapshotLoaded` - it implies a live Epic session, and the
 * Sweep action is host-backed, so a merely-retained pane must never mount it
 * (an ungated host hook there throws out of the pane and the route error
 * boundary swallows the whole canvas).
 */
function EpicShellStatusRow(props: EpicShellStatusRowProps) {
  return (
    <output
      data-testid="epic-shell-status-row"
      className="flex h-10 shrink-0 items-center justify-end gap-1.5 px-3 text-foreground"
    >
      {props.snapshotLoaded ? (
        <>
          <EpicConnectionPill />
          <EpicSweepAction epicId={props.epicId} tabId={props.tabId} />
        </>
      ) : null}
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
      className="canvas-token-scope relative h-full min-h-0 w-full overflow-hidden border border-canvas-border/70 bg-canvas text-canvas-foreground"
      data-testid="tile-canvas-loading"
    >
      <CanvasSkeleton />
    </div>
  );
}
