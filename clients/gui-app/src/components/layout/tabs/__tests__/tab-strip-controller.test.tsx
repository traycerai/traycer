/**
 * `useTabStripController` is the strip's behaviour without its layout, so a
 * presentation other than the header strip can mount over it. This suite pins:
 *
 *  - the `tab.split.*` and `epic.close` keybinding handlers are registered
 *    exactly once each under the real header `TabStrip` and released on
 *    unmount (`side-tab-strip.test.tsx` counts the same over the side strip),
 *    so a presentation that registered any of these ids itself would read two
 *    live registrations;
 *  - `isEmptyLanding`, read through a trivial list presentation, is true only
 *    with no tabs on route `/` (Home drawn is `tab-strip-home-placement`'s);
 *  - the dialogs are handed back as a node for the presentation to place.
 */
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useTabStripController } from "@/components/layout/tabs/tab-strip-controller";
import { TabStrip } from "@/components/layout/tabs/tab-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import type { ActionId } from "@/lib/keybindings/actions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabItemId } from "@/stores/tabs/layout";
import type { TabRef } from "@/stores/tabs/types";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useAuthStore } from "@/stores/auth/auth-store";
import * as sessions from "@/lib/registries/epic-session-registry";
import * as routing from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  localEntry,
  personalRemoteEntry,
  poolEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";

const pinBinding = vi.hoisted(
  (): {
    current: {
      hostClient: HostClient<HostRpcRegistry>;
      directory: HostDirectoryService;
    } | null;
  } => ({ current: null }),
);

/** Live registrations per action id, and the most ever live at once. */
const registrations = vi.hoisted(
  (): {
    readonly live: Map<string, number>;
    readonly peak: Map<string, number>;
  } => ({ live: new Map(), peak: new Map() }),
);

// Partial: the registry itself stays real; the wrapper only counts how many
// registrations of each id are live at the same time.
vi.mock("@/lib/keybindings/dispatch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/keybindings/dispatch")>();
  return {
    ...actual,
    registerDynamicActionHandler: (
      id: ActionId,
      handler: () => void,
    ): (() => void) => {
      const live = (registrations.live.get(id) ?? 0) + 1;
      registrations.live.set(id, live);
      registrations.peak.set(
        id,
        Math.max(live, registrations.peak.get(id) ?? 0),
      );
      const unregister = actual.registerDynamicActionHandler(id, handler);
      return () => {
        registrations.live.set(id, (registrations.live.get(id) ?? 1) - 1);
        unregister();
      };
    },
  };
});

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock(
  "@/hooks/epic/use-epic-task-pinned-states-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epic/use-epic-task-pinned-states-query")
      >();
    return {
      ...actual,
      useEpicTaskPinnedStates: () => new Map<string, TaskPinnedState>(),
    };
  },
);

// The router-only layout cases need only the active id. The pin cases install
// a real requester and exercise the normal mutation and transport dispatch.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () =>
      pinBinding.current?.hostClient ?? {
        getActiveHostId: () => localEntry.hostId,
      },
    useHostBinding: () => pinBinding.current,
  };
});

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

const KEYBINDING_IDS: ReadonlyArray<ActionId> = [
  "tab.split.add",
  "tab.split.swap",
  "tab.split.separate",
  "tab.split.close-left",
  "tab.split.close-right",
  "epic.close",
];

let queryClient: QueryClient;

/** A second presentation: a plain list over the controller, nothing else. */
function ListPresentation(): ReactNode {
  const controller = useTabStripController();
  return (
    <ul
      data-testid="list-presentation"
      data-empty-landing={String(controller.isEmptyLanding)}
      data-dialogs-returned={String(isValidElement(controller.dialogs))}
    >
      {controller.headerItemIds.map((itemId) => (
        <li key={itemId}>{itemId}</li>
      ))}
    </ul>
  );
}

function buildRouter(initialPath: string, presentation: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{presentation}</TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const elsewhereRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/elsewhere",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, elsewhereRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function setHomeTabEnabled(enabled: boolean): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutStore
    .getState()
    .setRegionValues("homeTab", { shown: enabled ? "shown" : "hidden" });
}

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
}

function openEpicTab(id: string): void {
  useEpicCanvasStore.getState().seedEpic(id, { tabId: id, name: id }, []);
  const ref: TabRef = { kind: "epic", id };
  useTabsStore.setState({
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    stripOrder: [ref],
    systemTabs: { history: null, settings: null },
  });
}

async function renderAt(path: string): Promise<HTMLElement> {
  render(<RouterProvider router={buildRouter(path, <ListPresentation />)} />);
  return screen.findByTestId("list-presentation");
}

describe("useTabStripController", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    registrations.live.clear();
    registrations.peak.clear();
    setHomeTabEnabled(false);
    resetStores();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    setHomeTabEnabled(false);
    resetStores();
    pinBinding.current?.hostClient.dispose();
    pinBinding.current?.directory.dispose();
    pinBinding.current = null;
    vi.restoreAllMocks();
    useAuthStore.setState({ status: "signed-out" });
  });

  it.each([true, false])(
    "uses the open task's peer for a cloud pin when pool configured is %s",
    async (configured) => {
      const epicId = "e-a";
      const taskPeer = configured ? poolEntry : personalRemoteEntry;
      const selection = mountTestSelectionAuthority({
        hosts: [
          { hostId: localEntry.hostId, kind: "local", teamOwned: false },
          {
            hostId: personalRemoteEntry.hostId,
            kind: "remote",
            teamOwned: false,
          },
        ],
        localHostId: localEntry.hostId,
        readyComputers: [localEntry.hostId, personalRemoteEntry.hostId],
        pool: configured ? "ready" : "disabled",
      });
      expect(await selection.activate(localEntry.hostId)).toEqual({ ok: true });
      expect(selection.snapshot().servingPeer).toEqual({
        kind: "computer",
        hostId: localEntry.hostId,
      });
      const plan = routing.createHostRpcTierPlan(configured ? poolEntry : null);
      vi.spyOn(routing, "readProcessHostRpcTierPlan").mockReturnValue(plan);
      vi.spyOn(sessions, "getEpicSessionHostId").mockReturnValue(
        taskPeer.hostId,
      );
      useAuthStore.getState().setSignedIn(
        {
          userId: "synthetic-tab-viewer",
          userName: "Tab viewer",
          email: "viewer@example.invalid",
        },
        { userId: "synthetic-tab-viewer", username: "Tab viewer" },
        [],
      );
      const messenger = new MockHostMessenger({
        registry: hostRpcRegistry,
        requestId: () => "synthetic-tab-pin",
        handlers: {
          "epic.setPinned": ({ pinned }) => ({
            pinned,
            home: "cloud" as const,
          }),
        },
      });
      const findHostById = (id: string) =>
        [localEntry, taskPeer].find((entry) => entry.hostId === id) ?? null;
      const client = new HostClient({
        registry: hostRpcRegistry,
        schedulingPolicy: hostRpcSchedulingPolicy,
        invalidator: createHostQueryInvalidator(queryClient),
        findHostById,
        messenger,
        routing: {
          plan,
          selectedHostId: () => selection.snapshot().effectiveHostId,
          serving: () => readHostServingDecision(findHostById),
        },
      });
      client.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "synthetic-tab-bearer",
          identity: {
            userId: "synthetic-tab-viewer",
            username: "Tab viewer",
            providerHandle: "synthetic-tab-viewer",
          },
        }),
      );
      const { version, websocketUrl } = localEntry;
      if (version === null || websocketUrl === null)
        throw new Error("The local pin fixture must be dialable");
      const directory = new HostDirectoryService({
        runnerHost: new MockRunnerHost({
          signInUrl: "https://auth.example.invalid/sign-in",
          authnBaseUrl: "https://auth.example.invalid",
          localHost: {
            hostId: localEntry.hostId,
            websocketUrl,
            version,
            pid: 1,
            systemHostName: "Synthetic local computer",
            displayName: "Synthetic local computer",
            availability: "available",
          },
          hosts: [],
          workspaceFolderPickerPaths: undefined,
          hasLocalHost: true,
          traycerCli: undefined,
        }),
        remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
        onRegistryPollTick: null,
        authContextId: null,
        credentialGeneration: null,
        localHostIdSeeder: null,
      });
      await directory.start();
      pinBinding.current = {
        hostClient: client.createRequesterForHostId(localEntry.hostId),
        directory,
      };
      openEpicTab(epicId);
      function PinControl(): ReactNode {
        const controller = useTabStripController();
        return (
          <button
            type="button"
            onClick={() =>
              controller.onSetTaskPinned(epicId, true, "Synthetic open task")
            }
          >
            Pin task
          </button>
        );
      }
      render(
        <RouterProvider router={buildRouter("/elsewhere", <PinControl />)} />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Pin task" }));
      await waitFor(() =>
        expect(
          messenger.calls
            .filter((call) => call.method === "epic.setPinned")
            .map((call) => ({
              hostId: call.authority.endpoint.hostId,
              params: call.params,
            })),
        ).toEqual([
          {
            hostId: configured ? taskPeer.hostId : localEntry.hostId,
            params: { epicId, pinned: true },
          },
        ]),
      );
    },
  );

  it("keeps one live registration per id under the real header strip", async () => {
    openEpicTab("e-a");
    render(<RouterProvider router={buildRouter("/elsewhere", <TabStrip />)} />);
    await screen.findByTestId("tab-strip");

    for (const id of KEYBINDING_IDS) {
      expect(registrations.live.get(id)).toBe(1);
      expect(registrations.peak.get(id)).toBe(1);
    }

    cleanup();

    for (const id of KEYBINDING_IDS) {
      expect(registrations.live.get(id)).toBe(0);
    }
  });

  it("reports an empty landing only with Home off, no tabs and route /", async () => {
    const list = await renderAt("/");
    expect(list.getAttribute("data-empty-landing")).toBe("true");
  });

  it("is not an empty landing with a tab open", async () => {
    openEpicTab("e-a");
    const list = await renderAt("/");
    expect(list.getAttribute("data-empty-landing")).toBe("false");
  });

  it("is not an empty landing off the landing route", async () => {
    const list = await renderAt("/elsewhere");
    expect(list.getAttribute("data-empty-landing")).toBe("false");
  });

  it("returns the dialogs as a node for the presentation to place", async () => {
    const list = await renderAt("/elsewhere");
    expect(list.getAttribute("data-dialogs-returned")).toBe("true");
  });
});
