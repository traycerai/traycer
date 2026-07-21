import { useMemo } from "react";
import { useRouterState } from "@tanstack/react-router";
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

/**
 * Route-independent landing body. Its exact draft runtime remains the T6
 * boundary; this surface only supplies a keyed shell for the top-level host.
 */
export function LandingDraftSurface() {
  const draftId = useDraftSurfaceId();
  const { workspaceFolders, settings } = useLandingDraftShell(draftId);
  const activity = useTabSurfaceActivity();
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
  const workspaceControls = useMemo(
    () => renderLandingWorkspaceControls.bind(null, workspaceSurface),
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

        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6">
          <div className="shrink-0">
            <SurfaceActivityProvider
              active={Boolean(activity.visible && !systemModalOpen)}
            >
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
    </div>
  );
}

function renderLandingWorkspaceControls(
  surface: { readonly kind: "home"; readonly draftId: string | null },
  disabled: boolean,
) {
  return <HostWorkspaceSelector surface={surface} disabled={disabled} />;
}
