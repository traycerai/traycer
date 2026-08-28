import type { ReactNode } from "react";
import { SettingsDensityContext } from "@/providers/settings-density-context";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import {
  isSettingsSectionVisible,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import { GeneralSettingsPanel } from "@/components/settings/panels/general-settings-panel";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { KeybindingsSettingsPanel } from "@/components/settings/panels/keybindings-settings-panel";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import { WorktreesSettingsPanel } from "@/components/settings/panels/worktrees-settings-panel";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { DevicesSessionsPanel } from "@/components/settings/panels/devices-sessions-panel";
import { LinkPhonePanel } from "@/components/settings/panels/link-phone-panel";
import { AppDiagnosticsSettingsPanel } from "@/components/settings/panels/app-diagnostics-settings-panel";
import { DiagnosticsSettingsPanel } from "@/components/settings/panels/diagnostics-settings-panel";
import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { AgentsSettingsPanel } from "@/components/settings/panels/agents-settings-panel";
import { NotificationsSettingsPanel } from "@/components/settings/panels/notifications-settings-panel";
import { UsageSettingsPanel } from "@/components/settings/panels/usage-settings-panel";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

export interface SettingsModalContentProps {
  readonly section: SettingsSectionId | null;
}

/**
 * Renders the settings UI inside the modal: sidebar (modal mode) +
 * the panel for the active section. Falls back to the General panel
 * when `section` is null (e.g., on the very first open).
 *
 * The section is REMEMBERED across launches, so it can also name a section
 * this build does not offer - and the rail beside it would then have no row
 * for the panel on screen. That falls back to General too, keyed off the
 * offered list rather than off the reason a section is missing from it.
 */
export function SettingsModalContent(
  props: SettingsModalContentProps,
): ReactNode {
  const { setSection } = useSystemTabModalActions();
  const requested: SettingsSectionId = props.section ?? "general";
  const section: SettingsSectionId = isSettingsSectionVisible(requested)
    ? requested
    : "general";
  return (
    <SettingsDensityContext.Provider value="compact">
      <div className="flex min-h-0 min-w-0 flex-1">
        <SettingsSidebar
          mode={{
            kind: "modal",
            activeSection: section,
            onSelect: setSection,
          }}
          variant="rail"
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <SettingsPanelForSection section={section} />
        </div>
      </div>
    </SettingsDensityContext.Provider>
  );
}

export function SettingsPanelForSection(props: {
  readonly section: SettingsSectionId;
}): ReactNode {
  switch (props.section) {
    case "general":
      return <GeneralSettingsPanel />;
    case "appearance":
      return <AppearanceSettingsPanel />;
    case "providers":
      return <ProvidersSettingsPanel />;
    case "notifications":
      return <NotificationsSettingsPanel />;
    case "agents":
      return <AgentsSettingsPanel />;
    case "keybindings":
      return <KeybindingsSettingsPanel />;
    case "shell":
      return <ShellSettingsPanel />;
    case "worktrees":
      return <WorktreesSettingsPanel />;
    case "host":
      return <HostSettingsPanel />;
    case "devices":
      return <DevicesSessionsPanel />;
    case "link-phone":
      return <LinkPhonePanel />;
    case "app-diagnostics":
      return <AppDiagnosticsSettingsPanel />;
    case "diagnostics":
      return <DiagnosticsSettingsPanel />;
    case "usage":
      return <UsageSettingsPanel />;
  }
}
