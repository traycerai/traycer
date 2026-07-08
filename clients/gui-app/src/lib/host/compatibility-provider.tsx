import type { ReactNode } from "react";
import {
  HostCompatibilityContext,
  useHostCompatibilityProbe,
} from "@/lib/host/compatibility-state";

export function HostCompatibilityProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const compatibility = useHostCompatibilityProbe();
  return (
    <HostCompatibilityContext.Provider value={compatibility}>
      {props.children}
    </HostCompatibilityContext.Provider>
  );
}
