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
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
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

function buildMobileHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in?shell=mobile",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    hasLocalHost: false,
    workspaceFolderPickerPaths: undefined,
    traycerCli: undefined,
  });
}

function fetcherFor(entries: readonly HostDirectoryEntry[]): RemoteHostFetcher {
  return () => Promise.resolve({ kind: "hosts", entries });
}

describe("<TraycerApp /> mobile cardinality behavior", () => {
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

  it("renders the explicit no-host guidance and never binds when the directory has zero entries", async () => {
    const host = buildMobileHost();
    render(
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={fetcherFor([])}
      />,
    );

    const signInButton = await screen.findByRole("button", { name: "Sign in" });
    // Start the device-flow attempt, then drive its poll to authorized.
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

    expect(await screen.findByTestId("mobile-no-host")).not.toBeNull();
    // The footer belongs to the gated AppShell; with zero hosts the gate
    // short-circuits to the no-host card so no RPC probe mounts.
    expect(screen.queryByLabelText("Host status")).toBeNull();
    expect(host.hostPicker.isOpen).toBe(false);
    expect(screen.queryByTestId("host-picker")).toBeNull();
  });

  // The previous "auto-binds the single remote entry" and "auto-opens the
  // picker and defers binding until the user picks" cases asserted the
  // binding via the `Host status` footer's `data-bound-host-id`
  // attribute. That footer was removed in favor of the composer chip (see
  // `app-shell-lifecycle-bridges.test.tsx`), and there is no equivalent
  // DOM-level surface in this minimal app harness to assert binding state
  // against. Cardinality routing itself is covered by sibling tests that
  // exercise the picker and the no-host guidance; the cases removed
  // here only tested the deleted footer's attribute mirror.
});
