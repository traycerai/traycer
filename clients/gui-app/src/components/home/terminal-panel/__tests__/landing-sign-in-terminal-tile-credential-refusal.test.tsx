import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LandingTerminalTabRef } from "@/stores/home/landing-panel-store";

/**
 * A landing sign-in terminal whose session is gone offers "Start again". That
 * button is the only way back into a credential flow from the tile, so on a
 * host that takes no credentials (a sandbox) it is disabled.
 */

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  isPending: false,
  /** What the login hook reports as `credentialRefusal`; `null` takes sign-ins. */
  credentialRefusal: null as string | null,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-a",
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host A",
    basis: "directory",
    unavailability: null,
  }),
  resolvedHostLabel: () => "Host A",
}));
vi.mock("@/hooks/host/use-bounded-host-load", () => ({
  useBoundedHostLoad: () => ({ kind: "ready" }),
}));
// The host has settled on "this session is gone", which is what shows the
// ended panel.
vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  useTerminalTileBootstrap: () => ({
    handle: null,
    hostHasSession: false,
    hostSessionExited: false,
    reportMeasuredGrid: () => undefined,
  }),
}));
vi.mock("@/hooks/providers/use-landing-provider-terminal-login", () => ({
  useLandingProviderStartTerminalLogin: () => ({
    start: mocks.start,
    isPending: mocks.isPending,
    credentialRefusal: mocks.credentialRefusal,
  }),
}));
vi.mock(
  "@/components/home/terminal-panel/use-remove-exited-landing-tab",
  () => ({
    useRemoveExitedLandingTab: () => vi.fn(),
  }),
);

import { LandingSignInTerminalTile } from "@/components/home/terminal-panel/landing-sign-in-terminal-tile";

const SIGN_IN_TAB: LandingTerminalTabRef = {
  kind: "terminal",
  instanceId: "inst-signin",
  sessionId: "term-signin",
  hostId: "host-a",
  cwd: "~",
  name: "Reasonix sign-in",
  titleSource: "manual",
  origin: "provider-login",
  originProviderId: "reasonix",
};

function renderTile(): void {
  render(
    <LandingSignInTerminalTile
      tab={SIGN_IN_TAB}
      landingPageId="draft-1"
      active
      panelOpen
      createEnabled
      authorityEntry={null}
      onScreen
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.credentialRefusal = null;
  mocks.isPending = false;
});

describe("<LandingSignInTerminalTile /> ended panel", () => {
  it("disables Start again while the host takes no credentials, and starts nothing", () => {
    mocks.credentialRefusal = "Sandboxes don't take sign-ins";
    renderTile();

    expect(screen.getByText("Sign-in terminal ended.")).toBeDefined();
    const restart = screen.getByRole<HTMLButtonElement>("button", {
      name: /Start again/,
    });
    expect(restart.disabled).toBe(true);

    fireEvent.click(restart);

    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("control: on a host that takes sign-ins Start again is enabled and restarts the sign-in on this page", () => {
    renderTile();

    const restart = screen.getByRole<HTMLButtonElement>("button", {
      name: /Start again/,
    });
    expect(restart.disabled).toBe(false);

    fireEvent.click(restart);

    expect(mocks.start).toHaveBeenCalledWith("draft-1");
  });
});
