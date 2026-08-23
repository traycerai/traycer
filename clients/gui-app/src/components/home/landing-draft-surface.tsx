import { useEffect, useMemo, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { v4 as uuidv4 } from "uuid";
import { HomeHero } from "@/components/home/home-hero";
import { LandingComposer } from "@/components/home/composer/landing-composer";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { HostUpdateBanner } from "@/components/home/host-update-banner";
import { HostWorkspaceSelector } from "@/components/home/host-workspace-selector/host-workspace-selector";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { useTabSurfaceActivity } from "@/components/layout/tab-surface-activity-hooks";
import { parseSystemTabOverlayView } from "@/lib/system-tab-overlay-search";
import { useDraftSurfaceId } from "@/providers/draft-surface-hooks";
import { useLandingDraftShell } from "@/stores/home/landing-draft-store";
import { LandingTerminalPaneAnchor } from "@/components/home/terminal-panel/landing-terminal-host";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import "./home-touch-targets.css";
import { focusRegisteredActiveComposer } from "@/lib/composer/composer-focus-registry";
import { isMobileApp } from "@/lib/mobile-app";
import { focusTerminalInstance } from "@/lib/terminals/terminal-focus-registry";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
} from "@/stores/home/landing-terminal-store";
import { usePaneActivationFocusIntent } from "@/components/epic-canvas/pane-activation";

/**
 * Route-independent landing body. Its exact draft runtime remains the T6
 * boundary; this surface only supplies a keyed shell for the top-level host.
 */
export function LandingDraftSurface() {
  const draftId = useDraftSurfaceId();
  const { workspaceFolders, settings } = useLandingDraftShell(draftId);
  const activity = useTabSurfaceActivity();
  const paneActivationFocusIntent = usePaneActivationFocusIntent();

  // Pre-mint the mount identity for the null-draft landing so the first
  // substantive edit (which creates a draft and flips this surface's id
  // null->id) does not remount the Tiptap editor and throw the caret to the
  // document end. Switching between existing drafts still remounts via a
  // changing key.
  //
  // Bound->null rotation is a render-phase state adjustment (React docs
  // pattern): a passive effect would leave one committed frame still keyed by
  // the retired draft id (a stale interactive editor). Adjusting here
  // re-renders synchronously before commit, so the new pending id is the first
  // key after the transition - exactly one remount, no stale frame.
  const [pendingDraftId, setPendingDraftId] = useState(() => uuidv4());
  const [prevDraftId, setPrevDraftId] = useState<string | null>(draftId);
  if (draftId !== prevDraftId) {
    setPrevDraftId(draftId);
    if (draftId === null) {
      setPendingDraftId(uuidv4());
    }
  }
  const composerMountId = draftId ?? pendingDraftId;
  const systemModalOpen = useRouterState({
    select: (state) => {
      const overlay = parseSystemTabOverlayView(state.location.search);
      return overlay.settingsOverlay || overlay.historyOverlay;
    },
  });
  // Phones drop the embedded list entirely: the hamburger drawer already
  // carries "Recent tasks" + "View all" off the same `useHistoryQuery`, so an
  // inline copy is pure duplication at this width.
  const isMobile = useIsMobileViewport();
  const setNavOpen = useMobileNavStore((state) => state.setOpen);
  const workspaceSurface = useMemo(
    () => ({ kind: "home" as const, draftId }),
    [draftId],
  );
  const workspaceControls = useMemo(
    () => renderLandingWorkspaceControls.bind(null, workspaceSurface),
    [workspaceSurface],
  );
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const focusRestorationTargetRef = useRef<HTMLElement | null>(null);
  const surfaceEffectivelyFocused = activity.focused && !systemModalOpen;
  const previouslyEffectivelyFocusedRef = useRef(false);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const rememberFocusedElement = (event: globalThis.FocusEvent): void => {
      if (
        event.target instanceof HTMLElement &&
        surface.contains(event.target)
      ) {
        lastFocusedElementRef.current = event.target;
      }
    };
    // Native focus events follow the DOM tree. The landing terminal is owned
    // by a sibling React root and portaled into this surface's anchor, so a
    // React onFocusCapture here cannot observe it even though its DOM lives
    // below this node.
    document.addEventListener("focusin", rememberFocusedElement);
    return () =>
      document.removeEventListener("focusin", rememberFocusedElement);
  }, []);

  useEffect(() => {
    const newlyFocused =
      surfaceEffectivelyFocused && !previouslyEffectivelyFocusedRef.current;
    previouslyEffectivelyFocusedRef.current = surfaceEffectivelyFocused;
    if (!surfaceEffectivelyFocused) {
      focusRestorationTargetRef.current = lastFocusedElementRef.current;
      return;
    }
    if (!newlyFocused || paneActivationFocusIntent.shouldYieldAutoFocus()) {
      return;
    }
    // The surface becoming focused is not a user gesture, and on the installed
    // mobile app that alone must not raise the software keyboard - the same
    // rule the composer's own autofocus obeys, restated here because this path
    // reaches the composer and the terminal through their focus REGISTRIES and
    // therefore never runs their guards. Explicit focus (tapping the composer,
    // tapping the terminal) is unaffected: it is the gesture the rule asks for.
    if (isMobileApp()) return;
    restoreLandingSurfaceFocus(
      draftId,
      surfaceRef.current,
      focusRestorationTargetRef.current,
    );
  }, [draftId, paneActivationFocusIntent, surfaceEffectivelyFocused]);

  return (
    <div
      ref={surfaceRef}
      data-home-touch-scope
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background text-foreground"
      data-primary-focus-scope="true"
      data-testid="landing-draft-surface"
    >
      {/* The column track must be minmax(0,1fr), not the implicit `auto`: an
          auto track's minimum is its items' min-content, so the composer
          toolbar's intrinsic width would lock the whole column wider than a
          narrow viewport (or the space left beside the terminal panel) and
          the outer overflow-hidden would clip the right edge instead of
          letting content reflow. */}
      {/* Row 2 bottom-aligns the hero and row 3 top-anchors the composer, so
          the boundary between them is where the pair sits. An even 1fr/1fr
          split (desktop, where the epics list fills row 3) centres it; below md
          the list is gone, so row 3 is weighted heavier to lift the pair just
          above the midpoint, where it reads better on a tall phone. Both rows
          stay fractional on purpose - an intrinsic row 3 would let a grown
          composer (attachments, several folders, keyboard open) squeeze row 2
          to zero and then clip against this container's overflow-hidden. */}
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_minmax(0,1fr)] overflow-hidden max-md:grid-rows-[auto_minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="mx-auto w-full max-w-3xl px-6 pt-3 max-md:px-4">
          <HostUpdateBanner className={undefined} />
        </div>

        <section className="mx-auto flex w-full max-w-3xl items-end justify-center px-6 pb-10 pt-3 max-md:px-4 max-md:pb-6">
          <HomeHero workspaceFolders={workspaceFolders} />
        </section>

        {/* Composer + recent epics share one row so the composer is top-anchored:
            adding a folder grows it downward into the (scrollable) epics list
            below instead of recentering and shoving the hero up. */}
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 max-md:px-4">
          <div className="shrink-0">
            <SurfaceActivityProvider
              active={Boolean(activity.focused && !systemModalOpen)}
            >
              <LandingComposer
                key={composerMountId}
                draftId={draftId}
                pendingCreateId={draftId === null ? pendingDraftId : null}
                initialSettings={settings}
                workspaceControls={workspaceControls}
              />
            </SurfaceActivityProvider>
          </div>

          {isMobile ? (
            /* Recent tasks live in the hamburger drawer at this width, which is
               not discoverable from a landing page that is otherwise empty
               below the composer. `mt-auto` drops this into that dead space at
               the bottom of the row; the bottom inset keeps it clear of the
               home indicator. */
            <button
              type="button"
              data-testid="home-view-history"
              className="mt-auto shrink-0 self-center pt-4 pb-safe-bottom-gutter text-ui-xs text-muted-foreground transition-colors active:text-foreground"
              onClick={() => {
                setNavOpen(true);
              }}
            >
              View history
            </button>
          ) : (
            <div className="mt-3 flex min-h-0 flex-1 flex-col pb-6">
              {!systemModalOpen && activity.visible ? (
                <EpicsListPanel
                  variant="embedded"
                  className={undefined}
                  onSelectEpic={null}
                  onOpenItem={null}
                  routeSearch={null}
                  historyNowMs={null}
                  autoFocusSearch={false}
                />
              ) : null}
            </div>
          )}
        </div>
      </div>
      {draftId === null ? null : (
        <LandingTerminalPaneAnchor draftId={draftId} />
      )}
    </div>
  );
}

/**
 * Puts the caret back where this surface last had it, in the order the surface
 * itself ranks its endpoints: a maximized terminal owns the pane outright, then
 * the element that actually held focus, then the active composer.
 *
 * A module function rather than an inline effect body so the effect above stays
 * a list of GUARDS - who may restore, and when - with the ranking read on its
 * own.
 */
function restoreLandingSurfaceFocus(
  draftId: string | null,
  surface: HTMLDivElement | null,
  previous: HTMLElement | null,
): void {
  const terminalState = useLandingTerminalStore.getState();
  const layout = landingTerminalLayoutFor(
    terminalState,
    draftId ?? "unbound-landing-page",
  );
  if (layout.panelOpen && layout.maximized) {
    const instanceId = terminalState.activeInstanceId;
    if (instanceId !== null) {
      focusTerminalInstance(instanceId);
      return;
    }
  }

  if (
    surface !== null &&
    previous !== null &&
    previous.isConnected &&
    surface.contains(previous)
  ) {
    previous.focus({ preventScroll: true });
    if (
      document.activeElement === previous ||
      (document.activeElement !== null &&
        previous.contains(document.activeElement))
    ) {
      return;
    }
  }
  // The local Tiptap editor may not have registered yet
  // (`immediatelyRender: false`). Never fall back to a retained inactive split
  // partner here; if no active endpoint exists, the local editor's own
  // autofocus effect will run as soon as it registers.
  focusRegisteredActiveComposer();
}

function renderLandingWorkspaceControls(
  surface: { readonly kind: "home"; readonly draftId: string | null },
  disabled: boolean,
) {
  return <HostWorkspaceSelector surface={surface} disabled={disabled} />;
}
