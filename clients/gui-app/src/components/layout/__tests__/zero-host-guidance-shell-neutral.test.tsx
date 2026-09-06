/**
 * The zero-host guidance says the SAME thing on every shell that can reach it.
 *
 * `mobile-no-host` is not a mobile fact despite its name: the readiness arm
 * that produces it asks `hasLocalHost === false` plus a concluded empty
 * directory, so the installed phone app, a browser tab and the in-browser dev
 * loop all land on this card. Its copy used to name "this device" as the place
 * to connect a host from - true of neither, since both are reading it on
 * hardware that cannot run one, and an instruction the reader cannot follow is
 * worse than no instruction.
 *
 * Two properties are pinned here, and they are different. The per-shell
 * equality is the SHELL-NEUTRALITY itself - a relationship between rows, which
 * is why it is asserted through the four-shell fixture and with the product
 * flag actually set, so a copy branch keyed on `isMobileApp()` would separate
 * the rows and fail. The phrasing assertion is what stops a device-local
 * remedy from coming back under any wording.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { setMobileApp } from "@/lib/mobile-app";
import {
  shellSurfaces,
  type ShellSurfaceFixture,
} from "../../../../__tests__/shell-surfaces";

const routerState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: routerState.pathname } }),
}));

// The real header mounts the tab strip, notifications and menus - none of which
// this card is about, and all of which need their own provider stack.
vi.mock("@/components/layout/header/app-header", () => ({
  AppHeader: (props: { readonly variant: string }) => (
    <header data-variant={props.variant} />
  ),
}));

/**
 * The whole message, written out rather than matched loosely.
 *
 * A substring check would pass on the sentence this test exists to retire -
 * "No host connected." is common to both - so the literal is the assertion.
 */
const NO_HOST_MESSAGE =
  "No host connected. Install Traycer on a computer to add a host to this account.";

/**
 * Any remedy pointing at the hardware the reader is holding. The card is only
 * ever drawn on a shell that has no local host, so every one of these is a
 * machine that cannot answer.
 */
const DEVICE_LOCAL_REMEDY = /this (device|machine|phone|computer|browser|tab)/i;

const PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

const ZERO_HOST: SurfaceReadiness = { kind: "mobile-no-host" };

function controllerFor(): HostReadinessController {
  return {
    readinessFor: () => ZERO_HOST,
    defaultHostPresentation: PRESENTATION,
    hasBeenDefaultHostReady: false,
  };
}

function renderZeroHostCard(runnerHost: IRunnerHost): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider value={controllerFor()}>
          <HostReadyGate>
            <main>app</main>
          </HostReadyGate>
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

/** The card's message line, which carries the `mobile-no-host` test id. */
function guidanceText(): string {
  return screen.getByTestId("mobile-no-host").textContent;
}

beforeEach(() => {
  routerState.pathname = "/";
  // The gate never blocks a signed-out user, so an unauthenticated harness
  // would render `<main>` and every assertion below would be against a card
  // that was not on screen.
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
  setMobileApp(false);
});

function surfaceNamed(name: string): ShellSurfaceFixture {
  const surface = shellSurfaces().find((candidate) => candidate.name === name);
  if (surface === undefined) {
    throw new Error(`no shell surface named "${name}"`);
  }
  return surface;
}

describe("zero-host guidance", () => {
  it("names a machine to install Traycer on, not the hardware the app is running on", () => {
    const surface = surfaceNamed("webapp");
    setMobileApp(surface.mobileApp);
    renderZeroHostCard(surface.runnerHost);

    // Existence first: a card that failed to render would satisfy the phrasing
    // assertion below by having no text at all.
    expect(screen.getByTestId("mobile-no-host")).toBeTruthy();
    expect(guidanceText()).toBe(NO_HOST_MESSAGE);
    expect(guidanceText()).not.toMatch(DEVICE_LOCAL_REMEDY);
  });

  it("says the same thing on every shell that mounts the app", () => {
    // Rendered shell by shell rather than reading the copy from the module,
    // WITH the product flag each shell's bootstrap sets: this is the assertion
    // that a gate keyed on `isMobileApp()` - the exact mis-keying the other
    // web-shell gates had - would fail, and a static read of the string could
    // not see.
    const rendered = new Map<string, string>();
    for (const surface of shellSurfaces()) {
      setMobileApp(surface.mobileApp);
      renderZeroHostCard(surface.runnerHost);
      rendered.set(surface.name, guidanceText());
      cleanup();
      setMobileApp(false);
    }

    expect([...rendered.keys()].sort()).toEqual(
      shellSurfaces()
        .map((surface) => surface.name)
        .sort(),
    );
    expect(new Set(rendered.values())).toEqual(new Set([NO_HOST_MESSAGE]));
  });
});
