import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  chooseStartPageWallpaper,
  removeStartPageWallpaper,
  useStartPageWallpaperImage,
} from "@/lib/appearance/start-page-wallpaper";
import { trackSettingChanged } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import {
  useSettingsStore,
  type StartPageWallpaperStyle,
} from "@/stores/settings/settings-store";

const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";

const STYLES: ReadonlyArray<{
  readonly id: StartPageWallpaperStyle;
  readonly label: string;
}> = [
  { id: "photo", label: "Photo" },
  { id: "dither", label: "Dot pattern" },
  { id: "grain", label: "Film grain" },
];

/**
 * Settings > Appearance > Start page. Plain rows like every other group in the
 * panel; each one writes straight through to the settings store (autosave). The
 * start page itself is the preview.
 */
export function StartPageSettingsSection() {
  const wallpaper = useSettingsStore((state) => state.startPageWallpaper);
  const setWallpaper = useSettingsStore((state) => state.setStartPageWallpaper);
  const showGreeting = useSettingsStore((state) => state.showGreeting);
  const setShowGreeting = useSettingsStore((state) => state.setShowGreeting);
  const showRecentHistory = useSettingsStore(
    (state) => state.showRecentHistory,
  );
  const setShowRecentHistory = useSettingsStore(
    (state) => state.setShowRecentHistory,
  );
  const image = useStartPageWallpaperImage();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const accept = (file: File | null | undefined): void => {
    if (file === null || file === undefined) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    void chooseStartPageWallpaper(file, controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        trackSettingChanged("appearance", "startPageWallpaper");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        toast.error(
          error instanceof Error
            ? error.message
            : "That image could not be used as a wallpaper.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
  };

  const remove = (): void => {
    abortRef.current?.abort();
    setBusy(false);
    trackSettingChanged("appearance", "startPageWallpaper");
    void removeStartPageWallpaper().catch((error: unknown) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "The wallpaper could not be removed.",
      );
    });
  };

  return (
    <SettingsGroup
      title="Start page"
      tone="default"
      dataTestId="start-page-settings-group"
      fill={false}
    >
      <SettingsRow
        label="Wallpaper"
        description={
          image.name ?? (image.url === null ? "None" : "Custom image")
        }
        control={
          <div className="flex items-center gap-2.5">
            {image.url === null ? null : (
              <img
                src={image.url}
                alt=""
                className="h-[34px] w-[56px] shrink-0 rounded-md border border-border/60 object-cover"
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES}
              className="hidden"
              onChange={(event) => {
                accept(event.target.files?.item(0));
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                fileInputRef.current?.click();
              }}
            >
              Choose image…
            </Button>
            {wallpaper === null ? null : (
              <Button type="button" variant="ghost" size="sm" onClick={remove}>
                Remove
              </Button>
            )}
          </div>
        }
      />

      {wallpaper === null ? null : (
        <>
          <SettingsRow
            label="Wallpaper effect"
            description="Keep the original photo, turn it into a dot pattern, or add film grain."
            control={
              <div className="inline-flex items-center gap-1 rounded-md border border-border bg-foreground/3 p-0.5">
                {STYLES.map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    aria-pressed={wallpaper.style === style.id}
                    onClick={() => {
                      trackSettingChanged("appearance", "startPageWallpaper");
                      setWallpaper({ ...wallpaper, style: style.id });
                    }}
                    className={cn(
                      "rounded-sm px-3 py-1 text-ui-sm transition-colors",
                      wallpaper.style === style.id
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {style.label}
                  </button>
                ))}
              </div>
            }
          />

          {wallpaper.style === "photo" ? null : (
            <SettingsRow
              label="Effect strength"
              description="Adjust how strongly the effect changes the photo."
              control={
                <div className="space-y-1">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    aria-label="Effect strength"
                    value={Math.round(wallpaper.intensity * 100)}
                    onChange={(event) => {
                      setWallpaper({
                        ...wallpaper,
                        intensity: event.target.valueAsNumber / 100,
                      });
                    }}
                    onPointerUp={() =>
                      trackSettingChanged("appearance", "startPageWallpaper")
                    }
                    className="w-[min(40vw,10rem)] accent-primary"
                  />
                  <div
                    aria-hidden
                    className="flex justify-between text-ui-xs text-muted-foreground"
                  >
                    <span>Subtle</span>
                    <span>Strong</span>
                  </div>
                </div>
              }
            />
          )}

          {wallpaper.style !== "dither" ? null : (
            <SettingsRow
              label="Tint wallpaper with theme accent color"
              control={
                <Switch
                  checked={wallpaper.tintWithAccent}
                  onCheckedChange={(next) => {
                    trackSettingChanged("appearance", "startPageWallpaperTint");
                    setWallpaper({ ...wallpaper, tintWithAccent: next });
                  }}
                  aria-label="Tint wallpaper with theme accent color"
                />
              }
            />
          )}
        </>
      )}

      <SettingsRow
        label="Show greeting"
        control={
          <Switch
            checked={showGreeting}
            onCheckedChange={(next) => {
              trackSettingChanged("appearance", "showGreeting");
              setShowGreeting(next);
            }}
            aria-label="Show greeting"
          />
        }
      />
      <SettingsRow
        label="Show recent tasks"
        control={
          <Switch
            checked={showRecentHistory}
            onCheckedChange={(next) => {
              trackSettingChanged("appearance", "showRecentHistory");
              setShowRecentHistory(next);
            }}
            aria-label="Show recent tasks"
          />
        }
      />
    </SettingsGroup>
  );
}
