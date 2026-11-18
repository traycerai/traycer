import { Settings } from "lucide-react";
import { SettingsModalContent } from "@/components/settings/settings-modal-content";
import { consumeSettingsEscape } from "@/components/settings/settings-escape-consumers";
import { isSettingsSearchActive } from "@/lib/settings-search/settings-search";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { resolveSettingsTabIntent } from "@/lib/commands/actions/open-system-tab";
import { isSettingsPath } from "@/stores/tabs/kinds/settings";
import {
  beginRulesEditHandoff,
  cancelRulesEditHandoff,
} from "@/components/settings/panels/permissions/rules-edit-store";
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
  // A body control that owns Escape while the keyboard is in it (Fallback's
  // Test a model panel) comes first: it is where the user is. Then a running
  // search, the innermost thing Escape can otherwise mean: the first press
  // clears it, and only the next one closes Settings.
  consumeEscape: () => {
    if (consumeSettingsEscape()) return true;
    const { query, setQuery } = useSettingsSearchStore.getState();
    if (!isSettingsSearchActive(query)) return false;
    setQuery("");
    return true;
  },
  // A reveal armed in the modal has to land in the tab the modal becomes, and
  // so does an unsaved Rules edit: the modal closing on the way is not a close.
  prepareForPromotion: () => {
    useSettingsSearchStore.getState().beginRevealHandoff();
    beginRulesEditHandoff();
  },
  // A refused promotion keeps the modal open, and no tab will take either
  // handoff: each ends here, so the modal's real close still resets.
  abandonPromotion: () => {
    useSettingsSearchStore.getState().endRevealHandoff();
    cancelRulesEditHandoff();
  },
};
