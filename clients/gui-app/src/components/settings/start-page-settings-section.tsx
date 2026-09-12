import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  queryOptions,
  useMutation,
  useMutationState,
  useQuery,
} from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  fetchCuratedWallpaperManifest,
  type CuratedWallpaper,
} from "@/lib/appearance/curated-wallpapers";
import {
  applyCuratedStartPageWallpaper,
  chooseStartPageWallpaper,
  removeStartPageWallpaper,
  useStartPageWallpaperImage,
} from "@/lib/appearance/start-page-wallpaper";
import { trackSettingChanged } from "@/lib/analytics";
import { appearanceMutationKeys } from "@/lib/query-keys/appearance-mutation-keys";
import { appearanceQueryKeys } from "@/lib/query-keys/appearance-query-keys";
import { cn } from "@/lib/utils";
import {
  useSettingsStore,
  type StartPageWallpaperStyle,
} from "@/stores/settings/settings-store";

const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";

/**
 * Viewport-capped rather than `w-full`: the gallery sits in a `SettingsRow`
 * control, which sizes to its content, and an `auto-fill` track list repeats
 * only once against an indefinite width - a full-width grid there would
 * collapse to a single column. A definite width is what gives `auto-fill` a
 * column count to compute.
 */
const GALLERY_WIDTH = "w-[min(70vw,26rem)]";

const STYLES: ReadonlyArray<{
  readonly id: StartPageWallpaperStyle;
  readonly label: string;
}> = [
  { id: "photo", label: "Photo" },
  { id: "dither", label: "Dot pattern" },
  { id: "grain", label: "Film grain" },
];

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * The curated wallpaper whose apply is in flight, read off the mutation cache
 * rather than component state. The download outlives this panel (the abort
 * controller lives in `lib/appearance/start-page-wallpaper.ts`), so a reopened
 * panel has to be able to find it again.
 */
function usePendingCuratedId(): string | null {
  const pending = useMutationState({
    filters: {
      mutationKey: appearanceMutationKeys.applyCuratedWallpaper(),
      status: "pending",
    },
    select: (mutation) => mutation.state.variables,
  });
  for (const variables of pending) {
    if (
      typeof variables === "object" &&
      variables !== null &&
      "id" in variables &&
      typeof variables.id === "string"
    )
      return variables.id;
  }
  return null;
}

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

  const manifest = useQuery(
    queryOptions({
      queryKey: appearanceQueryKeys.curatedWallpapers(),
      queryFn: ({ signal }) => fetchCuratedWallpaperManifest(signal),
      staleTime: Infinity,
      retry: 1,
    }),
  );
  const applyCurated = useMutation({
    mutationKey: appearanceMutationKeys.applyCuratedWallpaper(),
    mutationFn: (entry: CuratedWallpaper) =>
      applyCuratedStartPageWallpaper(entry),
    onSuccess: () => {
      trackSettingChanged("appearance", "startPageWallpaperCurated");
    },
    onError: (error: Error) => {
      // A superseded apply (another tile, a custom pick, Remove) is the user's
      // own next action, not a failure to report.
      if (isAbortError(error)) return;
      toast.error(error.message);
    },
  });
  const pendingCuratedId = usePendingCuratedId();

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
      group={APPEARANCE.definitions.startPage}
      showTitle
      tone="default"
      dataTestId="start-page-settings-group"
      fill={false}
    >
      <SettingsRow
        row={APPEARANCE.definitions.wallpaper}
        status={image.name ?? (image.url === null ? "None" : "Custom image")}
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

      <SettingsRow
        row={APPEARANCE.definitions.curatedWallpapers}
        control={
          <div className="flex items-start gap-1.5">
            <div className={GALLERY_WIDTH}>
              <CuratedWallpaperGallery
                wallpapers={manifest.data}
                error={manifest.isError ? manifest.error.message : null}
                appliedId={wallpaper?.curatedId ?? null}
                pendingId={pendingCuratedId}
                onRetry={() => void manifest.refetch()}
                onApply={(entry) => {
                  applyCurated.mutate(entry);
                }}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh wallpapers"
              disabled={manifest.isFetching}
              onClick={() => void manifest.refetch()}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        }
      />

      {wallpaper === null ? null : (
        <>
          <SettingsRow
            row={APPEARANCE.definitions.wallpaperEffect}
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
              row={APPEARANCE.definitions.effectStrength}
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
              row={APPEARANCE.definitions.tintWallpaper}
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
        row={APPEARANCE.definitions.showGreeting}
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
        row={APPEARANCE.definitions.showRecentTasks}
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

const TILE_GRID = "grid w-full grid-cols-[repeat(auto-fill,minmax(7rem,1fr))]";

function CuratedWallpaperGallery(props: {
  readonly wallpapers: ReadonlyArray<CuratedWallpaper> | undefined;
  readonly error: string | null;
  readonly appliedId: string | null;
  readonly pendingId: string | null;
  readonly onRetry: () => void;
  readonly onApply: (entry: CuratedWallpaper) => void;
}): ReactNode {
  if (props.error !== null) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 p-3 text-ui-sm text-destructive"
      >
        {props.error}
        <Button variant="ghost" size="sm" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (props.wallpapers === undefined) {
    return (
      <div className={cn(TILE_GRID, "gap-2")}>
        {[0, 1, 2].map((slot) => (
          <Skeleton key={slot} className="aspect-[16/10] w-full" />
        ))}
      </div>
    );
  }
  if (props.wallpapers.length === 0) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        No wallpapers available.
      </p>
    );
  }
  return (
    <div className={cn(TILE_GRID, "gap-2")}>
      {props.wallpapers.map((entry) => {
        const applied = entry.id === props.appliedId;
        const pending = entry.id === props.pendingId;
        return (
          <button
            key={entry.id}
            type="button"
            aria-pressed={applied}
            aria-label={entry.title}
            // Only the downloading tile is disabled: another tile is how the
            // user changes their mind, and that click aborts the one in
            // flight (last action wins). The APPLIED tile stays enabled - a
            // control a screen reader can reach and a pointer cannot press
            // reads as broken - and no-ops instead.
            disabled={pending}
            onClick={() => {
              if (applied) return;
              props.onApply(entry);
            }}
            className="block w-full text-left"
          >
            <div
              className={cn(
                // Foreground alpha, never `bg-muted`: this is the skeleton the tile
                // shows until its thumbnail paints.
                "relative aspect-[16/10] w-full overflow-hidden rounded-md border border-border/60 bg-foreground/10",
                applied && "ring-2 ring-primary",
              )}
            >
              <img
                src={entry.thumbUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                draggable={false}
                className="size-full object-cover"
              />
              {applied ? (
                <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-2.5" />
                </span>
              ) : null}
              {pending ? (
                <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                  <AgentSpinningDots
                    className={undefined}
                    testId={undefined}
                    variant={undefined}
                  />
                </span>
              ) : null}
            </div>
            <span className="mt-1 block truncate text-ui-xs text-muted-foreground">
              {entry.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}
