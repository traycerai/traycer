import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SandboxCreateStartTeamTask } from "@/components/hosts/sandbox-create-start-team-task";
import { browserTabId } from "@/lib/browser-tab-identity";
import { pinComposerHost } from "@/lib/composer/start-task-on-host";
import {
  composerSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

/**
 * A team sandbox's create success offers the person with no task owned by the
 * team yet a way to start one on the new host, and starting one pins this
 * window's landing composer to that host.
 */

function renderOffer(handlers: {
  readonly onStart: () => void;
  readonly onDone: () => void;
}): void {
  render(
    <SandboxCreateStartTeamTask
      teamSlug="acme"
      onStart={handlers.onStart}
      onDone={handlers.onDone}
    />,
  );
}

describe("<SandboxCreateStartTeamTask />", () => {
  afterEach(cleanup);

  it("offers to start a task for the team and to finish", () => {
    renderOffer({ onStart: vi.fn(), onDone: vi.fn() });

    expect(screen.getByTestId("sandbox-create-start-team-task")).toBeTruthy();
    expect(
      screen.getByTestId("sandbox-create-start-team-task-start").textContent,
    ).toBe("Start a acme task");
    expect(
      screen.getByTestId("sandbox-create-start-team-task-done").textContent,
    ).toBe("Done");
  });

  it("starts a task once when the offer is taken, and does not finish", () => {
    const onStart = vi.fn();
    const onDone = vi.fn();
    renderOffer({ onStart, onDone });

    fireEvent.click(screen.getByTestId("sandbox-create-start-team-task-start"));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("finishes once when Done is pressed, and starts nothing", () => {
    const onStart = vi.fn();
    const onDone = vi.fn();
    renderOffer({ onStart, onDone });

    fireEvent.click(screen.getByTestId("sandbox-create-start-team-task-done"));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("names the team it is given, not a fixed one", () => {
    render(
      <SandboxCreateStartTeamTask
        teamSlug="platform-crew"
        onStart={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("sandbox-create-start-team-task-start").textContent,
    ).toBe("Start a platform-crew task");
  });
});

describe("pinComposerHost", () => {
  beforeEach(() => {
    useSurfaceHostSelectionStore.setState({ selections: {} });
  });
  afterEach(() => {
    useSurfaceHostSelectionStore.setState({ selections: {} });
  });

  it("pins this window's landing composer to the host", () => {
    pinComposerHost("host-sbx-1");

    const selections = useSurfaceHostSelectionStore.getState().selections;
    expect(selections[composerSurfaceKey(browserTabId())]).toBe("host-sbx-1");
  });

  it("replaces an earlier pin with the new host", () => {
    pinComposerHost("host-old");
    pinComposerHost("host-sbx-2");

    const selections = useSurfaceHostSelectionStore.getState().selections;
    expect(selections[composerSurfaceKey(browserTabId())]).toBe("host-sbx-2");
  });
});
