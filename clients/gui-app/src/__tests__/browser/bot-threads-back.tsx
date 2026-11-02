import { useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
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
import { BotThreadsView } from "@/components/bots/bot-threads-view";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import "@/index.css";

/**
 * THE THREADS VIEW IN A BOT TAB NARROWER AND WIDER THAN THE CHANNEL COLUMN.
 *
 * The real `BotThreadsView` sits in a container as the bot tab's is
 * (`@container`), `?width=<px>` wide. Below the width at which the tab shows
 * its channel column, the view's own back control is the way back to the
 * channel, and choosing it gives the pane back to the channel; at that width
 * and above, the column's channel row is, and the view draws no back
 * control. The host answers its status only: the list under the header is
 * not what the spec reads.
 */
const HOST_ID = "bot-threads-back-host";

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4546,
  systemHostName: "bot-threads-back-fixture",
  displayName: "bot-threads-back-fixture",
  availability: "available",
} as const;

const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `bot-threads-back-${String(++requestCounter)}`,
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
        updatesExternallyManaged: null,
      }),
    },
  });

const width = new URLSearchParams(window.location.search).get("width");

export function Tab(): ReactElement {
  const [threadsShown, setThreadsShown] = useState(true);
  return (
    <div
      className="@container flex h-safe-dvh"
      style={width === null ? undefined : { width: `${width}px` }}
      data-testid="bot-tab"
    >
      <TabHostContext.Provider value={HOST_ID}>
        {threadsShown ? (
          <BotThreadsView
            level2={null}
            hostId={HOST_ID}
            channelTitle="Tracy"
            onBack={() => setThreadsShown(false)}
          />
        ) : (
          <p data-testid="channel">Tracy</p>
        )}
      </TabHostContext.Provider>
    </div>
  );
}

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: new MockTraycerCli(),
});

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
            fallback={<div data-testid="bot-threads-back-fallback" />}
          >
            <WindowsBridgeContext.Provider value={windowsBridgeValue}>
              <TooltipProvider>
                <Tab />
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
if (root === null) throw new Error("bot threads back fixture root missing");
createRoot(root).render(<RouterProvider router={buildRouter()} />);
