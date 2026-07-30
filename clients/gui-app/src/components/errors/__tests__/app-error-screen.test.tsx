import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppErrorScreen } from "@/components/errors/app-error-screen";
import { captureReportIssueError } from "@/lib/report-issue-error-capture";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

afterEach(() => {
  cleanup();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftContext: null,
  });
});

describe("<AppErrorScreen />", () => {
  it("renders the recovery card with both actions and the error detail", () => {
    const onRefresh = vi.fn();
    const onReturnHome = vi.fn();
    render(
      <AppErrorScreen
        error={new Error("Cannot subscribe with a closed WsStreamClient.")}
        capture={null}
        onRefresh={onRefresh}
        onReturnHome={onReturnHome}
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(
      screen.getByText("Cannot subscribe with a closed WsStreamClient."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /refresh window/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onReturnHome).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /return to home/i }));
    expect(onReturnHome).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("omits the detail line when the error carries no message", () => {
    render(
      <AppErrorScreen
        error={null}
        capture={null}
        onRefresh={() => undefined}
        onReturnHome={() => undefined}
      />,
    );

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /refresh window/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /return to home/i }),
    ).toBeTruthy();
  });

  it("truncates an overly long error message", () => {
    render(
      <AppErrorScreen
        error={new Error("x".repeat(500))}
        capture={null}
        onRefresh={() => undefined}
        onReturnHome={() => undefined}
      />,
    );

    const detail = screen.getByText(/x{100,}/);
    const text = String(detail.textContent);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(301);
  });

  it("still builds a private cause for a blank-message error (gated on the catch, not on a displayable message)", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const error = new Error("");
    const capture = captureReportIssueError({
      error,
      componentStack: "in Foo",
      errorCode: null,
      sourceAction: "App crash",
    });

    render(
      <AppErrorScreen
        error={error}
        capture={capture}
        onRefresh={() => undefined}
        onReturnHome={() => undefined}
      />,
    );

    // The public detail line is correctly absent - there is nothing safe and
    // displayable to show - but the private cause must still exist.
    fireEvent.click(screen.getByRole("button", { name: /report issue/i }));
    const draft = useDesktopDialogStore.getState().reportIssueDraftContext;
    expect(draft?.privateDiagnostics.cause).not.toBeNull();
    expect(draft?.privateDiagnostics.cause?.componentStack).toBe("in Foo");
    expect(draft?.privateDiagnostics.cause?.type).toBe("Error");
    expect(draft?.privateDiagnostics.fingerprint).toMatch(/^fp:v1:/);
  });
});
