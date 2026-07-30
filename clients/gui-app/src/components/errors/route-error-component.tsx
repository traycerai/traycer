import { useState, type ReactNode } from "react";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { AppErrorScreen } from "@/components/errors/app-error-screen";

/**
 * Router `defaultErrorComponent`: the catch-all for any error thrown inside a
 * route match (loader, `beforeLoad`, or a component render) that the route's
 * own `errorComponent` didn't handle. TanStack mounts it inside the nearest
 * route's error boundary and resets that boundary automatically on the next
 * successful navigation, so navigating home clears the error.
 */
export function RouteErrorComponent(props: ErrorComponentProps): ReactNode {
  const router = useRouter();
  // Lazy initializer, not a bare `Date.now()` in the render body: it runs
  // once at mount (a fresh mount per crash, since TanStack remounts this on
  // error), which is the sanctioned way to capture an impure "first render"
  // value without making the render itself impure.
  const [timestamp] = useState(() => Date.now());
  return (
    <AppErrorScreen
      error={props.error}
      componentStack={props.info?.componentStack ?? null}
      timestamp={timestamp}
      onRefresh={() => window.location.reload()}
      onReturnHome={() => {
        void router.navigate({ to: "/" });
      }}
    />
  );
}
