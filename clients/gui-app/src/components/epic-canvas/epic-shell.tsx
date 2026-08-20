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
        {/*
         * The failure is surfaced OVER a mounted body, never in place of it.
         * Swapping `EpicShellSessionBody` out for the card unmounted
         * `TileCanvas` and every tile with it, discarding scroll positions,
         * drafts and editor state that a Retry one click away would have
         * restored for free - and it did so on a path where nothing is
         * necessarily wrong with the session at all (see the deadline trigger
         * below).
         *
         * The pattern was already one line away: `establishing` keeps the body
         * mounted and degrades it to read-only. `failed` differed only in
         * destroying it, and that asymmetry was the whole defect.
         *
         * BOTH triggers are covered here because neither releases the handle,
         * which is what makes one fix sufficient - checked rather than assumed:
         *  - the ∅-host arm (`epic-session-provider.tsx`) only calls
         *    `presentSession`; it disposes nothing;
         *  - the establishing-deadline arm calls `disposePending()`, which
         *    disposes the PENDING replacement and leaves the current session
         *    standing.
         * So `EpicSessionGate` stays resolved through both and the body below
         * still has a session to render. Scope the fix to what `failed`
         * RENDERS, not to which condition produced it.
         *
         * The gate's FALLBACK arm keeps rendering the card full-bleed, and
         * that stays correct: there is no handle there, so there is no canvas
         * to preserve and nothing is being destroyed.
         */}
        <>
          <EpicShellSessionBody
            epicId={epicId}
            tabId={tabId}
            active={active}
            readOnly={presentation?.kind === "establishing" || failure !== null}
          />
          {failure === null ? null : (
            /*
             * ⚠ `z-50` is a MEASURED floor, not a default. The canvas subtree
             * carries positioned elements up to `z-40` and `tile-canvas.tsx`
             * establishes no `isolate` boundary between them and this shell,
             * so they share a stacking context with this overlay and anything
             * at or below `z-40` would otherwise paint OVER the failure card.
             *
             * No test on this branch can see that: jsdom has no layout or
             * paint engine, so a card rendered completely behind a tile
             * satisfies every assertion in the suite below. Recorded here
             * because the arms are green either way, and raise this if the
             * canvas ever grows a higher layer.
             */
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 p-6">
              <EpicRepointFailureCard presentation={failure} />
            </div>
          )}
        </>
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

/**
 * The full-bleed presentation, for the gate's FALLBACK arm only - there is no
 * session handle there, so the card is legitimately the whole content. The
 * resolved arm overlays {@link EpicRepointFailureCard} on a mounted body
 * instead; see the comment at that call site.
 */
function EpicRepointFailure(props: {
  readonly presentation: EpicSessionPresentation;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <EpicRepointFailureCard presentation={props.presentation} />
    </div>
  );
}

/**
 * The card itself, carrying the `epic-repoint-failure` test id so "the failure
 * is being shown" is ONE query whichever arm rendered it - a second id per arm
 * is how a test comes to assert the copy appeared while missing that the
 * canvas behind it did not survive.
 */
function EpicRepointFailureCard(props: {
  readonly presentation: EpicSessionPresentation;
}) {
  const hostLabel = props.presentation.targetHostId ?? "the selected host";
  const originalHostId = props.presentation.originalHostId;
  return (
    <div
      data-testid="epic-repoint-failure"
      className="flex max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm"
    >
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
