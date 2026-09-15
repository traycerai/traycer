import type { TileController } from "@/components/epic-canvas/renderers/tile-controller";

/**
 * Which of the toolbar's three regions have anything in them.
 *
 * Extracted from the component because it is the whole of the toolbar's
 * branching: a capability added to a region has to be added here too, and a
 * region left out of this answer renders empty padding or - worse - hides a
 * control whose capability is on. Keeping it as one pure function is what makes
 * that reviewable, and testable without a render.
 */
/**
 * Whether the overflow menu has any row in it.
 *
 * Its own answer rather than a copy of the trailing-region one: the trailing
 * region also opens for the annotate toggle, the screenshot button and a private
 * session, none of which put a row in the menu. Two separate literal lists is
 * how the menu came to be gated on a set that predated half its rows, so both
 * gates now read from here.
 */
export function browserToolbarMenuHasRows(
  capabilities: TileController["capabilities"],
): boolean {
  return (
    capabilities.zoom ||
    capabilities.devtools ||
    capabilities.siteInfo ||
    capabilities.appearance ||
    capabilities.clearCache ||
    capabilities.audio ||
    capabilities.hardReload ||
    capabilities.previewWindow
  );
}

export function browserToolbarRegions(
  controller: TileController,
  hasPictureInPicture: boolean,
): {
  readonly showNav: boolean;
  readonly showAddress: boolean;
  readonly showTrailing: boolean;
} {
  const capabilities = controller.capabilities;
  const showAdvanced = browserToolbarMenuHasRows(capabilities);
  return {
    showNav: capabilities.back || capabilities.forward || capabilities.reload,
    showAddress: capabilities.navigate,
    showTrailing:
      controller.viewport !== null ||
      capabilities.annotate ||
      (capabilities.screenshot && controller.onSaveScreenshot !== null) ||
      (capabilities.recording && controller.onToggleRecording !== null) ||
      hasPictureInPicture ||
      controller.profile === "isolated" ||
      showAdvanced,
  };
}
