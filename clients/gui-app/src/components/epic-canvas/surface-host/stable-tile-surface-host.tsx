/**
 * Ticket 21 slice 3: the fixed connected overlay plane itself.
 *
 * One flat host, keyed by `instanceId`, above every retained top-level
 * surface and below the app-wide `DndContext` (mounted inside
 * `TopLevelTabHost`, itself inside `RootDndProvider`). A member's record is
 * a stable, permanently connected DOM container; structural moves reassign
 * its rect/environment, never its React parent or DOM parent - see
 * `design/index.md`'s "Why the host must be above EpicSurface".
 *
 * `renderRecordBody` is the seam the design calls a "synthetic ready
 * slot/body seam": nothing in production supplies a real one yet (slice 4
 * routes chats through it), so `TopLevelTabHost` passes a no-op and only
 * the permanent jsdom lifecycle suite - and a future dev-desktop
 * synthetic-body check - ever supply a real renderer.
 *
 * Layer contract (`design/index.md` "Permanent surface plane and geometry",
 * design-review finding 9): the plane is `pointer-events:none` at the root
 * auto/zero stacking layer; each record is `pointer-events:auto`,
 * `overflow:hidden`, and gets NO positive z-index of its own, so pane
 * drag shields/drop previews and document portals (which DO carry positive
 * z-index) always paint above every record without depending on DOM order.
 *
 * Presentation contract (slice-3 review finding 1): the PLANE ROOT carries
 * no `aria-hidden` of its own - an aria-hidden ancestor hides every
 * descendant regardless of the descendant's own `aria-hidden` value, which
 * would erase every future visible hosted body from the accessibility tree.
 * Visibility is a per-RECORD concern only. A record whose environment
 * reports `presentation.topLevelVisible: false` is `aria-hidden`, `inert`,
 * AND non-painted via `visibility:hidden` (Tailwind's `invisible`) rather
 * than `display:none`: `visibility:hidden` keeps the box's layout - and
 * this module's own geometry-coordinator-applied `transform`/`width`/
 * `height` - intact while hidden, so a later re-show needs no re-measure or
 * reflow; `display:none` would collapse the box out of layout entirely and
 * force one on re-show. The explicit focus-relinquishment protocol
 * (`runPresentationLossBlur`, design-review finding 5) is slice 4's
 * "presentation-loss blur" - `inert` alone does not reliably force a browser
 * to blur a focused descendant, so this module does not claim it does.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  Suspense,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { runPresentationLossBlur } from "@/components/epic-tabs/pane-visibility-context";
import {
  getTileSurfaceMembership,
  subscribeTileSurfaceMembership,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import {
  getTileSurfaceEnvironment,
  isTileSurfacePresented,
  subscribeTileSurfaceEnvironment,
  type ReadyTileSurfaceEnvironment,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import {
  registerTileSurfaceGeometryHost,
  registerTileSurfaceGeometrySlot,
  type TileSurfaceRect,
} from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";
import {
  HOSTED_TILE_RECORD_SELECTOR,
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
  HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import { resolveHostedTileOwnership } from "@/components/epic-canvas/surface-host/hosted-tile-resolver";
import { claimHostedPaneActivation } from "@/components/epic-canvas/pane-activation";

export interface StableTileSurfaceHostProps {
  readonly renderRecordBody: (
    environment: ReadyTileSurfaceEnvironment,
  ) => ReactNode;
}

export function StableTileSurfaceHost(
  props: StableTileSurfaceHostProps,
): ReactNode {
  const memberInstanceIds = useSyncExternalStore(
    subscribeTileSurfaceMembership,
    getTileSurfaceMembership,
    getTileSurfaceMembership,
  );
  const registerHostElement = useCallback(
    (element: HTMLDivElement | null): (() => void) | undefined => {
      if (element === null) return undefined;
      return registerTileSurfaceGeometryHost(element);
    },
    [],
  );
  const claimHostedPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const { target } = event;
      if (!(target instanceof Element)) return;
      const ownership = resolveHostedTileOwnership(target);
      if (ownership === null) return;
      // Descendant preventDefault does not suppress claims, matching the
      // physical capture path; the deferred attribute is the opt-out.
      claimHostedPaneActivation(ownership.viewTabId, ownership.paneId, {
        defaultPrevented: event.defaultPrevented,
        scope: target.closest(HOSTED_TILE_RECORD_SELECTOR),
        target,
      });
    },
    [],
  );

  return (
    <div
      ref={registerHostElement}
      data-testid="stable-tile-surface-host"
      className="pointer-events-none absolute inset-0 z-0"
      onPointerDownCapture={claimHostedPointerDown}
    >
      {Array.from(memberInstanceIds, (instanceId) => (
        <TileSurfaceRecord
          key={instanceId}
          instanceId={instanceId}
          renderBody={props.renderRecordBody}
        />
      ))}
    </div>
  );
}

function applyRectToElement(element: HTMLElement, rect: TileSurfaceRect): void {
  element.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function isUsableTileSurfaceRect(rect: TileSurfaceRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function TileSurfaceRecord(props: {
  readonly instanceId: string;
  readonly renderBody: (environment: ReadyTileSurfaceEnvironment) => ReactNode;
}): ReactNode {
  const { instanceId } = props;
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeTileSurfaceEnvironment(instanceId, listener),
    [instanceId],
  );
  const getSnapshot = useCallback(
    () => getTileSurfaceEnvironment(instanceId),
    [instanceId],
  );
  const environment = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [canMountBody, setCanMountBody] = useState(false);
  const slotElement = environment?.services.geometryAnchorElement ?? null;
  const visible = isTileSurfacePresented(environment);

  useLayoutEffect(() => {
    if (slotElement === null) return undefined;
    const element = elementRef.current;
    if (element === null) return undefined;
    return registerTileSurfaceGeometrySlot(instanceId, slotElement, (rect) => {
      const hasUsableRect = isUsableTileSurfaceRect(rect);
      // A hidden top-level tab's slot lives below a display:none ancestor and
      // therefore reports 0x0 when any shared ResizeObserver target changes.
      // Keep this record's last usable geometry while hidden so its still-
      // mounted body cannot reflow at zero width and publish bogus item sizes.
      // Visible records must still accept a real zero rect (for example when a
      // pane is collapsed) so they do not leave an interactive stale overlay.
      // A retained-but-deselected chat is the same case arriving from the
      // pane instead of the header, hence the shared presented predicate
      // rather than `topLevelVisible` alone.
      const currentlyVisible = isTileSurfacePresented(
        getTileSurfaceEnvironment(instanceId),
      );
      if (!currentlyVisible && !hasUsableRect) return;
      applyRectToElement(element, rect);
      if (currentlyVisible || hasUsableRect) setCanMountBody(true);
    });
    // Re-register on a visibility transition. Registration synchronously
    // delivers the current rect, which opens the sticky mount latch for a
    // visible 0x0 birth without a separate set-state effect. Only records born
    // hidden wait for usable geometry; once mounted, the body stays mounted.
  }, [instanceId, slotElement, visible]);

  // A hosted record going hidden is a physically distant sibling of
  // `SurfacePresentationBoundary`'s own portal container, so that
  // boundary's own presentation-loss blur (scoped to ITS container) never
  // reaches a focused descendant here. Reuse the same protocol directly
  // rather than reimplementing it - see design-review finding 5.
  useEffect(() => {
    if (visible) return;
    const element = elementRef.current;
    const active = document.activeElement;
    if (
      element !== null &&
      active instanceof HTMLElement &&
      element.contains(active)
    ) {
      runPresentationLossBlur(() => active.blur());
    }
  }, [visible]);

  return (
    <div
      ref={elementRef}
      aria-hidden={!visible}
      inert={!visible}
      className={cn(
        "pointer-events-auto absolute left-0 top-0 overflow-hidden",
        // `visibility: hidden` can leave independently composited descendant
        // layers painted for several frames in Electron. Opacity makes the
        // retained record an atomic invisible compositor group while keeping
        // its last usable geometry available to the mounted body.
        !visible && "invisible opacity-0",
      )}
      data-testid={`stable-tile-surface-record-${instanceId}`}
      {...{ [HOSTED_TILE_INSTANCE_ID_ATTRIBUTE]: instanceId }}
      {...(environment !== null
        ? {
            [HOSTED_TILE_PANE_ID_ATTRIBUTE]: environment.placement.paneId,
            [HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE]:
              environment.placement.viewTabId,
          }
        : {})}
    >
      {environment !== null && canMountBody ? (
        <Suspense fallback={null}>{props.renderBody(environment)}</Suspense>
      ) : null}
    </div>
  );
}
