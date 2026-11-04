import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AppColumnFrame } from "@/components/layout/app-column-frame";
import { AppHeader } from "@/components/layout/header/app-header";
import {
  appColumnChrome,
  type AppColumnChromeInput,
} from "@/components/layout/header/app-title-band-kind";
import { VoiceColumnTopRow } from "@/components/layout/voice/voice-top-row";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import type { TabStripPlacement } from "@/lib/layout/layout-arrangement";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabItemId, type StripItem } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The real column frame, header and voice row, because where Talk lands is a
 * layout claim jsdom cannot decide. `?placement=top|left|right` picks the
 * placement and `?wco=mac|win` stands in for the frameless desktop preload, as
 * `sheet-shell-guest-clip.tsx` does: the real `appColumnChrome()` then decides
 * the title band. `?account=1` signs in, which draws the bell and the user menu.
 * Until `__voiceTopRowProbe.openTabs` the tab strip is empty;
 * `__voiceTopRowProbe.fillTabs` stands in for tabs of a given natural width.
 */
declare global {
  interface Window {
    __voiceTopRowProbe?: {
      readonly fillTabs: (width: number) => void;
      readonly offerVoice: () => void;
      readonly goLive: () => void;
      readonly openTabs: (count: number) => void;
    };
  }
}

const search = new URLSearchParams(window.location.search);
const placementParam = search.get("placement");
const PLACEMENT: TabStripPlacement =
  placementParam === "left" || placementParam === "right"
    ? placementParam
    : "top";
const WCO = search.get("wco");
const FRAMELESS = WCO === "mac" || WCO === "win";
const PLATFORM = WCO === "win" ? "win32" : "darwin";

const CHROME_INPUT: AppColumnChromeInput = {
  placement: PLACEMENT,
  platform: FRAMELESS ? PLATFORM : null,
  frameless: FRAMELESS,
};
const CHROME = appColumnChrome(CHROME_INPUT);

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

if (FRAMELESS) {
  Reflect.set(runnerHost, "menu", {
    platform: PLATFORM,
    getSnapshot: () => Promise.resolve({ revision: 1, menus: [] }),
    executeItem: () => Promise.resolve(),
    onChange: () => ({ dispose: () => undefined }),
    openTopLevel: () => Promise.resolve(),
  });
  Reflect.set(window, "runnerHost", runnerHost);
  document.documentElement.classList.add("wco");
}

if (search.get("account") === "1") {
  useAuthStore.getState().setSignedIn(
    {
      userId: "fixture-user",
      userName: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
    },
    { userId: "fixture-user", username: "ada" },
    [],
  );
}

const WINDOWS_BRIDGE = { bridge: null, hasHydrated: true } as const;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let requestCounter = 0;

const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `voice-top-row-${String(++requestCounter)}`,
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
        previousExit: null,
      }),
      "host.notifications.indicatorState": () => ({
        epics: {},
        chats: {},
        complete: true,
      }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
    },
  });

window.__voiceTopRowProbe = {
  fillTabs: (width) => {
    const box = document.querySelector(
      "[data-testid='app-header-centre-gap']",
    )?.previousElementSibling;
    if (box === null || box === undefined) throw new Error("no centre zone");
    const tabs = document.createElement("div");
    tabs.dataset.fixtureTabs = "";
    tabs.style.width = `${String(width)}px`;
    tabs.style.flex = "0 1 auto";
    box.append(tabs);
  },
  offerVoice: () => {
    useVoiceSessionStore.setState({
      availability: "live",
      driver: {
        start: () => undefined,
        end: () => undefined,
        setMuted: () => undefined,
      },
    });
  },
  goLive: () => {
    useVoiceSessionStore.setState({
      phase: "live",
      captions: true,
      focus: {
        botId: "fixture-bot",
        hostId: "fixture-host",
        threadId: null,
        anchorMessageId: null,
        anchorThread: null,
      },
      queue: [
        {
          id: "fixture-waiting",
          kind: "reply",
          botId: "fixture-bot",
          hostId: "fixture-host",
          threadId: null,
          chatId: "fixture-chat",
          messageId: null,
          surfaceId: null,
          title: "A reply",
          author: null,
          line: "A reply",
          at: 0,
          state: "queued",
        },
      ],
    });
  },
  openTabs: (count) => {
    const refs: TabRef[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = `fixture-tab-${String(index)}`;
      useEpicCanvasStore
        .getState()
        .seedEpic(id, { tabId: id, name: `Task ${String(index)}` }, []);
      refs.push({ kind: "epic", id });
    }
    const items: StripItem[] = refs.map((ref) => ({
      kind: "tab",
      id: tabItemId(ref),
      ref,
    }));
    useTabsStore.setState({
      items,
      activeItemId: items[0]?.id ?? null,
      stripOrder: refs,
    });
  },
};

export function Fixture(): ReactNode {
  return (
    <AppColumnFrame
      {...CHROME}
      columnRef={() => undefined}
      header={<AppHeader variant="app" />}
      voiceTopRow={
        CHROME.titleBand === "header" ? null : (
          <VoiceColumnTopRow titleBand={CHROME.titleBand} />
        )
      }
      strip={<nav data-fixture-strip className="w-60 shrink-0" />}
      banners={null}
      surface={<div data-fixture-surface className="size-full" />}
      mainTail={null}
      tail={null}
    />
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
            fallback={<div data-fixture-runtime-fallback />}
          >
            <LazyMotion features={domAnimation}>
              <TooltipProvider>
                <WindowsBridgeContext.Provider value={WINDOWS_BRIDGE}>
                  <Fixture />
                </WindowsBridgeContext.Provider>
              </TooltipProvider>
            </LazyMotion>
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

const container = document.getElementById("root");
if (container !== null)
  createRoot(container).render(<RouterProvider router={buildRouter()} />);
