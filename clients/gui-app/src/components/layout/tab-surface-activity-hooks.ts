import { use } from "react";
import {
  TabSurfaceActivityContext,
  type TabSurfaceActivity,
} from "@/components/layout/tab-surface-activity-context";

export function useTabSurfaceActivity(): TabSurfaceActivity {
  return use(TabSurfaceActivityContext);
}
