import { Settings } from "lucide-react";
import { SettingsModalContent } from "@/components/settings/settings-modal-content";
import { isSettingsSearchActive } from "@/lib/settings-search/settings-search";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { resolveSettingsTabIntent } from "@/lib/commands/actions/open-system-tab";
import { isSettingsPath } from "@/stores/tabs/kinds/settings";
import type { SystemOverlayModule } from "@/stores/tabs/system-overlay-registry";

export const settingsOverlayModule: SystemOverlayModule<"settings"> = {
  kind: "settings",
  label: "Settings",
  Icon: Settings,
  renderBody: (active) => <SettingsModalContent section={active.section} />,
  promotionIntent: (active) =>
    resolveSettingsTabIntent({
      subSection: active.section,
      resetToGeneral: false,
    }),
  isOverlayPath: (pathname) => isSettingsPath(pathname),
  // A running search is the innermost thing Escape can mean: the first press
  // clears it, and only the next one closes Settings.
  consumeEscape: () => {
    const { query, setQuery } = useSettingsSearchStore.getState();
    if (!isSettingsSearchActive(query)) return false;
    setQuery("");
    return true;
  },
};
