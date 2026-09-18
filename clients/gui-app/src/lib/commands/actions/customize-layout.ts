import type { NavigateFn } from "@tanstack/react-router";
import { activateTabIntent } from "@/lib/tab-navigation";
import {
  captureSettingsOpener,
  ensureSampleWorkspaceTab,
  enterCustomize,
} from "@/lib/customize/enter-exit";
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { isVisualLayoutEditorEnabled } from "@/stores/settings/settings-store";

export function customizeLayoutAction(): void {
  enterCustomize({
    scene: "in-place",
    opener: captureSettingsOpener(),
    target: null,
    source: "command_palette",
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
