import { useShallow } from "zustand/react/shallow";
import { useState } from "react";
import { FontPicker } from "@/components/settings/controls/font-picker";
import { SettingsNumberInput } from "@/components/settings/controls/settings-number-input";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useRunnerInstalledFontsQuery } from "@/hooks/runner/use-runner-installed-fonts-query";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

export function AppearanceDetails() {
  const [advanced, setAdvanced] = useState(false);
  const preferences = useThemeLibraryStore(
    useShallow((state) => ({
      promptFontFamily: state.promptFontFamily,
      promptFontSize: state.promptFontSize,
      fontLigatures: state.fontLigatures,
      panelAnimations: state.panelAnimations,
      panelAnimationDuration: state.panelAnimationDuration,
      contrast: state.contrast,
      setAppearancePreference: state.setAppearancePreference,
    })),
  );
  const fonts = useRunnerInstalledFontsQuery();
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-ui-sm">More appearance options</h2>
        <label
          htmlFor="appearance-advanced"
          className="flex items-center gap-2 text-ui-xs"
        >
          Advanced
          <Switch
            id="appearance-advanced"
            checked={advanced}
            onCheckedChange={setAdvanced}
          />
        </label>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60">
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
        {advanced ? (
          <>
            <SettingsRow
              label="Font ligatures"
              description="Use combined letterforms in prompts and code when the font supports them."
              control={
                <Switch
                  checked={preferences.fontLigatures}
                  onCheckedChange={(fontLigatures) =>
                    preferences.setAppearancePreference({ fontLigatures })
                  }
                  aria-label="Font ligatures"
                />
              }
            />
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
              label="Panel animation duration"
              description="How quickly sidebars, menus, and dialogs open and close."
              control={
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
                  ariaLabel="Panel animation duration"
                  defaultValue={100}
                  resetTooltip="Reset animation duration"
                />
              }
            />
            <SettingsRow
              label="Contrast"
              description="Adjust text and border contrast across the interface."
              control={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <output className="text-ui-xs tabular-nums">
                    {preferences.contrast}%
                  </output>
                  <input
                    type="range"
                    aria-label="Appearance contrast"
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
          </>
        ) : null}
      </div>
    </section>
  );
}
