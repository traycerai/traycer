import { use, type ReactNode } from "react";
import { SurfaceActivityContext } from "@/components/home/composer/surface-activity-context-internal";

/** Providers compose: a nested provider can only narrow activity, never widen it past its parent (e.g. the
 * landing surface provides "home page not occluded by a system modal". */
export function SurfaceActivityProvider(props: {
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  const parentActive = use(SurfaceActivityContext);
  const active = parentActive ? props.active : false;
  return (
    <SurfaceActivityContext.Provider value={active}>
      {props.children}
    </SurfaceActivityContext.Provider>
  );
}
