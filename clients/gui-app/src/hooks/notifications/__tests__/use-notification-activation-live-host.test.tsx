import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import type { NotificationPayload } from "@/lib/notifications";

interface StubActivationHostClient {
  readonly getActiveHostId: () => string | null;
  readonly createRequesterForHostId: (
    hostId: string | null,
  ) => StubActivationHostClient;
}

const bindingState = vi.hoisted<{
  current: {
    readonly hostClient: StubActivationHostClient;
    readonly directory: IHostDirectoryService;
  } | null;
}>(() => ({ current: null }));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => bindingState.current,
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

import {
  useNotificationActivation,
  type NotificationActivationController,
} from "@/hooks/notifications/use-notification-activation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";

const HOST_A = "host-a-live";
const HOST_B = "host-b-live";

/** The authority's pointer, seeded rather than stubbed: the activation reads
 * it live, and `routeNotificationForHost` is the real router under test. */
function setEffectiveHost(hostId: string): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: 1,
  });
}

function emptyDirectory(): IHostDirectoryService {
  const entries: readonly HostDirectoryEntry[] = [];
  return {
    list: () => Promise.resolve(entries),
    findById: () => null,
    refresh: () => Promise.resolve(entries),
    refreshForEra: () => Promise.resolve(entries),
    invalidateInFlightRefresh: () => undefined,
  };
}

function bindStubClient(): void {
  const hostClient: StubActivationHostClient = {
    getActiveHostId: () => null,
    createRequesterForHostId: () => hostClient,
  };
  bindingState.current = { hostClient, directory: emptyDirectory() };
}

const PROMPTS: ReadonlyArray<{
  readonly name: string;
  readonly payload: NotificationPayload;
}> = [
  {
    name: "approval",
    payload: {
      kind: "approval",
      epicId: "epic-origin",
      chatId: "chat-origin",
      approvalId: "approval-1",
      sessionId: undefined,
      artifactId: undefined,
    },
  },
  {
    name: "interview",
    payload: {
      kind: "interview",
      epicId: "epic-origin",
      chatId: "chat-origin",
      interviewBlockId: "block-1",
    },
  },
];

/**
 * Mounts the real activation hook under a real router and keeps the callback
 * from THIS render, the way a click handler captured earlier would. The
 * epic-tab route is the one a notification activation navigates to.
 */
async function mountRetained(payload: NotificationPayload): Promise<{
  readonly markAsRead: Mock<(row: MergedNotificationRow | string) => void>;
  readonly close: Mock<() => void>;
  readonly router: {
    readonly state: { readonly location: { readonly pathname: string } };
  };
  readonly activate: () => void;
}> {
  let retained: NotificationActivationController | null = null;
  function Probe(): ReactNode {
    const controller = useNotificationActivation();
    retained ??= controller;
    return <Outlet />;
  }
  const rootRoute = createRootRoute({ component: Probe });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
  });
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    validateSearch: (search: Record<string, unknown>) => search,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, epicTabRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  const markAsRead = vi.fn<(row: MergedNotificationRow | string) => void>();
  const close = vi.fn<() => void>();
  return {
    markAsRead,
    close,
    router,
    activate: () => {
      if (retained === null) throw new Error("expected a mounted activation");
      const controller = retained;
      act(() => {
        controller.activate({
          payload,
          receivedAt: 1,
          feedId: "host:prompt-1",
          originHostId: HOST_A,
          onResult: activationResultHandler({
            row: null,
            feedId: "host:prompt-1",
            surface: "center",
            markAsRead,
            onSuccess: close,
          }),
        });
      });
    },
  };
}

describe("notification activation reads the live host", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    bindStubClient();
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  describe.each(PROMPTS)("$name raised on host A", ({ payload }) => {
    it("is not acknowledged when the authority moved to host B after render", async () => {
      setEffectiveHost(HOST_A);
      const retained = await mountRetained(payload);

      setEffectiveHost(HOST_B);
      retained.activate();

      // Routing still opened the epic - through B, which is not the origin.
      await waitFor(() => {
        expect(retained.router.state.location.pathname).toMatch(
          /^\/epics\/epic-origin\//,
        );
      });
      expect(retained.markAsRead).not.toHaveBeenCalled();
      expect(retained.close).not.toHaveBeenCalled();
    });

    it("is acknowledged when the authority returned to host A after render", async () => {
      setEffectiveHost(HOST_B);
      const retained = await mountRetained(payload);

      setEffectiveHost(HOST_A);
      retained.activate();

      await waitFor(() => {
        expect(retained.router.state.location.pathname).toMatch(
          /^\/epics\/epic-origin\//,
        );
      });
      expect(retained.markAsRead).toHaveBeenCalledWith("host:prompt-1");
      expect(retained.close).toHaveBeenCalledTimes(1);
    });
  });
});
