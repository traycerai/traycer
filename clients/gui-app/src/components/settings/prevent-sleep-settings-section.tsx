import { type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { trackSettingChanged } from "@/lib/analytics";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";

export function PreventSleepSettingsSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  const { preventSleepWhileRunning, setPreventSleepWhileRunning } =
    useSettingsStore(
      useShallow((s) => ({
        preventSleepWhileRunning: s.preventSleepWhileRunning,
        setPreventSleepWhileRunning: s.setPreventSleepWhileRunning,
      })),
    );

  // The only consumer of this setting is `PreventSleepController`, which holds
  // an OS power-save blocker through the desktop power bridge. Where that
  // bridge is absent the toggle would persist a preference nothing can act on
  // and the device would sleep anyway. The gate itself is the row definition's
  // `availableWhen` (`isPreventSleepRowAvailable`), which search reads from the
  // same definition, so the row and the result pointing at it cannot disagree.
  if (!GENERAL.definitions.preventSleep.availableWhen(availability))
    return null;

  return (
    <SettingsRow
      row={GENERAL.definitions.preventSleep}
      control={
        <Switch
          checked={preventSleepWhileRunning}
          onCheckedChange={(value) => {
            trackSettingChanged("general", "preventSleepWhileRunning");
            setPreventSleepWhileRunning(value);
          }}
          aria-label="Prevent sleep while running"
        />
      }
    />
  );
}
