import { AlertsNotificationKindsSection } from "@/components/settings/panels/alerts-notification-kinds-section";
import { ALERTS } from "@/components/settings/panels/alerts-settings.definitions";
import { PushPermissionSection } from "@/components/settings/panels/push-permission-section";
import { SystemNotificationSettingsSection } from "@/components/settings/panels/system-notification-settings-section";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  isAlertsSystemGroupAvailable,
  isPushPermissionRowAvailable,
} from "@/lib/settings/settings-availability";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

export function AlertsSettingsPanel() {
  const availability = useSettingsAvailabilityContext();
  const compact = useSettingsDensity() === "compact";
  // The OS row exists on the desktop and the push row in the phone app; each
  // gates itself, and a shell with neither draws no System card.
  const system = isAlertsSystemGroupAvailable(availability) ? (
    <SettingsGroup
      group={ALERTS.definitions.system}
      showTitle
      tone="default"
      dataTestId="alerts-system-section"
      fill={false}
    >
      <SystemNotificationSettingsSection />
      <PushPermissionSection />
    </SettingsGroup>
  ) : null;
  // The push row says whether the Push switches can move, so on the phone it
  // comes before them; the desktop's OS row is a pointer and comes last.
  const systemFirst = isPushPermissionRowAvailable(availability);
  return (
    <SettingsPanelShell
      title={ALERTS.page.label}
      description={
        availability.mobileApp
          ? "What interrupts you on this device. Every notification still appears in the bell."
          : "What interrupts you on this computer. Every notification still appears in the bell."
      }
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        {systemFirst ? system : null}
        <AlertsNotificationKindsSection />
        {systemFirst ? null : system}
      </div>
    </SettingsPanelShell>
  );
}
