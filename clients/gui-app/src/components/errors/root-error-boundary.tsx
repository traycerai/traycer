import { Component, type ErrorInfo, type ReactNode } from "react";
import type { AppRouter } from "@/router";
import { AppErrorScreen } from "@/components/errors/app-error-screen";
import { appLogger } from "@/lib/logger";
import {
  captureReportIssueError,
  type ReportIssueErrorCapture,
} from "@/lib/report-issue-error-capture";

interface RootErrorBoundaryProps {
  /** Router instance used to navigate home from outside `RouterProvider`. */
  readonly router: AppRouter;
  readonly children: ReactNode;
}

interface RootErrorBoundaryState {
  readonly error: unknown;
  readonly capture: ReportIssueErrorCapture | null;
}

/**
 * Top-level renderer catch-all. The router's `defaultErrorComponent` already
 * covers everything inside the route tree; this boundary sits ABOVE
 * `RouterProvider` so a crash in an app-wide provider (host stream, auth
 * lifecycle bridges) or in `RouterProvider` itself still lands on the shared
 * error card rather than a blank canvas. "Return to Home" drives the router
 * imperatively (the boundary renders outside React Router's context) and
 * clears the error so the home route can mount.
 */
export class RootErrorBoundary extends Component<
  RootErrorBoundaryProps,
  RootErrorBoundaryState
> {
  constructor(props: RootErrorBoundaryProps) {
    super(props);
    this.state = { error: null, capture: null };
  }

  static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
    return { error, capture: null };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Captured here (catch time), not in render: mints the correlation id /
    // fingerprint once and reports to Sentry - re-deriving in render would
    // re-mint and re-capture on every re-render.
    const capture = captureReportIssueError({
      error,
      componentStack: info.componentStack ?? null,
      errorCode: null,
      sourceAction: "App crash",
    });
    this.setState({ capture });
    appLogger.errorSummary(
      "[renderer] uncaught error reached RootErrorBoundary",
      { componentStack: capture.cause.componentStack },
      error,
    );
  }

  private handleReturnHome = (): void => {
    void this.props.router.navigate({ to: "/" });
    this.setState({ error: null });
  };

  private handleRefresh = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <AppErrorScreen
        error={this.state.error}
        capture={this.state.capture}
        onRefresh={this.handleRefresh}
        onReturnHome={this.handleReturnHome}
      />
    );
  }
}
