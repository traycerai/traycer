import { useContext } from "react";
import { SurfaceActivityContext } from "@/components/home/composer/surface-activity-context-internal";

/** See `SurfaceActivityProvider`. Defaults to `true` with no provider. */
export function useSurfaceActivity(): boolean {
  return useContext(SurfaceActivityContext);
}
