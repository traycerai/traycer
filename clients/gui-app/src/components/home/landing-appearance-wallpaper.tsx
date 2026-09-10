import { useStartPageWallpaperImage } from "@/lib/appearance/start-page-wallpaper";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { AppearanceWallpaper } from "./appearance-wallpaper";

export function LandingAppearanceWallpaper() {
  const wallpaper = useSettingsStore((state) => state.startPageWallpaper);
  const image = useStartPageWallpaperImage();
  return (
    <AppearanceWallpaper wallpaper={wallpaper} url={image.url} tint={null} />
  );
}
