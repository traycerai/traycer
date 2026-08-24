import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { TerminalConnectionOverlay } from "../terminal-connection-overlay";

afterEach(() => {
  cleanup();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
  });
});

describe("<TerminalConnectionOverlay />", () => {
  it("keeps reconnect primary and reports only fixed terminal context", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    render(
      <TerminalConnectionOverlay
        state="lost"
        onReconnect={() => undefined}
        testId="terminal-connection-overlay"
      />,
    );

    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    const report = screen.getByRole("button", { name: "Report issue" });
    expect(reconnect.getAttribute("data-variant")).toBe("outline");
    expect(report.getAttribute("data-variant")).toBe("ghost");

    fireEvent.click(report);
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Terminal session could not reconnect",
      message: "The terminal session could not be restarted.",
      code: null,
      source: "Terminal",
    });
  });

  it("hides reporting when the support capability is unavailable", () => {
    render(
      <TerminalConnectionOverlay
        state="lost"
        onReconnect={() => undefined}
        testId="terminal-connection-overlay"
      />,
    );

    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});
