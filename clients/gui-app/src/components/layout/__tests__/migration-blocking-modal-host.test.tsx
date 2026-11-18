import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MigrationBlockingModalHost } from "@/components/layout/dialogs/migration-blocking-modal-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useMigrationRunStore } from "@/stores/migration/migration-run-store";

const HOST = "host-a";

describe("<MigrationBlockingModalHost />", () => {
  beforeEach(() => {
    useMigrationRunStore.setState({ runs: new Map(), remoteRunning: false });
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  afterEach(() => {
    cleanup();
    useMigrationRunStore.setState({ runs: new Map(), remoteRunning: false });
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("renders the settings retry migration layer as a portaled full-screen blocker", () => {
    useMigrationRunStore.getState().markRunning(HOST);

    const { container } = render(
      <main className="relative">
        <MigrationBlockingModalHost />
      </main>,
    );

    const overlay = screen.getByTestId("migration-blocking-overlay");
    const modal = screen.getByRole("dialog", { name: "Migrating tasks" });

    expect(container.contains(overlay)).toBe(false);
    expect(container.contains(modal)).toBe(false);
    expect(overlay.className).toContain("fixed");
    expect(overlay.className).not.toContain("absolute");
    expect(modal.className).toContain("fixed");
  });

  it("offers a capability-gated report action with fixed migration context", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    // An error is only ever a RUN's error: a frame for a host with no run is
    // dropped rather than materialising a slice, so start one first.
    useMigrationRunStore.getState().markRunning(HOST);
    useMigrationRunStore.getState().applyError(HOST);

    render(<MigrationBlockingModalHost />);
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Migration interrupted",
        message: "The migration did not finish.",
        code: null,
        source: "Data migration",
      },
    });
  });
});
