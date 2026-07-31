import { StrictMode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const captureReportIssueError = vi.hoisted(() =>
  vi.fn(() => ({
    cause: {
      type: "Error",
      message: "route failed",
      stack: null,
      componentStack: null,
      errorCode: null,
      sourceAction: "Route error",
      timestamp: 1,
    },
    correlationId: "correlation-1",
    fingerprint: "fp:v1:test",
    stackFamily: null,
  })),
);

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));

vi.mock("@/lib/report-issue-error-capture", () => ({
  captureReportIssueError,
}));

vi.mock("@/components/errors/app-error-screen", () => ({
  AppErrorScreen: () => <div data-testid="route-error-screen" />,
}));

import { RouteErrorComponent } from "@/components/errors/route-error-component";

afterEach(() => {
  cleanup();
  captureReportIssueError.mockClear();
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
});
