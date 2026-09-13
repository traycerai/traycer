import { StrictMode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { appLogger } from "@/lib/logger";
import type {
  ReportIssueErrorCapture,
  ReportIssueErrorCaptureInput,
} from "@/lib/report-issue-error-capture";

// Derived from the input so the log assertions below see the stack the
// component forwarded, not a constant the mock would echo for any input.
const captureReportIssueError = vi.hoisted(() =>
  vi.fn((input: ReportIssueErrorCaptureInput): ReportIssueErrorCapture => ({
    cause: {
      type: "Error",
      message: "route failed",
      stack: null,
      componentStack: input.componentStack,
      errorCode: null,
      sourceAction: input.sourceAction,
      timestamp: 1,
    },
    correlationId: "correlation-1",
    fingerprint: "fp:v1:test",
    stackFamily: null,
  })),
);

const errorSummary = vi.hoisted(() => vi.fn<typeof appLogger.errorSummary>());

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));

vi.mock("@/lib/report-issue-error-capture", () => ({
  captureReportIssueError,
}));

vi.mock("@/lib/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logger")>()),
  appLogger: { errorSummary, info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/components/errors/app-error-screen", () => ({
  AppErrorScreen: () => <div data-testid="route-error-screen" />,
}));

import { RouteErrorComponent } from "@/components/errors/route-error-component";

afterEach(() => {
  cleanup();
  captureReportIssueError.mockClear();
  errorSummary.mockClear();
});

describe("<RouteErrorComponent />", () => {
  it("captures one Sentry correlation bundle under StrictMode", () => {
    const error = new Error("route failed");
    render(
      <StrictMode>
        <RouteErrorComponent error={error} reset={() => undefined} />
      </StrictMode>,
    );

    expect(captureReportIssueError).toHaveBeenCalledTimes(1);
    expect(captureReportIssueError).toHaveBeenCalledWith({
      error,
      componentStack: null,
      errorCode: null,
      sourceAction: "Route error",
    });
  });

  it("captures one primitive route failure under StrictMode", () => {
    const error = "route failed";
    render(
      <StrictMode>
        <RouteErrorComponent error={error} reset={() => undefined} />
      </StrictMode>,
    );

    expect(captureReportIssueError).toHaveBeenCalledTimes(1);
    expect(captureReportIssueError).toHaveBeenCalledWith({
      error,
      componentStack: null,
      errorCode: null,
      sourceAction: "Route error",
    });
  });

  it("logs the component stack once per occurrence under StrictMode", () => {
    // A production React build reduces a render loop to "Minified React error
    // #185" with no component name, so the stack the router hands over is
    // the only thing that says which route component crashed. It must reach
    // the desktop log, not only Sentry - and once, like the Sentry capture.
    const error = new Error("Minified React error #185");
    const componentStack = "\n    at LandingTerminalFleet\n    at StartPage";
    render(
      <StrictMode>
        <RouteErrorComponent
          error={error}
          info={{ componentStack }}
          reset={() => undefined}
        />
      </StrictMode>,
    );

    expect(captureReportIssueError).toHaveBeenCalledWith({
      error,
      componentStack,
      errorCode: null,
      sourceAction: "Route error",
    });
    expect(errorSummary).toHaveBeenCalledTimes(1);
    expect(errorSummary).toHaveBeenCalledWith(
      "[renderer] route error reached RouteErrorComponent",
      { componentStack },
      error,
    );
  });

  it("still logs a route failure the router hands over without a stack", () => {
    const error = new Error("loader failed");
    render(
      <StrictMode>
        <RouteErrorComponent error={error} reset={() => undefined} />
      </StrictMode>,
    );

    expect(errorSummary).toHaveBeenCalledTimes(1);
    expect(errorSummary).toHaveBeenCalledWith(
      "[renderer] route error reached RouteErrorComponent",
      { componentStack: null },
      error,
    );
  });
});
