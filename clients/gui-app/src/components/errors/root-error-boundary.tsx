import { Component, type ErrorInfo, type ReactNode } from "react";
import type { AppRouter } from "@/router";
import { AppErrorScreen } from "@/components/errors/app-error-screen";

interface RootErrorBoundaryProps {
  /** Router instance used to navigate home from outside `RouterProvider`. */
  readonly router: AppRouter;
  readonly children: ReactNode;
}

interface RootErrorBoundaryState {
  readonly error: unknown;
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
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Boundary-level trace: an uncaught renderer error that escaped every
    // route-level handler. Logged at the boundary (the error + component stack,
    // never user content) so the desktop console bridge captures fatal crashes.
    // eslint-disable-next-line no-console
    console.error(
      "[renderer] uncaught error reached RootErrorBoundary",
      error,
      info.componentStack,
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
        onRefresh={this.handleRefresh}
        onReturnHome={this.handleReturnHome}
      />
    );
  }
}
