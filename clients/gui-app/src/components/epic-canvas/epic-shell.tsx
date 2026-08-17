/**
 * Canvas-only since the sidebar hoist: the left sidebar is ONE app-level
 * instance mounted by the `/epics` layout route (`epic-sidebar-column.tsx`),
 * not part of each keep-alive pane. This shell renders the status row + tile
 * canvas for its pane, so sidebar collapse/resize can never remount canvas
 * content.
 */
import { use, useMemo, type ReactNode } from "react";
import { TileCanvas } from "@/components/epic-canvas/canvas/tile-canvas";
import { WorkspaceFileIconSpriteSheet } from "@/components/epic-canvas/workspace-file/workspace-file-icons";
import { EpicConnectionPill } from "@/components/epic-canvas/panels/epic-connection-pill";
import { EpicUsageEntryPoint } from "@/components/epic-canvas/panels/epic-usage-entry-point";
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
import {
  EpicSessionPresentationContext,
  type EpicSessionPresentation,
} from "@/lib/registries/epic-session-registry";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  const presentation = use(EpicSessionPresentationContext);
  const failure = presentation?.kind === "failed" ? presentation : null;

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
        fallback={
          failure === null ? (
            <EpicShellLoadingBody epicId={epicId} tabId={tabId} />
          ) : (
            <EpicRepointFailure presentation={failure} />
          )
        }
      >
        {failure === null ? (
          <EpicShellSessionBody
            epicId={epicId}
            tabId={tabId}
            active={active}
            readOnly={presentation?.kind === "establishing"}
          />
        ) : (
          <EpicRepointFailure presentation={failure} />
        )}
      </EpicSessionGate>
    </div>
  );
}

function EpicShellSessionBody(
  props: EpicShellProps & { readonly readOnly: boolean },
) {
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
      <CanvasColumn
        statusRow={
          <EpicShellStatusRow
            snapshotLoaded={snapshotLoaded}
            sessionReady
            epicId={props.epicId}
            tabId={props.tabId}
          />
        }
        canvas={
          <div
            // `h-full min-h-0` is load-bearing, not decoration: `TileCanvas`
            // sizes itself with `h-full`, so every element between it and
            // `CanvasColumn`'s `min-h-0 flex-1` slot must carry a definite
            // height forward. A wrapper left at `height: auto` gives that
            // percentage nothing to resolve against, and the canvas collapses
            // to its tab strip (~36px) with the tile body at 0.
            className={cn(
              "h-full min-h-0",
              props.readOnly && "pointer-events-none select-none",
            )}
            data-epic-repoint-read-only={props.readOnly ? "true" : "false"}
            inert={props.readOnly}
          >
            <TileCanvas epicId={props.epicId} tabId={props.tabId} />
          </div>
        }
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
          sessionReady={false}
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
  readonly sessionReady: boolean;
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Top-right status row: keep the connection pill present while a live session
 * establishes, but defer host-backed usage/sweep controls until its snapshot
 * makes their data dependencies valid.
 */
function EpicShellStatusRow(props: EpicShellStatusRowProps) {
  return (
    <output
      data-testid="epic-shell-status-row"
      className="flex h-10 shrink-0 items-center justify-end gap-1.5 px-3 text-foreground"
    >
      {props.sessionReady ? <EpicConnectionPill epicId={props.epicId} /> : null}
      {props.snapshotLoaded ? (
        <>
          <EpicUsageEntryPoint epicId={props.epicId} />
          <EpicSweepAction epicId={props.epicId} tabId={props.tabId} />
        </>
      ) : null}
    </output>
  );
}

function EpicRepointFailure(props: {
  readonly presentation: EpicSessionPresentation;
}) {
  const hostLabel = props.presentation.targetHostId ?? "the selected host";
  const originalHostId = props.presentation.originalHostId;
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-6"
      data-testid="epic-repoint-failure"
    >
      <div className="flex max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm">
        <p className="text-ui-sm font-medium">
          Couldn&apos;t load this task from {hostLabel}.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={props.presentation.retry}>
            Retry
          </Button>
          {originalHostId !== null ? (
            <Button
              size="sm"
              variant="outline"
              onClick={props.presentation.openOnOriginalHost}
            >
              Open on original host
            </Button>
          ) : null}
        </div>
      </div>
    </div>
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
