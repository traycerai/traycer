import { useState, type ReactNode } from "react";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { AppErrorScreen } from "@/components/errors/app-error-screen";
import {
  captureReportIssueError,
  type ReportIssueErrorCapture,
} from "@/lib/report-issue-error-capture";

type RouteErrorComponentProps = Omit<ErrorComponentProps, "error"> & {
  readonly error: unknown;
};

// The props object identifies this mounted error occurrence even when a route throws a primitive or
// redirect-like value.
const captureByOccurrence = new WeakMap<
  RouteErrorComponentProps,
  ReportIssueErrorCapture
>();

function captureRouteError(
  props: RouteErrorComponentProps,
): ReportIssueErrorCapture {
  const existing = captureByOccurrence.get(props);
  if (existing !== undefined) return existing;
  const capture = captureReportIssueError({
    error: props.error,
    componentStack: props.info?.componentStack ?? null,
    errorCode: null,
    sourceAction: "Route error",
  });
  captureByOccurrence.set(props, capture);
  return capture;
}

/** Router `defaultErrorComponent`: the catch-all for any error thrown inside a route match (loader,
 * `beforeLoad`, or a component render) that the route's own `errorComponent` didn't handle. */
export function RouteErrorComponent(
  props: RouteErrorComponentProps,
): ReactNode {
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
