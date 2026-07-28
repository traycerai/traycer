import { type ReactNode } from "react";
import { DefaultHostReadyGate } from "@/components/layout/host-readiness-controller";

/**
 * Compatibility-named signed-in readiness root.
 *
 * T8 keeps this component name so route-level callers do not need a migration.
 * The one controller mounts above RouterProvider so host-stream bridges and
 * routed slots consume the exact same lifecycle; this wrapper deliberately adds
 * no second subscription of its own.
 *
 * It DOES block: until the default host is ready, everything below is replaced
 * by the full-screen setup surface (`/settings` excepted). Per-surface readiness
 * fallbacks still exist for the tab-host scope, but they are not a substitute -
 * with only those, the shell stayed live through setup and host-dependent
 * affordances were reachable from the tab strip.
 */
export function HostReadyGate(props: {
  readonly children: ReactNode;
}): ReactNode {
  return <DefaultHostReadyGate>{props.children}</DefaultHostReadyGate>;
}
