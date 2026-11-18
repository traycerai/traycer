import { use } from "react";
import {
  TabSurfaceActivityContext,
  type TabSurfaceActivity,
} from "@/components/layout/tab-surface-activity-context";

/** Structural activity seam. */
export function useTabSurfaceActivity(): TabSurfaceActivity {
  return use(TabSurfaceActivityContext);
}
