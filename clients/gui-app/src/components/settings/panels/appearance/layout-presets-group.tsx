import type { ReactNode } from "react";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { LayoutThumbnail } from "@/components/settings/panels/appearance/layout-thumbnail";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  applyLayoutPreset,
  LAYOUT_PRESET_IDS,
  LAYOUT_PRESET_LABELS,
  layoutOverrideForPreset,
  resetLayoutToDefaults,
  useLayoutIsFullyDefault,
  useLayoutPresetMatch,
  type LayoutPresetId,
} from "@/lib/layout-presets";
import { cn } from "@/lib/utils";
import { LayoutOverrideProvider } from "@/providers/layout-override-provider";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * What distinguishes each preset, in one line. The text carries the choice; the
 * thumbnail beside it is decoration that can hide the very difference being
 * chosen at this size (D16).
 */
const PRESET_DESCRIPTIONS: Readonly<Record<LayoutPresetId, string>> = {
  default:
    "The standard amount of detail: dock rows open, full usage readings.",
  compact:
    "Every reading stays, none spelled out: dock rows fold to chips, and the dictation and compact buttons go.",
  detailed:
    "Everything the chrome can say, said: long usage readings, every button, the context breakdown pinned.",
};

function presetFromValue(value: string): LayoutPresetId | null {
  return LAYOUT_PRESET_IDS.find((id) => id === value) ?? null;
}

/**
 * The three presets with a picture each, and the way back.
 *
 * The same three bundles the Layout page's segmented control applies, through
 * the same `applyLayoutPreset` and the same match/Reset hooks - this is the
 * Customize era's front door to them, not a second implementation. There is no
 * selected-preset state: the pressed option is derived from the stores on every
 * render, so an edit made in the editor flips this to `Custom` with no
 * bookkeeping, and `Custom` is a verdict shown beside the group, never an
 * option a reader can pick.
 */
export function AppearanceLayoutPresets(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  if (!APPEARANCE.definitions.presets.availableWhen(availability)) return null;
  return <AvailableLayoutPresets />;
}

function AvailableLayoutPresets(): ReactNode {
  const row = APPEARANCE.definitions.presets;
  const compact = useSettingsDensity() === "compact";
  const match = useLayoutPresetMatch();
  const fullyDefault = useLayoutIsFullyDefault(match);
  return (
    <div
      data-settings-anchor={row.anchor ?? undefined}
      className={cn(
        "flex flex-col border-b border-border/40 last:border-b-0",
        compact ? "gap-2.5 px-4 py-2.5" : "gap-3 px-5 py-4",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-[50%] flex-1 space-y-1">
          <div className="font-medium text-foreground">{row.label}</div>
          <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
            {row.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {match === "custom" ? (
            <Badge variant="muted" data-testid="layout-preset-custom">
              {LAYOUT_PRESET_LABELS.custom}
            </Badge>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={fullyDefault}
            onClick={() => {
              // The id the Default option fires: one gesture, one setting; the
              // two differ in what they restore, not in what they are about.
              trackLayoutSetting("layout.preset.default");
              resetLayoutToDefaults();
            }}
          >
            Reset to defaults
          </Button>
        </div>
      </div>
      <RadioGroup
        // No option is checked while the verdict is `custom` - the honest
        // rendering of "none of these".
        value={match === "custom" ? "" : match}
        onValueChange={(value) => {
          const preset = presetFromValue(value);
          if (preset === null) return;
          trackLayoutSetting(`layout.preset.${preset}`);
          applyLayoutPreset(preset);
        }}
        aria-label="Layout preset"
        className="grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]"
      >
        {LAYOUT_PRESET_IDS.map((id) => (
          <PresetOption key={id} id={id} checked={match === id} />
        ))}
      </RadioGroup>
    </div>
  );
}

function PresetOption(props: {
  readonly id: LayoutPresetId;
  readonly checked: boolean;
}): ReactNode {
  const { id, checked } = props;
  const itemId = `appearance-layout-preset-${id}`;
  const nameId = `${itemId}-name`;
  const descriptionId = `${itemId}-description`;
  return (
    <label
      htmlFor={itemId}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-colors",
        checked
          ? "border-primary/50 bg-foreground/5"
          : "border-border/60 hover:bg-foreground/5",
      )}
    >
      <span className="flex items-center gap-2 font-medium text-foreground">
        {/* Named by the preset's name alone and described by its sentence, so
            the radio does not read out the whole card as its name. */}
        <RadioGroupItem
          id={itemId}
          value={id}
          aria-labelledby={nameId}
          aria-describedby={descriptionId}
        />
        <span id={nameId}>{LAYOUT_PRESET_LABELS[id]}</span>
      </span>
      <span
        id={descriptionId}
        className="text-pretty text-ui-sm text-muted-foreground"
      >
        {PRESET_DESCRIPTIONS[id]}
      </span>
      {/* The picture only. The label text above is the accessible name and the
          description, so a screen reader hears the choice once; the buttons of
          the page stay live outside this wrapper. */}
      <div
        inert
        aria-hidden
        className="pointer-events-none w-full rounded-md border border-border/60 bg-background p-2"
      >
        <LayoutOverrideProvider value={layoutOverrideForPreset(id)}>
          <LayoutThumbnail />
        </LayoutOverrideProvider>
      </div>
    </label>
  );
}
