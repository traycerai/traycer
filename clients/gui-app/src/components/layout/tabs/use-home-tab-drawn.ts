import { useRegionGhost } from "@/components/layout-editor/use-layout-region";
import { useRegionShown } from "@/lib/layout-overrides";

/**
 * Whether the strip draws the Home item, which is its `shown` plus the
 * editor's materialised preview of a hidden one (L-14). The item is a plain
 * control over state the strip already has, so a preview of it starts nothing.
 *
 * Only a STRIP asks this: the route guards and the command coordinator that
 * gate on Home ask `isHomeTabEnabled`, which never lies about the setting.
 */
export function useHomeTabDrawn(): boolean {
  const shown = useRegionShown("homeTab");
  const ghost = useRegionGhost("homeTab");
  return shown || ghost;
}
