import type { ReactNode } from "react";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { trackSettingChanged } from "@/lib/analytics";
import {
  GIT_DIFF_INDICATOR_STYLE_LABELS,
  GIT_DIFF_VIEW_MODE_LABELS,
  type DiffViewerPreferencesPatch,
  type GitDiffIndicatorStyle,
  type GitDiffViewMode,
} from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";

const MODE_OPTIONS: ReadonlyArray<{
  readonly value: GitDiffViewMode;
  readonly label: string;
}> = (["split", "unified"] as const).map((value) => ({
  value,
  label: GIT_DIFF_VIEW_MODE_LABELS[value],
}));

const INDICATOR_OPTIONS: ReadonlyArray<{
  readonly value: GitDiffIndicatorStyle;
  readonly label: string;
}> = (["bars", "classic", "none"] as const).map((value) => ({
  value,
  label: GIT_DIFF_INDICATOR_STYLE_LABELS[value],
}));

/**
 * Settings' door to the diff viewer preferences. The diff tile's settings
 * popover is the in-context door to the same `diffViewerPreferences`, so a
 * change in either shows in both and in every open diff.
 */
export function DiffViewerSettingsSection(): ReactNode {
  const preferences = useSettingsStore((state) => state.diffViewerPreferences);
  const patchPreferences = useSettingsStore(
    (state) => state.patchDiffViewerPreferences,
  );
  const patch = (next: DiffViewerPreferencesPatch): void => {
    trackSettingChanged("appearance", "diffViewerPreferences");
    patchPreferences(next);
  };

  return (
    <SettingsGroup
      group={APPEARANCE.definitions.diffViewer}
      showTitle={false}
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <SettingsRow
        row={APPEARANCE.definitions.diffLayout}
        control={
          <SettingsSegmentedControl
            value={preferences.mode}
            options={MODE_OPTIONS}
            onChange={(mode) => {
              patch({ mode });
            }}
            ariaLabel="Diff layout"
            disabled={false}
          />
        }
      />
      <SettingsRow
        row={APPEARANCE.definitions.diffLineNumbers}
        control={
          <Switch
            checked={preferences.lineNumbers}
            onCheckedChange={(lineNumbers) => {
              patch({ lineNumbers });
            }}
            aria-label={APPEARANCE.definitions.diffLineNumbers.label}
          />
        }
      />
      <SettingsRow
        row={APPEARANCE.definitions.diffBackgrounds}
        control={
          <Switch
            checked={preferences.backgrounds}
            onCheckedChange={(backgrounds) => {
              patch({ backgrounds });
            }}
            aria-label={APPEARANCE.definitions.diffBackgrounds.label}
          />
        }
      />
      <SettingsRow
        row={APPEARANCE.definitions.diffGutterMarks}
        control={
          <SettingsSegmentedControl
            value={preferences.indicatorStyle}
            options={INDICATOR_OPTIONS}
            onChange={(indicatorStyle) => {
              patch({ indicatorStyle });
            }}
            ariaLabel="Gutter marks"
            disabled={false}
          />
        }
      />
      <SettingsRow
        row={APPEARANCE.definitions.diffWordWrap}
        control={
          <Switch
            checked={preferences.wordWrap}
            onCheckedChange={(wordWrap) => {
              patch({ wordWrap });
            }}
            aria-label={APPEARANCE.definitions.diffWordWrap.label}
          />
        }
      />
      <SettingsRow
        row={APPEARANCE.definitions.diffIgnoreWhitespace}
        control={
          <Switch
            checked={preferences.ignoreWhitespace}
            onCheckedChange={(ignoreWhitespace) => {
              patch({ ignoreWhitespace });
            }}
            aria-label={APPEARANCE.definitions.diffIgnoreWhitespace.label}
          />
        }
      />
    </SettingsGroup>
  );
}
