import { useLandingDraftAppearance } from "@/hooks/appearance/use-landing-draft-appearance";
import { useResolvedAppearanceAssets } from "@/hooks/appearance/use-appearance-assets";
import { AppearanceWallpaper } from "./appearance-wallpaper";

export function LandingAppearanceWallpaper({
  draftId,
}: {
  readonly draftId: string | null;
}) {
  const source = useLandingDraftAppearance(draftId);
  const assets = useResolvedAppearanceAssets({
    scope: source.scope,
    appearance: source.appearance?.appearance ?? null,
    issues: source.appearance?.issues ?? [],
    focused: true,
    refreshKey: source.assetRefreshKey,
  });
  const project =
    assets.wallpaperUrl !== null && assets.wallpaperUrl === assets.project.url;
  return (
    <AppearanceWallpaper
      wallpaper={assets.wallpaper?.kind === "image" ? assets.wallpaper : null}
      originalUrl={assets.wallpaperUrl}
      scope={project ? source.scope : null}
      onDecodeFailure={project ? assets.project.reportDecodeFailure : null}
    />
  );
}
