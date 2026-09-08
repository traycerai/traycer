import { useLandingDraftAppearance } from "@/hooks/appearance/use-landing-draft-appearance";
import { useStartPageWallpaperImage } from "@/lib/appearance/start-page-wallpaper";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { AppearanceWallpaper } from "./appearance-wallpaper";

/**
 * The start page's backdrop: the personal wallpaper, plus a faint wash of the
 * repository's own color when the landing draft's primary folder has one. The
 * wash renders with or without a wallpaper (it is the identity, not the
 * treatment); the wallpaper takes the same color as its dither tint.
 */
export function LandingAppearanceWallpaper(props: {
  readonly draftId: string | null;
}) {
  const wallpaper = useSettingsStore((state) => state.startPageWallpaper);
  const image = useStartPageWallpaperImage();
  const appearance = useLandingDraftAppearance(props.draftId);
  const color = appearance.appearance?.appearance?.color ?? null;
  return (
    <>
      {color === null ? null : (
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{
            background: `radial-gradient(ellipse at 50% 30%, color-mix(in srgb, ${color} 6%, transparent), transparent 70%)`,
          }}
        />
      )}
      <AppearanceWallpaper wallpaper={wallpaper} url={image.url} tint={color} />
    </>
  );
}
