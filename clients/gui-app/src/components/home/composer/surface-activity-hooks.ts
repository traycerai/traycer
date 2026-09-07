import { useContext } from "react";
import { SurfaceActivityContext } from "@/components/home/composer/surface-activity-context-internal";

export function useSurfaceActivity(): boolean {
  return useContext(SurfaceActivityContext);
}
