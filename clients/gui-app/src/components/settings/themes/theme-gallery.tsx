import { useShallow } from "zustand/react/shallow";
import { lazy, Suspense, useState } from "react";
import {
  Copy,
  Download,
  Ellipsis,
  Moon,
  Pencil,
  Plus,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  useSettingsStore,
  type ThemeMode,
} from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { THEME_PRESETS, type ThemePreset } from "@/lib/theme-presets";
import { getBuiltinThemeColors } from "@/lib/themes/builtin-palettes";
import {
  createThemeFromPreset,
  exportThemes,
} from "@/lib/themes/theme-library";
import { type ThemeDefinition } from "@/lib/themes/theme-definition";
import {
  getActiveThemeDefinition,
  getActiveThemePreset,
  getResolvedTheme,
} from "@/lib/theme-applier";
import { cn } from "@/lib/utils";

const ThemeImportDialog = lazy(() =>
  import("./theme-import-dialog").then((module) => ({
    default: module.ThemeImportDialog,
  })),
);
const modes: ThemeMode[] = ["system", "light", "dark"];
const modeLabels: Record<ThemeMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export function ThemeGallery() {
  const mode = useSettingsStore((state) => state.theme);
  const setMode = useSettingsStore((state) => state.setTheme);
  const fallback = useSettingsStore((state) => state.themePreset);
  const library = useThemeLibraryStore(
    useShallow((state) => ({
      themes: state.themes,
      selected: state.selected,
      draft: state.draft,
      error: state.error,
      glassOpacity: state.glassOpacity,
      setDraft: state.setDraft,
      selectTheme: state.selectTheme,
      deleteTheme: state.deleteTheme,
      setGlassOpacity: state.setGlassOpacity,
    })),
  );
  const [importOpen, setImportOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const groups = new Map<string, ThemeDefinition[]>();
  for (const theme of library.themes) {
    const key = theme.collection?.id ?? theme.id;
    groups.set(key, [...(groups.get(key) ?? []), theme]);
  }
  const beginCreate = () => {
    if (library.draft) return;
    const active = getActiveThemeDefinition();
    library.setDraft(
      active
        ? {
            ...active,
            id: crypto.randomUUID(),
            name: `${active.name} copy`,
            collection: undefined,
          }
        : createThemeFromPreset(getActiveThemePreset(), getResolvedTheme()),
    );
  };
  return (
    <section className="space-y-6" aria-label="Theme">
      <div className="space-y-3">
        <h2 className="font-medium text-ui-sm">Color scheme</h2>
        <div className="grid grid-cols-3 gap-3">
          {modes.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "group min-w-0 space-y-2 rounded-xl border bg-card/50 p-2 pb-3 text-ui-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                mode === value
                  ? "border-primary bg-primary/5"
                  : "border-transparent hover:border-border",
              )}
            >
              <SchemePreview mode={value} preset={fallback} />
              <span className="font-medium">{modeLabels[value]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium text-ui-sm">Themes</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={beginCreate}
              disabled={library.draft !== null}
            >
              <Plus />
              Create theme
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(true)}
            >
              <Upload />
              Import theme
            </Button>
          </div>
        </div>
        <p className="text-ui-xs text-muted-foreground">
          Choose a palette for each appearance. System follows your device’s
          light and dark setting.
        </p>
        {library.themes.length > 0 ? (
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Filter themes"
            placeholder="Filter themes"
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-ui-sm"
          />
        ) : null}
        <div className="grid grid-cols-1 gap-3 @min-[24rem]:grid-cols-2 @min-[40rem]:grid-cols-3">
          {THEME_PRESETS.filter((preset) =>
            preset.label.toLowerCase().includes(filter.toLowerCase()),
          ).map((preset) => (
            <div
              key={preset.id}
              className="rounded-xl border border-border/40 bg-card/50 p-3"
            >
              <div className="flex justify-center gap-5 py-3">
                {(["light", "dark"] as const).map((appearance) => {
                  const colors = getBuiltinThemeColors(preset.id, appearance);
                  return (
                    <PaletteSwatch
                      key={appearance}
                      name={preset.label}
                      appearance={appearance}
                      background={colors.background ?? preset.swatch}
                      accent={colors.primary ?? preset.accent}
                      selected={
                        (library.selected[appearance] ?? fallback) === preset.id
                      }
                      onClick={() => library.selectTheme(appearance, preset.id)}
                    />
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ui-sm">{preset.label}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Customize ${preset.label}`}
                  disabled={library.draft !== null}
                  onClick={() =>
                    library.setDraft(
                      createThemeFromPreset(preset.id, getResolvedTheme()),
                    )
                  }
                >
                  <Copy />
                </Button>
              </div>
            </div>
          ))}
          {[...groups.entries()]
            .filter(([, themes]) =>
              themes.some((theme) =>
                `${theme.name} ${theme.collection?.name ?? ""}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              ),
            )
            .map(([id, themes]) => (
              <div
                key={id}
                className="rounded-xl border border-border/40 bg-card/50 p-3"
              >
                <div className="space-y-2">
                  {themes.map((theme) => (
                    <div key={theme.id} className="flex items-center gap-3">
                      <PaletteSwatch
                        name={theme.name}
                        appearance={theme.appearance}
                        background={theme.colors.background ?? "#202024"}
                        accent={theme.colors.primary ?? "#999999"}
                        selected={
                          library.selected[theme.appearance] === theme.id
                        }
                        onClick={() =>
                          library.selectTheme(theme.appearance, theme.id)
                        }
                      />
                      <span className="min-w-0 flex-1 truncate text-ui-xs">
                        {theme.name}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Manage ${theme.name}`}
                          >
                            <Ellipsis />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={library.draft !== null}
                            onSelect={() => library.setDraft(theme)}
                          >
                            <Pencil />
                            Edit theme
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={library.draft !== null}
                            onSelect={() =>
                              library.setDraft({
                                ...theme,
                                id: crypto.randomUUID(),
                                name: `${theme.name} copy`,
                                collection: undefined,
                              })
                            }
                          >
                            <Copy />
                            Duplicate theme
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => exportThemes([theme])}
                          >
                            <Download />
                            Export theme
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setPendingDelete(theme.id)}
                          >
                            <Trash2 />
                            Delete theme
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                </div>
                {themes[0]?.collection ? (
                  <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2">
                    <span className="truncate text-ui-xs text-muted-foreground">
                      {themes[0].collection.name}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Export ${themes[0].collection.name}`}
                      onClick={() => exportThemes(themes)}
                    >
                      <Download />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
        </div>
        {pendingDelete ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-ui-sm"
          >
            <span>
              Delete this theme? Active appearances return to the default
              palette.
            </span>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (library.deleteTheme(pendingDelete)) setPendingDelete(null);
              }}
            >
              Delete theme
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
          </div>
        ) : null}
        {library.error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {library.error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border/40 pt-5">
        <div>
          <label htmlFor="theme-glass" className="text-ui-sm font-medium">
            Glass opacity
          </label>
          <p className="mt-1 text-ui-xs text-muted-foreground">
            Make menus, dialogs, and the composer more solid.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <output className="text-ui-xs tabular-nums">
            {library.glassOpacity}%
          </output>
          <input
            id="theme-glass"
            type="range"
            min={30}
            max={100}
            value={library.glassOpacity}
            onChange={(event) =>
              library.setGlassOpacity(Number(event.target.value))
            }
            className="accent-primary"
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => library.setGlassOpacity(100)}
          >
            Reset
          </Button>
        </div>
      </div>
      {importOpen ? (
        <Suspense fallback={null}>
          <ThemeImportDialog open={importOpen} onOpenChange={setImportOpen} />
        </Suspense>
      ) : null}
    </section>
  );
}

function PaletteSwatch(props: {
  name: string;
  appearance: "light" | "dark";
  background: string;
  accent: string;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = props.appearance === "light" ? Sun : Moon;
  return (
    <button
      type="button"
      aria-label={`Use ${props.name} ${props.appearance}`}
      aria-pressed={props.selected}
      onClick={props.onClick}
      className={cn(
        "relative shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.selected
          ? "ring-2 ring-primary"
          : "ring-1 ring-transparent hover:ring-border",
      )}
    >
      <span
        className="block size-12 rounded-full border border-foreground/10 shadow-inner"
        style={{
          background: `radial-gradient(circle at 28% 25%, ${props.accent}, ${props.background} 78%)`,
        }}
      />
      <Icon
        aria-hidden="true"
        className="absolute -right-1 -bottom-1 size-4 rounded-full bg-card p-0.5 text-foreground"
      />
    </button>
  );
}
function SchemePreview(props: { mode: ThemeMode; preset: ThemePreset }) {
  const library = useThemeLibraryStore(
    useShallow((state) => ({ themes: state.themes, selected: state.selected })),
  );
  const halves =
    props.mode === "system" ? (["light", "dark"] as const) : [props.mode];
  return (
    <div
      aria-hidden="true"
      className="relative flex aspect-[1.8] overflow-hidden rounded-lg border border-foreground/10"
    >
      {halves.map((appearance) => {
        const custom = library.themes.find(
          (theme) => theme.id === library.selected[appearance],
        );
        const preset =
          custom?.base ??
          THEME_PRESETS.find(
            (preset) => preset.id === library.selected[appearance],
          )?.id ??
          props.preset;
        const colors = {
          ...getBuiltinThemeColors(preset, appearance),
          ...custom?.colors,
        };
        return (
          <div
            key={appearance}
            className="relative flex flex-1 overflow-hidden"
            style={{ background: colors.background, color: colors.foreground }}
          >
            <div className="w-1/4 space-y-1 border-r border-current/10 p-2">
              <div className="h-1 rounded-full bg-current/15" />
              <div className="h-1 rounded-full bg-current/30" />
              <div className="h-1 rounded-full bg-current/10" />
            </div>
            <div className="flex flex-1 flex-col justify-end gap-2 p-2">
              <div className="ml-auto h-3 w-2/3 rounded-full bg-current/10" />
              <div className="mb-auto h-1 w-3/4 rounded-full bg-current/30" />
              <div className="flex items-center justify-between rounded border border-current/10 p-1">
                <span className="h-1 w-1/3 rounded-full bg-current/10" />
                <span
                  className="size-2 rounded-full"
                  style={{ background: colors.primary }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
