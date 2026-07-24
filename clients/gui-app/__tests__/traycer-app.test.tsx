import {
  installAuthValidationFetch,
  installMockLocalStorage,
} from "./test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  mockInProcessHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  TraycerApp,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "../index";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAppDialogStore } from "@/stores/dialogs/app-dialog-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { queryClient } from "@/lib/query-client";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { epicCanvasKey } from "@/lib/persist";
import {
  __resetNotificationsStoreForTests,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  GuiHarnessId,
  GuiHarnessOption,
} from "@traycer/protocol/host/index";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEntry,
} from "@traycer/protocol/notifications/notification-entry";

function mockMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function buildHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://platform.traycer.ai?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    hasLocalHost: false,
    workspaceFolderPickerPaths: undefined,
    traycerCli: undefined,
  });
}

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
};
const TRAYCER_APP_TEST_TIMEOUT_MS = 30_000;

function buildHostWithLocalHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://platform.traycer.ai?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: localSnapshot,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function resetEpicCanvasStore(): void {
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState());
}

function guiHarness(id: GuiHarnessId, label: string): GuiHarnessOption {
  return {
    id,
    label,
    enabled: true,
    available: true,
    error: null,
    modes: ["gui", "tui"],
    requiresApiKey: false,
    supportedPermissionModes: [
      "supervised",
      "auto_accept_edits",
      "full_access",
    ],
    availabilityPending: false,
  };
}

function hostStatusResponse() {
  return {
    ready: true,
    hostVersion: "1.2.3",
    protocolVersion: { major: 1, minor: 0 },
  };
}

function harnessIdFromCallParams(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  if (!("harnessId" in params)) return null;
  return typeof params.harnessId === "string" ? params.harnessId : null;
}

describe("<TraycerApp />", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    installMockLocalStorage();
    window.localStorage.clear();
    resetEpicCanvasStore();
    __resetNotificationsStoreForTests();
    queryClient.clear();
    document.documentElement.className = "";
    mockMatchMedia();
    Object.defineProperty(window, "scrollTo", {
      writable: true,
      value: () => undefined,
    });
    window.history.replaceState({}, "", "/");
    useAppDialogStore.setState({ activeDialog: null });
    useAuthStore.getState().setSignedOut();
    useOnboardingStore.setState({ completedAt: 1 });
    restoreFetch = installAuthValidationFetch();
  });

  afterEach(() => {
    cleanup();
    resetEpicCanvasStore();
    __resetNotificationsStoreForTests();
    queryClient.clear();
    useAuthStore.getState().setSignedOut();
    restoreFetch();
  });

  it("mounts against a MockRunnerHost and renders the signed-out auth landing surface without host binding", async () => {
    const host = buildHost();
    render(
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={null}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Sign in" }),
    ).not.toBeNull();
    expect(
      await screen.findByRole("heading", {
        name: /welcome to traycer/i,
      }),
    ).not.toBeNull();
    // User menu (which now hosts the Switch host action) should not
    // appear while signed-out.
    expect(screen.queryByTestId("user-menu-trigger")).toBeNull();
  });

  it("starts the device flow and opens the verification page through openExternalLink on sign-in", async () => {
    const host = buildHost();
    render(
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={null}
      />,
    );

    const signIn = await screen.findByRole("button", {
      name: "Sign in",
    });
    fireEvent.click(signIn);

    await waitFor(() => {
      expect(host.deviceFlow.startCalls).toBe(1);
    });
    // signIn() runs the device flow directly and opens the pre-filled
    // verification page from the `/device/authorize` response - not the
    // shell's redirect sign-in URL.
    await waitFor(() => {
      expect(host.openedExternalLinks).toHaveLength(1);
    });
    expect(host.openedExternalLinks[0]).toBe(
      "https://app.traycer.ai/device?user_code=ABCDE-FGHIJ",
    );
  });

  it(
    "does not expose Switch host in the user menu after the chip rewire",
    async () => {
      // Host switching now lives on the combined chip near the
      // composer; the user-menu Switch host entry was removed alongside
      // the host-status footer. The mobile-host-gate path still
      // owns the auto-open picker for zero/many cardinalities.
      const host = buildHostWithLocalHost();
      render(
        <TraycerApp
          runnerHost={host}
          registry={hostRpcRegistry}
          remoteFetcher={null}
        />,
      );

      const signInButton = await screen.findByRole("button", {
        name: "Sign in",
      });
      // Start the device-flow attempt, then drive its poll to the authorized
      // terminal so the app lands signed-in.
      fireEvent.click(signInButton);
      await waitFor(() => {
        expect(host.deviceFlow.lastSession).not.toBeNull();
      });
      act(() => {
        host.deviceFlow.emitResult({
          kind: "authorized",
          token: "test-token",
          refreshToken: "test-token-refresh",
        });
      });

      const menuTrigger = await screen.findByTestId(
        "user-menu-trigger",
        undefined,
        { timeout: TRAYCER_APP_TEST_TIMEOUT_MS },
      );
      fireEvent.click(menuTrigger);
      expect(screen.queryByTestId("user-menu-switch-host")).toBeNull();
    },
    TRAYCER_APP_TEST_TIMEOUT_MS,
  );

  it("renders a visible failure message and keeps Sign in enabled as the retry CTA on a failed device attempt", async () => {
    const host = buildHost();
    render(
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={null}
      />,
    );

    const signIn = await screen.findByRole("button", {
      name: "Sign in",
    });
    fireEvent.click(signIn);
    await waitFor(() => {
      expect(host.deviceFlow.lastSession).not.toBeNull();
    });
    // A terminal device-flow error surfaces the generic sign-in-failed copy.
    host.deviceFlow.emitResult({ kind: "error" });

    const errorNode = await screen.findByRole("alert");
    expect(errorNode.textContent).toContain("Sign-in failed");

    // The button remains the retry CTA.
    const retry = await screen.findByRole("button", {
      name: "Sign in",
    });
    expect(retry).not.toBeNull();
    fireEvent.click(retry);

    // After a new signIn() the error is cleared and the active approval panel
    // takes over instead of showing a separate disabled "Signing in" button.
    await screen.findByRole("heading", { name: "Approve in your browser" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Signing in" })).toBeNull();
  });

  it(
    "renders the /epics list with rows from a mocked epic.listTasks response when a messengerFactory is provided",
    async () => {
      const host = buildHostWithLocalHost();
      // Seed a persisted token so AuthService.start() rehydrates it through
      // the `/api/v2/user` fetch stub and flips auth-store to `signed-in`.
      host.tokenStoreEntries.set("traycer.token", {
        token: "dev-runner-token",
        refreshToken: "dev-runner-token-refresh",
        authnBaseUrl: host.authnBaseUrl,
        savedAt: "2024-01-01T00:00:00.000Z",
        user: {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        },
      });

      const listTasksResponse: ListTasksResponse = {
        tasks: [
          {
            epic: {
              light: {
                id: "smoke-epic-1",
                title: "Smoke Epic Alpha",
                initialUserPrompt: "smoke prompt",
                ticketCount: 0,
                specCount: 0,
                storyCount: 0,
                reviewCount: 0,
                status: "draft",
                createdAt: 0,
                updatedAt: 0,
                createdBy: "dev-runner",
                version: "1",
              },
              permission: null,
              repos: [],
              workspaces: [],
              roomInfo: null,
            },
          },
        ],
        hasMore: false,
      };

      const messengerFactory: MessengerFactory<HostRpcRegistry> = (args) =>
        new MockHostMessenger<HostRpcRegistry>({
          registry: args.registry,
          requestId: () => "smoke-req",
          handlers: {
            "epic.listTasks": () => listTasksResponse,
            "agent.gui.listHarnesses": () => ({ harnesses: [] }),
            "host.status": () => hostStatusResponse(),
          },
        });

      window.history.replaceState({}, "", "/epics");

      render(
        <TraycerApp
          runnerHost={host}
          registry={hostRpcRegistry}
          remoteFetcher={null}
          messengerFactory={messengerFactory}
        />,
      );

      expect(
        await screen.findByTestId("epics-list-rows", undefined, {
          timeout: TRAYCER_APP_TEST_TIMEOUT_MS,
        }),
      ).not.toBeNull();
      expect(
        await screen.findByText("Smoke Epic Alpha", undefined, {
          timeout: TRAYCER_APP_TEST_TIMEOUT_MS,
        }),
      ).not.toBeNull();
    },
    TRAYCER_APP_TEST_TIMEOUT_MS,
  );

  it(
    "prefetches the GUI harness model catalog after host binding",
    async () => {
      const host = buildHostWithLocalHost();
      host.tokenStoreEntries.set("traycer.token", {
        token: "dev-runner-token",
        refreshToken: "dev-runner-token-refresh",
        authnBaseUrl: host.authnBaseUrl,
        savedAt: "2024-01-01T00:00:00.000Z",
        user: {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        },
      });

      const messenger = new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "harness-prefetch-req",
        handlers: {
          "epic.listTasks": () => ({
            tasks: [],
            hasMore: false,
          }),
          "agent.gui.listHarnesses": () => ({
            harnesses: [
              guiHarness("codex", "Codex"),
              guiHarness("claude", "Claude Code"),
            ],
          }),
          "agent.gui.listModels": (params) => ({
            harnessId: params.harnessId,
            models: [],
          }),
          "host.status": () => hostStatusResponse(),
        },
      });
      const messengerFactory: MessengerFactory<HostRpcRegistry> = () =>
        messenger;

      window.history.replaceState({}, "", "/epics");

      render(
        <TraycerApp
          runnerHost={host}
          registry={hostRpcRegistry}
          remoteFetcher={null}
          messengerFactory={messengerFactory}
        />,
      );

      expect(await screen.findByTestId("epics-list-empty")).not.toBeNull();
      await waitFor(() => {
        const modelHarnessIds = messenger.calls
          .filter((call) => call.method === "agent.gui.listModels")
          .map((call) => harnessIdFromCallParams(call.params));
        expect(modelHarnessIds).toContain("codex");
        expect(modelHarnessIds).toContain("claude");
      });
    },
    TRAYCER_APP_TEST_TIMEOUT_MS,
  );

  it("clears auth-scoped Zustand stores when sign-out starts during the request-context gap", async () => {
    const host = buildHostWithLocalHost();
    host.tokenStoreEntries.set("traycer.token", {
      token: "dev-runner-token",
      refreshToken: "dev-runner-token-refresh",
      authnBaseUrl: host.authnBaseUrl,
      savedAt: "2024-01-01T00:00:00.000Z",
      user: {
        id: "user-1",
        email: "test@example.com",
        name: "Test User",
      },
    });

    const messengerFactory: MessengerFactory<HostRpcRegistry> = (args) =>
      new MockHostMessenger<HostRpcRegistry>({
        registry: args.registry,
        requestId: () => "signout-req",
        handlers: {
          "epic.listTasks": () => ({
            tasks: [],
            hasMore: false,
          }),
          "agent.gui.listHarnesses": () => ({ harnesses: [] }),
          "host.status": () => hostStatusResponse(),
        },
      });

    window.history.replaceState({}, "", "/epics");

    render(
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={null}
        messengerFactory={messengerFactory}
      />,
    );

    expect(await screen.findByTestId("epics-list-empty")).not.toBeNull();
    await waitFor(() => {
      expect(useEpicCanvasStore.persist.getOptions().name).toBe(
        epicCanvasKey("test@example.com"),
      );
    });

    const staleNotification: NotificationEntry = {
      id: "stale-notification",
      createdAt: 1,
      readAt: null,
      event: {
        kind: NOTIFICATION_EVENT_TYPES.INVITED,
        epicId: "stale-epic",
        actorName: "Alice",
      },
    };

    act(() => {
      useEpicCanvasStore.getState().openEpicTab("stale-epic", "Stale Epic");
      useNotificationsStore.setState({
        entries: [staleNotification],
        unreadCount: 1,
      });
    });

    expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    expect(useNotificationsStore.getState().entries).toHaveLength(1);

    const binding = getHostBindingSnapshot();
    if (binding === null) {
      throw new Error("Expected host runtime binding to be mounted.");
    }

    await act(async () => {
      await binding.auth.signOut();
    });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
      expect(useNotificationsStore.getState().entries).toEqual([]);
    });
    expect(useEpicCanvasStore.persist.getOptions().name).toBe(
      epicCanvasKey(null),
    );
  });

  it(
    "routes a custom remoteFetcher through the mounted host picker",
    async () => {
      const host = buildHost();
      const entries: readonly HostDirectoryEntry[] = [
        mockRemoteHostEntry,
        mockInProcessHostEntry,
      ];
      const remoteFetcher: RemoteHostFetcher = () => Promise.resolve(entries);

      render(
        <TraycerApp
          runnerHost={host}
          registry={hostRpcRegistry}
          remoteFetcher={remoteFetcher}
        />,
      );

      const signInButton = await screen.findByRole("button", {
        name: "Sign in",
      });
      // Start the device-flow attempt, then drive its poll to the authorized
      // terminal so the app lands signed-in.
      fireEvent.click(signInButton);
      await waitFor(() => {
        expect(host.deviceFlow.lastSession).not.toBeNull();
      });
      act(() => {
        host.deviceFlow.emitResult({
          kind: "authorized",
          token: "test-token",
          refreshToken: "test-token-refresh",
        });
      });
      await screen.findByTestId("user-menu-trigger", undefined, {
        timeout: TRAYCER_APP_TEST_TIMEOUT_MS,
      });

      act(() => {
        host.hostPicker.requestOpen();
      });
      await screen.findByTestId("host-picker", undefined, {
        timeout: TRAYCER_APP_TEST_TIMEOUT_MS,
      });

      for (const entry of entries) {
        expect(
          await screen.findByTestId(
            `host-picker-option-${entry.hostId}`,
            undefined,
            { timeout: TRAYCER_APP_TEST_TIMEOUT_MS },
          ),
        ).not.toBeNull();
      }
    },
    TRAYCER_APP_TEST_TIMEOUT_MS,
  );
});
