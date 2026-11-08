import type { ReactNode } from "react";
import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { SoundtrackRecordingRow } from "@/components/settings/panels/soundtrack-recording-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Slider,
  SliderRange,
  SliderThumb,
  SliderTrack,
} from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  setPlaybackControlsOn,
  setSoundtrackOn,
} from "@/lib/commands/actions/soundtrack";
import {
  isMixDirectorId,
  type MixDirectorId,
} from "@/lib/soundtrack/directors";
import { useSettingsStore } from "@/stores/settings/settings-store";

const VOLUME_STEP = 0.05;

const DIRECTOR_LABELS: Readonly<Record<MixDirectorId, string>> = {
  static: "The open page",
  rules: "Page, alerts and agents",
};

const DIRECTOR_IDS: readonly MixDirectorId[] = ["static", "rules"];

/**
 * The soundtrack's switch, its level and what it follows, and on a build that
 * can save one, a recording of it. The level and what it follows stay editable
 * while it is off, so it comes back the way it was set. Its playback controls
 * show only while it is on, and keep their value.
 */
export function SoundtrackSettingsSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  const on = useSettingsStore((state) => state.soundtrackEnabled);
  const playbackControls = useSettingsStore(
    (state) => state.soundtrackPlaybackControls,
  );
  const volume = useSettingsStore((state) => state.soundtrackVolume);
  const setVolume = useSettingsStore((state) => state.setSoundtrackVolume);
  const director = useSettingsStore((state) => state.soundtrackDirector);
  const setDirector = useSettingsStore((state) => state.setSoundtrackDirector);
  if (!APP_NOTIFICATIONS.definitions.soundtrack.availableWhen(availability)) {
    return null;
  }
  return (
    <SettingsGroup
      group={APP_NOTIFICATIONS.definitions.soundtrack}
      showTitle
      tone="default"
      dataTestId="soundtrack-settings-section"
      fill={false}
    >
      <SettingsRow
        row={APP_NOTIFICATIONS.definitions.soundtrackEnabled}
        control={
          <Switch
            checked={on}
            onCheckedChange={setSoundtrackOn}
            aria-label="Music"
          />
        }
      />
      {APP_NOTIFICATIONS.definitions.soundtrackPlaybackControls.availableWhen(
        availability,
      ) ? (
        <SettingsRow
          row={APP_NOTIFICATIONS.definitions.soundtrackPlaybackControls}
          control={
            <Switch
              checked={playbackControls}
              onCheckedChange={setPlaybackControlsOn}
              aria-label="Playback controls"
            />
          }
        />
      ) : null}
      <SettingsRow
        row={APP_NOTIFICATIONS.definitions.soundtrackVolume}
        control={
          <Slider
            className="w-[min(40vw,9rem)]"
            value={[volume]}
            min={0}
            max={1}
            step={VOLUME_STEP}
            onValueChange={(next) => {
              setVolume(next[0]);
            }}
          >
            <SliderTrack size="default">
              <SliderRange />
            </SliderTrack>
            <SliderThumb size="default" aria-label="Soundtrack volume" />
          </Slider>
        }
      />
      <SettingsRow
        row={APP_NOTIFICATIONS.definitions.soundtrackDirector}
        control={
          <Select
            value={director}
            onValueChange={(next) => {
              if (isMixDirectorId(next)) setDirector(next);
            }}
          >
            <SelectTrigger
              className="w-[min(50vw,13rem)]"
              aria-label="What the soundtrack follows"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIRECTOR_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {DIRECTOR_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {APP_NOTIFICATIONS.definitions.soundtrackRecording.availableWhen(
        availability,
      ) ? (
        <SoundtrackRecordingRow />
      ) : null}
    </SettingsGroup>
  );
}
