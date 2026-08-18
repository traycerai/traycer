import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { LandingTerminalTabRef } from "@/stores/home/landing-terminal-store";

const bootstrapState = vi.hoisted(() => ({
  createIsError: true,
  createIsPending: false,
  createRetryIsPending: false,
  createIsSuccess: false,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host A",
    unavailability: null,
  }),
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  MEASURE_GRID_TIMEOUT_MS: 100,
  useTerminalTileBootstrap: () => ({
    hostHasSession: false,
    hostSessionExited: false,
    handle: null,
    createIsError: bootstrapState.createIsError,
    createIsPending: bootstrapState.createIsPending,
    createRetryIsPending: bootstrapState.createRetryIsPending,
    createIsSuccess: bootstrapState.createIsSuccess,
    createError: bootstrapState.createIsError
      ? { message: "Could not start terminal." }
      : null,
    createRetryError: bootstrapState.createRetryIsPending
      ? { message: "Could not start terminal." }
      : null,
    retry: () => {
      bootstrapState.createIsError = false;
      bootstrapState.createIsPending = true;
      bootstrapState.createRetryIsPending = true;
    },
    reportMeasuredGrid: () => undefined,
  }),
}));

vi.mock(
  "@/components/epic-canvas/renderers/terminal-grid-measure-probe",
  () => ({
    TerminalGridMeasureProbe: () => null,
  }),
);

import {
  LandingTerminalErrorState,
  LandingTerminalLegacyBootstrap,
} from "@/components/home/terminal-panel/landing-terminal-tile";

const TAB: LandingTerminalTabRef = {
  instanceId: "instance-1",
  sessionId: "terminal-1",
  hostId: "host-a",
  cwd: "/workspace/project",
  name: "project",
  titleSource: "default",
};

describe("LandingTerminalErrorState retry pending UX", () => {
  afterEach(() => {
    cleanup();
    bootstrapState.createIsError = true;
    bootstrapState.createIsPending = false;
    bootstrapState.createRetryIsPending = false;
    bootstrapState.createIsSuccess = false;
  });

  it("keeps the Retry label and disables the button with an inline spinner while pending", () => {
    const onRetry = vi.fn();
    render(
      <LandingTerminalErrorState
        message="Could not start terminal."
        isPending
        onRetry={onRetry}
      />,
    );

    screen.getByText("Could not start terminal.");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveProperty("disabled", true);
    expect(
      retry.querySelector('[data-testid="landing-terminal-retry-pending"]'),
    ).not.toBeNull();
    fireEvent.click(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("invokes retry when the request is not pending", () => {
    const onRetry = vi.fn();
    render(
      <LandingTerminalErrorState
        message="Could not start terminal."
        isPending={false}
        onRetry={onRetry}
      />,
    );

    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveProperty("disabled", false);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy caller's error surface mounted through retry settlement", async () => {
    const rendered = render(
      <LandingTerminalLegacyBootstrap
        landingPageId="landing-1"
        tab={TAB}
        active
        createEnabled
        authorityEntry={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    rendered.rerender(
      <LandingTerminalLegacyBootstrap
        landingPageId="landing-1"
        tab={TAB}
        active
        createEnabled
        authorityEntry={null}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toHaveProperty(
        "disabled",
        true,
      ),
    );
    expect(
      screen
        .getByRole("button", { name: "Retry" })
        .querySelector('[data-testid="landing-terminal-retry-pending"]'),
    ).not.toBeNull();

    bootstrapState.createIsPending = false;
    bootstrapState.createRetryIsPending = false;
    bootstrapState.createIsSuccess = true;
    rendered.rerender(
      <LandingTerminalLegacyBootstrap
        landingPageId="landing-1"
        tab={TAB}
        active
        createEnabled
        authorityEntry={null}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(),
    );
  });
});
