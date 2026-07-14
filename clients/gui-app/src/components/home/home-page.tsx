import { useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { useActiveLandingDraftShell } from "@/stores/home/landing-draft-store";
import { HomeHero } from "@/components/home/home-hero";
import { LandingComposer } from "@/components/home/composer/landing-composer";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { HostUpdateBanner } from "@/components/home/host-update-banner";
import { HostWorkspaceSelector } from "@/components/home/host-workspace-selector/host-workspace-selector";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { LandingTerminalPanel } from "@/components/home/terminal-panel/landing-terminal-panel";
import { parseSystemTabOverlayView } from "@/lib/system-tab-overlay-search";

export function HomePage() {
  // Subscribe to the render-stable shell, NOT the full draft: the active
  // draft's `prompt` changes on every keystroke, but `LandingComposer` reads it
  // once at mount (keyed by draft id), so excluding it here keeps typing from
  // re-rendering the entire home surface.
  const { draftId, workspaceFolders, settings } = useActiveLandingDraftShell();

  // The Settings / History modal renders over the home page. While it's open the
  // embedded list is fully occluded, yet it shares the history-search store +
  // query with the modal, so searching/filtering in the modal would re-render it
  // behind the dialog. Select a plain boolean (stable across unrelated
  // navigations) and unmount the occluded list so that work never happens.
  const systemModalOpen = useRouterState({
    select: (state) => {
      const overlay = parseSystemTabOverlayView(state.location.search);
      return overlay.settingsOverlay || overlay.historyOverlay;
    },
  });
  const workspaceSurface = useMemo(
    () => ({ kind: "home" as const, draftId }),
    [draftId],
  );
  // Composer v3: host select · Workspace rail picker. Per-folder
  // Environment config lives inside the selected folder panel.
  const workspaceControls = useMemo(
    () => <HostWorkspaceSelector surface={workspaceSurface} />,
    [workspaceSurface],
  );

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)_minmax(0,1fr)] overflow-hidden">
        <div className="mx-auto w-full max-w-3xl px-6 pt-3">
          <HostUpdateBanner className={undefined} />
        </div>

        <section className="mx-auto flex w-full max-w-3xl items-end justify-center px-6 pb-10 pt-3">
          <HomeHero workspaceFolders={workspaceFolders} />
        </section>

        {/* Composer + recent epics share one row so the composer is top-anchored:
            adding a folder grows it downward into the (scrollable) epics list
            below instead of recentering and shoving the hero up. */}
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6">
          <div className="shrink-0">
            <SurfaceActivityProvider active={!systemModalOpen}>
              <LandingComposer
                key={draftId}
                draftId={draftId}
                initialSettings={settings}
                workspaceControls={workspaceControls}
              />
            </SurfaceActivityProvider>
          </div>

          <div className="mt-3 flex min-h-0 flex-1 flex-col pb-6">
            {systemModalOpen ? null : (
              <EpicsListPanel
                variant="embedded"
                onSelectEpic={null}
                routeSearch={null}
                historyNowMs={null}
                autoFocusSearch={false}
              />
            )}
          </div>
        </div>
      </div>
      <LandingTerminalPanel draftId={draftId} />
    </div>
  );
}
