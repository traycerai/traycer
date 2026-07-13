import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RootErrorBoundary } from "@/components/errors/root-error-boundary";
import { ReportIssueDialogHost } from "@/components/layout/dialogs/report-issue-dialog-host";
import { Toaster } from "@/components/ui/sonner";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { router } from "@/router";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

function Boom(): never {
  throw new Error("boom from a provider");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useDesktopDialogStore.getState().close();
  useDesktopDialogStore.setState({ reportIssueAvailable: false });
});

describe("<RootErrorBoundary />", () => {
  it("renders children when nothing throws", () => {
    render(
      <RootErrorBoundary router={router}>
        <div data-testid="ok-child" />
      </RootErrorBoundary>,
    );

    expect(screen.getByTestId("ok-child")).toBeTruthy();
    expect(screen.queryByTestId("app-error-screen")).toBeNull();
  });

  it("catches a child crash and shows the recovery card", () => {
    // The thrown error is logged by React and by `componentDidCatch`; silence
    // the noise and assert the boundary logged it.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <RootErrorBoundary router={router}>
        <Boom />
      </RootErrorBoundary>,
    );

    expect(screen.getByTestId("app-error-screen")).toBeTruthy();
    expect(consoleError).toHaveBeenCalled();
  });

  it("navigates home when Return to Home is clicked", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const navigateSpy = vi
      .spyOn(router, "navigate")
      .mockResolvedValue(undefined);

    render(
      <RootErrorBoundary router={router}>
        <Boom />
      </RootErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /return to home/i }));
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/" });
  });

  it("shows report submission failures while the root crash screen is active", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runnerHost = Object.assign(
      new MockRunnerHost({
        signInUrl: "https://example.invalid/signin",
        authnBaseUrl: "https://example.invalid",
        localHost: null,
        hosts: [],
        workspaceFolderPickerPaths: undefined,
        hasLocalHost: undefined,
        traycerCli: undefined,
      }),
      {
        support: {
          getSnapshot: () => Promise.reject(new Error("snapshot unavailable")),
          revealLog: () => Promise.reject(new Error("log unavailable")),
          submitReport: () => Promise.reject(new Error("submit unavailable")),
          tailLog: () => Promise.reject(new Error("log unavailable")),
        },
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <QueryClientProvider client={queryClient}>
          <ReportIssueDialogHost />
          <Toaster />
          <RootErrorBoundary router={router}>
            <Boom />
          </RootErrorBoundary>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Report issue" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Submit Report" }),
    );

    expect(
      await screen.findByText("Failed to submit report. Please try again."),
    ).not.toBeNull();
    expect(screen.getByTestId("app-error-screen")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Report an Issue" }),
    ).not.toBeNull();
  });
});
