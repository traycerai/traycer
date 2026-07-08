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
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import { TraycerApp, hostRpcRegistry } from "../index";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAppDialogStore } from "@/stores/dialogs/app-dialog-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

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

// AuthService validates rehydrated and callback-delivered tokens against
// `${authnBaseUrl}/api/v2/user` post-T6, so the test fetch stub must answer
// that route with a 200; everything else still rejects to prove these tests
// are not silently making other network calls.

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
};
const HOST_PICKER_TEST_TIMEOUT_MS = 30_000;

function buildHost(initialLocal: LocalHostSnapshot | null): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: initialLocal,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function staticFetcher(
  entries: readonly HostDirectoryEntry[],
): RemoteHostFetcher {
  return () => Promise.resolve(entries);
}

describe("<HostPicker /> directory-change reactivity", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    installMockLocalStorage();
    window.localStorage.clear();
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
    useAuthStore.getState().setSignedOut();
    restoreFetch();
  });

  it(
    "shows newly-available local snapshots while the picker is mounted (empty → one)",
    async () => {
      const host = buildHost(null);
      render(
        <TraycerApp
          runnerHost={host}
          registry={hostRpcRegistry}
          remoteFetcher={staticFetcher([])}
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

      act(() => {
        host.hostPicker.requestOpen();
      });

      await screen.findByTestId("host-picker");
      expect(await screen.findByTestId("host-picker-empty")).not.toBeNull();

      // Directory change: a local snapshot becomes available while the picker
      // is mounted. The list must reflect the new entry without a remount.
      act(() => {
        host.setLocalHost(localSnapshot);
      });

      const option = await screen.findByTestId(
        `host-picker-option-${localSnapshot.hostId}`,
      );
      expect(option).not.toBeNull();
      expect(option.textContent).toContain(localSnapshot.displayName);
      expect(option.textContent).toContain("Local");
      expect(screen.queryByTestId("host-picker-empty")).toBeNull();
    },
    HOST_PICKER_TEST_TIMEOUT_MS,
  );

  it(
    "removes disappearing entries while the picker is mounted (two → one)",
    async () => {
      const host = buildHost(localSnapshot);
      render(
        <TraycerApp
          runnerHost={host}
          registry={hostRpcRegistry}
          remoteFetcher={staticFetcher([mockRemoteHostEntry])}
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

      act(() => {
        host.hostPicker.requestOpen();
      });

      await screen.findByTestId("host-picker");
      expect(
        await screen.findByTestId(`host-picker-option-${localSnapshot.hostId}`),
      ).not.toBeNull();
      expect(
        await screen.findByTestId(
          `host-picker-option-${mockRemoteHostEntry.hostId}`,
        ),
      ).not.toBeNull();

      // Directory change: drop the local snapshot. The remote fetcher still
      // returns the same remote, so after the runtime's refresh() the picker
      // should render exactly one option without a remount.
      act(() => {
        host.setLocalHost(null);
      });

      await waitFor(() => {
        expect(
          screen.queryByTestId(`host-picker-option-${localSnapshot.hostId}`),
        ).toBeNull();
      });
      expect(
        await screen.findByTestId(
          `host-picker-option-${mockRemoteHostEntry.hostId}`,
        ),
      ).not.toBeNull();
    },
    HOST_PICKER_TEST_TIMEOUT_MS,
  );

  it(
    "clears the data-selected badge when the selected entry disappears from the directory",
    async () => {
      const host = buildHost(localSnapshot);
      render(
        <TraycerApp
          runnerHost={host}
          registry={hostRpcRegistry}
          remoteFetcher={staticFetcher([mockRemoteHostEntry])}
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

      act(() => {
        host.hostPicker.requestOpen();
      });

      await screen.findByTestId("host-picker");
      const localOption = await screen.findByTestId(
        `host-picker-option-${localSnapshot.hostId}`,
      );

      // Explicit selection via click: `HostDirectoryService.selectById()`
      // sets `selected` so `reconcileSelection()` has something to clear when
      // the local snapshot is dropped below.
      act(() => {
        fireEvent.click(localOption);
      });

      // Clicking the option calls `runnerHost.hostPicker.requestClose()`.
      // Re-open so the DialogContent (and HostPickerList) are mounted when
      // the directory-change event arrives.
      act(() => {
        host.hostPicker.requestOpen();
      });

      const selectedLocalOption = await screen.findByTestId(
        `host-picker-option-${localSnapshot.hostId}`,
      );
      await waitFor(() => {
        expect(selectedLocalOption.getAttribute("data-selected")).toBe("true");
      });

      // Directory change: the selected entry disappears. `reconcileSelection`
      // clears the selection which in turn unbinds `hostClient`; the picker
      // must re-render without crashing and no option should remain selected.
      act(() => {
        host.setLocalHost(null);
      });

      await waitFor(() => {
        expect(
          screen.queryByTestId(`host-picker-option-${localSnapshot.hostId}`),
        ).toBeNull();
      });

      const remoteOption = await screen.findByTestId(
        `host-picker-option-${mockRemoteHostEntry.hostId}`,
      );
      expect(remoteOption.getAttribute("data-selected")).toBe("false");
      expect(document.querySelectorAll('[data-selected="true"]').length).toBe(
        0,
      );
    },
    HOST_PICKER_TEST_TIMEOUT_MS,
  );
});
