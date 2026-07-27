import { type ReactNode } from "react";

/**
 * Compatibility-named signed-in readiness root.
 *
 * T8 keeps this component name so route-level callers do not need a migration.
 * The one controller mounts above RouterProvider so host-stream bridges and
 * routed slots consume the exact same lifecycle; this compatibility wrapper
 * deliberately adds no second subscription or pathname gate.
 */
export function HostReadyGate(props: {
  readonly children: ReactNode;
}): ReactNode {
  return props.children;
}
