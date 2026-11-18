import { type WallpaperFrameSlot } from "@/components/home/appearance-wallpaper-frame";
import { useStartPageWallpaperImage } from "@/lib/appearance/start-page-wallpaper";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { AppearanceWallpaper } from "./appearance-wallpaper";

export function LandingAppearanceWallpaper(props: {
  /** The landing page and the sidebar rasterize at different sizes. */
  readonly frameSlot?: WallpaperFrameSlot;
}) {
  const wallpaper = useSettingsStore((state) => state.startPageWallpaper);
  const image = useStartPageWallpaperImage();
  return (
    <AppearanceWallpaper
      wallpaper={wallpaper}
      url={image.url}
      tint={null}
      surface="page"
      frameSlot={props.frameSlot ?? "page"}
    />
  );
}
