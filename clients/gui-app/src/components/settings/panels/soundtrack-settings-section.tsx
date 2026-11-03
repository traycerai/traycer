import type { ReactNode } from "react";
import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
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
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
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

/** The soundtrack's level and what it follows; its toggle is in the top row. */
export function SoundtrackSettingsSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
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
    </SettingsGroup>
  );
}
