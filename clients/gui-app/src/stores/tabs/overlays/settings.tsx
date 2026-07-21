import { Settings } from "lucide-react";
import { SettingsModalContent } from "@/components/settings/settings-modal-content";
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
};
