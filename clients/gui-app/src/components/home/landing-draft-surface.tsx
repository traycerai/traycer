import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { isMobileApp } from "@/lib/mobile-app";
import { restoreLandingSurfaceFocus } from "@/components/home/landing-surface-focus-restore";
import { usePaneActivationFocusIntent } from "@/components/epic-canvas/pane-activation";
import { LandingAppearanceWallpaper } from "@/components/home/landing-appearance-wallpaper";
import { Paintbrush } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { cn } from "@/lib/utils";

/**
 * Route-independent landing body. Its exact draft runtime remains the T6
 * boundary; this surface only supplies a keyed shell for the top-level host.
 */
export function LandingDraftSurface() {
  const draftId = useDraftSurfaceId();
  const { workspaceFolders, settings } = useLandingDraftShell(draftId);
  const activity = useTabSurfaceActivity();
  const showGreeting = useSettingsStore((state) => state.showGreeting);
  const showRecentHistory = useSettingsStore(
    (state) => state.showRecentHistory,
  );
  const paneActivationFocusIntent = usePaneActivationFocusIntent();
  const layout = startPageLayout(showGreeting, showRecentHistory);

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
  const appearanceSurfaceRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const focusRestorationTargetRef = useRef<HTMLElement | null>(null);
  const surfaceEffectivelyFocused = activity.focused && !systemModalOpen;
  const previouslyEffectivelyFocusedRef = useRef(false);

  useComposerFocusPoint(
    appearanceSurfaceRef,
    `${composerMountId}:${layout.placement}`,
  );

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
          to zero and then clip against this container's overflow-hidden.
          With both the greeting and the recent list off there is no pair to
          balance, so row 2 collapses outright and the composer centres itself
          inside the whole remainder. */}
      <div
        ref={appearanceSurfaceRef}
        className={cn(
          "landing-appearance-surface relative isolate grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden",
          layout.rows,
        )}
      >
        {activity.visible ? (
          <LandingAppearanceWallpaper draftId={draftId} />
        ) : null}
        <div className="mx-auto w-full max-w-3xl px-6 pt-3 max-md:px-4">
          <HostUpdateBanner className={undefined} />
        </div>

        <section
          className={cn(
            "relative mx-auto flex w-full max-w-3xl items-end justify-center px-6 pb-10 pt-3 max-md:px-4 max-md:pb-6",
            !showGreeting && "invisible",
            layout.hero,
          )}
        >
          <HomeHero workspaceFolders={workspaceFolders} />
        </section>

        {/* Composer + recent epics share one row so the composer is top-anchored:
            adding a folder grows it downward into the (scrollable) epics list
            below instead of recentering and shoving the hero up. */}
        <div
          data-composer-placement={layout.placement}
          className={cn(
            "relative mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 max-md:px-4",
            layout.composer,
          )}
        >
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

          {showRecentHistory && isMobile ? (
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
          ) : null}
          {showRecentHistory && !isMobile ? (
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
          ) : null}
        </div>
        <CustomizeStartPageButton />
      </div>
      {draftId === null ? null : (
        <LandingTerminalPaneAnchor draftId={draftId} />
      )}
    </div>
  );
}

/**
 * Where the composer sits, and the classes that put it there. With neither the
 * greeting nor the recent list there is no pair to balance above and below it,
 * so the hero row collapses outright (the hero stays MOUNTED - unmounting it
 * would reconcile the composer against its slot and remount the editor) and
 * the composer centres itself in the whole remainder. Any other combination
 * keeps the fractional two-row split described at the grid itself.
 */
function startPageLayout(
  showGreeting: boolean,
  showRecentHistory: boolean,
): {
  readonly rows: string;
  readonly hero: string;
  readonly composer: string;
  readonly placement: "centered" | "top";
} {
  return showGreeting || showRecentHistory
    ? {
        rows: "grid-rows-[auto_minmax(0,1fr)_minmax(0,1fr)] max-md:grid-rows-[auto_minmax(0,1fr)_minmax(0,1.4fr)]",
        hero: "",
        composer: "",
        placement: "top",
      }
    : {
        rows: "grid-rows-[auto_minmax(0,0fr)_minmax(0,1fr)]",
        hero: "h-0 overflow-hidden",
        composer: "justify-center",
        placement: "centered",
      };
}

/**
 * Publishes the composer's centre, as percentages of the artwork surface, in
 * `--wallpaper-focus-x/y`. The wallpaper mask reads them, so the clearing it
 * burns for the composer follows the composer instead of sitting at a fixed
 * point. `layoutKey` re-measures on the layout changes a ResizeObserver cannot
 * see: a composer remount, and a row template that moves it without resizing
 * it.
 */
function useComposerFocusPoint(
  surfaceRef: RefObject<HTMLDivElement | null>,
  layoutKey: string,
): void {
  useEffect(() => {
    const surface = surfaceRef.current;
    const composer =
      surface?.querySelector<HTMLElement>("[data-composer-shell]") ?? null;
    if (surface === null || composer === null) return;
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      const box = surface.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      const target = composer.getBoundingClientRect();
      const x = ((target.left + target.width / 2 - box.left) / box.width) * 100;
      const y = ((target.top + target.height / 2 - box.top) / box.height) * 100;
      surface.style.setProperty("--wallpaper-focus-x", `${x.toFixed(2)}%`);
      surface.style.setProperty("--wallpaper-focus-y", `${y.toFixed(2)}%`);
    };
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [layoutKey, surfaceRef]);
}

/**
 * The start page's only entry into its own appearance. Every setting it opens
 * (wallpaper, greeting, recent tasks) lives in Settings, so this is a shortcut
 * into that panel rather than a second editor. It sits in the surface's
 * bottom-left corner, out of the composer's way. Phones have no room for it and
 * reach the same panel through the drawer.
 */
function CustomizeStartPageButton() {
  const { openSettings } = useSystemTabModalActions();
  const isMobile = useIsMobileViewport();
  if (isMobile || isMobileApp()) return null;
  return (
    <div className="absolute bottom-3 left-3 z-10">
      <TooltipWrapper
        label="Customize start page"
        side="right"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          aria-label="Customize start page"
          onClick={() => {
            openSettings({ section: "appearance", resetToGeneral: false });
          }}
        >
          <Paintbrush className="size-3.5" />
        </Button>
      </TooltipWrapper>
    </div>
  );
}

function renderLandingWorkspaceControls(
  surface: { readonly kind: "home"; readonly draftId: string | null },
  disabled: boolean,
) {
  return <HostWorkspaceSelector surface={surface} disabled={disabled} />;
}
