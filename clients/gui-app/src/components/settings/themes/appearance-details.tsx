import { useShallow } from "zustand/react/shallow";
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
        label="Prompt font"
        description="The font used where you write prompts."
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
        label="Use font ligatures"
        description="Join characters such as != into a single symbol in prompts and code, when supported by the font. The underlying text stays the same."
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
      title="Motion and readability"
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <SettingsRow
        label="Panel animations"
        description="Animate sidebars, menus, and dialogs as they open and close."
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
        label="Animation duration"
        description="Lower values are faster; 0 ms is instant. Applies when panel animations are on."
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
        label="Text and border contrast"
        description="100% uses the theme’s original colors. Increase it to make text and borders stand out more."
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
