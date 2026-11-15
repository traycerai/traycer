import { useLayoutEffect, type ReactNode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { observeAppRouterHistory, type AppRouter } from "@/router";

/**
 * The app's router provider: installs `observeAppRouterHistory` and mounts
 * `<RouterProvider>`. The install is a layout effect of this component, which
 * runs before the passive effect in which the router's load subscribes to the
 * history, so the observers come first in the subscriber order.
 */
export function AppRouterProvider(props: {
  readonly router: AppRouter;
}): ReactNode {
  useLayoutEffect(() => observeAppRouterHistory(props.router), [props.router]);
  return <RouterProvider router={props.router} />;
}
