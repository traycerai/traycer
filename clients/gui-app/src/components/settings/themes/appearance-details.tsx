import { useShallow } from "zustand/react/shallow";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
import { FontPicker } from "@/components/settings/controls/font-picker";
import { SettingsNumberInput } from "@/components/settings/controls/settings-number-input";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useRunnerInstalledFontsQuery } from "@/hooks/runner/use-runner-installed-fonts-query";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

export function AppearanceDetails() {
  const compact = useSettingsDensity() === "compact";
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
    <SettingsGroup
      title="More appearance options"
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
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
      <Collapsible>
        <CollapsibleTrigger
          className={cn(
            "group flex w-full items-center justify-between gap-3 text-start font-medium text-foreground transition-colors hover:bg-foreground/4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            compact ? "px-4 py-2.5" : "px-5 py-4",
          )}
        >
          <span>Advanced options</span>
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 rtl:rotate-180 rtl:group-data-[state=open]:rotate-90"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border/40">
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
        </CollapsibleContent>
      </Collapsible>
    </SettingsGroup>
  );
}
