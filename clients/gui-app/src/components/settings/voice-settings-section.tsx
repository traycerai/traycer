import { type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isVoiceInputRowAvailable } from "@/lib/settings/settings-availability";

export function VoiceSettingsSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  const { voiceInputEnabled, setVoiceInputEnabled } = useSettingsStore(
    useShallow((s) => ({
      voiceInputEnabled: s.voiceInputEnabled,
      setVoiceInputEnabled: s.setVoiceInputEnabled,
    })),
  );

  // `useDictationAvailability` refuses dictation outright without a local host,
  // so this row would be a toggle for something the shell will not do - and the
  // description below promises on-device transcription that a shell whose every
  // reachable host is a remote machine cannot deliver. The gate itself lives in
  // `isVoiceInputRowAvailable`, which the search entry pointing at this row
  // calls too: same capability, same gate, so the two cannot disagree.
  if (!isVoiceInputRowAvailable(availability)) return null;

  return (
    <SettingsRow
      label="Voice input"
      anchor="general-voice-input"
      description="Dictate prompts with the mic button in the composer. Speech is transcribed on-device - audio never leaves your machine."
      control={
        <Switch
          checked={voiceInputEnabled}
          onCheckedChange={(enabled) => {
            Analytics.getInstance().track(
              enabled
                ? AnalyticsEvent.VoiceEnabled
                : AnalyticsEvent.VoiceDisabled,
              { source: "direct_ui" },
            );
            setVoiceInputEnabled(enabled);
          }}
          aria-label="Voice input"
        />
      }
    />
  );
}
