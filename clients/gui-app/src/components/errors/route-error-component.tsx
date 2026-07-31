import { useState, type ReactNode } from "react";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { AppErrorScreen } from "@/components/errors/app-error-screen";
import {
  captureReportIssueError,
  type ReportIssueErrorCapture,
} from "@/lib/report-issue-error-capture";

// StrictMode invokes lazy state initializers twice in development. Cache by
// the thrown Error instance so only the first initializer mints a correlation
// id and reports to Sentry; the discarded probe render reuses that capture.
const captureByError = new WeakMap<Error, ReportIssueErrorCapture>();

function captureRouteError(
  props: ErrorComponentProps,
): ReportIssueErrorCapture {
  if (props.error instanceof Error) {
    const existing = captureByError.get(props.error);
    if (existing !== undefined) return existing;
  }
  const capture = captureReportIssueError({
    error: props.error,
    componentStack: props.info?.componentStack ?? null,
    errorCode: null,
    sourceAction: "Route error",
  });
  if (props.error instanceof Error) captureByError.set(props.error, capture);
  return capture;
}

/**
 * Router `defaultErrorComponent`: the catch-all for any error thrown inside a
 * route match (loader, `beforeLoad`, or a component render) that the route's
 * own `errorComponent` didn't handle. TanStack mounts it inside the nearest
 * route's error boundary and resets that boundary automatically on the next
 * successful navigation, so navigating home clears the error.
 */
export function RouteErrorComponent(props: ErrorComponentProps): ReactNode {
  const router = useRouter();
  const [capture] = useState(() => captureRouteError(props));
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
