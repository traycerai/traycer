import { Component, type ErrorInfo, type ReactNode } from "react";
import type { AppRouter } from "@/router";
import { AppErrorScreen } from "@/components/errors/app-error-screen";
import { appLogger } from "@/lib/logger";

interface RootErrorBoundaryProps {
  /** Router instance used to navigate home from outside `RouterProvider`. */
  readonly router: AppRouter;
  readonly children: ReactNode;
}

interface RootErrorBoundaryState {
  readonly error: unknown;
  readonly componentStack: string | null;
  readonly timestamp: number;
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
    this.state = { error: null, componentStack: null, timestamp: 0 };
  }

  static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
    return { error, componentStack: null, timestamp: 0 };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null;
    this.setState({ componentStack, timestamp: Date.now() });
    appLogger.errorSummary(
      "[renderer] uncaught error reached RootErrorBoundary",
      { componentStack },
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
        componentStack={this.state.componentStack}
        timestamp={this.state.timestamp}
        onRefresh={this.handleRefresh}
        onReturnHome={this.handleReturnHome}
      />
    );
  }
}
