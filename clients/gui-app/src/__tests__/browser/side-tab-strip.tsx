import { useEffect, type ReactNode } from "react";
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
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { SideTabStrip } from "@/components/layout/tabs/side-strip/side-tab-strip";
import { publishTabDetachHandler } from "@/components/layout/tabs/tab-detach-channel";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import {
  DEFAULT_ARRANGEMENT,
  type EdgeSide,
} from "@/lib/layout/layout-arrangement";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLayoutStore } from "@/stores/layout/layout-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import { tabItemId, tabRefKey, type StripItem } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import {
  moveSideStripLongListTask,
  seedSideStripIdleGroup,
  seedSideStripLongList,
  seedSideStripPairs,
  seedSideStripSections,
  seedSideStripTabs,
  seedSideStripWaitingAgents,
  type SeededSection,
} from "./side-tab-strip-seed";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE VERTICAL STRIP'S DRAG GESTURE (S-11), in real Chrome with real mouse
 * input.
 *
 * The real `SideTabStrip` at `?edge=left|right` inside the real
 * `RootDndProvider`, over a seeded tabs store (six tabs, one split, one
 * group), so the row list's scroller, its frames and the rows' drag handles
 * are the ones the provider measures. The driver drags rows along y (a
 * reorder with neighbours displacing, a drop on a row's half that pairs two
 * tabs into a split, a split dragged whole) and sideways out of the strip
 * (the tear-off preview and the new-window request).
 *
 * The content beside the strip is an empty surface, and the strip's other
 * side is a 48px margin so the window edge is not the strip's own edge: that
 * margin is where "pulling toward the window edge" lands, which must not tear
 * off until the pointer leaves the viewport (tech plan 3.5).
 *
 * The real `TabNavigationRouteBridge` is mounted, as the shell mounts it, so a
 * drop that pairs two tabs commits through the tab navigation controller the
 * way it does in the app; the task routes it navigates to render nothing.
 *
 * What is NOT real: the new-window request is recorded, not performed. The
 * route-tree owner that opens a window (`TabDetachOwner`) needs the desktop
 * windows bridge; the fixture publishes a detach handler on the same channel
 * that owner publishes on, so the product's own tear-off decision is what
 * calls it. Opening the window is the Staging pass's.
 *
 * `?scene=sections` puts the strip in the Activity view over a seeded set of
 * tasks that fills every section (Needs you, To review, Working, Idle), for
 * the claims only real layout answers: the rows' heights and what truncates
 * first at the narrowest width.
 *
 * `?scene=sections&tasks=20` is that view over twenty tasks, enough to overflow
 * the list, and `moveTask` puts one of them in another section as its state
 * changing would.
 *
 * `?tasks=idle-group` is the owner's grouping report instead: four idle tasks,
 * the second alone in an organization's group, in either view (add
 * `scene=sections` for the Activity view).
 *
 * `?tasks=pairs` is the split pairs' boards: a task, the current pair, a second
 * pair and Start Page, in either view.
 *
 * `&agents=waiting` names the agent behind each waiting prompt (sections and
 * pairs), so a Needs you task can expand to the agent that asks.
 *
 * `&rail=1` collapses the strip to the rail, which in the sections scene runs
 * the same tasks as tiles in the same sections.
 *
 * `window.__sideTabStripProbe.ready` gates all of it.
 */

interface SideTabStripProbe {
  readonly ready: boolean;
  readonly edge: EdgeSide;
  /** Back to the seeded tabs, so every gesture starts from the same strip. */
  readonly reset: () => void;
  /** The strip's items, each as its tab keys (`epic:<id>`). */
  readonly items: () => ReadonlyArray<ReadonlyArray<string>>;
  /** Whether the provider is showing the tear-off preview right now. */
  readonly tearOffPreview: () => boolean;
  /** The tab keys a released tear-off asked to open in a new window. */
  readonly detachRequests: () => ReadonlyArray<string>;
  /** Puts a task's title back to generating, so its row shows the spinner glyph. */
  readonly markTitlePending: (epicId: string, title: string) => void;
  /** Sets the expanded strip's width, in CSS pixels. */
  readonly setWidth: (widthPx: number) => void;
  /** Moves a long-list task to a section (`tasks=20` only). */
  readonly moveTask: (epicId: string, section: SeededSection) => void;
  /** Makes a task's tab the active one, as a shortcut or a palette jump would. */
  readonly activate: (epicId: string) => void;
}

declare global {
  interface Window {
    __sideTabStripProbe?: SideTabStripProbe;
  }
}

function readEdge(): EdgeSide {
  return new URLSearchParams(window.location.search).get("edge") === "right"
    ? "right"
    : "left";
}

const EDGE = readEdge();
const SECTIONS_SCENE =
  new URLSearchParams(window.location.search).get("scene") === "sections";
const LONG_LIST =
  new URLSearchParams(window.location.search).get("tasks") === "20";
const RAIL = new URLSearchParams(window.location.search).get("rail") === "1";
const IDLE_GROUP =
  new URLSearchParams(window.location.search).get("tasks") === "idle-group";
const PAIRS =
  new URLSearchParams(window.location.search).get("tasks") === "pairs";
const WAITING_AGENTS =
  new URLSearchParams(window.location.search).get("agents") === "waiting";

function seedScene(): void {
  if (SECTIONS_SCENE) {
    useLayoutStore.setState({
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: EDGE,
        sideStripView: "activity",
      },
    });
  }
  if (IDLE_GROUP) seedSideStripIdleGroup();
  else if (PAIRS) seedSideStripPairs();
  else if (!SECTIONS_SCENE) seedSideStripTabs(false);
  else if (LONG_LIST) seedSideStripLongList();
  else seedSideStripSections();
}
const detachRequests: string[] = [];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

let requestCounter = 0;

/** The three calls the runtime makes on startup; the tabs address no host. */
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `side-tab-strip-${String(++requestCounter)}`,
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
    },
  });

function itemKeys(item: StripItem): ReadonlyArray<string> {
  if (item.kind === "tab") return [tabRefKey(item.ref)];
  return [item.left, item.right].flatMap((member) =>
    member.kind === "tab" ? [tabRefKey(member.ref)] : [],
  );
}

function buildProbe(): SideTabStripProbe {
  return {
    ready: true,
    edge: EDGE,
    reset: seedScene,
    items: () => useTabsStore.getState().items.map(itemKeys),
    tearOffPreview: () => useEpicDndStore.getState().headerTearOffPreview,
    detachRequests: () => [...detachRequests],
    markTitlePending: (epicId, title) => {
      useEpicCanvasStore.getState().markEpicTitlePending(epicId, title);
    },
    setWidth: (widthPx) => {
      useSideTabStripStore.setState({ widthPx });
    },
    moveTask: moveSideStripLongListTask,
    activate: (epicId) => {
      useTabsStore.setState({
        activeItemId: tabItemId({ kind: "epic", id: epicId }),
      });
    },
  };
}

/**
 * The window: a margin on the strip's window-edge side, the strip, and the
 * content it tears off into. DOM order is visual order, as in the shell.
 */
export function StripFixture(): ReactNode {
  useEffect(() => {
    const unpublish = publishTabDetachHandler({
      isAvailable: true,
      requestOpen: (tab) => {
        detachRequests.push(tabRefKey({ kind: tab.kind, id: tab.id }));
      },
    });
    window.__sideTabStripProbe = buildProbe();
    return () => {
      unpublish();
      window.__sideTabStripProbe = undefined;
    };
  }, []);

  const margin = (
    <div data-fixture-far-side aria-hidden className="w-12 shrink-0 bg-muted" />
  );
  const content = (
    <main data-fixture-content className="min-w-0 flex-1 bg-background" />
  );
  const shell = (
    <div className="flex h-dvh bg-canvas text-canvas-foreground md:bg-shell-ground">
      <TabNavigationRouteBridge />
      <RootDndProvider>
        {EDGE === "left" ? margin : content}
        <SideTabStrip edge={EDGE} ownsTitleBar={false} />
        {EDGE === "left" ? content : margin}
      </RootDndProvider>
    </div>
  );
  // The sections scene's prompts and finished tasks are cloud-feed rows.
  return SECTIONS_SCENE ? (
    <NotificationFeedModeContext.Provider value="cloud">
      {shell}
    </NotificationFeedModeContext.Provider>
  ) : (
    shell
  );
}

export function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>{props.children}</TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const fixtureErrors: string[] = [];
window.addEventListener("error", (event) => {
  fixtureErrors.push(
    event.error instanceof Error
      ? (event.error.stack ?? event.message)
      : event.message,
  );
});
window.addEventListener("unhandledrejection", (event) => {
  fixtureErrors.push(
    event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason),
  );
});
Reflect.set(window, "__sideTabStripErrors", fixtureErrors);

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <Providers>
        <StripFixture />
      </Providers>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  // The task routes a tab activation or a pair navigates to. They render
  // nothing: the strip is the surface under test, and the route bridge only
  // needs the location to resolve.
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => null,
  });
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, epicTabRoute, epicRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

installTabSyncCoordinator({ readyPromise: Promise.resolve() });
useSideTabStripStore.getState().resetWidth();
useSideTabStripStore.getState().setCollapsed(RAIL);
seedScene();
if (WAITING_AGENTS) seedSideStripWaitingAgents(PAIRS);

const container = document.getElementById("root");
if (container !== null)
  createRoot(container).render(<RouterProvider router={buildRouter()} />);
