import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useNotificationCenterOpenLifecycle } from "@/hooks/notifications/use-notification-center-open-lifecycle";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";

const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));

const directoryRef = vi.hoisted(() => ({
  value: null as {
    findById: (hostId: string) => typeof mockLocalHostEntry | null;
  } | null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => activeHostIdRef.value,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    if (hostId.length === 0 || directoryRef.value === null) return null;
    return directoryRef.value.findById(hostId);
  },
}));

function LifecycleHarness(): ReactNode {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lifecycle = useNotificationCenterOpenLifecycle({
    triggerRef,
    headingRef,
  });

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        data-testid="lifecycle-trigger"
        onPointerDown={lifecycle.onTriggerPointerDown}
        onKeyDown={lifecycle.onTriggerKeyDown}
        onClick={() => {
          const openEvent = new Event("focus", { cancelable: true });
          lifecycle.onContentOpenAutoFocus(openEvent);
        }}
      >
        Open
      </button>
      <h2 ref={headingRef} tabIndex={-1} data-testid="lifecycle-heading">
        Heading
      </h2>
      <button
        type="button"
        data-testid="lifecycle-escape-close"
        onClick={() => {
          lifecycle.onContentEscapeKeyDown();
          const closeEvent = new Event("focus", { cancelable: true });
          lifecycle.onContentCloseAutoFocus(closeEvent);
        }}
      >
        Escape close
      </button>
      <button
        type="button"
        data-testid="lifecycle-other-close"
        onClick={() => {
          const closeEvent = new Event("focus", { cancelable: true });
          lifecycle.onContentCloseAutoFocus(closeEvent);
        }}
      >
        Other close
      </button>
      <button
        type="button"
        data-testid="lifecycle-programmatic-open"
        onClick={() => {
          const openEvent = new Event("focus", { cancelable: true });
          lifecycle.onContentOpenAutoFocus(openEvent);
        }}
      >
        Programmatic open
      </button>
    </div>
  );
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.com",
    authnBaseUrl: "https://auth.example.com",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function mountBellWithRouter(): void {
  const queryClient = createTestQueryClient();
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <RunnerHostProvider runnerHost={createRunnerHost()}>
        <TooltipProvider>
          <NotificationsBell />
        </TooltipProvider>
      </RunnerHostProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("useNotificationCenterOpenLifecycle", () => {
  beforeEach(() => {
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    useNotificationsPopoverStore.getState().setOpen(false);
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    useNotificationsPopoverStore.getState().setOpen(false);
  });

  it("does not focus the heading on pointer open", () => {
    render(<LifecycleHarness />);
    const heading = screen.getByTestId("lifecycle-heading");
    const trigger = screen.getByTestId("lifecycle-trigger");

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    expect(document.activeElement).not.toBe(heading);
  });

  it("focuses the heading on keyboard Enter/Space open", () => {
    render(<LifecycleHarness />);
    const heading = screen.getByTestId("lifecycle-heading");
    const trigger = screen.getByTestId("lifecycle-trigger");

    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(heading);

    heading.blur();
    fireEvent.keyDown(trigger, { key: " " });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(heading);
  });

  it("focuses the heading on programmatic open", () => {
    render(<LifecycleHarness />);
    const heading = screen.getByTestId("lifecycle-heading");

    fireEvent.click(screen.getByTestId("lifecycle-programmatic-open"));
    expect(document.activeElement).toBe(heading);
  });

  it("returns focus to the trigger on escape close only", () => {
    render(<LifecycleHarness />);
    const trigger = screen.getByTestId("lifecycle-trigger");
    const heading = screen.getByTestId("lifecycle-heading");

    fireEvent.click(screen.getByTestId("lifecycle-programmatic-open"));
    expect(document.activeElement).toBe(heading);

    fireEvent.click(screen.getByTestId("lifecycle-escape-close"));
    expect(document.activeElement).toBe(trigger);

    // Non-escape close must not yank focus back to the trigger.
    const other = document.createElement("button");
    other.type = "button";
    other.textContent = "elsewhere";
    document.body.appendChild(other);
    other.focus();
    fireEvent.click(screen.getByTestId("lifecycle-other-close"));
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("resets modality so a stale pointer flag does not suppress a later programmatic open", () => {
    render(<LifecycleHarness />);
    const heading = screen.getByTestId("lifecycle-heading");
    const trigger = screen.getByTestId("lifecycle-trigger");

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(heading);

    fireEvent.click(screen.getByTestId("lifecycle-programmatic-open"));
    expect(document.activeElement).toBe(heading);
  });

  it("integrates pointer open vs programmatic open through NotificationsBell", async () => {
    mountBellWithRouter();
    const bell = await screen.findByTestId("notifications-bell");

    fireEvent.pointerDown(bell);
    fireEvent.click(bell);
    const popover = await screen.findByTestId("notifications-popover");
    const heading = popover.querySelector("h2");
    if (heading === null) throw new Error("missing heading");
    expect(document.activeElement).not.toBe(heading);

    act(() => {
      useNotificationsPopoverStore.getState().setOpen(false);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    });

    act(() => {
      useNotificationsPopoverStore.getState().setOpen(true);
    });
    const reopened = await screen.findByTestId("notifications-popover");
    const reopenedHeading = reopened.querySelector("h2");
    if (reopenedHeading === null) throw new Error("missing heading");
    await waitFor(() => {
      expect(document.activeElement).toBe(reopenedHeading);
    });
  });

  it("returns focus to the bell on Escape and not on settings navigation close", async () => {
    useSettingsSectionStore.getState().setSection(null);
    mountBellWithRouter();
    const bell = await screen.findByTestId("notifications-bell");

    fireEvent.keyDown(bell, { key: "Enter" });
    fireEvent.click(bell);
    const popover = await screen.findByTestId("notifications-popover");
    const heading = popover.querySelector("h2");
    if (heading === null) throw new Error("missing heading");
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });

    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    });
    // Tooltip may remount the trigger node; identity is by testid, not ref.
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "notifications-bell",
    );

    act(() => {
      useNotificationsPopoverStore.getState().setOpen(true);
    });
    await screen.findByTestId("notifications-popover");
    // Header gear is a direct button (no overflow menu).
    expect(screen.queryByTestId("notifications-overflow-menu")).toBeNull();
    fireEvent.click(await screen.findByTestId("notifications-open-settings"));

    await waitFor(() => {
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    });
    // Settings close is not Escape - focus must not be forced onto the bell.
    expect(document.activeElement?.getAttribute("data-testid")).not.toBe(
      "notifications-bell",
    );
    expect(useSettingsSectionStore.getState().section).toBe("notifications");
  });
});
