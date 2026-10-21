import { useMemo } from "react";
import { useIsNarrowWindow } from "@/hooks/ui/use-narrow-window";
import {
  phoneLayoutDiffViewerPreferences,
  type DiffViewerPreferences,
} from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The diff viewer preferences a tile RENDERS with: the stored ones, except
 * in a window narrower than the mobile breakpoint, where the layout is
 * always one column (`phoneLayoutDiffViewerPreferences`). Every git and
 * snapshot diff tile reads through here so the rendering and its toolbar
 * agree; the settings doors keep reading the store, because they edit the
 * stored choice.
 *
 * Keyed on WIDTH, not on the phone-layout policy: an iPad or an unfolded
 * phone in landscape runs the phone-layout bundle and still has room for two
 * columns, and a desktop browser tab narrowed past the breakpoint does not.
 * Rotating or widening the window is the way back to the stored choice.
 */
export function useDiffViewerPreferences(): DiffViewerPreferences {
  const stored = useSettingsStore((s) => s.diffViewerPreferences);
  const narrowWindow = useIsNarrowWindow();
  return useMemo(
    () => (narrowWindow ? phoneLayoutDiffViewerPreferences(stored) : stored),
    [narrowWindow, stored],
  );
}
