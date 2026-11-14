import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { MobileEpicTileView } from "@/components/epic-canvas/mobile/mobile-epic-tile-view";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import {
  setMobileApp,
  setMobileAppPlatform,
  setPhoneLayoutOnly,
} from "@/lib/mobile-app";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { LazyMotion, domMax } from "motion/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import "../../../../mobile/src/web/index.native.css";

/** Production split view with mocked host transport for browser touch checks. */
const EPIC_ID = "fixture-epic";
const FIXTURE_HOST_ID = "fixture-host";

const FIXTURE_LOCAL_HOST: LocalHostSnapshot = {
  hostId: FIXTURE_HOST_ID,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  version: "0.0.0-fixture",
  pid: 1,
  systemHostName: "fixture",
  displayName: "fixture",
  availability: "available",
};

const fixtureStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const fixtureMessengerFactory: MessengerFactory<HostRpcRegistry> = (args) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry: args.registry,
    requestId: () => `fixture-req-${Math.random().toString(36).slice(2, 8)}`,
    handlers: {},
  });

// Portalled selector content reads the resolved theme from this context.
const RESOLVED_THEME = {
  resolvedTheme: "dark",
  themePreset: "neutral",
} as const;

const TILE: EpicCanvasTileRef = {
  id: "fixture-spec",
  instanceId: "fixture-spec-inst",
  type: "spec",
  name: "Fixture",
  hostId: FIXTURE_HOST_ID,
};

const runnerHost = new MockRunnerHost({
  signInUrl: "https://auth.traycer.invalid/sign-in",
  authnBaseUrl: "http://127.0.0.1:1",
  localHost: FIXTURE_LOCAL_HOST,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

const epicHandle = openStoreForTest({
  epicId: EPIC_ID,
  userId: null,
  factories: {
    streamClientFactory: fixtureStreamClientFactory,
    laneSelection: null,
  },
  writeCommand: null,
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

declare global {
  interface Window {
    __primarySwitcherOpen?: () => boolean;
  }
}
const TAB_ID = "split-fixture-tab";
window.__primarySwitcherOpen = () =>
  useMobileSwitcherStore.getState().openTabId === TAB_ID;
const first: EpicCanvasTileRef = {
  ...TILE,
  id: "first",
  instanceId: "first",
  name: "First",
};
const second: EpicCanvasTileRef = {
  ...TILE,
  id: "second",
  instanceId: "second",
  name: "Second",
};
const ref = { kind: "epic" as const, id: TAB_ID };
setMobileApp(true);
setMobileAppPlatform("ios");
setPhoneLayoutOnly(true);
useSideTabStripStore.getState().setCollapsed(true);
useSettingsStore.setState({ mobileSwipeHistory: false });
useTabsStore.setState({
  items: [{ kind: "tab", id: "split-item", ref }],
  activeItemId: "split-item",
  stripOrder: [ref],
});
useEpicCanvasStore.setState({
  tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Task" } },
  activeTabId: TAB_ID,
  canvasByTabId: {
    [TAB_ID]: {
      root: {
        kind: "pane",
        id: "pane-A",
        tabInstanceIds: ["first", "second"],
        activeTabId: "first",
        previewTabId: null,
        activationHistory: ["first"],
      },
      activePaneId: "pane-A",
      tilesByInstanceId: { first, second },
      sizesByGroupId: {},
    },
  },
});
useEpicCanvasStore
  .getState()
  .setMobileSecondaryTile(TAB_ID, { instanceId: "second", transient: false });
const history = createMemoryHistory({ initialEntries: ["/"] });
const router = createRouter({
  routeTree: createRootRoute({ component: () => null }),
  history,
});
export function SwipeSplit() {
  const transition = useMobileHistorySwipes();
  return (
    <div style={{ height: "100dvh" }}>
      <MobileEpicTileView epicId={EPIC_ID} tabId={TAB_ID} />
      {transition}
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(
  <RouterContextProvider router={router}>
    <LazyMotion features={domMax}>
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={fixtureMessengerFactory}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="fixture-runtime-fallback" />}
          >
            <TooltipProvider>
              <ResolvedThemeContext.Provider value={RESOLVED_THEME}>
                <EpicSessionContext.Provider value={epicHandle}>
                  <SwipeSplit />
                </EpicSessionContext.Provider>
              </ResolvedThemeContext.Provider>
            </TooltipProvider>
          </HostRuntimeProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    </LazyMotion>
  </RouterContextProvider>,
);
