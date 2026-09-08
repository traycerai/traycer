import type { WorkspaceAppearance } from "@traycer/protocol/host/workspace/appearance-schemas";
import { useState } from "react";
import { useWallpaperTreatment } from "@/hooks/appearance/use-wallpaper-treatment";
import type { AppearanceScope } from "@/lib/appearance/appearance-cache";
import "./appearance-wallpaper.css";

export type AppearanceWallpaperImage = Extract<
  WorkspaceAppearance["wallpaper"],
  { kind: "image" }
>;

export function AppearanceWallpaper(props: {
  readonly wallpaper: AppearanceWallpaperImage | null;
  readonly originalUrl: string | null;
  readonly scope: AppearanceScope | null;
  readonly onDecodeFailure: (() => void) | null;
}) {
  const wallpaper = props.wallpaper;
  const url = useWallpaperTreatment({
    scope: props.scope,
    originalUrl: props.originalUrl,
    treatment: wallpaper?.treatment ?? "original",
    strength: wallpaper?.strength ?? 0,
  });
  const [failedDerivedUrl, setFailedDerivedUrl] = useState<string | null>(null);
  const displayedUrl = url === failedDerivedUrl ? props.originalUrl : url;
  if (wallpaper === null || displayedUrl === null) return null;
  return (
    <div
      className="appearance-wallpaper pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      <img
        className="size-full object-cover"
        src={displayedUrl}
        alt=""
        draggable={false}
        onError={() => {
          if (displayedUrl !== props.originalUrl)
            setFailedDerivedUrl(displayedUrl);
          else props.onDecodeFailure?.();
        }}
        style={{
          objectPosition: `${wallpaper.focalPoint[0] * 100}% ${wallpaper.focalPoint[1] * 100}%`,
          opacity: 1 - wallpaper.dimming,
        }}
      />
      {wallpaper.treatment === "texture" ? (
        <div
          className="appearance-wallpaper-texture absolute inset-0"
          style={{ opacity: wallpaper.strength * 0.28 }}
        />
      ) : null}
      <div className="appearance-wallpaper-mask absolute inset-0" />
    </div>
  );
}
