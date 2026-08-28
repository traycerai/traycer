import { type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { trackSettingChanged } from "@/lib/analytics";
import { resolveDesktopPowerBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";

export function PreventSleepSettingsSection(): ReactNode {
  const { preventSleepWhileRunning, setPreventSleepWhileRunning } =
    useSettingsStore(
      useShallow((s) => ({
        preventSleepWhileRunning: s.preventSleepWhileRunning,
        setPreventSleepWhileRunning: s.setPreventSleepWhileRunning,
      })),
    );
  const runnerHost = useRunnerHost();

  // The only consumer of this setting is `PreventSleepController`, which holds
  // an OS power-save blocker through the desktop power bridge. Where that
  // bridge is absent the toggle would persist a preference nothing can act on
  // and the device would sleep anyway, so the row is keyed on the bridge the
  // controller itself resolves - feature-detected, because `power` is a
  // duck-typed extra a shell installs and not a typed `IRunnerHost` field.
  if (resolveDesktopPowerBridge(runnerHost) === null) return null;

  return (
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
  );
}
