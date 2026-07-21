import { use } from "react";
import {
  TabSurfaceActivityContext,
  type TabSurfaceActivity,
} from "@/components/layout/tab-surface-activity-context";

/** Structural activity seam; focused ownership is completed in T8. */
export function useTabSurfaceActivity(): TabSurfaceActivity {
  return use(TabSurfaceActivityContext);
}
