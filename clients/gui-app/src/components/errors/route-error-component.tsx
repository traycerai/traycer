import { useState, type ReactNode } from "react";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { AppErrorScreen } from "@/components/errors/app-error-screen";
import { captureReportIssueError } from "@/lib/report-issue-error-capture";

/**
 * Router `defaultErrorComponent`: the catch-all for any error thrown inside a
 * route match (loader, `beforeLoad`, or a component render) that the route's
 * own `errorComponent` didn't handle. TanStack mounts it inside the nearest
 * route's error boundary and resets that boundary automatically on the next
 * successful navigation, so navigating home clears the error.
 */
export function RouteErrorComponent(props: ErrorComponentProps): ReactNode {
  const router = useRouter();
  // Lazy initializer, not a bare call in the render body: it runs once at
  // mount (a fresh mount per crash, since TanStack remounts this on error),
  // which is the sanctioned way to mint an id and report to Sentry exactly
  // once without making the render itself impure or re-capturing on rerender.
  const [capture] = useState(() =>
    captureReportIssueError({
      error: props.error,
      componentStack: props.info?.componentStack ?? null,
      errorCode: null,
      sourceAction: "Route error",
    }),
  );
  return (
    <AppErrorScreen
      error={props.error}
      capture={capture}
      onRefresh={() => window.location.reload()}
      onReturnHome={() => {
        void router.navigate({ to: "/" });
      }}
    />
  );
}
