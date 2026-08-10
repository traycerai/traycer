import { type ReactNode } from "react";
import {
  TabSurfaceActivityContext,
  type TabSurfaceActivity,
} from "@/components/layout/tab-surface-activity-context";

export function TabSurfaceActivityProvider(props: {
  readonly activity: TabSurfaceActivity;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <TabSurfaceActivityContext.Provider value={props.activity}>
      {props.children}
    </TabSurfaceActivityContext.Provider>
  );
}
