import { useLayoutEffect, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, domAnimation } from "motion/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { RateLimitPollProvider } from "@/providers/rate-limit-poll-provider";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import {
  PanelTaskHeader,
  SidebarWidthResizeHandle,
} from "@/components/epic-canvas/sidebar/epic-sidebar-column";
import { EpicLeftPanelRail } from "@/components/epic-canvas/sidebar/epic-sidebar-rail";
import { StableTileSurfaceHost } from "@/components/epic-canvas/surface-host/stable-tile-surface-host";
import { TileSurfaceSlot } from "@/components/epic-canvas/surface-host/tile-surface-slot";
import { EpicSurfaceSheets } from "@/components/epic-tabs/epic-surface";
import { AppColumnFrame } from "@/components/layout/app-column-frame";
import { AppHeader } from "@/components/layout/header/app-header";
import {
  appColumnChrome,
  sideStripOwnsTitleBar,
} from "@/components/layout/header/app-title-band-kind";
import { useAppColumnChromeInput } from "@/components/layout/use-app-column-chrome-input";
import { SideTabStrip } from "@/components/layout/tabs/side-strip/side-tab-strip";
import { AppStatusBar } from "@/components/layout/status-bar/app-status-bar";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { SampleWorkspaceBody } from "@/components/sample-workspace/sample-workspace-body";
import { NavigatorResourceHotspotChip } from "@/components/resources/resource-usage-chip";
import { useNavigatorResourceMetrics } from "@/hooks/resources/use-navigator-resource-metrics";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
} from "@/lib/host";
import { useArrangementValue } from "@/lib/layout-overrides";
import { cn } from "@/lib/utils";
import { sideTabStripEdge } from "@/lib/layout/layout-arrangement";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  useMainPanelCollapsed,
  useSidebarWidthPx,
} from "@/stores/epics/left-panel-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useStatusBarShown } from "@/stores/layout/layout-store";
import {
  EPIC_SURFACE_ID,
  EPIC_SURFACE_CHAT,
  TRACKED_AGENT_ID,
  harnessMessengerFactory,
  type SweepWindow,
} from "@/components/layout-editor/__tests__/layout-sweep-fixtures";

function renderHostedBody(): ReactNode {
  return (
    <div
      data-sweep-hosted-body
      className="flex h-full w-full items-center justify-center border-2 border-dashed border-info bg-info/10 text-ui-sm"
    >
      Hosted chat body
    </div>
  );
}

/**
 * One agent row's readings: the REAL chip every agent and terminal row draws,
 * with the metrics the REAL hook resolves from `agentRows`. The row around it is
 * a stand-in, because the real Agents tree needs a live host.
 */
function AgentRowReadingsSpecimen(): ReactNode {
  const metrics = useNavigatorResourceMetrics();
  return (
    <div
      data-sweep-agent-row
      className="flex items-center justify-between gap-2 px-3 py-1.5 text-ui-sm"
    >
      <span className="truncate">Plan the migration</span>
      <NavigatorResourceHotspotChip
        owner={{
          epicId: EPIC_SURFACE_ID,
          kind: "chat",
          ownerId: TRACKED_AGENT_ID,
          hostId: "sweep-host",
        }}
        metrics={metrics}
        className={undefined}
      />
    </div>
  );
}

/**
 * A task's surface as `EpicSurface` lays it out, through the REAL
 * `EpicSurfaceSheets`: one task sheet, the panel pane on the stored sidebar
 * side, the REAL width handle on the hairline, the content pane beside it. The
 * panel draws the REAL rail across its top (vertical in the collapsed rail) and
 * the REAL task header; the agents tree below is one row's readings specimen.
 */
function EpicWindowSurface(props: {
  readonly session: OpenedStoreForTest;
}): ReactNode {
  const sidebarSide = useArrangementValue("sidebarSide");
  const sidebarWidthPx = useSidebarWidthPx();
  const mainCollapsed = useMainPanelCollapsed(EPIC_SURFACE_ID);
  const stripEdge = sideTabStripEdge(useArrangementValue("tabStripPlacement"));
  const canvasSeam = stripEdge === sidebarSide ? null : stripEdge;
  const statusBarShown = useStatusBarShown();
  const handle = (
    <SidebarWidthResizeHandle side={sidebarSide} hidden={mainCollapsed} />
  );
  const panel = (
    <div
      data-epic-sidebar-panel
      className={cn(
        "flex h-full min-h-0 max-w-[50vw] shrink-0 flex-col overflow-hidden bg-background",
        mainCollapsed && "hidden",
      )}
      style={{ width: sidebarWidthPx }}
    >
      {mainCollapsed ? null : (
        <>
          <EpicLeftPanelRail
            epicId={EPIC_SURFACE_ID}
            tabId={EPIC_SURFACE_ID}
            orientation="horizontal"
          />
          <PanelTaskHeader epicId={EPIC_SURFACE_ID} tabId={EPIC_SURFACE_ID} />
          <AgentRowReadingsSpecimen />
        </>
      )}
    </div>
  );
  const collapsedRail = mainCollapsed ? (
    <div className="shrink-0 overflow-clip bg-background">
      <EpicLeftPanelRail
        epicId={EPIC_SURFACE_ID}
        tabId={EPIC_SURFACE_ID}
        orientation="vertical"
      />
    </div>
  ) : null;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-clip">
      <EpicSessionContext value={props.session}>
        <EpicSurfaceSheets
          tabId={EPIC_SURFACE_ID}
          sidebarSide={sidebarSide}
          sidebar={
            sidebarSide === "right" ? (
              <>
                {handle}
                {panel}
                {collapsedRail}
              </>
            ) : (
              <>
                {collapsedRail}
                {panel}
                {handle}
              </>
            )
          }
        >
          <div
            data-epic-canvas-frame
            className={cn(
              "min-h-0 flex-1 border border-canvas-border/70 max-md:border-0",
              canvasSeam === "left" && "md:border-s-0",
              canvasSeam === "right" && "md:border-e-0",
              statusBarShown && "md:border-b-0",
            )}
          >
            <TileSurfaceSlot
              node={EPIC_SURFACE_CHAT}
              epicId={EPIC_SURFACE_ID}
              paneId="sweep-epsilon-pane"
              viewTabId={EPIC_SURFACE_ID}
              tabSelected
              canvasPaneActive
            />
          </div>
        </EpicSurfaceSheets>
      </EpicSessionContext>
      <StableTileSurfaceHost renderRecordBody={renderHostedBody} />
    </div>
  );
}

// ── The sample window ───────────────────────────────────────────────────────

/**
 * The sample workspace as the app mounts it: a route surface, which is one
 * sheet, holding the sample notice and the sample body (rail, transcript,
 * minimap, dock, composer).
 */
function SampleWindowSurface(): ReactNode {
  return (
    <div
      data-shell-sheet="route"
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-clip"
    >
      <div
        data-sample-notice
        className="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-warning-foreground/40 bg-warning-foreground/14 px-3 text-ui-xs font-medium text-warning-foreground"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Info aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            Sample workspace. Changes apply to your layout.
          </span>
        </span>
      </div>
      <SampleWorkspaceBody />
    </div>
  );
}

// ── The column ──────────────────────────────────────────────────────────────

/**
 * The app column and nothing else, as `app-shell.tsx` arranges it: the shell's
 * own `AppColumnFrame` fed the placement and band kind the way the shell
 * computes them, the real header, the real side strip, the surface for this
 * window and the real status bar in the tail.
 */
export function SweepColumn(props: {
  readonly windowKind: SweepWindow;
  readonly session: OpenedStoreForTest | null;
}): ReactNode {
  const chromeInput = useAppColumnChromeInput();
  const chrome = appColumnChrome(chromeInput);
  const stripEdge = sideTabStripEdge(chromeInput.placement);
  return (
    <div data-sweep-root className="flex min-h-safe-dvh">
      <RootDndProvider>
        <AppColumnFrame
          columnRef={() => undefined}
          {...chrome}
          header={<AppHeader variant="app" />}
          strip={
            stripEdge === null ? null : (
              <SideTabStrip
                edge={stripEdge}
                ownsTitleBar={sideStripOwnsTitleBar(chromeInput)}
              />
            )
          }
          banners={null}
          surface={
            props.windowKind === "epic" && props.session !== null ? (
              <EpicWindowSurface session={props.session} />
            ) : (
              <SampleWindowSurface />
            )
          }
          mainTail={null}
          tail={<AppStatusBar />}
        />
      </RootDndProvider>
    </div>
  );
}

/**
 * A signed-in request context, which is what lets a host query run at all: the
 * harness's AuthService has no session, so every `useHostQuery` stays disabled
 * without one. Set once the runtime has started, and before anything under it
 * mounts.
 */
function RequestContext(props: { readonly children: ReactNode }): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (ready || binding === null) return;
    const unsubscribe = binding.hostClient.onChange(() => {
      setReady(true);
    });
    binding.hostClient.setRequestContext(
      createRendererContextFixture({ bearerToken: "sweep" }),
    );
    return unsubscribe;
  }, [binding, ready]);
  return ready ? props.children : null;
}

export function SweepProviders(props: {
  readonly queryClient: QueryClient;
  readonly runnerHost: MockRunnerHost;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <QueryClientProvider client={props.queryClient}>
      <RunnerHostProvider runnerHost={props.runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={harnessMessengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-sweep-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>
              <RequestContext>
                <RateLimitPollProvider />
                <SampleSceneProvider>{props.children}</SampleSceneProvider>
              </RequestContext>
            </TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}
