import { useShallow } from "zustand/react/shallow";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { FontPicker } from "@/components/settings/controls/font-picker";
import { SettingsNumberInput } from "@/components/settings/controls/settings-number-input";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useRunnerInstalledFontsQuery } from "@/hooks/runner/use-runner-installed-fonts-query";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

export function AppearanceFontRows() {
  const preferences = useThemeLibraryStore(
    useShallow((state) => ({
      promptFontFamily: state.promptFontFamily,
      promptFontSize: state.promptFontSize,
      fontLigatures: state.fontLigatures,
      setAppearancePreference: state.setAppearancePreference,
    })),
  );
  const fonts = useRunnerInstalledFontsQuery();
  return (
    <>
      <SettingsRow
        row={APPEARANCE.definitions.promptFont}
        control={
          <div className="flex flex-wrap justify-end gap-2">
            <FontPicker
              value={preferences.promptFontFamily}
              onChange={(promptFontFamily) =>
                preferences.setAppearancePreference({ promptFontFamily })
              }
              options={fonts.data ?? []}
              defaultLabel="Same as interface"
              resetTooltip="Use interface font"
              ariaLabel="Prompt font"
            />
            <SettingsNumberInput
              value={preferences.promptFontSize}
              onChange={(promptFontSize) =>
                preferences.setAppearancePreference({ promptFontSize })
              }
              min={10}
              max={24}
              unit="px"
              ariaLabel="Prompt font size"
              defaultValue={14}
              resetTooltip="Reset prompt size"
            />
          </div>
        }
      />
      <SettingsRow
        row={APPEARANCE.definitions.fontLigatures}
        control={
          <Switch
            checked={preferences.fontLigatures}
            onCheckedChange={(fontLigatures) =>
              preferences.setAppearancePreference({ fontLigatures })
            }
            aria-label="Use font ligatures"
          />
        }
      />
    </>
  );
}

export function AppearanceDetails() {
  const preferences = useThemeLibraryStore(
    useShallow((state) => ({
      panelAnimations: state.panelAnimations,
      panelAnimationDuration: state.panelAnimationDuration,
      contrast: state.contrast,
      setAppearancePreference: state.setAppearancePreference,
    })),
  );
  return (
    <SettingsGroup
      group={APPEARANCE.definitions.motionAndReadability}
      showTitle
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <SettingsRow
        row={APPEARANCE.definitions.panelAnimations}
        control={
          <Switch
            checked={preferences.panelAnimations}
            onCheckedChange={(panelAnimations) =>
              preferences.setAppearancePreference({ panelAnimations })
            }
            aria-label="Panel animations"
          />
        }
      />
      <SettingsRow
        row={APPEARANCE.definitions.panelAnimationDuration}
        control={
          <fieldset
            disabled={!preferences.panelAnimations}
            className="min-w-0 disabled:opacity-50"
          >
            <SettingsNumberInput
              value={preferences.panelAnimationDuration}
              onChange={(panelAnimationDuration) =>
                preferences.setAppearancePreference({
                  panelAnimationDuration,
                })
              }
              min={0}
              max={500}
              unit="ms"
              ariaLabel="Animation duration"
              defaultValue={100}
              resetTooltip="Reset animation duration"
            />
          </fieldset>
        }
      />
      <SettingsRow
        row={APPEARANCE.definitions.contrast}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <output className="text-ui-xs tabular-nums">
              {preferences.contrast}%
            </output>
            <input
              type="range"
              aria-label="Text and border contrast"
              min={70}
              max={130}
              value={preferences.contrast}
              onChange={(event) =>
                preferences.setAppearancePreference({
                  contrast: Number(event.target.value),
                })
              }
              className="accent-primary"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                preferences.setAppearancePreference({ contrast: 100 })
              }
            >
              Reset
            </Button>
          </div>
        }
      />
    </SettingsGroup>
  );
}
