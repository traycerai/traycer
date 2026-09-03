import { type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { trackSettingChanged } from "@/lib/analytics";
import { isMobileApp } from "@/lib/mobile-app";

export function PreventSleepSettingsSection(): ReactNode {
  const { preventSleepWhileRunning, setPreventSleepWhileRunning } =
    useSettingsStore(
      useShallow((s) => ({
        preventSleepWhileRunning: s.preventSleepWhileRunning,
        setPreventSleepWhileRunning: s.setPreventSleepWhileRunning,
      })),
    );

  // The only consumer of this setting is `PreventSleepController`, which holds
  // an OS power-save blocker through the desktop power bridge -
  // `resolveDesktopPowerBridge` returns null in the mobile app, so the toggle
  // would persist a preference nothing can act on and the device would sleep
  // anyway. Hide it there.
  //
  // The GROUP is returned from here, not from the panel, because this is the
  // only row in it: the two resource-visibility toggles that used to sit
  // beside it moved to Layout. One gate then hides the heading with the row it
  // headed - and it stays one gate on the day this narrows from the build
  // identity to the capability it is really about. Same shape as
  // `BrowserSettingsSection`, which owns its own `SettingsGroup` and drops the
  // whole card when no dev origins were detected.
  if (isMobileApp()) return null;

  return (
    <SettingsGroup
      title="Running agents"
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <SettingsRow
        label="Prevent sleep while running"
        description="Keep the computer awake while an agent is running, so work continues when you step away."
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
    </SettingsGroup>
  );
}
