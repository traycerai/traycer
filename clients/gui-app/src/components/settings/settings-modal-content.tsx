import type { ReactNode } from "react";
import { SettingsDensityContext } from "@/providers/settings-density-context";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import {
  isSettingsSectionVisible,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import { GeneralSettingsPanel } from "@/components/settings/panels/general-settings-panel";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import { OpeningBehaviorPanel } from "@/components/settings/panels/opening-behavior-panel";
import { KeybindingsSettingsPanel } from "@/components/settings/panels/keybindings-settings-panel";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import { WorktreesSettingsPanel } from "@/components/settings/panels/worktrees-settings-panel";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { DevicesSessionsPanel } from "@/components/settings/panels/devices-sessions-panel";
import { LinkPhonePanel } from "@/components/settings/panels/link-phone-panel";
import { AppDiagnosticsSettingsPanel } from "@/components/settings/panels/app-diagnostics-settings-panel";
import { AppNotificationsSettingsPanel } from "@/components/settings/panels/app-notifications-settings-panel";
import { DiagnosticsSettingsPanel } from "@/components/settings/panels/diagnostics-settings-panel";
import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { AgentsSettingsPanel } from "@/components/settings/panels/agents-settings-panel";
import { NotificationsSettingsPanel } from "@/components/settings/panels/notifications-settings-panel";
import { UsageSettingsPanel } from "@/components/settings/panels/usage-settings-panel";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { useSettingsAnchorReveal } from "@/components/settings/use-settings-anchor-reveal";
import "./settings-search.css";

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
        {/* The pane a page result scrolls to the top: see
            `useSettingsAnchorReveal`. Marked here, by the surface, rather
            than by each panel, so a bespoke panel cannot opt out of it. */}
        <div
          data-settings-panel-pane
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
        >
          <SettingsPanelForSection section={section} />
        </div>
      </div>
    </SettingsDensityContext.Provider>
  );
}

/**
 * The panel each section renders. A `Record` keyed by the union rather than a
 * `switch`: `satisfies` keeps it exhaustive (a new section id is a compile
 * error here) without a `case` per entry.
 */
const SETTINGS_PANELS = {
  general: GeneralSettingsPanel,
  appearance: AppearanceSettingsPanel,
  layout: LayoutSettingsPanel,
  "opening-behavior": OpeningBehaviorPanel,
  "app-notifications": AppNotificationsSettingsPanel,
  providers: ProvidersSettingsPanel,
  notifications: NotificationsSettingsPanel,
  agents: AgentsSettingsPanel,
  keybindings: KeybindingsSettingsPanel,
  shell: ShellSettingsPanel,
  worktrees: WorktreesSettingsPanel,
  host: HostSettingsPanel,
  devices: DevicesSessionsPanel,
  "link-phone": LinkPhonePanel,
  "app-diagnostics": AppDiagnosticsSettingsPanel,
  diagnostics: DiagnosticsSettingsPanel,
  usage: UsageSettingsPanel,
} satisfies Record<SettingsSectionId, () => ReactNode>;

export function SettingsPanelForSection(props: {
  readonly section: SettingsSectionId;
}): ReactNode {
  // The one mount point for the settings-search reveal watcher, and the reason
  // it sits here rather than in either surface: both the modal and the routed
  // tab render their panel THROUGH this function, so one watcher covers both
  // and there is no arrangement of surfaces that gets two of them.
  useSettingsAnchorReveal(props.section);
  const Panel = SETTINGS_PANELS[props.section];
  return <Panel />;
}
