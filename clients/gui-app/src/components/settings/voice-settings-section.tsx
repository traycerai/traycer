import { type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings/settings-store";

export function VoiceSettingsSection(): ReactNode {
  const { voiceInputEnabled, setVoiceInputEnabled } = useSettingsStore(
    useShallow((s) => ({
      voiceInputEnabled: s.voiceInputEnabled,
      setVoiceInputEnabled: s.setVoiceInputEnabled,
    })),
  );

  return (
    <SettingsRow
      label="Voice input"
      description="Dictate prompts with the mic button in the composer. Speech is transcribed on-device - audio never leaves your machine."
      control={
        <Switch
          checked={voiceInputEnabled}
          onCheckedChange={setVoiceInputEnabled}
          aria-label="Voice input"
        />
      }
    />
  );
}
