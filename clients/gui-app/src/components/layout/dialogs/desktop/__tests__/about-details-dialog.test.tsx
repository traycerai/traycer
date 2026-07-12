import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSupportBridge } from "@/lib/windows/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { AboutDetailsDialog } from "@/components/layout/dialogs/desktop/about-details-dialog";

afterEach(() => {
  cleanup();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

function unavailableSupport(): DesktopSupportBridge {
  return {
    getSnapshot: () =>
      Promise.reject(new Error("secret-token-should-never-render")),
    revealLog: vi.fn(),
    submitReport: vi.fn(),
    tailLog: vi.fn(),
  };
}

describe("<AboutDetailsDialog />", () => {
  it("gates the failed-snapshot report action on capability and never forwards the raw error", async () => {
    render(
      <AboutDetailsDialog
        open
        onOpenChange={() => {}}
        support={unavailableSupport()}
        openExternalLink={() => Promise.resolve()}
      />,
    );

    await waitFor(() => {
      screen.getByText("Could not load desktop details.");
    });
    expect(screen.queryByText(/secret-token-should-never-render/)).toBeNull();
    // Capability-gated off by default.
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't load desktop details",
        message: null,
        code: null,
        source: "About Traycer",
      },
    });
  });

  it("gates the missing-support-bridge report action on capability", () => {
    render(
      <AboutDetailsDialog
        open
        onOpenChange={() => {}}
        support={null}
        openExternalLink={() => Promise.resolve()}
      />,
    );

    screen.getByText("Desktop support bridge unavailable.");
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState().reportIssueContext).toMatchObject({
      title: "Couldn't load desktop details",
      message: null,
      code: null,
      source: "About Traycer",
    });
  });
});
