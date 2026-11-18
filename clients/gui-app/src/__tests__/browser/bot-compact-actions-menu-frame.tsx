import {
  useEffect,
  useLayoutEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import { MobileBotHeaderSlotProvider } from "@/components/layout/header/mobile-bot-header-slot";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
} from "@/lib/host";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import { BotDraftsPersistLifecycleBridge } from "@/providers/bot-drafts-persist-lifecycle-bridge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";
import "@/index.css";
import {
  messengerFactory,
  queryClient,
  requestContext,
  runnerHost,
  USER_ID,
  windowsBridgeValue,
} from "./bot-compact-actions-menu-host";

/** Holds the page back until the host client has its request context. */
function RequestContextGate(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || binding === null) return;
    const unsubscribe = binding.hostClient.onChange(() => setReady(true));
    binding.hostClient.setRequestContext(requestContext);
    return unsubscribe;
  }, [binding, ready]);
  return ready ? props.children : null;
}

function SignedIn(props: { readonly children: ReactNode }): ReactElement {
  const authStatus = useAuthStore((state) => state.status);
  useEffect(() => {
    if (authStatus === "signed-in") return;
    useAuthStore.getState().setSignedIn(
      {
        userId: USER_ID,
        userName: "Fixture User",
        email: "compact-actions-menu@example.invalid",
      },
      { userId: USER_ID, username: "Fixture User" },
      [],
    );
  }, [authStatus]);
  return <>{props.children}</>;
}

/** Marks the first commit of what it holds, for a sampler that starts there. */
function CommitMarker(): null {
  useLayoutEffect(() => {
    window.__fixtureCommitted = true;
  }, []);
  return null;
}

/** The app around a tab: header, providers and the pane the tab fills. */
function FixtureFrame(props: { readonly children: ReactNode }): ReactElement {
  return (
    <ResolvedThemeContext.Provider
      value={{ resolvedTheme: "light", themePreset: "neutral" }}
    >
      <MobileBotHeaderSlotProvider>
        <div className="flex h-safe-dvh min-h-0 flex-col bg-background">
          <MobileAppHeader />
          <div className="flex min-h-0 flex-1">
            <ChatOpenStoreScopeProvider value="compact-actions-menu">
              <ActivityGroupOpenStoreProvider store={null}>
                <A2AOpenStoreProvider store={null}>
                  <ChatFindForceStoreProvider tileInstanceId="compact-actions-menu">
                    <div className="h-full w-[var(--pane-width,100%)]">
                      <CommitMarker />
                      {props.children}
                    </div>
                  </ChatFindForceStoreProvider>
                </A2AOpenStoreProvider>
              </ActivityGroupOpenStoreProvider>
            </ChatOpenStoreScopeProvider>
          </div>
        </div>
      </MobileBotHeaderSlotProvider>
    </ResolvedThemeContext.Provider>
  );
}

function buildRouter(content: ReactElement) {
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
            fallback={<div data-testid="bot-compact-actions-menu-fallback" />}
          >
            <WindowsBridgeContext.Provider value={windowsBridgeValue}>
              <TooltipProvider>
                <SignedIn>
                  <BotDraftsPersistLifecycleBridge>
                    <RequestContextGate>
                      <FixtureFrame>{content}</FixtureFrame>
                    </RequestContextGate>
                  </BotDraftsPersistLifecycleBridge>
                </SignedIn>
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

/** The fixture app with `children` as the tab, over the fake host. */
export function FixtureApp(props: {
  readonly children: ReactElement;
}): ReactElement {
  const [router] = useState(() => buildRouter(props.children));
  return <RouterProvider router={router} />;
}
