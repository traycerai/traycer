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
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";

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
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
    __resetTabNavigationControllerForTesting();
    restoreFetch = installAuthValidationFetch();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
    __resetTabNavigationControllerForTesting();
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
    // The shell-owned picker port is gone (redesign P3.4); the assertion that
    // survives is the one about the DOM - no picker surface is mounted here.
    expect(screen.queryByTestId("host-picker")).toBeNull();
  });

  // Binding used to be asserted on the deleted Host-status footer; cardinality
  // routing is covered by sibling picker / no-host tests.
});
