import { useEffect, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { LandingTerminalHost } from "@/components/home/terminal-panel/landing-terminal-host";
import { TopLevelTabHost } from "@/components/layout/top-level-tab-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { tabItemId, type PersistedTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import "@/index.css";

/**
 * THE START PAGE'S ROW WITH ITS COLLAPSED TERMINAL PANEL PARKED PAST IT.
 *
 * The real `TopLevelTabHost` renders each Start Page through the draft tab
 * module (`renderDraftSurface`: the real `DraftSurfaceProvider` around the real
 * `LandingDraftSurface`), and the real `LandingTerminalHost` sits beside it as
 * `app-shell.tsx` mounts it, portaling the real `LandingTerminalPanel` into the
 * page's own row. Nothing of the row, the panel's collapsed style or the tab
 * strip is reimplemented here.
 *
 * What the fixture supplies is only what the app supplies around them: the
 * provider stack (`tab-recovery.tsx`'s), two Start Pages in the tab strip, and
 * a `terminal.list` answer so the panel's host probe reads "supported". The
 * panel opens collapsed with an unpicked "New tab" row active, which is the
 * state the tab strip's mount-time `scrollIntoView` acts on.
 *
 * Skipped on purpose: `HostScopeReady` (readiness gating is the app shell's
 * concern; the runtime below is ready by construction).
 */
const localHost = {
  hostId: "landing-panel-row-scroll-host",
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4343,
  systemHostName: "landing-panel-row-scroll-fixture",
  displayName: "landing-panel-row-scroll-fixture",
  availability: "available",
} as const;

const PLACEHOLDER_INSTANCE_ID = "landing-panel-row-scroll-placeholder";
const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `landing-panel-row-scroll-${String(++requestCounter)}`,
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
      }),
      "host.notifications.indicatorState": () => ({ epics: {}, chats: {} }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
      "terminal.list": () => ({ sessions: [], homeCwd: "/home/fixture" }),
    },
  });

export function SignedInFixture(props: {
  readonly children: ReactNode;
}): ReactElement {
  const authStatus = useAuthStore((state) => state.status);
  useEffect(() => {
    if (authStatus === "signed-in") return;
    useAuthStore.getState().setSignedIn(
      {
        userId: "landing-panel-row-scroll-user",
        userName: "Row Scroll User",
        email: "row-scroll@example.invalid",
      },
      {
        userId: "landing-panel-row-scroll-user",
        username: "Row Scroll User",
      },
      [],
    );
  }, [authStatus]);
  return <>{props.children}</>;
}

/** Two Start Pages in the strip, the first active, as `tab-recovery.tsx` seeds one. */
function seedStartPages(): ReadonlyArray<string> {
  const draftIds = [
    useLandingDraftStore.getState().createDraft(null),
    useLandingDraftStore.getState().createDraft(null),
  ];
  const layout: PersistedTabStripLayout = {
    version: 2,
    items: draftIds.map((id) => ({
      kind: "tab",
      id: tabItemId({ kind: "draft", id }),
      ref: { kind: "draft", id },
    })),
    activeItemId: tabItemId({ kind: "draft", id: draftIds[0] }),
    activationHistory: [],
    systemTabs: { history: null, settings: null },
  };
  useTabsStore.setState((state) => ({
    ...state,
    ...layout,
    stripOrder: draftIds.map((id) => ({ kind: "draft", id })),
  }));
  return draftIds;
}

/** The unpicked "New tab" row active, the panel left collapsed (its default). */
function seedCollapsedPanelWithActiveTab(): void {
  useLandingPanelStore.getState().openPlaceholder(PLACEHOLDER_INSTANCE_ID, 0);
}

const draftIds = seedStartPages();
seedCollapsedPanelWithActiveTab();
/** Selects the nth Start Page in the strip, as clicking its tab does. */
Reflect.set(window, "__landingPanelRowScroll", {
  activate: (index: number): void => {
    useTabsStore.setState({
      activeItemId: tabItemId({ kind: "draft", id: draftIds[index] }),
    });
  },
});

function buildRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "http://127.0.0.1:9/sign-in",
    authnBaseUrl: "http://127.0.0.1:9",
    localHost,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: new MockTraycerCli(),
  });
}

const runnerHost = buildRunnerHost();

/** The app column's content viewport (`app-column-frame.tsx`): a clipped flex box. */
export function AppSurface(): ReactElement {
  return (
    <div className="flex h-safe-dvh flex-col">
      <div className="relative flex min-h-0 flex-1 overflow-clip">
        <DndContext>
          <TopLevelTabHost />
        </DndContext>
        <LandingTerminalHost />
      </div>
    </div>
  );
}

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={messengerFactory}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="landing-panel-row-scroll-fallback" />}
          >
            <WindowsBridgeContext.Provider value={windowsBridgeValue}>
              <TooltipProvider>
                <SignedInFixture>
                  <AppSurface />
                </SignedInFixture>
              </TooltipProvider>
            </WindowsBridgeContext.Provider>
          </HostRuntimeProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

const root = document.querySelector("#root");
if (root === null)
  throw new Error("landing panel row scroll fixture root missing");
createRoot(root).render(<RouterProvider router={buildRouter()} />);
