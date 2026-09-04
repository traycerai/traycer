import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  useLandingPanelStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-panel-store";
import {
  hasPrimaryFocusIntent,
  resetPrimaryFocusCoordinatorForTests,
} from "@/lib/focus/primary-focus-coordinator";
import {
  focusTerminalInstance,
  resetTerminalFocusRegistryForTests,
} from "@/lib/terminals/terminal-focus-registry";
import { LandingTerminalLegacyBootstrap } from "../landing-terminal-tile";

const testState = vi.hoisted<{ exited: boolean }>(() => ({ exited: false }));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host A",
    basis: "directory",
    unavailability: null,
  }),
  resolvedHostLabel: (reachability: { readonly hostLabel: string }) =>
    reachability.hostLabel,
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  useTerminalTileBootstrap: () => ({
    handle: null,
    createIsError: false,
    createError: null,
    retry: () => undefined,
    hostHasSession: false,
    hostSessionExited: testState.exited,
    reportMeasuredGrid: () => undefined,
  }),
}));

vi.mock(
  "@/components/epic-canvas/renderers/terminal-grid-measure-probe",
  () => ({ TerminalGridMeasureProbe: () => null }),
);

const LANDING_PAGE_ID = "landing-1";

const EXITING_TAB: LandingTerminalTabRef = {
  kind: "terminal",
  instanceId: "terminal-instance",
  sessionId: "terminal-session",
  hostId: "host-a",
  cwd: "/work/repo",
  name: "shell",
  titleSource: "default",
};

beforeEach(() => {
  testState.exited = false;
  useLandingPanelStore.getState().resetForTests();
  resetTerminalFocusRegistryForTests();
  resetPrimaryFocusCoordinatorForTests();
});

afterEach(() => {
  cleanup();
  useLandingPanelStore.getState().resetForTests();
  resetTerminalFocusRegistryForTests();
  resetPrimaryFocusCoordinatorForTests();
});

/**
 * A shell exiting removes its tab and the store promotes a neighbour. In a
 * mixed strip that neighbour need not be a terminal, and only a terminal
 * endpoint can ever fulfil a terminal focus request - so aiming one at the
 * promoted browser row would park an intent nothing claims for the rest of
 * the session.
 */
describe("<LandingTerminalTile /> exit focus hand-off", () => {
  it("does not aim the exiting terminal's focus at a promoted browser neighbour", async () => {
    const store = useLandingPanelStore.getState();
    store.addTab(EXITING_TAB);
    store.addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    store.activateTab(EXITING_TAB.instanceId);
    // Panel OPEN, so the promote-a-neighbour arm is the one under test rather
    // than the collapsed arm that always falls through to the composer.
    store.setPanelOpen(LANDING_PAGE_ID, true);
    // The exiting tile owns the keyboard: without that the handler returns
    // before it decides anything.
    focusTerminalInstance(EXITING_TAB.instanceId);

    testState.exited = true;
    render(
      <LandingTerminalLegacyBootstrap
        landingPageId={LANDING_PAGE_ID}
        tab={EXITING_TAB}
        active
        createEnabled={false}
        authorityEntry={null}
      />,
    );

    await waitFor(() => {
      expect(useLandingPanelStore.getState().activeInstanceId).toBe(
        "browser-instance",
      );
    });
    expect(
      hasPrimaryFocusIntent(
        (target) =>
          target.kind === "terminal" &&
          target.instanceId === "browser-instance",
      ),
    ).toBe(false);
    // The exiting tile's own request went with it, rather than being left
    // parked against a tab that no longer exists.
    expect(
      hasPrimaryFocusIntent(
        (target) =>
          target.kind === "terminal" &&
          target.instanceId === EXITING_TAB.instanceId,
      ),
    ).toBe(false);
  });
});
