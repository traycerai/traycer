import { useEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { LazyMotion, domAnimation } from "motion/react";
import type { BrowserCatalogRecord } from "@traycer/protocol/host/browser/catalog-contracts";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { BrowserCatalogContext } from "@/components/epic-canvas/renderers/browser-catalog-context";
import { BrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { SwitcherBrowsersList } from "@/components/epic-canvas/mobile/switcher-browsers-list";
import {
  BrowsersPanelActions,
  BrowsersPanelBody,
} from "@/components/epic-canvas/sidebar/epic-browser-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { authQueryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useBrowserPanelStore } from "@/stores/epics/browser-panel-store";
import {
  usePanelHeaderSearchOpen,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE GROUPED BROWSER LIST, in real Chrome.
 *
 * The real task browsers panel (`BrowsersPanelActions` + `BrowsersPanelBody`),
 * or with `?surface=mobile` the real task switcher list, over a seeded
 * catalog inventory of three devices: this computer, a device with a long
 * name and a lab device with long titles and URLs. `?width=` sets the column
 * width in CSS pixels, so one page covers the narrow and wide layouts.
 *
 * Reachability comes from a seeded account registry: every device is online,
 * or with `?offline=1` the lab device is confirmed offline and shown.
 *
 * `window.__browserGroupedListProbe.reset` clears the remembered collapse and
 * the search between tests, so a page loads once per spec file.
 */
interface BrowserGroupedListProbe {
  readonly ready: true;
  readonly reset: () => void;
}

declare global {
  interface Window {
    __browserGroupedListProbe?: BrowserGroupedListProbe;
  }
}

const EPIC_ID = "fixture-browsers-epic";
const TAB_ID = "fixture-browsers-tab";
const LOCAL_HOST_ID = "fx-local";
const WORK_HOST_ID = "fx-work";
const LAB_HOST_ID = "fx-lab";

const params = new URLSearchParams(window.location.search);
const MOBILE = params.get("surface") === "mobile";
const WIDTH = Number(params.get("width") ?? "360");
/** `?offline=1` makes the lab device confirmed offline in the account registry and shows it. */
const LAB_OFFLINE = params.get("offline") === "1";

const LONG_URL =
  "https://internal-dashboard.example.com/projects/very/long/path/segment/that/keeps/going?filter=active&sort=updated";

function record(
  hostId: string,
  sessionId: string,
  tabs: ReadonlyArray<{ tabId: string; title: string; url: string }>,
): BrowserCatalogRecord {
  return {
    epicId: EPIC_ID,
    hostId,
    sessionId,
    inventoryRevision: 1,
    lastActivityAt: 1,
    tabs: [...tabs],
  };
}

const RECORDS: readonly BrowserCatalogRecord[] = [
  record(LOCAL_HOST_ID, "s-local", [
    { tabId: "local-docs", title: "Docs", url: "https://docs.example.com" },
    {
      tabId: "local-app",
      title: "Staging app",
      url: "https://staging.example.com",
    },
  ]),
  record(WORK_HOST_ID, "s-work", [
    { tabId: "work-docs", title: "Docs", url: "https://work.example.com/docs" },
    {
      tabId: "work-long",
      title:
        "A very long page title that has to truncate instead of pushing the close button out of the row",
      url: LONG_URL,
    },
  ]),
  record(LAB_HOST_ID, "s-lab", [
    { tabId: "lab-router", title: "Router", url: "http://192.168.0.1" },
  ]),
];

const HOSTS: readonly HostDirectoryEntry[] = [
  {
    hostId: WORK_HOST_ID,
    label: "Production build runner in the east datacenter",
    kind: "remote",
    websocketUrl: "ws://127.0.0.1:9/work",
    version: "1.2.3",
    transportDialability: "dialable",
  },
  {
    hostId: LAB_HOST_ID,
    label: "Lab",
    kind: "remote",
    websocketUrl: "ws://127.0.0.1:9/lab",
    version: "1.2.3",
    transportDialability: "dialable",
  },
];

function registryItem(
  hostId: string,
  name: string,
  offline: boolean,
): HostListItem {
  return {
    hostId,
    displayName: name,
    platform: "darwin",
    kind: "personal",
    publicKey: `key-${hostId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: {
      connectivity: offline ? "offline" : "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.2.3",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    },
    updatePolicy: "manual",
  };
}

/**
 * Answer the same registry query the host pickers read before mounting them.
 * The fixture stays off the network and no frame shows an unresolved registry.
 */
function RegistrySeed(props: { readonly children: ReactNode }): ReactNode {
  const binding = useHostBinding();
  const registry = useQuery(
    queryOptions({
      queryKey:
        binding === null
          ? authQueryKeys.registeredHostsMissing()
          : authQueryKeys.registeredHosts(binding.auth, null),
      queryFn: () =>
        Promise.resolve({
          hosts: [
            registryItem(
              WORK_HOST_ID,
              "Production build runner in the east datacenter",
              false,
            ),
            registryItem(LAB_HOST_ID, "Lab", LAB_OFFLINE),
          ],
        }),
      enabled: binding !== null,
      staleTime: Infinity,
    }),
  );
  return binding === null || !registry.isSuccess ? null : props.children;
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function openSession() {
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  getOpenEpicRegistry().acquire(EPIC_ID, () => handle);
  return handle;
}

const SESSION = openSession();

const liveState: BrowserSessionsState = {
  hostId: LOCAL_HOST_ID,
  lifecycle: "live",
  inventoryReady: true,
  canMaterializeElectron: false,
  connectionGeneration: 0,
  items: [],
  viewports: {},
  setViewport: () => Promise.reject(new Error("not used")),
  reportViewport: () => undefined,
  errorMessage: null,
  retry: () => undefined,
  openTab: () => Promise.reject(new Error("not used")),
  prepareOpenTab: () => {
    throw new Error("not used");
  },
  closeTab: () => Promise.reject(new Error("not used")),
  attachTab: () => Promise.reject(new Error("not used")),
  moveTab: () => Promise.reject(new Error("not used")),
};

const CATALOG = {
  status: "ready" as const,
  scope: "cloud" as const,
  records: RECORDS,
  refetch: () => undefined,
};

function seedCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Fixture" } },
    openTabOrder: [TAB_ID],
  });
}

function reset(): void {
  window.localStorage.clear();
  useBrowserPanelStore.setState({ preferences: {} });
  usePanelHeaderSearchStore.getState().closeSearch(TAB_ID, "browsers");
  if (LAB_OFFLINE)
    useBrowserPanelStore
      .getState()
      .setShowOffline(JSON.stringify([null, EPIC_ID]), true);
  seedCanvas();
}

function Panel(): ReactNode {
  const slotRef = useRef<HTMLDivElement>(null);
  const registerSearchSlot = usePanelHeaderSearchStore(
    (state) => state.registerSearchSlot,
  );
  const unregisterSearchSlot = usePanelHeaderSearchStore(
    (state) => state.unregisterSearchSlot,
  );
  // The header trades its title row for the search field only while search is
  // open, as `epic-sidebar-header.tsx` does, so the slot exists only then.
  const searchOpen = usePanelHeaderSearchOpen(TAB_ID, "browsers");
  useEffect(() => {
    const element = slotRef.current;
    if (element === null) return;
    registerSearchSlot(TAB_ID, "browsers", element);
    return () => unregisterSearchSlot(TAB_ID, "browsers", element);
  }, [registerSearchSlot, searchOpen, unregisterSearchSlot]);
  return (
    <SidebarProvider defaultOpen className="h-full min-h-0 w-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        {searchOpen ? (
          <div
            ref={slotRef}
            className="min-w-0 flex-1"
            data-testid="fixture-search-slot"
          />
        ) : null}
        <BrowsersPanelActions epicId={EPIC_ID} tabId={TAB_ID} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <BrowsersPanelBody epicId={EPIC_ID} tabId={TAB_ID} />
      </div>
    </SidebarProvider>
  );
}

export function Fixture(): ReactNode {
  useEffect(() => {
    window.__browserGroupedListProbe = { ready: true, reset };
    return () => {
      window.__browserGroupedListProbe = undefined;
    };
  }, []);
  return (
    <div className="flex h-dvh bg-canvas text-canvas-foreground">
      <RootDndProvider>
        <div
          data-fixture-panel
          style={{ width: `${String(WIDTH)}px` }}
          className="flex h-full max-w-full shrink-0 flex-col overflow-hidden border-r border-border bg-background"
        >
          {MOBILE ? (
            <SwitcherBrowsersList
              epicId={EPIC_ID}
              tabId={TAB_ID}
              onClose={() => undefined}
            />
          ) : (
            <Panel />
          )}
        </div>
      </RootDndProvider>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: {
    hostId: LOCAL_HOST_ID,
    websocketUrl: "ws://127.0.0.1:9/rpc",
    version: "1.2.3",
    pid: 4343,
    systemHostName: "This Mac",
    displayName: "This Mac",
    availability: "available",
  },
  hosts: HOSTS,
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `browser-grouped-list-${String(++requestCounter)}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
        processMemory: null,
        crossHostMessaging: null,
        sessions: null,
      }),
    },
  });

export function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() =>
            Promise.resolve({ kind: "hosts", entries: HOSTS })
          }
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>
              <EpicSessionContext value={SESSION}>
                <RegistrySeed>
                  <BrowserCatalogContext.Provider value={CATALOG}>
                    <BrowserSessionsContext.Provider value={liveState}>
                      {props.children}
                    </BrowserSessionsContext.Provider>
                  </BrowserCatalogContext.Provider>
                </RegistrySeed>
              </EpicSessionContext>
            </TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

reset();

const container = document.getElementById("root");
if (container !== null)
  createRoot(container).render(
    <Providers>
      <Fixture />
    </Providers>,
  );
