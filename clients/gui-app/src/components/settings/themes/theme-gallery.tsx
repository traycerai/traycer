import { useShallow } from "zustand/react/shallow";
import { lazy, Suspense, useId, useRef, useState } from "react";
import {
  ChevronsUpDown,
  Copy,
  Download,
  Ellipsis,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Search,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useCoarsePointerOpenAutoFocus } from "@/hooks/ui/use-coarse-pointer-open-autofocus";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { THEME_PRESETS, findThemePreset } from "@/lib/theme-presets";
import { getBuiltinThemeColors } from "@/lib/themes/builtin-palettes";
import {
  createThemeFromPreset,
  exportThemes,
} from "@/lib/themes/theme-library";
import {
  type ThemeDefinition,
  type ThemeToken,
} from "@/lib/themes/theme-definition";
import {
  getActiveThemeDefinition,
  getActiveThemePreset,
  getResolvedTheme,
} from "@/lib/theme-applier";
import { useThemeRevision } from "@/providers/use-theme-revision";
import { cn } from "@/lib/utils";

const ThemeImportDialog = lazy(() =>
  import("./theme-import-dialog").then((module) => ({
    default: module.ThemeImportDialog,
  })),
);
const modes = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;
const paletteTokens: ThemeToken[] = ["background", "foreground", "primary"];

export function ThemeGallery() {
  useThemeRevision();
  const mode = useSettingsStore((state) => state.theme);
  const setMode = useSettingsStore((state) => state.setTheme);
  const library = useThemeLibraryStore(
    useShallow((state) => ({
      draft: state.draft,
      setDraft: state.setDraft,
      error: state.error,
    })),
  );
  const [importOpen, setImportOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const manageTrigger = useRef<HTMLButtonElement>(null);
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
    <section className="space-y-5" aria-label="Theme">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-ui-sm font-medium">Color scheme</h2>
          <p className="text-ui-xs text-muted-foreground">
            {mode === "system"
              ? "Follows your device’s appearance."
              : "Light and dark themes are saved separately."}
          </p>
        </div>
        <div
          role="group"
          aria-label="Color scheme"
          className="inline-flex rounded-md bg-foreground/5 p-0.5"
        >
          {modes.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "flex items-center gap-1.5 rounded px-3 py-1.5 text-ui-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                mode === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <h2 className="px-1 text-ui-xs font-semibold text-muted-foreground">
          Themes
        </h2>
        <div className="divide-y divide-border/50 rounded-lg border border-border/60">
          <ThemeSlot
            appearance="light"
            active={getResolvedTheme() === "light"}
          />
          <ThemeSlot appearance="dark" active={getResolvedTheme() === "dark"} />
          <GlassControl />
        </div>
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={beginCreate}
            disabled={library.draft !== null}
          >
            <Plus />
            Create theme
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
            <Upload />
            Import theme
          </Button>
          <Button
            ref={manageTrigger}
            variant="ghost"
            size="sm"
            onClick={() => setManageOpen(true)}
            className="text-muted-foreground"
          >
            Manage themes
          </Button>
        </div>
        {library.error ? (
          <p role="alert" className="text-ui-xs text-destructive">
            {library.error}
          </p>
        ) : null}
      </div>
      {manageOpen ? (
        <ThemeManager
          onOpenChange={setManageOpen}
          onReturnFocus={() => manageTrigger.current?.focus()}
        />
      ) : null}
      {importOpen ? (
        <Suspense fallback={null}>
          <ThemeImportDialog open={importOpen} onOpenChange={setImportOpen} />
        </Suspense>
      ) : null}
    </section>
  );
}

function ThemeSlot({
  appearance,
  active,
}: {
  appearance: "light" | "dark";
  active: boolean;
}) {
  const fallback = useSettingsStore((state) => state.themePreset);
  const library = useThemeLibraryStore(
    useShallow((state) => ({
      themes: state.themes,
      selected: state.selected,
      draft: state.draft,
      setDraft: state.setDraft,
    })),
  );
  const id = library.selected[appearance] ?? fallback;
  const saved = library.themes.find(
    (theme) => theme.id === id && theme.appearance === appearance,
  );
  const preset =
    THEME_PRESETS.find((theme) => theme.id === id) ?? findThemePreset(fallback);
  const name = saved?.name ?? preset.label;
  const colors = {
    ...getBuiltinThemeColors(saved?.base ?? preset.id, appearance),
    ...saved?.colors,
  };
  const Icon = appearance === "light" ? Sun : Moon;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3">
      <div className="flex items-center gap-2 text-ui-sm">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden />
        <span>{appearance === "light" ? "Light theme" : "Dark theme"}</span>
        {active ? (
          <span className="text-ui-xs text-muted-foreground">· Active</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-1 @min-[30rem]:max-w-[55%]">
        <ThemePicker
          appearance={appearance}
          id={id}
          name={name}
          colors={colors}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Edit ${appearance} theme`}
          disabled={library.draft !== null}
          onClick={() =>
            library.setDraft(
              saved ?? createThemeFromPreset(preset.id, appearance),
            )
          }
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ThemePicker({
  appearance,
  id,
  name,
  colors,
}: {
  appearance: "light" | "dark";
  id: string;
  name: string;
  colors: Partial<Record<ThemeToken, string>>;
}) {
  const [open, setOpen] = useState(false);
  const pickerId = useId();
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(
    null,
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const { contentRef, onOpenAutoFocus } = useCoarsePointerOpenAutoFocus();
  const themes = useThemeLibraryStore((state) => state.themes);
  const selectTheme = useThemeLibraryStore((state) => state.selectTheme);
  const error = useThemeLibraryStore((state) => state.error);
  const saved = themes.filter((theme) => theme.appearance === appearance);
  const choose = (next: string) => {
    if (selectTheme(appearance, next)) setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next)
          setDialogContainer(
            trigger.current?.closest<HTMLElement>(
              '[data-slot="dialog-content"]',
            ) ?? null,
          );
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-describedby={`${pickerId}-value`}
          aria-label={appearance === "light" ? "Light theme" : "Dark theme"}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-border/70 bg-foreground/3 px-2.5 py-2 text-ui-sm outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PaletteSwatch colors={colors} />
          <span
            id={`${pickerId}-value`}
            className="min-w-0 flex-1 truncate text-start"
          >
            {name}
          </span>
          <ChevronsUpDown
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        // Portal outside the dialog's backdrop-filter so this surface can blur
        // the settings content behind it instead of nesting backdrop roots.
        collisionBoundary={dialogContainer ?? undefined}
        onOpenAutoFocus={onOpenAutoFocus}
        className="w-[min(85vw,var(--container-sm))] max-h-(--radix-popover-content-available-height) overflow-hidden p-0"
      >
        <Command
          label={`Search ${appearance} themes`}
          defaultValue={
            saved.some((theme) => theme.id === id)
              ? `saved:${id}`
              : `builtin:${id}`
          }
          className="min-h-0 rounded-lg"
        >
          <CommandInput
            aria-label={`Search ${appearance} themes`}
            placeholder="Search themes…"
            spellCheck={false}
          />
          <CommandList className="max-h-[min(45svh,var(--container-xs))]">
            <CommandEmpty>No matching themes.</CommandEmpty>
            {saved.length > 0 ? (
              <CommandGroup heading="Your themes">
                {saved.map((theme) => (
                  <CommandItem
                    key={theme.id}
                    value={`saved:${theme.id}`}
                    keywords={[theme.name, theme.collection?.name ?? ""]}
                    aria-label={`Use ${theme.name} ${appearance}`}
                    data-checked={theme.id === id}
                    onSelect={() => choose(theme.id)}
                  >
                    <PaletteSwatch
                      colors={{
                        ...getBuiltinThemeColors(theme.base, appearance),
                        ...theme.colors,
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {theme.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading="Built-in">
              {THEME_PRESETS.map((preset) => (
                <CommandItem
                  key={preset.id}
                  value={`builtin:${preset.id}`}
                  keywords={[preset.label]}
                  aria-label={`Use ${preset.label} ${appearance}`}
                  data-checked={preset.id === id}
                  onSelect={() => choose(preset.id)}
                >
                  <PaletteSwatch
                    colors={getBuiltinThemeColors(preset.id, appearance)}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {preset.label}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {error ? (
          <p role="alert" className="px-3 pb-2 text-ui-xs text-destructive">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function PaletteSwatch({
  colors,
}: {
  colors: Partial<Record<ThemeToken, string>>;
}) {
  return (
    <span aria-hidden className="flex shrink-0 -space-x-1">
      {paletteTokens.map((token) => (
        <span
          key={token}
          className="size-3.5 rounded-full border border-foreground/15"
          style={{ background: colors[token] }}
        />
      ))}
    </span>
  );
}

function ThemeManager({
  onOpenChange,
  onReturnFocus,
}: {
  onOpenChange: (open: boolean) => void;
  onReturnFocus: () => void;
}) {
  const themes = useThemeLibraryStore((state) => state.themes);
  const setDraft = useThemeLibraryStore((state) => state.setDraft);
  const error = useThemeLibraryStore((state) => state.error);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  const groups = new Map<string, ThemeDefinition[]>();
  for (const theme of themes) {
    const key = theme.collection?.id ?? "custom";
    groups.set(key, [...(groups.get(key) ?? []), theme]);
  }
  const search = query.trim().toLowerCase();
  const matches = (theme: ThemeDefinition) =>
    `${theme.name} ${theme.collection?.name ?? ""}`
      .toLowerCase()
      .includes(search);
  const edit = (theme: ThemeDefinition) => {
    editing.current = true;
    onOpenChange(false);
    setDraft(theme);
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(80svh,var(--spacing-safe-svh))] flex-col gap-4 sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!editing.current) onReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Manage themes</DialogTitle>
          <DialogDescription>
            Your saved themes and imported packs.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter saved themes"
            placeholder="Filter saved themes…"
            className="ps-9"
          />
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto">
          {[...groups.entries()].map(([key, group]) => (
            <SavedThemeGroup
              key={key}
              themes={group}
              visible={group.filter(matches)}
              onEdit={edit}
              onDelete={() => searchInput.current?.focus()}
            />
          ))}
          {!themes.some(matches) ? (
            <p className="py-6 text-center text-ui-sm text-muted-foreground">
              {themes.length
                ? "No matching themes."
                : "Create or import a theme to add it here."}
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-ui-xs text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SavedThemeGroup({
  themes,
  visible,
  onEdit,
  onDelete,
}: {
  themes: ThemeDefinition[];
  visible: ThemeDefinition[];
  onEdit: (theme: ThemeDefinition) => void;
  onDelete: () => void;
}) {
  const selected = useThemeLibraryStore((state) => state.selected);
  const selectTheme = useThemeLibraryStore((state) => state.selectTheme);
  const collection = themes[0]?.collection;
  if (!visible.length) return null;
  return (
    <section className="space-y-1">
      <div className="flex items-center justify-between gap-2 px-2">
        <h3 className="min-w-0 truncate text-ui-xs font-medium text-muted-foreground">
          {collection?.name ?? "Custom themes"}
        </h3>
        {collection ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Export ${collection.name}`}
            onClick={() => exportThemes(themes)}
          >
            <Download className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {visible.map((theme) => (
        <div
          key={theme.id}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1"
        >
          <button
            type="button"
            aria-label={`Use ${theme.name} ${theme.appearance}`}
            aria-pressed={selected[theme.appearance] === theme.id}
            onClick={() => selectTheme(theme.appearance, theme.id)}
            className="flex min-w-0 items-center gap-2.5 rounded-md px-2 py-2 text-start outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PaletteSwatch
              colors={{
                ...getBuiltinThemeColors(theme.base, theme.appearance),
                ...theme.colors,
              }}
            />
            <span className="min-w-0 flex-1 truncate text-ui-sm">
              {theme.name}
            </span>
            <span className="text-ui-xs text-muted-foreground">
              {theme.appearance}
            </span>
            {selected[theme.appearance] === theme.id ? (
              <span className="text-ui-xs text-muted-foreground">
                · Selected
              </span>
            ) : null}
          </button>
          <ThemeActions theme={theme} onEdit={onEdit} onDelete={onDelete} />
        </div>
      ))}
    </section>
  );
}

function ThemeActions({
  theme,
  onEdit,
  onDelete,
}: {
  theme: ThemeDefinition;
  onEdit: (theme: ThemeDefinition) => void;
  onDelete: () => void;
}) {
  const draft = useThemeLibraryStore((state) => state.draft);
  const deleteTheme = useThemeLibraryStore((state) => state.deleteTheme);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            size="icon-sm"
            variant="ghost"
            aria-label={`Manage ${theme.name}`}
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (confirmDelete) {
              event.preventDefault();
              cancel.current?.focus();
            }
          }}
        >
          <DropdownMenuItem
            disabled={draft !== null}
            onSelect={() => onEdit(theme)}
          >
            <Pencil />
            Edit theme
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={draft !== null}
            onSelect={() =>
              onEdit({
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
          <DropdownMenuItem onSelect={() => exportThemes([theme])}>
            <Download />
            Export theme
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setConfirmDelete(true)}>
            <Trash2 />
            Delete theme
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmDelete ? (
        <div
          role="alert"
          className="col-span-full flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/5 p-3"
        >
          <p className="text-ui-xs">
            Delete {theme.name}? Active appearances return to the default
            palette.
          </p>
          <div className="flex gap-2">
            <Button
              ref={cancel}
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmDelete(false);
                trigger.current?.focus();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (deleteTheme(theme.id)) onDelete();
              }}
            >
              Delete theme
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function GlassControl() {
  const opacity = useThemeLibraryStore((state) => state.glassOpacity);
  const setOpacity = useThemeLibraryStore((state) => state.setGlassOpacity);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
      <label htmlFor="theme-glass" className="text-ui-sm">
        Glass opacity
      </label>
      <div className="flex min-w-0 items-center gap-3">
        <input
          id="theme-glass"
          type="range"
          min={30}
          max={100}
          value={opacity}
          onChange={(event) => setOpacity(Number(event.target.value))}
          className="accent-primary"
        />
        <output className="text-ui-xs tabular-nums text-muted-foreground">
          {opacity}%
        </output>
        <Button size="sm" variant="ghost" onClick={() => setOpacity(100)}>
          Reset
        </Button>
      </div>
    </div>
  );
}
