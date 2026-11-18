import { House } from "lucide-react";
import {
  SHOW_HIDE_VERBS,
  type LayoutRegion,
} from "@/components/layout-editor/regions/region-grammar";
import { shownStateWord } from "@/components/layout-editor/regions/region-state-words";
import { alwaysLive } from "@/components/layout-editor/regions/row-availability";
import { alwaysAvailable } from "@/lib/settings/settings-availability";

/**
 * The Home tab's row on a phone, where there is no tab strip: what Shown still
 * decides is the menu's Home row and where the app opens with no task open
 * (`MobileNavDrawer`, `MobileAppHeader`), so the row says that instead.
 */
export const HOME_TAB_PHONE_HINT =
  "Adds Home to the menu and opens it when no task is open. Hidden, the app opens on a new task.";

/** The Tabs surface's one customizable element. */
export const HOME_TAB_REGION: LayoutRegion<"homeTab"> = {
  id: "homeTab",
  name: "Home tab",
  surface: "topBar",
  icon: House,
  where: "Tab strip - left of the tabs",
  whereByHost: null,
  hint: null,
  keywords: ["home", "start", "page", "tab"],
  rows: [],
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  quickVerbs: SHOW_HIDE_VERBS,
  stateWord: shownStateWord,
};
