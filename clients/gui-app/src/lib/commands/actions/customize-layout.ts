import type { NavigateFn } from "@tanstack/react-router";
import { activateTabIntent } from "@/lib/tab-navigation";
import {
  captureSettingsOpener,
  ensureSampleWorkspaceTab,
  enterCustomize,
} from "@/lib/customize/enter-exit";
import type { AnalyticsSource } from "@/lib/analytics";
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { isVisualLayoutEditorEnabled } from "@/stores/settings/settings-store";

/**
 * Start Customize on the current tab. The one function behind the palette, the
 * chrome's context menus and the Appearance card; `source` is the gesture that
 * reached it, reported on `layout_editor_opened`.
 */
export function customizeLayoutAction(source: AnalyticsSource): void {
  enterCustomize({
    scene: "in-place",
    opener: captureSettingsOpener(),
    target: null,
    source,
  });
}
export function openSampleWorkspaceAction(navigate: NavigateFn): void {
  if (isVisualLayoutEditorEnabled() && !isMobileViewport())
    activateTabIntent(
      navigate,
      ensureSampleWorkspaceTab(captureSettingsOpener()),
      undefined,
    );
}
