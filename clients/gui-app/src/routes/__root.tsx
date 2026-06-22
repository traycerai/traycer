import { createRootRouteWithContext } from "@tanstack/react-router";
import type { AppRouterContext } from "@/router";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";
import { RootComponent } from "./root-route-components";

export const Route = createRootRouteWithContext<AppRouterContext>()({
  validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
  component: RootComponent,
});
