import type { ReactNode } from "react";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { type SettingsSectionId } from "@/lib/settings-sections";
import { GeneralSettingsPanel } from "@/components/settings/panels/general-settings-panel";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { KeybindingsSettingsPanel } from "@/components/settings/panels/keybindings-settings-panel";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import { WorktreesSettingsPanel } from "@/components/settings/panels/worktrees-settings-panel";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

export interface SettingsModalContentProps {
  readonly section: SettingsSectionId | null;
}

/**
 * Renders the settings UI inside the modal: sidebar (modal mode) +
 * the panel for the active section. Falls back to the General panel
 * when `section` is null (e.g., on the very first open).
 */
export function SettingsModalContent(
  props: SettingsModalContentProps,
): ReactNode {
  const { setSection } = useSystemTabModalActions();
  const section: SettingsSectionId = props.section ?? "general";
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SettingsSidebar
        mode={{
          kind: "modal",
          activeSection: section,
          onSelect: setSection,
        }}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <SettingsPanelForSection section={section} />
      </div>
    </div>
  );
}

function SettingsPanelForSection(props: {
  readonly section: SettingsSectionId;
}): ReactNode {
  switch (props.section) {
    case "general":
      return <GeneralSettingsPanel />;
    case "appearance":
      return <AppearanceSettingsPanel />;
    case "providers":
      return <ProvidersSettingsPanel />;
    case "keybindings":
      return <KeybindingsSettingsPanel />;
    case "shell":
      return <ShellSettingsPanel />;
    case "worktrees":
      return <WorktreesSettingsPanel />;
    case "host":
      return <HostSettingsPanel />;
  }
}
