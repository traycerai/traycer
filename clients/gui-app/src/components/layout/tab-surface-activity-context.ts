import { createContext } from "react";

export interface TabSurfaceActivity {
  readonly visible: boolean;
  readonly focused: boolean;
}

export const TabSurfaceActivityContext = createContext<TabSurfaceActivity>({
  visible: true,
  focused: true,
});
