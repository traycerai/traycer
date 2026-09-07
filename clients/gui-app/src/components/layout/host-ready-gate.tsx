import { type ReactNode } from "react";
import { DefaultHostReadyGate } from "@/components/layout/host-readiness-controller";

/** T8 keeps this component name so route-level callers do not need a migration. */
export function HostReadyGate(props: {
  readonly children: ReactNode;
}): ReactNode {
  return <DefaultHostReadyGate>{props.children}</DefaultHostReadyGate>;
}
