import { LandingAppearanceWallpaper } from "@/components/home/landing-appearance-wallpaper";
import { getActiveThemeDefinition } from "@/lib/theme-applier";
import { useThemeRevision } from "@/providers/use-theme-revision";
import { useTabSurfaceActivity } from "./tab-surface-activity-hooks";

export function SidebarArtwork() {
  useThemeRevision();
  const activity = useTabSurfaceActivity();
  if (!activity.visible || getActiveThemeDefinition()?.sidebarArtwork !== true)
    return null;
  return (
    <div
      className="sidebar-artwork pointer-events-none absolute inset-0 -z-10"
      aria-hidden="true"
    >
      <LandingAppearanceWallpaper />
    </div>
  );
}
