import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import { useLayoutHotspot } from "@/components/customize/use-layout-hotspot";
import { TabStripHomeItem } from "@/components/layout/tabs/tab-strip-home-item";
import { StatusBarUsageTrigger } from "@/components/layout/status-bar/status-bar-rate-limit-cluster";
import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";
import { useStatusBarUsageDisplay } from "@/components/layout/status-bar/status-bar-usage-display";
import { StatusBarUsageScroller } from "@/components/layout/status-bar/status-bar-usage-scroller";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { SampleWorkspaceBody } from "@/components/sample-workspace/sample-workspace-body";
import { Popover } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { enterCustomize, exitCustomize } from "@/lib/customize/enter-exit";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useLayoutStore } from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
// Side effect: mirrors the store's `panelAnimations` onto <html data-reduce-panel-motion>.
import "@/lib/theme-applier";
import "@/index.css";

/**
 * Real-layout fixture for the Customize overlay over the sample workspace.
 * The driver (`scripts/customize-overlay-browser.mjs`) uses native CDP input.
 *
 * REAL: the Home tab (tabs.home hotspot), the usage handle (statusBar.usage,
 * same 24px dashed box as `StatusBarUsageSlot`'s), CustomizeOverlay (bar, search, proxies, popover, dnd, real
 * `useHotspotRects` on real layout), SampleSceneProvider, SampleWorkspaceBody
 * (rail, transcript, dock, composer + toolbar, minimap), the status-bar usage
 * scroller / trigger / provider segments / resource segment, the real
 * stylesheet, a real memory-history router (search navigates).
 * NOT REAL: AppShell / AppHeader / TopLevelTabHost / the strip's host-scope
 * hooks (too much to import; the `data-customize-inert` wrappers below mimic
 * AppShell's header / main / status-bar markers only). The footer cluster is
 * hand-built, so it proves geometry, not live rate-limit data.
 *
 * `?accounts=N` footer accounts, `?long=1` long account labels.
 */
const params = new URLSearchParams(window.location.search);
const PROVIDERS = ["codex", "claude-code", "grok"] as const;
const LONG_LABEL =
  "A deliberately long account label that keeps going and going";

function accountSegment(index: number): StatusBarProviderSegmentModel {
  const providerId = PROVIDERS[index % PROVIDERS.length];
  const profileId = `profile-${index}`;
  const window = {
    windowKey: `${providerId}:primary`,
    label: "5h",
    labelIsDuration: true,
    kind: "session" as const,
    usedPercent: 17 + index * 9,
    resetsAt: Date.now() + 6 * 60 * 60_000 - 30_000,
    severity: "healthy" as const,
  };
  return {
    providerId,
    profileId,
    hidden: false,
    account: {
      profileId,
      accentColor: "#5b8def",
      label: params.get("long") === "1" ? `${LONG_LABEL} ${index}` : "work",
    },
    state: "live",
    reason: null,
    windows: [window],
    shown: [window],
    tightest: window,
  };
}

const cluster: StatusBarRateLimitCluster = {
  kind: "segments",
  segments: Array.from(
    { length: Number(params.get("accounts") ?? "3") },
    (_u, i) => accountSegment(i),
  ),
};

/** Mirrors `StatusBarUsageSlot`'s handle: registered and drawn only while editing. */
export function UsageHandle() {
  const { ref, editing } = useLayoutHotspot({
    settingId: "statusBar.usage",
    tileId: null,
    ghost: false,
    condition: null,
  });
  return editing ? (
    <span
      ref={ref}
      data-testid="status-bar-usage-handle"
      className="mr-1 inline-flex size-6 shrink-0 rounded-xs border border-dashed border-border/60"
    />
  ) : null;
}

export function Footer() {
  const display = useStatusBarUsageDisplay();
  return (
    <div
      data-customize-inert
      data-testid="app-status-bar"
      className="shrink-0 border-t border-border/90 bg-canvas text-canvas-foreground"
    >
      <div className="flex h-6 items-center gap-2 px-2 text-ui-xs tabular-nums">
        <Popover>
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <UsageHandle />
            <StatusBarUsageScroller
              hostId="fixture-host"
              cluster={cluster}
              testId="status-bar-rate-limit-scroller"
            >
              <StatusBarUsageTrigger
                cluster={cluster}
                display={display}
                onRevealProfile={() => undefined}
              />
            </StatusBarUsageScroller>
          </span>
        </Popover>
        <StatusBarResourceSegment
          hostId="fixture-host"
          hostLabel="Fixture"
          hasExplicitPick={false}
          interactive
        />
      </div>
    </div>
  );
}

function enter(): boolean {
  return enterCustomize({
    scene: "sample",
    opener: { kind: "none" },
    target: null,
  });
}

export function Page() {
  useEffect(() => {
    if (params.get("view") !== "layout") enter();
  }, []);
  if (params.get("view") === "layout")
    return (
      <div className="w-full min-w-0 p-2">
        <LayoutSettingsPanel />
      </div>
    );
  return (
    <>
      <SampleSceneProvider>
        <div className="flex h-full flex-col">
          <header
            data-customize-inert
            className="flex min-h-10 shrink-0 items-center gap-2 border-b px-2 text-ui-sm"
          >
            <TabStripHomeItem
              isActive={false}
              onActivate={() => undefined}
              badgeCount={0}
            />
            Header stand-in
          </header>
          <main data-customize-inert className="flex min-h-0 flex-1 flex-col">
            <SampleWorkspaceBody />
          </main>
          <Footer />
        </div>
      </SampleSceneProvider>
      <CustomizeOverlay />
    </>
  );
}

useSettingsStore.setState({ visualLayoutEditorEnabled: true });
// Animations on so the reduced-motion checks have something to remove.
useThemeLibraryStore.setState({ panelAnimations: true });
// The driver reads state back and uses `enter` / `exit` (lease retry, re-entry)
// and the theme store (the app's animation switch); every other action is
// native input.
Object.assign(window, {
  __fixture: {
    customize: useCustomizeStore,
    layout: useLayoutStore,
    theme: useThemeLibraryStore,
    settings: useSettingsStore,
    enter,
    exit: () => exitCustomize("done"),
  },
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const runnerHost = new MockRunnerHost({
  signInUrl: "https://auth.traycer.invalid/sign-in",
  authnBaseUrl: "http://localhost:5005",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});
const router = createRouter({
  routeTree: createRootRoute({ component: Page }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(
  <RunnerHostProvider runnerHost={runnerHost}>
    <QueryClientProvider client={queryClient}>
      <HostRuntimeProvider
        registry={hostRpcRegistry}
        messengerFactory={(args: { registry: HostRpcRegistry }) =>
          new MockHostMessenger<HostRpcRegistry>({
            registry: args.registry,
            requestId: () => "customize-browser-request",
            handlers: {},
          })
        }
        invalidator={null}
        requestId={null}
        remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
        fallback={null}
      >
        <LazyMotion features={domAnimation}>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </LazyMotion>
      </HostRuntimeProvider>
    </QueryClientProvider>
  </RunnerHostProvider>,
);
