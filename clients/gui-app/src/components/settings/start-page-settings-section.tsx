import { useEffect, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { AppearanceWallpaper } from "@/components/home/appearance-wallpaper";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  chooseStartPageWallpaper,
  saveStartPageWallpaper,
  useStartPageWallpaperImage,
} from "@/lib/appearance/start-page-wallpaper";
import { trackSettingChanged } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import {
  DEFAULT_START_PAGE_WALLPAPER_INTENSITY,
  useSettingsStore,
  type StartPageWallpaperStyle,
} from "@/stores/settings/settings-store";

const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";

const STYLES: ReadonlyArray<{
  readonly id: StartPageWallpaperStyle;
  readonly label: string;
}> = [
  { id: "photo", label: "Photo" },
  { id: "dither", label: "Dither" },
  { id: "grain", label: "Grain" },
];

/**
 * Settings > Appearance > Start page. Every row writes straight through to the
 * settings store (autosave, like the rest of the panel); the preview above them
 * is the real start-page wallpaper component over ghosts of the surfaces the
 * two switches control, so the card shows the actual treatment rather than an
 * illustration of it.
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
  const [dragging, setDragging] = useState(false);
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
        if (wallpaper === null) {
          setWallpaper({
            style: "dither",
            intensity: DEFAULT_START_PAGE_WALLPAPER_INTENSITY,
          });
        }
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
    trackSettingChanged("appearance", "startPageWallpaper");
    setWallpaper(null);
    void saveStartPageWallpaper(null).catch(() => undefined);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    accept(event.dataTransfer.files.item(0));
  };

  return (
    <SettingsGroup
      title="Start page"
      tone="default"
      dataTestId="start-page-settings-group"
      fill={false}
    >
      <div className="px-5 pt-4 pb-1">
        <div
          data-testid="start-page-preview"
          className={cn(
            "relative isolate aspect-[16/7] w-full overflow-hidden rounded-lg border border-border/60 bg-background",
            dragging && "outline-2 -outline-offset-2 outline-primary",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={onDrop}
        >
          <AppearanceWallpaper
            wallpaper={wallpaper}
            url={image.url}
            tint={null}
          />
          <div
            className="absolute top-1/2 left-1/2 grid w-3/5 -translate-x-1/2 -translate-y-[30%] gap-1.5"
            aria-hidden="true"
          >
            {showGreeting ? (
              <div className="text-center text-ui-xs text-foreground/90">
                What would you like to work on?
              </div>
            ) : null}
            <div className="rounded-lg border border-border/60 bg-card/85 px-3 py-2 text-ui-xs text-muted-foreground backdrop-blur-sm">
              Ask Traycer anything. @ mention for context
            </div>
            {showRecentHistory ? (
              <div className="flex justify-center gap-1">
                <i className="h-1 w-[26%] rounded-full bg-foreground/10" />
                <i className="h-1 w-[26%] rounded-full bg-foreground/10" />
                <i className="h-1 w-[26%] rounded-full bg-foreground/10" />
              </div>
            ) : null}
          </div>
          {wallpaper === null ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-ui-xs text-muted-foreground">
              Drop an image here to try the treatment
            </div>
          ) : null}
        </div>
      </div>

      <SettingsRow
        label="Wallpaper"
        description={image.name ?? "None"}
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
            {wallpaper === null && image.url === null ? null : (
              <Button type="button" variant="ghost" size="sm" onClick={remove}>
                Remove
              </Button>
            )}
          </div>
        }
      />

      {wallpaper === null ? null : (
        <SettingsRow
          label="Style"
          description="Dither takes its tint from the repo color when the start page is for a repo that has one."
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
      )}

      {wallpaper === null || wallpaper.style === "photo" ? null : (
        <SettingsRow
          label="Intensity"
          description="How far the style departs from the photo."
          control={
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              aria-label="Intensity"
              value={Math.round(wallpaper.intensity * 100)}
              onChange={(event) => {
                setWallpaper({
                  ...wallpaper,
                  intensity: event.target.valueAsNumber / 100,
                });
              }}
              className="w-[min(40vw,10rem)] accent-primary"
            />
          }
        />
      )}

      <SettingsRow
        label="Greeting"
        description="Show the greeting above the composer."
        control={
          <Switch
            checked={showGreeting}
            onCheckedChange={(next) => {
              trackSettingChanged("appearance", "showGreeting");
              setShowGreeting(next);
            }}
            aria-label="Greeting"
          />
        }
      />
      <SettingsRow
        label="Recent tasks"
        description="List your recent tasks below the composer."
        control={
          <Switch
            checked={showRecentHistory}
            onCheckedChange={(next) => {
              trackSettingChanged("appearance", "showRecentHistory");
              setShowRecentHistory(next);
            }}
            aria-label="Recent tasks"
          />
        }
      />
    </SettingsGroup>
  );
}
